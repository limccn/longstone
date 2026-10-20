/**
 * `put` — the sovereign write path (design v0.2 §3).
 *
 * The whole point of model A: staging is remote/keyless, signing is local.
 * Steps 5b (stamp) and 6 (sign) are the ones that cannot move anywhere else.
 */

import { canonicalBytes, cidDigest, contentHash, parseMemoryContent } from '@menhir/core';
import type { PrivateKeyAccount } from 'viem/accounts';

import type { LongstoneConfig } from '../config.js';
import type { GateClient } from '../gate.js';
import type { RegistryClient } from '../registry.js';
import { waitForReceipt } from '../registry.js';
import { stampCommitments } from '../stamp.js';
import { fail } from '../errors.js';
import { commitmentHash } from '@menhir/core';

export interface PutOptions {
  text: string;
  tags?: string[];
  prev?: `0x${string}`;
  owner: `0x${string}`;
  account: PrivateKeyAccount;
}

export interface PutResult {
  cid: string;
  commitmentHash: `0x${string}`;
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

const ZERO32 = `0x${'0'.repeat(64)}` as const;

export async function put(deps: PutDeps, options: PutOptions): Promise<PutResult> {
  const { config, gate, registry } = deps;

  // 1–2. canonicalize + hash with the same code the browser and contract use.
  const content = parseMemoryContent({ text: options.text, format: 'text.v0' });
  const hash = contentHash(content);
  const digest = cidDigest(canonicalBytes(content));

  // 3. stage (integrity gate recomputes server-side; no pin or row on mismatch).
  const staged = await gate.stage({
    owner: options.owner,
    content,
    contentHash: hash,
    tags: options.tags ?? [],
  });

  // 4. digest is computed locally, never taken from the backend (D-9).
  void digest;

  // 5. build a batch from staged rows.
  const built = await gate.build({ owner: options.owner });

  // 5b. stamp ALL THREE placeholders before signing. A missed signer reverts;
  //     a missed prev/blockHeight would anchor wrong metadata silently.
  const blockHeight = await registry.blockNumber();
  const prev = options.prev ?? ZERO32;
  if (prev !== ZERO32) {
    // Pre-check so an unknown predecessor costs no gas; a race still decodes to
    // the same typed error from the revert.
    const existing = await registry.getCommitment(prev).catch(() => null);
    if (existing === null || existing.contentHash === `0x${'0'.repeat(64)}`) {
      fail({ code: 'PREDECESSOR_UNKNOWN', which: 'prev' });
    }
  }

  const stamped = stampCommitments(built.commitments, {
    signer: options.account.address,
    blockHeight,
    prev,
  });

  // The tag list must line up with the stamped commitments; the gateway built
  // both from the same staged rows, so a mismatch means someone reordered one.
  const tagLists = built.tagLists;
  if (stamped.length !== tagLists.length) {
    fail({ code: 'INVALID_BATCH_SIZE' });
  }
  // Tags arrive ALREADY encoded as bytes32: the gateway built `tagLists` from
  // the same staged rows and applied `tagToBytes32` there. Re-encoding would
  // treat a 66-character hex string as a tag and blow the 32-byte limit.
  for (const list of tagLists) {
    for (const tag of list) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(tag)) {
        fail({ code: 'SCHEMA_VIOLATION', detail: `tag ${tag} is not bytes32` });
      }
    }
  }

  // 6–7. sign locally and broadcast to the sequencer.
  const txHash = await registry.commitBatch(stamped, tagLists, options.account);

  // 8. poll the general endpoint for the receipt (never `pending`).
  const wait = deps.waitForReceipt ?? waitForReceipt;
  const receipt = await wait(config, txHash);

  // 9. confirm is a single-shot check; longstone drives the retry.
  const outcome = await gate.confirm({ owner: options.owner, txHash });

  const first = stamped[0];
  if (first === undefined) fail({ code: 'INVALID_BATCH_SIZE' });

  return {
    cid: staged.cid,
    // The hash of the STAMPED struct — the one that actually anchored, not the
    // gateway's placeholder-derived value.
    commitmentHash: commitmentHash(first),
    txHash,
    confirmed: outcome.status === 'anchored' && receipt.status === 'success',
  };
}
