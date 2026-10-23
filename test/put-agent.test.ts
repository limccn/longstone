/**
 * AC-7 / AC-8 (method A): the optional ERC-8004 reference rides inside
 * `MemoryContent.meta.agent`, and omitting it produces the exact 0.1.1 bytes.
 *
 * The no-agent expectation is a FROZEN hex fixture captured from the released
 * canonicalizer, not a hash recomputed on both sides: recomputing would pass
 * even if the canonical bytes changed. The with-agent fixture was derived
 * independently from the JCS preimage (keys sorted: format, meta, text; inside
 * agent: agentId, registry) and then frozen.
 */

import {
  ZERO_BYTES32,
  canonicalBytes,
  cidDigest,
  commitmentHash,
  contentHash,
  parseMemoryContent,
  type Commitment,
} from '@limccn/menhir-core';
import { describe, expect, it } from 'vitest';

import type { AgentRef } from '../src/agent-ref.js';
import { put } from '../src/commands/put.js';
import { putMany } from '../src/commands/put-batch.js';
import { DEFAULTS } from '../src/config.js';
import { LongstoneFailure } from '../src/errors.js';
import type { GateClient } from '../src/gate.js';
import type { RegistryClient } from '../src/registry.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const SIGNER = `0x${'22'.repeat(20)}` as const;
const ZERO_ADDR = `0x${'0'.repeat(40)}` as const;
const TX = `0x${'ab'.repeat(32)}` as const;

const TEXT = 'golden fixture for the agent sidecar';

// --- Frozen no-agent fixture (the 0.1.1 canonical bytes) -------------------
const NO_AGENT_BYTES =
  '7b22666f726d6174223a22746578742e7630222c2274657874223a22676f6c64656e206669787475726520666f7220746865206167656e742073696465636172227d';
const NO_AGENT_HASH = '0x11bfcdba4870117dae4dc7681f621511bab4c726086e57fe5ab75de887b1df51';
const NO_AGENT_DIGEST = '0x6bb1beb7f5370c235b747f5f852d77cbaab22c7ab41df398cd0377eff4a90615';

// --- Frozen with-agent fixture (same text + one pointer) -------------------
const AGENT_REF: AgentRef = {
  registry: 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e',
  agentId: '42',
};
const AGENT_BYTES =
  '7b22666f726d6174223a22746578742e7630222c226d657461223a7b226167656e74223a7b226167656e744964223a223432222c227265676973747279223a226569703135353a38343533323a307838303034413831384246423931323233336334393138373162336438346338394134393442443965227d7d2c2274657874223a22676f6c64656e206669787475726520666f7220746865206167656e742073696465636172227d';
const AGENT_HASH = '0xfd2416d778c9928969bb73452ac1abe2f9b106518583ce835673f3c5dfed4eea';
const AGENT_DIGEST = '0xe31a13ec2c653eb21e99d9b3bac401dbb994696f6eb13c475f712d5a8267e585';

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

function hexOf(content: unknown): string {
  return Buffer.from(canonicalBytes(parseMemoryContent(content))).toString('hex');
}

interface StageCall {
  content: unknown;
  contentHash: `0x${string}`;
  tags: string[];
}

function harness() {
  const stageCalls: StageCall[] = [];
  const commits: Array<readonly Commitment[]> = [];

  const gate: GateClient = {
    async stage(input) {
      stageCalls.push({ content: input.content, contentHash: input.contentHash, tags: input.tags });
      const content = parseMemoryContent(input.content);
      return {
        cid: `bafy-agent-${stageCalls.length - 1}`,
        cidDigest: cidDigest(canonicalBytes(content)),
        status: 'staged',
      };
    },
    async build() {
      return {
        batchId: 'batch-agent',
        commitments: stageCalls.map((call) =>
          commitment({
            contentHash: call.contentHash,
            cidDigest: cidDigest(canonicalBytes(parseMemoryContent(call.content))),
          }),
        ),
        tagLists: stageCalls.map(() => []),
      };
    },
    async confirm() {
      return { status: 'anchored' };
    },
    async list() {
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
    async commitBatch(commitments: readonly Commitment[]) {
      commits.push(commitments);
      return TX;
    },
  } as unknown as RegistryClient;

  return {
    stageCalls,
    commits,
    deps: {
      config: { ...DEFAULTS },
      gate,
      registry,
      waitForReceipt: async () => ({ status: 'success' }) as never,
    },
  };
}

function account() {
  return { address: SIGNER } as never;
}

async function failureOf(promise: Promise<unknown>): Promise<LongstoneFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LongstoneFailure) return error;
    throw error;
  }
  throw new Error('expected a LongstoneFailure');
}

describe('put without an agent reference is byte-identical to 0.1.1', () => {
  it('stages {text, format} with no meta key and the frozen canonical bytes', async () => {
    const test = harness();
    const result = await put(test.deps, {
      text: TEXT,
      tags: ['topic:agent'],
      owner: OWNER,
      account: account(),
    });

    expect(test.stageCalls).toHaveLength(1);
    const staged = test.stageCalls[0]!;

    // No `meta` member at all: the preimage is exactly the old one.
    expect(Object.keys(staged.content as Record<string, unknown>).sort()).toEqual([
      'format',
      'text',
    ]);
    expect(hexOf(staged.content)).toBe(NO_AGENT_BYTES);
    expect(contentHash(parseMemoryContent(staged.content))).toBe(NO_AGENT_HASH);
    expect(cidDigest(canonicalBytes(parseMemoryContent(staged.content)))).toBe(NO_AGENT_DIGEST);
    expect(staged.contentHash).toBe(NO_AGENT_HASH);

    // The result keeps the old shape plus `agent: null`.
    expect(result.agent).toBeNull();
    expect(Object.keys(result).sort()).toEqual([
      'agent',
      'cid',
      'commitmentHash',
      'confirmed',
      'txHash',
    ]);
    expect(test.commits).toHaveLength(1);
    expect(test.commits[0]![0]!.contentHash).toBe(NO_AGENT_HASH);
  });
});

describe('put with an agent reference anchors a pointer in meta.agent', () => {
  it('stages {text, format, meta.agent} with the frozen golden digests', async () => {
    const test = harness();
    const result = await put(test.deps, {
      text: TEXT,
      owner: OWNER,
      account: account(),
      agent: AGENT_REF,
    });

    expect(test.stageCalls).toHaveLength(1);
    const staged = test.stageCalls[0]!;

    expect(staged.content).toEqual({ text: TEXT, format: 'text.v0', meta: { agent: AGENT_REF } });
    expect(hexOf(staged.content)).toBe(AGENT_BYTES);
    expect(contentHash(parseMemoryContent(staged.content))).toBe(AGENT_HASH);
    expect(cidDigest(canonicalBytes(parseMemoryContent(staged.content)))).toBe(AGENT_DIGEST);
    expect(staged.contentHash).toBe(AGENT_HASH);

    // The caller can confirm what was anchored without re-deriving content.
    expect(result.agent).toEqual(AGENT_REF);
    expect(test.commits[0]![0]!.contentHash).toBe(AGENT_HASH);
    expect(test.commits[0]![0]!.cidDigest).toBe(AGENT_DIGEST);
    expect(commitmentHash(test.commits[0]![0]!)).toBe(result.commitmentHash);
  });

  it('changes the content hash and therefore the (owner, contentHash) dedup identity', async () => {
    const plain = harness();
    const withAgent = harness();

    const plainResult = await put(plain.deps, { text: TEXT, owner: OWNER, account: account() });
    const agentResult = await put(withAgent.deps, {
      text: TEXT,
      owner: OWNER,
      account: account(),
      agent: AGENT_REF,
    });

    expect(plainResult.agent).toBeNull();
    expect(agentResult.agent).toEqual(AGENT_REF);
    expect(plain.stageCalls[0]!.contentHash).toBe(NO_AGENT_HASH);
    expect(withAgent.stageCalls[0]!.contentHash).toBe(AGENT_HASH);
    expect(withAgent.stageCalls[0]!.contentHash).not.toBe(plain.stageCalls[0]!.contentHash);
  });
});

describe('put-batch carries the same optional reference', () => {
  it('applies one agent ref to every item without changing item alignment', async () => {
    const texts = ['agent batch one', 'agent batch two'];
    const test = harness();

    const result = await putMany(test.deps, {
      intents: texts.map((text) => ({ text })),
      tags: [],
      owner: OWNER,
      account: account(),
      agent: AGENT_REF,
    });

    expect(test.stageCalls).toHaveLength(2);
    for (const [index, call] of test.stageCalls.entries()) {
      expect(call.content).toEqual({
        text: texts[index],
        format: 'text.v0',
        meta: { agent: AGENT_REF },
      });
    }
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.commitmentHash).not.toBe(result.items[1]!.commitmentHash);
  });
});

describe('invalid references fail before staging (no pin, no gas)', () => {
  it('put rejects a malformed registry before gate.stage', async () => {
    const test = harness();
    const failure = await failureOf(
      put(test.deps, {
        text: TEXT,
        owner: OWNER,
        account: account(),
        agent: { registry: 'eip155:84532:0xnothex', agentId: '1' },
      }),
    );

    expect(failure.error.code).toBe('SCHEMA_VIOLATION');
    expect((failure.error as { detail?: string }).detail).toContain('meta.agent.registry');
    expect(test.stageCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });

  it('put rejects a numeric agentId before gate.stage', async () => {
    const test = harness();
    const failure = await failureOf(
      put(test.deps, {
        text: TEXT,
        owner: OWNER,
        account: account(),
        agent: { registry: AGENT_REF.registry, agentId: 42 } as unknown as AgentRef,
      }),
    );

    expect(failure.error.code).toBe('SCHEMA_VIOLATION');
    expect((failure.error as { detail?: string }).detail).toContain('meta.agent.agentId');
    expect(test.stageCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });

  it('putMany rejects an unknown key under meta.agent before the first stage', async () => {
    const test = harness();
    const failure = await failureOf(
      putMany(test.deps, {
        intents: [{ text: 'one' }, { text: 'two' }],
        tags: [],
        owner: OWNER,
        account: account(),
        agent: { registry: AGENT_REF.registry, agentId: '1', chain: 'base' } as unknown as AgentRef,
      }),
    );

    expect(failure.error.code).toBe('SCHEMA_VIOLATION');
    expect((failure.error as { detail?: string }).detail).toContain('unknown key');
    expect(test.stageCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });
});
