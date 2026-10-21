/**
 * Scan floor: no commitment can predate the registry's code, so the effective
 * start is `max(configured, deploymentBlock)` and discovery is bounded.
 */

import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';

import { scanOwner } from '../src/indexer.js';

const REGISTRY = `0x${'11'.repeat(20)}` as const;
const OWNER = `0x${'22'.repeat(20)}` as const;

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
