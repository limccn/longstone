/**
 * F5 through the registry client: the same classification an embedder sees from
 * `getCommitment` / `commitBatch`. Fake client, no network.
 */

import { memoryRegistryAbi } from '@limccn/menhir-core';
import {
  ContractFunctionRevertedError,
  HttpRequestError,
  encodeErrorResult,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { DEFAULTS } from '../src/config.js';
import { LongstoneFailure } from '../src/errors.js';
import { createRegistry } from '../src/registry.js';

const HASH = `0x${'aa'.repeat(32)}` as const;
const OWNER = `0x${'22'.repeat(20)}` as const;
const SIGNER = `0x${'11'.repeat(20)}` as const;
const CONFIG = { ...DEFAULTS };

/** The first call on either path (read or simulate) throws `error`. */
function clientThrowing(error: unknown): PublicClient {
  return {
    async readContract() {
      throw error;
    },
    async simulateContract() {
      throw error;
    },
  } as unknown as PublicClient;
}

function notAuthorizedRevert(): ContractFunctionRevertedError {
  const data = encodeErrorResult({
    abi: memoryRegistryAbi,
    errorName: 'NotAuthorized',
    args: [OWNER, SIGNER, 1n],
  });
  return new ContractFunctionRevertedError({
    abi: memoryRegistryAbi,
    data,
    functionName: 'commitBatch',
  });
}

function httpError(status?: number): HttpRequestError {
  return new HttpRequestError({
    url: 'https://rpc.example/v2/SECRETKEY',
    ...(status === undefined ? {} : { status }),
  });
}

describe('registry.translate — client bugs are not outages', () => {
  it('maps a TypeError from a read to INTERNAL_ERROR and keeps the cause', async () => {
    const original = new TypeError("Cannot read properties of undefined (reading 'length')");
    const registry = createRegistry(CONFIG, { publicClient: clientThrowing(original) });

    await expect(registry.getCommitment(HASH)).rejects.toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
    try {
      await registry.getCommitment(HASH);
      expect.unreachable('must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LongstoneFailure);
      const typed = error as LongstoneFailure;
      expect(typed.cause).toBe(original);
      expect(JSON.stringify(typed.error)).toContain('TypeError: ');
    }
  });

  it('maps a TypeError from the commitBatch simulate path to INTERNAL_ERROR', async () => {
    const registry = createRegistry(CONFIG, {
      publicClient: clientThrowing(new TypeError('bad args')),
    });
    await expect(registry.commitBatch([], [], {} as never)).rejects.toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  });
});

describe('registry.translate — transport stays RPC_UNAVAILABLE', () => {
  it('maps HttpRequestError 503 to RPC_UNAVAILABLE', async () => {
    const registry = createRegistry(CONFIG, { publicClient: clientThrowing(httpError(503)) });
    await expect(registry.getCommitment(HASH)).rejects.toMatchObject({
      error: { code: 'RPC_UNAVAILABLE' },
    });
  });

  it('maps a connection failure (no status) to RPC_UNAVAILABLE', async () => {
    const registry = createRegistry(CONFIG, { publicClient: clientThrowing(httpError()) });
    await expect(registry.getCommitment(HASH)).rejects.toMatchObject({
      error: { code: 'RPC_UNAVAILABLE' },
    });
  });
});

describe('registry.translate — contract reverts keep their code', () => {
  it('maps a NotAuthorized revert from a read to NOT_AUTHORIZED', async () => {
    const registry = createRegistry(CONFIG, {
      publicClient: clientThrowing(notAuthorizedRevert()),
    });
    await expect(registry.getCommitment(HASH)).rejects.toMatchObject({
      error: { code: 'NOT_AUTHORIZED', role: 'commit' },
    });
  });

  it('maps a NotAuthorized revert from the commitBatch simulate path', async () => {
    const registry = createRegistry(CONFIG, {
      publicClient: clientThrowing(notAuthorizedRevert()),
    });
    await expect(registry.commitBatch([], [], {} as never)).rejects.toMatchObject({
      error: { code: 'NOT_AUTHORIZED' },
    });
  });
});

describe('registry.translate — typed failures pass through', () => {
  it('rethrows the same LongstoneFailure instance', async () => {
    const original = new LongstoneFailure({ code: 'NO_KEY', detail: 'absent' });
    const registry = createRegistry(CONFIG, { publicClient: clientThrowing(original) });
    try {
      await registry.getCommitment(HASH);
      expect.unreachable('must reject');
    } catch (error) {
      expect(error).toBe(original);
    }
  });
});
