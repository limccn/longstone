/**
 * F1 + F2 — batch writes and confirm recovery.
 *
 * These drive `putMany` with a fake gate and registry, and an injected
 * `waitForReceipt`, so no chain or network is involved. The assertions are the
 * trust-boundary ones: one capability, one build, one signature only after every
 * stage replied `staged`, index-aligned tags/commitments, and a broadcast write
 * that survives a broken confirm without losing its txHash.
 */

import {
  ZERO_BYTES32,
  canonicalBytes,
  cidDigest,
  commitmentHash,
  contentHash,
  parseMemoryContent,
  tagToBytes32,
} from '@limccn/menhir-core';
import type { Commitment } from '@limccn/menhir-core';
import { describe, expect, it } from 'vitest';

import { putMany } from '../src/commands/put-batch.js';
import { put } from '../src/commands/put.js';
import { DEFAULTS } from '../src/config.js';
import { confirmWithRetry, isRetryableConfirmError } from '../src/confirm.js';
import {
  LongstoneFailure,
  describe as describeError,
  type LongstoneError,
} from '../src/errors.js';
import type { ConfirmOutcome, GateClient, MemoryRowResponse } from '../src/gate.js';
import type { RegistryClient } from '../src/registry.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const SIGNER = `0x${'22'.repeat(20)}` as const;
const ZERO_ADDR = `0x${'0'.repeat(40)}` as const;
const ZERO32 = `0x${'0'.repeat(64)}` as const;
const TX = `0x${'ab'.repeat(32)}` as const;
const UNKNOWN_TX = `0x${'cd'.repeat(32)}` as const;

interface LocalItem {
  text: string;
  content: ReturnType<typeof parseMemoryContent>;
  hash: `0x${string}`;
  digest: `0x${string}`;
}

function locals(texts: string[]): LocalItem[] {
  return texts.map((text) => {
    const content = parseMemoryContent({ text, format: 'text.v0' });
    return { text, content, hash: contentHash(content), digest: cidDigest(canonicalBytes(content)) };
  });
}

function commitment(overrides: Partial<Commitment> = {}): Commitment {
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

function row(overrides: Partial<MemoryRowResponse> = {}): MemoryRowResponse {
  return {
    cid: 'bafy-batched',
    contentHash: `0x${'55'.repeat(32)}`,
    cidDigest: `0x${'66'.repeat(32)}`,
    owner: OWNER,
    tags: [],
    status: 'batched',
    batchId: 'batch-old',
    txHash: null,
    createdAt: 0,
    commitmentHash: null,
    ...overrides,
  };
}

interface HarnessOptions {
  texts: string[];
  /** Per-stage status; default `staged`. */
  statuses?: string[];
  buildError?: unknown;
  buildTransform?: (
    commitments: Commitment[],
    tagLists: `0x${string}`[][],
  ) => { commitments: Commitment[]; tagLists: `0x${string}`[][] };
  listRows?: MemoryRowResponse[];
  confirm?: (call: number) => Promise<ConfirmOutcome>;
  getCommitment?: (hash: `0x${string}`) => Promise<Commitment>;
  receiptStatus?: 'success' | 'reverted';
}

function harness(options: HarnessOptions) {
  const local = locals(options.texts);
  const stageCalls: Array<{
    owner: `0x${string}`;
    contentHash: `0x${string}`;
    tags: string[];
    capability: string;
  }> = [];
  const buildCalls: Array<{ capability: string }> = [];
  const commits: Array<{
    commitments: readonly Commitment[];
    tagLists: readonly `0x${string}`[][];
  }> = [];
  const confirmCalls: string[] = [];
  const listCalls: Array<{ owner: `0x${string}`; status?: string; limit?: number }> = [];
  const commitmentReads: `0x${string}`[] = [];
  let stageIndex = 0;
  let confirmIndex = 0;

  // Placeholder structs, one per locally staged item; each row gets a DIFFERENT
  // tag list so an alignment bug cannot pass by accident.
  const builtCommitments = local.map((item) =>
    commitment({ contentHash: item.hash, cidDigest: item.digest }),
  );
  const builtTags = local.map((_, index) => [tagToBytes32(`row${index}`)]);

  const gate: GateClient = {
    async stage(input) {
      const index = stageIndex;
      stageIndex += 1;
      stageCalls.push({
        owner: input.owner,
        contentHash: input.contentHash,
        tags: input.tags,
        capability: input.capability,
      });
      return {
        cid: `bafy-item-${index}`,
        cidDigest: local[index]!.digest,
        status: options.statuses?.[index] ?? 'staged',
      };
    },
    async build(input) {
      buildCalls.push({ capability: input.capability });
      if (options.buildError !== undefined) throw options.buildError;
      const transformed =
        options.buildTransform === undefined
          ? { commitments: builtCommitments, tagLists: builtTags }
          : options.buildTransform([...builtCommitments], builtTags.map((tags) => [...tags]));
      return { batchId: 'batch-1', ...transformed };
    },
    async list(input) {
      listCalls.push({
        owner: input.owner,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return options.listRows ?? [];
    },
    async confirm(input) {
      confirmIndex += 1;
      confirmCalls.push(input.txHash);
      if (options.confirm !== undefined) return options.confirm(confirmIndex);
      return { status: 'anchored' };
    },
    async fetchContent() {
      throw new Error('fetchContent is not used by putMany');
    },
  };

  const registry = {
    async blockNumber() {
      return 100n;
    },
    async getCommitment(hash: `0x${string}`) {
      commitmentReads.push(hash);
      if (options.getCommitment !== undefined) return options.getCommitment(hash);
      throw new Error('getCommitment is not expected in this test');
    },
    async commitBatch(commitments: readonly Commitment[], tagLists: readonly `0x${string}`[][]) {
      commits.push({ commitments, tagLists });
      return TX;
    },
  } as unknown as RegistryClient;

  const deps = {
    config: { ...DEFAULTS },
    gate,
    registry,
    waitForReceipt: async () => ({ status: options.receiptStatus ?? 'success' }) as never,
  };

  return { local, stageCalls, buildCalls, commits, confirmCalls, listCalls, commitmentReads, deps };
}

function account() {
  return { address: SIGNER } as never;
}

function intents(texts: string[]) {
  return texts.map((text) => ({ text }));
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

function failure(code: LongstoneError['code'], extra: Record<string, unknown> = {}): LongstoneFailure {
  return new LongstoneFailure({ code, ...extra } as LongstoneError);
}

describe('putMany — validation happens before any staging', () => {
  it('rejects zero intents', async () => {
    const test = harness({ texts: [] });
    const error = await failureOf(
      putMany(test.deps, { intents: [], tags: [], owner: OWNER, account: account() }),
    );

    expect(error.error.code).toBe('INVALID_BATCH_SIZE');
    expect(test.stageCalls).toHaveLength(0);
    expect(test.buildCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });

  it('rejects 65 intents', async () => {
    const texts = Array.from({ length: 65 }, (_, index) => `batch item ${index}`);
    const test = harness({ texts });
    const error = await failureOf(
      putMany(test.deps, { intents: intents(texts), tags: [], owner: OWNER, account: account() }),
    );

    expect(error.error.code).toBe('INVALID_BATCH_SIZE');
    expect(test.stageCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });

  it('rejects duplicate content before the first stage and names both indexes', async () => {
    const test = harness({ texts: ['same memory', 'same memory'] });
    const error = await failureOf(
      putMany(test.deps, {
        intents: intents(['same memory', 'same memory']),
        tags: [],
        owner: OWNER,
        account: account(),
      }),
    );

    expect(error.error.code).toBe('SCHEMA_VIOLATION');
    expect((error.error as { detail?: string }).detail).toMatch(/intent 1/);
    expect((error.error as { detail?: string }).detail).toMatch(/intent 0/);
    expect(test.stageCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });
});

describe('putMany — one capability, one build, one transaction', () => {
  it.each([1, 3, 64])('anchors %i items with a single commitBatch', async (count) => {
    const texts = Array.from({ length: count }, (_, index) => `batch item ${index} of ${count}`);
    const test = harness({ texts });

    const result = await putMany(test.deps, {
      intents: intents(texts),
      tags: ['layer:deep', 'topic:batch'],
      owner: OWNER,
      account: account(),
    });

    // One capability scoped every stage and the build.
    expect(test.stageCalls).toHaveLength(count);
    const capability = test.stageCalls[0]!.capability;
    expect(capability).toMatch(/^[0-9a-f]{32}$/);
    expect(test.stageCalls.every((call) => call.capability === capability)).toBe(true);
    expect(test.stageCalls.every((call) => call.tags.join(',') === 'layer:deep,topic:batch')).toBe(
      true,
    );
    expect(test.buildCalls).toEqual([{ capability }]);

    // Exactly one signed batch, in intent order, with tags travelling with the
    // selected commitment.
    expect(test.commits).toHaveLength(1);
    const signed = test.commits[0]!;
    expect(signed.commitments).toHaveLength(count);
    expect(signed.tagLists).toHaveLength(count);
    for (let index = 0; index < count; index += 1) {
      expect(signed.commitments[index]!.contentHash).toBe(test.local[index]!.hash);
      expect(signed.commitments[index]!.signer).toBe(SIGNER);
      expect(signed.commitments[index]!.blockHeight).toBe(100n);
      expect(signed.commitments[index]!.prev).toBe(ZERO32);
      expect(signed.tagLists[index]).toEqual([tagToBytes32(`row${index}`)]);
    }

    // Item order and hashes are those of the stamped structs, not a gateway row.
    expect(result.items).toHaveLength(count);
    for (let index = 0; index < count; index += 1) {
      expect(result.items[index]!.cid).toBe(`bafy-item-${index}`);
      expect(result.items[index]!.commitmentHash).toBe(commitmentHash(signed.commitments[index]!));
    }

    expect(result.txHash).toBe(TX);
    expect(result.confirmed).toBe(true);
    expect(test.confirmCalls).toEqual([TX]);
  });

  it('keeps items aligned by index when the gateway reorders the build', async () => {
    const texts = ['alpha', 'beta', 'gamma'];
    const test = harness({
      texts,
      buildTransform: (commitments, tagLists) => ({
        commitments: [...commitments].reverse(),
        tagLists: [...tagLists].reverse(),
      }),
    });

    const result = await putMany(test.deps, {
      intents: intents(texts),
      tags: ['topic:order'],
      owner: OWNER,
      account: account(),
    });

    const signed = test.commits[0]!;
    for (let index = 0; index < texts.length; index += 1) {
      expect(signed.commitments[index]!.contentHash).toBe(test.local[index]!.hash);
      // Row tags follow the local intent, never the gateway's order.
      expect(signed.tagLists[index]).toEqual([tagToBytes32(`row${index}`)]);
      expect(result.items[index]!.cid).toBe(`bafy-item-${index}`);
    }
  });

  it('put stays a one-intent wrapper with the original result shape', async () => {
    const test = harness({ texts: ['single memory'] });

    const result = await put(test.deps, {
      text: 'single memory',
      tags: ['topic:single'],
      owner: OWNER,
      account: account(),
    });

    expect(Object.keys(result).sort()).toEqual(['cid', 'commitmentHash', 'confirmed', 'txHash']);
    expect(result.cid).toBe('bafy-item-0');
    expect(result.commitmentHash).toBe(commitmentHash(test.commits[0]!.commitments[0]!));
    expect(result.txHash).toBe(TX);
    expect(result.confirmed).toBe(true);
    expect(test.commits).toHaveLength(1);
    expect(test.buildCalls).toHaveLength(1);
  });
});

describe('putMany — aborts before signing', () => {
  it('fails DUPLICATE_COMMITMENT when a stage is already anchored, naming the item', async () => {
    const test = harness({ texts: ['first', 'already on chain'], statuses: ['staged', 'anchored'] });
    const error = await failureOf(
      putMany(test.deps, {
        intents: intents(['first', 'already on chain']),
        tags: [],
        owner: OWNER,
        account: account(),
      }),
    );

    expect(error.error.code).toBe('DUPLICATE_COMMITMENT');
    expect((error.error as { detail?: string }).detail).toContain('item 1');
    expect(test.stageCalls).toHaveLength(2);
    expect(test.buildCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });

  it('fails STAGING_BATCHED with the listable txHash when a stage is batched', async () => {
    const texts = ['first', 'already batched'];
    const test = harness({
      texts,
      statuses: ['staged', 'batched'],
      listRows: [
        row({ contentHash: `0x${'aa'.repeat(32)}`, txHash: UNKNOWN_TX }),
        // The matching row is found by contentHash + cidDigest, not by order.
        row({ contentHash: canonicalHash(texts[1]!), cidDigest: canonicalDigest(texts[1]!), txHash: TX }),
      ],
    });

    const error = await failureOf(
      putMany(test.deps, { intents: intents(texts), tags: [], owner: OWNER, account: account() }),
    );

    expect(error.error.code).toBe('STAGING_BATCHED');
    expect(error.error).toMatchObject({ contentHash: canonicalHash(texts[1]!), txHash: TX });
    expect((error.error as { detail?: string }).detail).toContain('item 1');
    expect(test.listCalls).toEqual([{ owner: OWNER, status: 'batched', limit: 100 }]);
    expect(test.buildCalls).toHaveLength(0);
    expect(test.commits).toHaveLength(0);
  });

  it('fails STAGING_BATCHED with a null txHash when the row is not listable', async () => {
    const texts = ['already batched'];
    const test = harness({ texts, statuses: ['batched'], listRows: [] });

    const error = await failureOf(
      putMany(test.deps, { intents: intents(texts), tags: [], owner: OWNER, account: account() }),
    );

    expect(error.error).toMatchObject({ code: 'STAGING_BATCHED', contentHash: canonicalHash(texts[0]!), txHash: null });
    expect((error.error as { detail?: string }).detail).toContain('confirm --tx-hash');
    expect(test.commits).toHaveLength(0);
  });

  it('fails SCHEMA_VIOLATION on an unknown stage status', async () => {
    const test = harness({ texts: ['mystery'], statuses: ['mystery'] });
    const error = await failureOf(
      putMany(test.deps, { intents: intents(['mystery']), tags: [], owner: OWNER, account: account() }),
    );

    expect(error.error.code).toBe('SCHEMA_VIOLATION');
    expect((error.error as { detail?: string }).detail).toContain('mystery');
    expect((error.error as { detail?: string }).detail).toContain('item 0');
    expect(test.commits).toHaveLength(0);
  });

  it('maps build NO_STAGED to STAGING_BATCHED with contentHash null', async () => {
    const test = harness({
      texts: ['a', 'b'],
      buildError: new LongstoneFailure({
        code: 'GATE_REJECTED',
        gateCode: 'NO_STAGED',
        detail: 'no staged memories for this capability',
      }),
    });

    const error = await failureOf(
      putMany(test.deps, {
        intents: intents(['a', 'b']),
        tags: [],
        owner: OWNER,
        account: account(),
      }),
    );

    expect(error.error).toMatchObject({ code: 'STAGING_BATCHED', contentHash: null, txHash: null });
    expect((error.error as { detail?: string }).detail).toContain('2 intent');
    expect(test.commits).toHaveLength(0);
  });

  it('rethrows a build error that is not NO_STAGED', async () => {
    const buildError = new LongstoneFailure({
      code: 'GATE_REJECTED',
      gateCode: 'INVALID_HASH',
      detail: 'bad hash',
    });
    const test = harness({ texts: ['a'], buildError });

    const caught = await failureOf(
      putMany(test.deps, { intents: intents(['a']), tags: [], owner: OWNER, account: account() }),
    );

    expect(caught).toBe(buildError);
    expect(test.commits).toHaveLength(0);
  });

  it('fails STAGED_ROW_MISSING when the build omits a locally staged row', async () => {
    const texts = ['a', 'b'];
    const test = harness({
      texts,
      buildTransform: (commitments, tagLists) => ({
        commitments: [
          commitments[0]!,
          commitment({ contentHash: `0x${'ee'.repeat(32)}`, cidDigest: `0x${'ff'.repeat(32)}` }),
        ],
        tagLists,
      }),
    });

    const error = await failureOf(
      putMany(test.deps, {
        intents: intents(texts),
        tags: [],
        owner: OWNER,
        account: account(),
      }),
    );

    expect(error.error.code).toBe('STAGED_ROW_MISSING');
    expect(test.commits).toHaveLength(0);
  });

  it('fails AMBIGUOUS_BATCH_ROW when the build returns the same row twice', async () => {
    const texts = ['a', 'b'];
    const test = harness({
      texts,
      buildTransform: (commitments) => ({
        commitments: [commitments[0]!, commitments[0]!],
        tagLists: [[], []],
      }),
    });

    const error = await failureOf(
      putMany(test.deps, {
        intents: intents(texts),
        tags: [],
        owner: OWNER,
        account: account(),
      }),
    );

    expect(error.error.code).toBe('AMBIGUOUS_BATCH_ROW');
    expect(test.commits).toHaveLength(0);
  });
});

describe('putMany — the prev pre-check does not swallow transport failures', () => {
  it('treats UNKNOWN_COMMITMENT from getCommitment as a missing predecessor', async () => {
    const test = harness({
      texts: ['child'],
      getCommitment: async () => {
        throw failure('UNKNOWN_COMMITMENT');
      },
    });

    const error = await failureOf(
      putMany(test.deps, {
        intents: intents(['child']),
        tags: [],
        prev: UNKNOWN_TX,
        owner: OWNER,
        account: account(),
      }),
    );

    expect(error.error).toEqual({ code: 'PREDECESSOR_UNKNOWN', which: 'prev' });
    expect(test.commitmentReads).toEqual([UNKNOWN_TX]);
    expect(test.commits).toHaveLength(0);
  });

  it('rethrows an RPC/transport failure from getCommitment', async () => {
    const transport = failure('RPC_UNAVAILABLE', { detail: 'rpc down' });
    const test = harness({
      texts: ['child'],
      getCommitment: async () => {
        throw transport;
      },
    });

    const caught = await failureOf(
      putMany(test.deps, {
        intents: intents(['child']),
        tags: [],
        prev: UNKNOWN_TX,
        owner: OWNER,
        account: account(),
      }),
    );

    expect(caught).toBe(transport);
    expect(caught.error.code).toBe('RPC_UNAVAILABLE');
    expect(test.commits).toHaveLength(0);
  });

  it('treats a zero-filled commitment as a missing predecessor', async () => {
    const test = harness({
      texts: ['child'],
      getCommitment: async () => commitment({ contentHash: ZERO32, cidDigest: ZERO32 }),
    });

    const error = await failureOf(
      putMany(test.deps, {
        intents: intents(['child']),
        tags: [],
        prev: UNKNOWN_TX,
        owner: OWNER,
        account: account(),
      }),
    );

    expect(error.error.code).toBe('PREDECESSOR_UNKNOWN');
    expect(test.commits).toHaveLength(0);
  });

  it('does not read getCommitment for the zero root', async () => {
    const test = harness({ texts: ['root'] });
    await putMany(test.deps, {
      intents: intents(['root']),
      tags: [],
      owner: OWNER,
      account: account(),
    });
    expect(test.commitmentReads).toHaveLength(0);
  });
});

describe('putMany — receipt and confirm recovery (F2)', () => {
  it('raises TX_REVERTED instead of a recoverable result when the receipt reverted', async () => {
    const test = harness({ texts: ['reverts'], receiptStatus: 'reverted' });
    const error = await failureOf(
      putMany(test.deps, { intents: intents(['reverts']), tags: [], owner: OWNER, account: account() }),
    );

    expect(error.error).toEqual({ code: 'TX_REVERTED', txHash: TX });
    expect(test.confirmCalls).toHaveLength(0);
  });

  it('retries a confirm 429 and reports confirmed when the retry anchors', async () => {
    let attempts = 0;
    const test = harness({
      texts: ['retry'],
      confirm: async () => {
        attempts += 1;
        if (attempts <= 2) {
          throw new LongstoneFailure({
            code: 'GATE_REJECTED',
            gateCode: 'RATE_LIMITED',
            detail: 'slow down',
            httpStatus: 429,
          });
        }
        return { status: 'anchored' };
      },
    });

    const result = await putMany(test.deps, {
      intents: intents(['retry']),
      tags: [],
      owner: OWNER,
      account: account(),
    });

    expect(attempts).toBe(3);
    expect(result.confirmed).toBe(true);
    expect(result.txHash).toBe(TX);
  });

  it('returns confirmed:false with the txHash when retries are exhausted', async () => {
    let attempts = 0;
    const test = harness({
      texts: ['broadcast'],
      confirm: async () => {
        attempts += 1;
        throw new LongstoneFailure({
          code: 'GATE_REJECTED',
          gateCode: 'RPC_UNAVAILABLE',
          detail: 'upstream 429',
          httpStatus: 503,
        });
      },
    });

    const result = await putMany(test.deps, {
      intents: intents(['broadcast']),
      tags: [],
      owner: OWNER,
      account: account(),
    });

    expect(attempts).toBe(3);
    expect(result.confirmed).toBe(false);
    expect(result.txHash).toBe(TX);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.cid).toBe('bafy-item-0');
  });

  it.each(['CONTENT_NOT_FOUND', 'UNKNOWN_TX'])(
    'rethrows a non-retryable confirm %s instead of disguising it',
    async (gateCode) => {
      const test = harness({
        texts: ['broadcast'],
        confirm: async () => {
          throw new LongstoneFailure({
            code: 'GATE_REJECTED',
            gateCode,
            detail: 'not found',
            httpStatus: 404,
          });
        },
      });

      const error = await failureOf(
        putMany(test.deps, {
          intents: intents(['broadcast']),
          tags: [],
          owner: OWNER,
          account: account(),
        }),
      );

      expect(error.error).toMatchObject({ code: 'GATE_REJECTED', gateCode });
      expect(test.confirmCalls).toHaveLength(1);
    },
  );

  it('treats a pending 202 as terminal for putMany', async () => {
    const test = harness({
      texts: ['pending'],
      confirm: async () => ({ status: 'pending', retryAfter: 5 }),
    });

    const result = await putMany(test.deps, {
      intents: intents(['pending']),
      tags: [],
      owner: OWNER,
      account: account(),
    });

    expect(result.confirmed).toBe(false);
    expect(result.txHash).toBe(TX);
    expect(test.confirmCalls).toHaveLength(1);
  });
});

describe('confirmWithRetry — bounded backoff on transport failures only', () => {
  const input = { owner: OWNER, txHash: TX };
  const gateWith = (confirm: GateClient['confirm']): GateClient =>
    ({ confirm }) as unknown as GateClient;

  it('retries GATE_UNREACHABLE and returns the eventual outcome', async () => {
    let calls = 0;
    const gate = gateWith(async () => {
      calls += 1;
      if (calls === 1) throw failure('GATE_UNREACHABLE', { detail: 'fetch failed' });
      return { status: 'anchored' };
    });

    const outcome = await confirmWithRetry(gate, input, { baseMs: 0 });
    expect(outcome.status).toBe('anchored');
    expect(calls).toBe(2);
  });

  it('stops after the attempt budget and rethrows the last failure', async () => {
    let calls = 0;
    const failure503 = new LongstoneFailure({
      code: 'GATE_REJECTED',
      httpStatus: 503,
      detail: 'HTTP 503',
    });
    const gate = gateWith(async () => {
      calls += 1;
      throw failure503;
    });

    const caught = await failureOf(confirmWithRetry(gate, input, { attempts: 2, baseMs: 0 }));
    expect(caught).toBe(failure503);
    expect(calls).toBe(2);
  });

  it('does not retry a pending 202', async () => {
    let calls = 0;
    const gate = gateWith(async () => {
      calls += 1;
      return { status: 'pending' };
    });

    const outcome = await confirmWithRetry(gate, input, { baseMs: 0 });
    expect(outcome.status).toBe('pending');
    expect(calls).toBe(1);
  });

  it('classifies retryable and terminal failures by status and gate code', () => {
    const retryable: LongstoneError[] = [
      { code: 'GATE_UNREACHABLE', detail: 'timeout' },
      { code: 'GATE_REJECTED', httpStatus: 429 },
      { code: 'GATE_REJECTED', httpStatus: 500 },
      { code: 'GATE_REJECTED', httpStatus: 503 },
      { code: 'GATE_REJECTED', gateCode: 'RATE_LIMITED' },
      { code: 'GATE_REJECTED', gateCode: 'RPC_UNAVAILABLE' },
      { code: 'GATE_REJECTED', gateCode: 'GATEWAY_UPSTREAM' },
      { code: 'GATE_REJECTED', gateCode: 'INTERNAL' },
    ];
    for (const error of retryable) {
      expect(isRetryableConfirmError(new LongstoneFailure(error)), JSON.stringify(error)).toBe(true);
    }

    const terminal: LongstoneError[] = [
      { code: 'GATE_REJECTED', gateCode: 'CONTENT_NOT_FOUND', httpStatus: 404 },
      { code: 'GATE_REJECTED', gateCode: 'UNKNOWN_TX', httpStatus: 404 },
      { code: 'GATE_REJECTED', gateCode: 'INVALID_HASH', httpStatus: 400 },
      { code: 'INTERNAL_ERROR', detail: 'client bug' },
      { code: 'UNKNOWN_COMMITMENT' },
    ];
    for (const error of terminal) {
      expect(isRetryableConfirmError(new LongstoneFailure(error)), JSON.stringify(error)).toBe(false);
    }
    expect(isRetryableConfirmError(new Error('plain'))).toBe(false);
  });
});

describe('new typed errors stay actionable', () => {
  it('STAGING_BATCHED states the recovery path and appends path-specific detail', () => {
    const base = describeError({ code: 'STAGING_BATCHED', contentHash: null, txHash: null });
    expect(base).toContain('wait for the staging TTL');
    expect(base).toContain('confirm --tx-hash');

    const withDetail = describeError({
      code: 'STAGING_BATCHED',
      contentHash: null,
      txHash: null,
      detail: 'batch of 2 intents was reclaimed',
    });
    expect(withDetail).toContain('batch of 2 intents was reclaimed');
  });

  it('TX_REVERTED names the transaction', () => {
    expect(describeError({ code: 'TX_REVERTED', txHash: TX })).toContain(TX);
  });

  it('DUPLICATE_COMMITMENT keeps its old text and only appends a detail when present', () => {
    expect(describeError({ code: 'DUPLICATE_COMMITMENT' })).toBe('DUPLICATE_COMMITMENT');
    expect(
      describeError({ code: 'DUPLICATE_COMMITMENT', detail: 'item 1 is already anchored' }),
    ).toContain('item 1 is already anchored');
  });
});

/** Content-derived values for a text, used to build matching list rows. */
function canonicalHash(text: string): `0x${string}` {
  return contentHash(parseMemoryContent({ text, format: 'text.v0' }));
}

function canonicalDigest(text: string): `0x${string}` {
  const content = parseMemoryContent({ text, format: 'text.v0' });
  return cidDigest(canonicalBytes(content));
}
