/**
 * AC-1: the victim signs only the commitment it computed, even when the
 * gateway returns an attacker row first.
 *
 * The gateway is a stub; the registry captures the exact `commitBatch`
 * arguments. No network is involved.
 */

import {
  ZERO_BYTES32,
  canonicalBytes,
  cidDigest,
  contentHash,
  parseMemoryContent,
  tagToBytes32,
  type Commitment,
} from '@limccn/menhir-core';
import { describe, expect, it } from 'vitest';

import { put } from '../src/commands/put.js';
import { DEFAULTS } from '../src/config.js';
import { LongstoneFailure } from '../src/errors.js';
import type { GateClient, MemoryRowResponse } from '../src/gate.js';
import type { RegistryClient } from '../src/registry.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const SIGNER = `0x${'22'.repeat(20)}` as const;
const ZERO_ADDR = `0x${'0'.repeat(40)}` as const;
const TX = `0x${'ab'.repeat(32)}` as const;

function localContent(): { content: ReturnType<typeof parseMemoryContent>; hash: `0x${string}`; digest: `0x${string}` } {
  const content = parseMemoryContent({ text: 'victim memory', format: 'text.v0' });
  return {
    content,
    hash: contentHash(content),
    digest: cidDigest(canonicalBytes(content)),
  };
}

function commitment(overrides: Partial<Commitment>): Commitment {
  return {
    owner: OWNER,
    contentHash: `0x${'33'.repeat(32)}`,
    cidDigest: `0x${'44'.repeat(32)}`,
    signer: ZERO_ADDR,
    blockHeight: 0n,
    op: 0,
    prev: ZERO_BYTES32,
    ...overrides,
  };
}

describe('put — signs only the locally computed commitment', () => {
  it('filters an attacker row that the gateway returned first', async () => {
    const local = localContent();
    const attackerHash = `0x${'aa'.repeat(32)}` as const;
    const attackerDigest = `0x${'bb'.repeat(32)}` as const;
    const attackerTags = [tagToBytes32('attacker')];
    const localTags = [tagToBytes32('victim')];

    const stageCalls: Array<Record<string, unknown>> = [];
    const buildCalls: Array<Record<string, unknown>> = [];
    const commits: Array<{ commitments: readonly Commitment[]; tagLists: readonly `0x${string}`[][] }> = [];

    const gate: GateClient = {
      async stage(input) {
        stageCalls.push(input as unknown as Record<string, unknown>);
        return { cid: 'bafkreivictim', cidDigest: local.digest, status: 'staged' };
      },
      async build(input) {
        buildCalls.push(input as unknown as Record<string, unknown>);
        return {
          batchId: 'batch-1',
          commitments: [
            commitment({ contentHash: attackerHash, cidDigest: attackerDigest }),
            commitment({ contentHash: local.hash, cidDigest: local.digest }),
          ],
          tagLists: [attackerTags, localTags],
        };
      },
      async confirm() {
        return { status: 'anchored' };
      },
      async list(): Promise<MemoryRowResponse[]> {
        return [];
      },
      async fetchContent() {
        return new Uint8Array();
      },
    };

    const registry = {
      async blockNumber() {
        return 100n;
      },
      async getCommitment() {
        throw new Error('not used');
      },
      async commitBatch(commitments: readonly Commitment[], tagLists: readonly `0x${string}`[][]) {
        commits.push({ commitments, tagLists });
        return TX;
      },
    } as unknown as RegistryClient;

    const result = await put(
      {
        config: { ...DEFAULTS },
        gate,
        registry,
        waitForReceipt: async () => ({ status: 'success' }) as never,
      },
      {
        text: 'victim memory',
        tags: ['victim'],
        owner: OWNER,
        account: { address: SIGNER } as never,
      },
    );

    // Exactly one commitment was signed, and it is the local one.
    expect(commits).toHaveLength(1);
    expect(commits[0]!.commitments).toHaveLength(1);
    expect(commits[0]!.commitments[0]!.contentHash).toBe(local.hash);
    expect(commits[0]!.commitments[0]!.cidDigest).toBe(local.digest);
    expect(commits[0]!.commitments[0]!.owner.toLowerCase()).toBe(OWNER);
    expect(commits[0]!.commitments[0]!.signer).toBe(SIGNER);
    expect(commits[0]!.commitments[0]!.blockHeight).toBe(100n);
    expect(commits[0]!.tagLists).toEqual([localTags]);

    // The stage and build calls share one capability, and it is a 128-bit token.
    expect(stageCalls[0]!.capability).toMatch(/^[0-9a-f]{32}$/);
    expect(buildCalls[0]!.capability).toBe(stageCalls[0]!.capability);
    expect(result.cid).toBe('bafkreivictim');
    expect(result.confirmed).toBe(true);
  });

  it('fails closed before signing when the local row is absent', async () => {
    const local = localContent();
    let signed = false;

    const gate: GateClient = {
      async stage() {
        return { cid: 'bafkrei', cidDigest: local.digest, status: 'staged' };
      },
      async build() {
        return {
          batchId: 'batch-1',
          commitments: [commitment({ contentHash: `0x${'aa'.repeat(32)}`, cidDigest: `0x${'bb'.repeat(32)}` })],
          tagLists: [[]],
        };
      },
      async confirm() {
        return { status: 'anchored' };
      },
      async list(): Promise<MemoryRowResponse[]> {
        return [];
      },
      async fetchContent() {
        return new Uint8Array();
      },
    };

    const registry = {
      async blockNumber() {
        return 100n;
      },
      async commitBatch() {
        signed = true;
        return TX;
      },
    } as unknown as RegistryClient;

    await expect(
      put(
        {
          config: { ...DEFAULTS },
          gate,
          registry,
          waitForReceipt: async () => ({ status: 'success' }) as never,
        },
        { text: 'victim memory', owner: OWNER, account: { address: SIGNER } as never },
      ),
    ).rejects.toBeInstanceOf(LongstoneFailure);
    expect(signed).toBe(false);
  });
});
