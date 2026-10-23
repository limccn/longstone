/**
 * `put-batch` — one capability, one build, one signature, one transaction.
 *
 * The gateway already binds staged rows to a client-generated capability and
 * `MAX_BATCH = 64`; the contract's `commitBatch` is already an array API. This
 * command composes the existing primitives so N memories cost one transaction:
 *
 *   1. canonicalize and hash every text locally (this is what may be signed);
 *   2. generate ONE capability for the batch;
 *   3. stage every item under it; any status other than `staged` aborts before
 *      a signature — no gas is spent on a batch that cannot complete;
 *   4. build once, select every local commitment exactly once (H-1);
 *   5. stamp all rows once (same `prev`, default the zero root — rows are NOT
 *      auto-chained to each other inside a batch);
 *   6. sign once, broadcast once, wait for one receipt;
 *   7. confirm once (with bounded F2 retries).
 *
 * Per-item verify is deliberately NOT embedded: the result carries every
 * `cid`/`commitmentHash`, and the acceptance run verifies each. Embedding it
 * would add N gateway fetches to every write and a second failure mode after a
 * successful anchor.
 *
 * An abort after some stages leaves those earlier rows staged until the gateway
 * TTL; v1 has no cancel endpoint. The error names the failing item.
 */

import { randomBytes } from 'node:crypto';

import {
  canonicalBytes,
  cidDigest,
  commitmentHash,
  contentHash,
  parseMemoryContent,
} from '@limccn/menhir-core';
import type { PrivateKeyAccount } from 'viem/accounts';

import { selectLocalCommitments } from '../batch.js';
import type { LongstoneConfig } from '../config.js';
import { confirmWithRetry, isRetryableConfirmError } from '../confirm.js';
import { fail, LongstoneFailure } from '../errors.js';
import type { BuiltResponse, GateClient } from '../gate.js';
import type { RegistryClient } from '../registry.js';
import { waitForReceipt } from '../registry.js';
import { stampCommitments } from '../stamp.js';

export interface PutIntent {
  text: string;
}

export interface PutBatchOptions {
  /** 1..64 texts; a batch shares one owner, one tag list and one capability. */
  intents: PutIntent[];
  /** Shared by every item in v1 (per-item tags are out of scope). */
  tags: string[];
  /** Applied to every row; rows are not chained to each other. */
  prev?: `0x${string}`;
  owner: `0x${string}`;
  account: PrivateKeyAccount;
}

export interface PutBatchResult {
  /** Same order as `options.intents`; each item is verifiable on its own. */
  items: Array<{ cid: string; commitmentHash: `0x${string}` }>;
  txHash: `0x${string}`;
  confirmed: boolean;
}

export interface PutDeps {
  config: LongstoneConfig;
  gate: GateClient;
  registry: RegistryClient;
  /** Receipt polling is bounded; longstone owns the retry loop (D-10). */
  waitForReceipt?: typeof waitForReceipt;
}

const MAX_BATCH = 64;
const ZERO32 = `0x${'0'.repeat(64)}` as const;

function sameHex(value: string | null | undefined, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

/**
 * Best-effort recovery of the transaction that already carries a `batched` row.
 * `StagedResponse` has no txHash, so the bounded list page is the only place
 * that can supply one. A list failure must not hide the staging error.
 */
async function batchedTxHash(
  gate: GateClient,
  owner: `0x${string}`,
  contentHashValue: `0x${string}`,
  cidDigestValue: `0x${string}`,
): Promise<`0x${string}` | null> {
  try {
    const rows = await gate.list({ owner, status: 'batched', limit: 100 });
    const match = rows.find(
      (row) =>
        sameHex(row.contentHash, contentHashValue) && sameHex(row.cidDigest, cidDigestValue),
    );
    return match?.txHash ?? null;
  } catch {
    return null;
  }
}

/**
 * The shared batch core. `put` calls it with one intent, so the staging, build,
 * selection, stamping and broadcast logic exists exactly once.
 */
export async function putMany(deps: PutDeps, options: PutBatchOptions): Promise<PutBatchResult> {
  const { config, gate, registry } = deps;
  const { intents } = options;

  // 0. Validate before creating a capability: a rejected batch must not leave
  //    staged rows behind. Duplicates are detected by contentHash (canonical
  //    text), not by raw string equality.
  if (intents.length < 1 || intents.length > MAX_BATCH) {
    fail({ code: 'INVALID_BATCH_SIZE' });
  }

  const contents = intents.map((intent) =>
    parseMemoryContent({ text: intent.text, format: 'text.v0' }),
  );
  const hashes = contents.map((content) => contentHash(content));
  const digests = contents.map((content) => cidDigest(canonicalBytes(content)));

  const seen = new Map<string, number>();
  for (let index = 0; index < hashes.length; index += 1) {
    const key = hashes[index]!.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      fail({
        code: 'SCHEMA_VIOLATION',
        detail: `intent ${index} duplicates intent ${first} (same contentHash ${hashes[index]!})`,
      });
    }
    seen.set(key, index);
  }

  // 1. ONE capability for the whole batch. It is a 128-bit session token; never
  //    logged or persisted.
  const capability = randomBytes(16).toString('hex');
  const tags = options.tags;
  const cids: string[] = [];

  // 2. Stage every item. Any non-`staged` status aborts before any signature.
  for (let index = 0; index < intents.length; index += 1) {
    const staged = await gate.stage({
      owner: options.owner,
      content: contents[index]!,
      contentHash: hashes[index]!,
      tags,
      capability,
    });

    if (staged.status === 'staged') {
      cids.push(staged.cid);
      continue;
    }
    if (staged.status === 'anchored') {
      fail({
        code: 'DUPLICATE_COMMITMENT',
        detail: `item ${index} is already anchored on chain; it must not be signed again`,
      });
    }
    if (staged.status === 'batched') {
      const txHash = await batchedTxHash(gate, options.owner, hashes[index]!, digests[index]!);
      fail({
        code: 'STAGING_BATCHED',
        contentHash: hashes[index]!,
        txHash,
        detail:
          `item ${index} is already in a batch` +
          (txHash === null
            ? '; its original transaction was not in the first 100 batched rows — locate it, then run `longstone confirm --tx-hash <hash>`'
            : `; confirm it with \`longstone confirm --tx-hash ${txHash}\``),
      });
    }
    fail({
      code: 'SCHEMA_VIOLATION',
      detail: `unexpected stage status ${staged.status} for item ${index}`,
    });
  }

  // 3. Build once. If every stage said `staged` and the build still finds
  //    nothing, the rows were reclaimed into another batch (gateway TTL); map
  //    the gateway's bare NO_STAGED to the explanatory code and rethrow
  //    everything else.
  let built: BuiltResponse;
  try {
    built = await gate.build({ owner: options.owner, capability });
  } catch (error) {
    if (
      error instanceof LongstoneFailure &&
      error.error.code === 'GATE_REJECTED' &&
      error.error.gateCode === 'NO_STAGED'
    ) {
      fail({
        code: 'STAGING_BATCHED',
        contentHash: null,
        txHash: null,
        detail:
          `build returned no staged rows for a batch of ${intents.length} intent(s) after every ` +
          'stage replied staged; the rows were reclaimed into another batch — wait for the ' +
          'staging TTL or run `longstone confirm --tx-hash` with the original transaction',
      });
    }
    throw error;
  }

  // 4. Select ONLY what this client computed. Missing/ambiguous/duplicate rows
  //    fail here, before stamping. The selected order matches the intent order.
  const selected = selectLocalCommitments(
    built,
    intents.map((_, index) => ({
      owner: options.owner,
      contentHash: hashes[index]!,
      cidDigest: digests[index]!,
    })),
  );

  // 5. Stamp all rows with one context. A non-zero `prev` must exist; only a
  //    typed UNKNOWN_COMMITMENT means "missing" — an RPC/transport failure is
  //    rethrown so a duplicate predecessor cannot reach signing.
  const blockHeight = await registry.blockNumber();
  const prev = options.prev ?? ZERO32;
  if (prev !== ZERO32) {
    const existing = await registry.getCommitment(prev).catch((error: unknown) => {
      if (error instanceof LongstoneFailure && error.error.code === 'UNKNOWN_COMMITMENT') {
        return null;
      }
      throw error;
    });
    if (existing === null || existing.contentHash === ZERO32) {
      fail({ code: 'PREDECESSOR_UNKNOWN', which: 'prev' });
    }
  }

  const stamped = stampCommitments(
    selected.map((entry) => entry.commitment),
    { signer: options.account.address, blockHeight, prev },
  );
  const tagLists = selected.map((entry) => entry.tags);

  // 6. One signature, one broadcast, one receipt.
  const txHash = await registry.commitBatch(stamped, tagLists, options.account);
  const wait = deps.waitForReceipt ?? waitForReceipt;
  const receipt = await wait(config, txHash);

  // A reverted receipt is final. It is NOT the recoverable confirm failure.
  if (receipt.status !== 'success') {
    fail({ code: 'TX_REVERTED', txHash });
  }

  // 7. Confirm once (F2 retries inside the helper). Only an exhausted transport
  //    failure becomes a recoverable result: the write happened, so the txHash
  //    and every item must survive. Terminal gateway/contract errors rethrow.
  let confirmed = false;
  try {
    const outcome = await confirmWithRetry(gate, { owner: options.owner, txHash });
    confirmed = outcome.status === 'anchored';
  } catch (error) {
    if (!isRetryableConfirmError(error)) throw error;
    process.stderr.write(
      `warning: transaction ${txHash} was broadcast and mined, but gateway confirmation ` +
        `did not complete. The write is recoverable: longstone confirm --tx-hash ${txHash}\n`,
    );
  }

  return {
    items: selected.map((_, index) => ({
      cid: cids[index]!,
      // The hash of the STAMPED struct — the one that actually anchored.
      commitmentHash: commitmentHash(stamped[index]!),
    })),
    txHash,
    confirmed,
  };
}
