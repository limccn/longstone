/**
 * Scan floor: no commitment can predate the registry's code, so the effective
 * start is `max(configured, deploymentBlock)` and discovery is bounded.
 */

import { HttpRequestError, TimeoutError, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';

import { LongstoneFailure } from '../src/errors.js';
import { scanOwner } from '../src/indexer.js';

const REGISTRY = `0x${'11'.repeat(20)}` as const;
const OWNER = `0x${'22'.repeat(20)}` as const;
const RPC_URL = 'https://rpc.example/v2/SECRETKEY';

function httpError(status?: number): HttpRequestError {
  return new HttpRequestError({
    url: RPC_URL,
    ...(status === undefined ? {} : { status }),
  });
}

interface FakeHandlers {
  getBlockNumber?: () => Promise<bigint>;
  getCode?: (args: { blockNumber: bigint }) => Promise<string | undefined>;
  getLogs?: (args: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown[]>;
}

function clientWith(handlers: FakeHandlers = {}): PublicClient {
  return {
    getBlockNumber: handlers.getBlockNumber ?? (async () => 1000n),
    getCode:
      handlers.getCode ?? (async ({ blockNumber }) => (blockNumber >= 400n ? '0x6000' : '0x')),
    getLogs: handlers.getLogs ?? (async () => []),
  } as unknown as PublicClient;
}

function scanWith(client: PublicClient, extra: { maxAttempts?: number } = {}) {
  return scanOwner({
    client,
    registryAddress: REGISTRY,
    owner: OWNER,
    chunk: 100,
    ...extra,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<LongstoneFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LongstoneFailure);
    return error as LongstoneFailure;
  }
  throw new Error('expected the scan to reject');
}

interface Fake {
  client: PublicClient;
  logCalls: Array<{ fromBlock: bigint; toBlock: bigint }>;
  codeCalls: number;
}

function fakeChain(options: { latest: bigint; deploy: bigint | null }): Fake {
  const logCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let codeCalls = 0;
  const client = {
    async getBlockNumber() {
      return options.latest;
    },
    async getCode({ blockNumber }: { blockNumber: bigint }) {
      codeCalls += 1;
      if (options.deploy === null) return '0x';
      return blockNumber >= options.deploy ? '0x6000' : '0x';
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      logCalls.push({ fromBlock, toBlock });
      return [];
    },
  } as unknown as PublicClient;
  return {
    client,
    logCalls,
    get codeCalls() {
      return codeCalls;
    },
  };
}

function scan(fake: Fake, fromBlock?: bigint) {
  return scanOwner({
    client: fake.client,
    registryAddress: REGISTRY,
    owner: OWNER,
    chunk: 100,
    ...(fromBlock === undefined ? {} : { fromBlock }),
  });
}

describe('scan start — deployment block is a hard floor', () => {
  it('discovers the deployment block when no start is configured', async () => {
    const fake = fakeChain({ latest: 1000n, deploy: 400n });
    const index = await scan(fake);
    expect(fake.logCalls[0]!.fromBlock).toBe(400n);
    expect(index.startBlock).toBe(400n);
    expect(index.requestedStartBlock).toBe(0n);
  });

  it('clamps a configured start below deployment and reports both values', async () => {
    const fake = fakeChain({ latest: 1000n, deploy: 400n });
    const index = await scan(fake, 100n);
    expect(fake.logCalls[0]!.fromBlock).toBe(400n);
    expect(index.requestedStartBlock).toBe(100n);
    expect(index.startBlock).toBe(400n);
  });

  it('honours a configured start above deployment', async () => {
    const fake = fakeChain({ latest: 1000n, deploy: 400n });
    await scan(fake, 600n);
    expect(fake.logCalls[0]!.fromBlock).toBe(600n);
  });

  it('handles a registry present at genesis', async () => {
    const fake = fakeChain({ latest: 10n, deploy: 0n });
    await scan(fake);
    expect(fake.logCalls[0]!.fromBlock).toBe(0n);
  });

  it('fails typed when the registry has no code at head', async () => {
    const fake = fakeChain({ latest: 1000n, deploy: null });
    await expect(scan(fake)).rejects.toMatchObject({
      error: { code: 'REGISTRY_NOT_CONFIGURED' },
    });
  });

  it('fails typed when the configured start is above head', async () => {
    const fake = fakeChain({ latest: 1000n, deploy: 400n });
    await expect(scan(fake, 2000n)).rejects.toMatchObject({
      error: { code: 'REGISTRY_NOT_CONFIGURED' },
    });
  });
});

describe('scan classification — startup and deployment discovery (R3)', () => {
  it('getBlockNumber TypeError is a client bug, not an outage', async () => {
    const original = new TypeError('bad rpc config');
    const typed = await failureOf(
      scanWith(
        clientWith({
          getBlockNumber: async () => {
            throw original;
          },
        }),
      ),
    );
    expect(typed.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(typed.cause).toBe(original);
  });

  it('getBlockNumber HttpRequestError is an outage', async () => {
    const typed = await failureOf(
      scanWith(
        clientWith({
          getBlockNumber: async () => {
            throw httpError(503);
          },
        }),
      ),
    );
    expect(typed.error).toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });

  it('deployment getCode TypeError is a client bug', async () => {
    const original = new TypeError('getCode encoded badly');
    const typed = await failureOf(
      scanWith(
        clientWith({
          getCode: async () => {
            throw original;
          },
        }),
      ),
    );
    expect(typed.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(typed.cause).toBe(original);
  });

  it('deployment getCode HttpRequestError is an outage', async () => {
    const typed = await failureOf(
      scanWith(
        clientWith({
          getCode: async () => {
            throw httpError();
          },
        }),
      ),
    );
    expect(typed.error).toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });
});

describe('scan classification — getLogs (R3)', () => {
  it('a non-transport fatal error is INTERNAL_ERROR with cause and full context', async () => {
    const original = new Error('boom');
    const typed = await failureOf(
      scanWith(
        clientWith({
          getLogs: async () => {
            throw original;
          },
        }),
      ),
    );
    expect(typed.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(typed.cause).toBe(original);
    const detail = (typed.error as { detail: string }).detail;
    expect(detail).toContain('blocks 400..499');
    expect(detail).toContain('cursor 400');
    expect(detail).toMatch(/chunk \d+/);
    expect(detail).toContain('1 attempts');
    expect(detail).toContain('boom');
  });

  it('a connection failure (no status) is retried even though its text looks fatal', async () => {
    // HttpRequestError's message names no 429/5xx, so the text heuristic says
    // "fatal". The class-based classifier must override that: a refused
    // connection is an outage, and retrying is the correct response.
    let calls = 0;
    const typed = await failureOf(
      scanWith(
        clientWith({
          getLogs: async () => {
            calls += 1;
            throw httpError();
          },
        }),
        { maxAttempts: 2 },
      ),
    );
    expect(calls).toBe(2);
    expect(typed.error).toMatchObject({ code: 'RPC_UNAVAILABLE' });
    const detail = (typed.error as { detail: string }).detail;
    expect(detail).toContain('blocks 400..499');
    expect(detail).toContain('cursor 400');
    expect(detail).toMatch(/chunk \d+/);
    expect(detail).toContain('2 attempts');
    // Redaction stays at the typed-error creation point.
    expect(detail).not.toContain('SECRETKEY');
  });

  it('a TimeoutError exhausts to RPC_UNAVAILABLE, never INTERNAL_ERROR', async () => {
    const typed = await failureOf(
      scanWith(
        clientWith({
          getLogs: async () => {
            throw new TimeoutError({ body: {}, url: RPC_URL });
          },
        }),
        { maxAttempts: 1 },
      ),
    );
    expect(typed.error).toMatchObject({ code: 'RPC_UNAVAILABLE' });
    expect((typed.error as { detail: string }).detail).toContain('1 attempts');
  });

  it('a text-retryable "HTTP 503" error exhausts to RPC_UNAVAILABLE', async () => {
    const typed = await failureOf(
      scanWith(
        clientWith({
          getLogs: async () => {
            throw new Error('HTTP 503');
          },
        }),
        { maxAttempts: 1 },
      ),
    );
    expect(typed.error).toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });
});
