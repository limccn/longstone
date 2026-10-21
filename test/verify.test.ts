/**
 * AC-2: a gateway-supplied hash is a candidate, never an expected value.
 * Expected digests are read from `getCommitment`.
 */

import {
  ZERO_BYTES32,
  canonicalBytes,
  cidDigest,
  contentHash,
  parseMemoryContent,
  type Commitment,
} from '@limccn/menhir-core';
import { describe, expect, it } from 'vitest';

import { verify } from '../src/commands/verify.js';
import { LongstoneFailure } from '../src/errors.js';
import type { ChainIndex } from '../src/indexer.js';
import type { GateClient, MemoryRowResponse } from '../src/gate.js';
import type { RegistryClient } from '../src/registry.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const OTHER = `0x${'22'.repeat(20)}` as const;
const H = `0x${'aa'.repeat(32)}` as const;
const OTHER_H = `0x${'bb'.repeat(32)}` as const;
const ZERO32 = `0x${'0'.repeat(64)}` as const;
const ZERO_ADDR = `0x${'0'.repeat(40)}` as const;

const content = parseMemoryContent({ text: 'verified memory', format: 'text.v0' });
const bytes = canonicalBytes(content);
const expectedHash = contentHash(content);
const expectedDigest = cidDigest(bytes);

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    owner: OWNER,
    contentHash: expectedHash,
    cidDigest: expectedDigest,
    signer: ZERO_ADDR,
    blockHeight: 42n,
    op: 0,
    prev: ZERO_BYTES32,
    ...overrides,
  };
}

function gateWith(row: Partial<MemoryRowResponse> | null): GateClient {
  return {
    async stage() {
      throw new Error('not used');
    },
    async build() {
      throw new Error('not used');
    },
    async confirm() {
      throw new Error('not used');
    },
    async list(): Promise<MemoryRowResponse[]> {
      return row === null
        ? []
        : [
            {
              cid: 'bafkrei',
              contentHash: expectedHash,
              cidDigest: expectedDigest,
              owner: OWNER,
              tags: [],
              status: 'anchored',
              batchId: 'b',
              txHash: `0x${'12'.repeat(32)}`,
              createdAt: 0,
              commitmentHash: H,
              ...row,
            },
          ];
    },
    async fetchContent() {
      return bytes;
    },
  };
}

function registryFor(commitments: Record<string, Commitment>): RegistryClient {
  return {
    async getCommitment(hash: `0x${string}`) {
      return commitments[hash] ?? commitment({ owner: ZERO_ADDR, contentHash: ZERO32, cidDigest: ZERO32, blockHeight: 0n });
    },
    async isDeep(hash: `0x${string}`) {
      return commitments[hash] !== undefined;
    },
    async isActive(hash: `0x${string}`) {
      return commitments[hash] !== undefined;
    },
  } as unknown as RegistryClient;
}

function indexWith(hash: `0x${string}`, entry: Commitment): ChainIndex {
  return {
    byHash: new Map([
      [
        hash,
        {
          commitmentHash: hash,
          commitment: entry,
          tags: [],
          blockNumber: 1n,
          txHash: `0x${'12'.repeat(32)}`,
          retracted: false,
          replacedBy: null,
        },
      ],
    ]),
    order: [hash],
    scannedTo: 100n,
    startBlock: 1n,
    requestedStartBlock: 0n,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ error: { code } });
}

describe('verify — chain-only expected values', () => {
  it('reports a non-verified result when the gateway candidate does not match the bytes', async () => {
    // The chain commitment exists and is active, but commits different bytes.
    const registry = registryFor({
      [H]: commitment({ contentHash: `0x${'01'.repeat(32)}`, cidDigest: `0x${'02'.repeat(32)}` }),
    });

    let scanned = false;
    const report = await verify(
      {
        gate: gateWith({ commitmentHash: H }),
        registry,
        scan: async () => {
          scanned = true;
          return indexWith(H, commitment());
        },
      },
      { cid: 'bafkrei', owner: OWNER },
    );

    expect(report.hashSource).toBe('gateway');
    expect(report.hashMatch).toBe(false);
    expect(report.digestMatch).toBe(false);
    expect(report.anchored).toBe(false);
    expect(report.active).toBe(false);
    expect(report.chainDeep).toBe(true);
    // A resolved-but-mismatched candidate is reported, not re-scanned.
    expect(scanned).toBe(false);
  });

  it('falls back to the indexer when the gateway candidate is not a live commitment', async () => {
    const registry = registryFor({ [H]: commitment() });
    const report = await verify(
      {
        gate: gateWith({ commitmentHash: OTHER_H }),
        registry,
        scan: async () => indexWith(H, commitment()),
      },
      { cid: 'bafkrei', owner: OWNER },
    );

    expect(report.hashSource).toBe('indexer');
    expect(report.commitmentHash).toBe(H);
    expect(report.hashMatch).toBe(true);
    expect(report.digestMatch).toBe(true);
    expect(report.anchored).toBe(true);
    expect(report.active).toBe(true);
  });

  it('uses a live gateway candidate without scanning', async () => {
    let scanned = false;
    const report = await verify(
      {
        gate: gateWith({ commitmentHash: H }),
        registry: registryFor({ [H]: commitment() }),
        scan: async () => {
          scanned = true;
          return indexWith(H, commitment());
        },
      },
      { cid: 'bafkrei', owner: OWNER },
    );

    expect(report.hashSource).toBe('gateway');
    expect(report.hashMatch).toBe(true);
    expect(report.digestMatch).toBe(true);
    expect(report.anchored).toBe(true);
    expect(scanned).toBe(false);
  });

  it('falls back to the indexer when the gateway list is unreachable', async () => {
    const unreachable: GateClient = {
      async stage() {
        throw new Error('not used');
      },
      async build() {
        throw new Error('not used');
      },
      async confirm() {
        throw new Error('not used');
      },
      async list() {
        throw new Error('ECONNREFUSED https://user:pass@gw.example/x?token=1');
      },
      async fetchContent() {
        return bytes;
      },
    };

    const report = await verify(
      { gate: unreachable, registry: registryFor({ [H]: commitment() }), scan: async () => indexWith(H, commitment()) },
      { cid: 'bafkrei', owner: OWNER },
    );
    expect(report.hashSource).toBe('indexer');
    expect(report.anchored).toBe(true);
  });

  it('fails with HASH_UNRESOLVED when nothing resolves', async () => {
    await expectCode(
      verify(
        { gate: gateWith(null), registry: registryFor({}) },
        { cid: 'bafkrei', owner: OWNER },
      ),
      'HASH_UNRESOLVED',
    );
  });

  it('asserts ownership on an explicit hash', async () => {
    const registry = registryFor({ [H]: commitment({ owner: OTHER }) });
    await expectCode(
      verify({ gate: gateWith(null), registry }, { cid: 'bafkrei', commitmentHash: H, owner: OWNER }),
      'OWNER_MISMATCH',
    );
  });

  it('reports the resolved hash and both computed and expected digests', async () => {
    const report = await verify(
      { gate: gateWith(null), registry: registryFor({ [H]: commitment() }) },
      { cid: 'bafkrei', commitmentHash: H, owner: OWNER },
    );
    expect(report.commitmentHash).toBe(H);
    expect(report.owner.toLowerCase()).toBe(OWNER);
    expect(report.contentHash).toBe(expectedHash);
    expect(report.cidDigest).toBe(expectedDigest);
    expect(report.computedContentHash).toBe(expectedHash);
    expect(report.computedCidDigest).toBe(expectedDigest);
    expect(report.blockHeight).toBe('42');
  });

  it('a retracted commitment is not active but is still digest-matched', async () => {
    const registry = registryFor({ [H]: commitment() });
    registry.isActive = async () => false;
    const report = await verify(
      { gate: gateWith(null), registry },
      { cid: 'bafkrei', commitmentHash: H, owner: OWNER },
    );
    expect(report.hashMatch).toBe(true);
    expect(report.digestMatch).toBe(true);
    expect(report.anchored).toBe(true);
    expect(report.active).toBe(false);
  });
});
