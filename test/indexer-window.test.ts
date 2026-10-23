/**
 * Adaptive `getLogs` windows (F3).
 *
 * The scanner starts at `chunk`, grows after three consecutive successful
 * requests up to `maxChunk`, shrinks on a provider range rejection, and retries
 * at the shrunk window. A learned ceiling is cached per `rpcUrl`.
 *
 * Every client here is a fake and `sleep` is injected as a no-op: no network,
 * no real timers.
 */

import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type PublicClient } from 'viem';
import { memoryRegistryAbi } from '@limccn/menhir-core';
import { describe, expect, it } from 'vitest';

import { scanOwner, type ChainIndex, type ScanOptions } from '../src/indexer.js';

const REGISTRY = `0x${'11'.repeat(20)}` as const;
const OWNER = `0x${'22'.repeat(20)}` as const;
const ZERO32 = `0x${'00'.repeat(32)}` as const;

const noSleep = async (): Promise<void> => {};

interface LogCall {
  fromBlock: bigint;
  toBlock: bigint;
}

interface FakeChain {
  client: PublicClient;
  calls: LogCall[];
}

function width(call: LogCall): bigint {
  return call.toBlock - call.fromBlock + 1n;
}

function fakeChain(
  onLogs: (call: LogCall) => unknown[] | Promise<unknown[]>,
  options: { latest: bigint; deploy?: bigint },
): FakeChain {
  const calls: LogCall[] = [];
  const deploy = options.deploy ?? 0n;
  const client = {
    async getBlockNumber() {
      return options.latest;
    },
    async getCode({ blockNumber }: { blockNumber: bigint }) {
      return blockNumber >= deploy ? '0x6000' : '0x';
    },
    async getLogs({ fromBlock, toBlock }: LogCall) {
      const call = { fromBlock, toBlock };
      calls.push(call);
      return onLogs(call);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

function scan(fake: FakeChain, extra: Partial<ScanOptions> = {}): Promise<ChainIndex> {
  return scanOwner({
    client: fake.client,
    registryAddress: REGISTRY,
    owner: OWNER,
    sleep: noSleep,
    ...extra,
  });
}

/** A decodable `MemoryCommitted` log for `OWNER`. */
function committedLog(args: { contentHash: `0x${string}`; commitmentHash: `0x${string}` }) {
  const commitment = {
    owner: OWNER,
    contentHash: args.contentHash,
    cidDigest: ZERO32,
    signer: OWNER,
    blockHeight: 1n,
    op: 0,
    prev: ZERO32,
  };
  const topics = encodeEventTopics({
    abi: memoryRegistryAbi,
    eventName: 'MemoryCommitted',
    args: {
      owner: OWNER,
      contentHash: args.contentHash,
      commitmentHash: args.commitmentHash,
    },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      '(address owner, bytes32 contentHash, bytes32 cidDigest, address signer, uint64 blockHeight, uint8 op, bytes32 prev), bytes32[]',
    ),
    [commitment, []],
  );
  return {
    topics,
    data,
    blockNumber: 10n,
    transactionHash: `0x${'ee'.repeat(32)}` as const,
  };
}

describe('scan window — growth', () => {
  it('grows after three successes and stops at maxChunk', async () => {
    const fake = fakeChain(() => [], { latest: 20_000n });
    await scan(fake, { chunk: 200, maxChunk: 1000 });

    const widths = fake.calls.map(width);
    expect(widths.slice(0, 3)).toEqual([200n, 200n, 200n]);
    expect(widths[3]).toBe(400n);
    expect(widths[6]).toBe(800n);
    expect(widths[9]).toBe(1000n);
    expect(widths.every((w) => w <= 1000n)).toBe(true);
  });

  it('does not grow when maxChunk is omitted (direct callers keep the fixed window)', async () => {
    const fake = fakeChain(() => [], { latest: 999n });
    await scan(fake, { chunk: 100 });

    expect(fake.calls.every((call) => width(call) === 100n)).toBe(true);
  });
});

describe('scan window — shrink and retry', () => {
  it('retries a failed range at the shrunk window, not the failed one', async () => {
    // A provider that rejects anything above 200 blocks. The initial 400 fails;
    // attempt 2 must ask for 200 blocks from the same cursor.
    const providerLimit = 200n;
    const fake = fakeChain(
      (call) => {
        if (width(call) > providerLimit) throw new Error('block range is too large');
        return [];
      },
      { latest: 999n },
    );

    await scan(fake, { chunk: 400, maxChunk: 10_000 });

    expect(fake.calls[0]).toEqual({ fromBlock: 0n, toBlock: 399n });
    expect(fake.calls[1]).toEqual({ fromBlock: 0n, toBlock: 199n });
  });

  it('converges the ceiling to the last good window and never re-requests the failed size', async () => {
    let failedOnce = false;
    const fake = fakeChain(
      (call) => {
        if (!failedOnce && width(call) === 400n) {
          failedOnce = true;
          throw new Error('block range is too large');
        }
        return [];
      },
      { latest: 5000n },
    );

    await scan(fake, { chunk: 200, maxChunk: 10_000 });

    const widths = fake.calls.map(width);
    const failureIndex = widths.indexOf(400n);
    expect(failureIndex).toBe(3); // three successes at 200, then the failed 400
    // The retry and every later request stay at or below the last good window.
    expect(widths.slice(failureIndex + 1).some((w) => w > 200n)).toBe(false);
    expect(widths.slice(failureIndex + 1).includes(400n)).toBe(false);
  });

  it('adopts a provider-stated cap without growing to it on the failed attempt', async () => {
    let failedOnce = false;
    const fake = fakeChain(
      (call) => {
        if (!failedOnce && width(call) === 400n) {
          failedOnce = true;
          throw new Error('limited to 300 blocks per request');
        }
        return [];
      },
      { latest: 5000n },
    );

    await scan(fake, { chunk: 200, maxChunk: 10_000 });

    const widths = fake.calls.map(width);
    const failureIndex = widths.indexOf(400n);
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    // Retry uses the stated ceiling, not the failed 400 and not a jump above it.
    expect(widths[failureIndex + 1]).toBe(300n);
    expect(widths.slice(failureIndex + 1).every((w) => w <= 300n)).toBe(true);
  });

  it('halves on a transient 429 but does not lower the ceiling', async () => {
    let failedOnce = false;
    const fake = fakeChain(
      () => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error('HTTP 429 Too Many Requests');
        }
        return [];
      },
      { latest: 20_000n },
    );

    await scan(fake, { chunk: 200, maxChunk: 1600 });

    const widths = fake.calls.map(width);
    expect(widths[0]).toBe(200n);
    expect(widths[1]).toBe(100n);
    // Growth resumed: a transient failure must not pin the ceiling at 100.
    expect(widths.reduce((max, w) => (w > max ? w : max), 0n)).toBe(1600n);
  });
});

describe('scan window — correctness under retry', () => {
  it('records a log once across a failed and retried overlap', async () => {
    const contentHash = `0x${'ab'.repeat(32)}` as const;
    const commitmentHash = `0x${'cd'.repeat(32)}` as const;
    const log = committedLog({ contentHash, commitmentHash });
    let failedOnce = false;

    const fake = fakeChain(
      (call) => {
        if (!failedOnce && width(call) > 200n) {
          failedOnce = true;
          throw new Error('block range is too large');
        }
        // The log sits at block 10, inside both 0..399 and the retried 0..199.
        return call.fromBlock <= 10n && 10n <= call.toBlock ? [log] : [];
      },
      { latest: 999n },
    );

    const index = await scan(fake, { chunk: 400, maxChunk: 10_000 });

    expect(index.order).toEqual([commitmentHash]);
    expect(index.byHash.size).toBe(1);
    expect(index.byHash.get(commitmentHash)?.blockNumber).toBe(10n);
  });

  it('learns a per-RPC ceiling and reuses it on the next scan', async () => {
    const rpcUrl = 'https://rpc.example/window-cache-test';
    let failedOnce = false;

    const first = fakeChain(
      (call) => {
        if (!failedOnce && width(call) === 400n) {
          failedOnce = true;
          throw new Error('block range is too large');
        }
        return [];
      },
      { latest: 1000n },
    );
    await scan(first, { chunk: 200, maxChunk: 10_000, rpcUrl });

    // A fresh scan with a larger ceiling still starts small and grows only up
    // to the ceiling the first scan learned for this endpoint.
    const second = fakeChain(() => [], { latest: 1000n });
    await scan(second, { chunk: 100, maxChunk: 4000, rpcUrl });

    const widths = second.calls.map(width);
    expect(widths[0]).toBe(100n);
    expect(widths.slice(0, 3)).toEqual([100n, 100n, 100n]);
    expect(widths[3]).toBe(200n);
    expect(widths.every((w) => w <= 200n)).toBe(true);
  });
});
