/**
 * `put` — the sovereign write path (design v0.2 §3).
 *
 * The whole point of model A: staging is remote/keyless, signing is local.
 * Steps 5b (stamp) and 6 (sign) are the ones that cannot move anywhere else.
 *
 * This is a one-intent wrapper over `putMany`: the staging, build, selection,
 * stamping, broadcast and confirm-recovery logic exists exactly once, and the
 * result keeps the original single-memory shape.
 */

import type { PrivateKeyAccount } from 'viem/accounts';

import { fail } from '../errors.js';
import { putMany, type PutDeps } from './put-batch.js';

export type { PutDeps };

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

export async function put(deps: PutDeps, options: PutOptions): Promise<PutResult> {
  const batch = await putMany(deps, {
    intents: [{ text: options.text }],
    tags: options.tags ?? [],
    ...(options.prev === undefined ? {} : { prev: options.prev }),
    owner: options.owner,
    account: options.account,
  });

  const first = batch.items[0];
  if (first === undefined) fail({ code: 'INVALID_BATCH_SIZE' });

  return {
    cid: first.cid,
    commitmentHash: first.commitmentHash,
    txHash: batch.txHash,
    confirmed: batch.confirmed,
  };
}
