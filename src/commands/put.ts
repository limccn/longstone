/**
 * `put` — the sovereign write path (design v0.2 §3).
 *
 * The whole point of model A: staging is remote/keyless, signing is local.
 * Steps 5b (stamp) and 6 (sign) are the ones that cannot move anywhere else.
 */

import { randomBytes } from 'node:crypto';

import { canonicalBytes, cidDigest, contentHash, parseMemoryContent } from '@limccn/menhir-core';
import type { PrivateKeyAccount } from 'viem/accounts';

import { selectLocalCommitments } from '../batch.js';
import type { LongstoneConfig } from '../config.js';
import type { GateClient } from '../gate.js';
import type { RegistryClient } from '../registry.js';
import { waitForReceipt } from '../registry.js';
import { stampCommitments } from '../stamp.js';
import { fail } from '../errors.js';
import { commitmentHash } from '@limccn/menhir-core';

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

  // A 128-bit session token for this staging call, generated locally. The
  // gateway binds the row to it (scoped to its deployment) and only a build
  // presenting it can select the row. It is never logged or persisted.
  const capability = randomBytes(16).toString('hex');

  // 3. stage (integrity gate recomputes server-side; no pin or row on mismatch).
  const staged = await gate.stage({
    owner: options.owner,
    content,
    contentHash: hash,
    tags: options.tags ?? [],
    capability,
  });

  // 4. digest is computed locally, never taken from the backend (D-9); it is
  //    part of the intent used to select what may be signed.
  // 5. build the batch for this capability.
  const built = await gate.build({ owner: options.owner, capability });

  // 5a. Select ONLY the commitment this client computed. The gateway may have
  //     returned rows for other actors (or reordered/dropped ours); signing
  //     anything else is the H-1 cross-tenant injection.
  const selection = selectLocalCommitments(built, [
    { owner: options.owner, contentHash: hash, cidDigest: digest },
  ]);
  const selected = selection[0];
  if (selected === undefined) fail({ code: 'INVALID_BATCH_SIZE' });

  // 5b. stamp THE selected commitment before signing. A missed signer reverts;
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

  const stamped = stampCommitments([selected.commitment], {
    signer: options.account.address,
    blockHeight,
    prev,
  });

  // The tag list must line up with the stamped commitment; batch selection
  // already validated the bytes32 shape and kept the pairing by index.
  const tagLists = [selected.tags];

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
    // The hash of the STAMPED struct — the one that actually anchored, and the
    // one selected from the local intent, not `stamped[0]` of a gateway batch.
    commitmentHash: commitmentHash(first),
    txHash,
    confirmed: outcome.status === 'anchored' && receipt.status === 'success',
  };
}
