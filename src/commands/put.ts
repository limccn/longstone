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

import { parseAgentRef, type AgentRef } from '../agent-ref.js';
import { fail } from '../errors.js';
import { putMany, type PutDeps } from './put-batch.js';

export type { PutDeps };

export interface PutOptions {
  text: string;
  tags?: string[];
  prev?: `0x${string}`;
  owner: `0x${string}`;
  account: PrivateKeyAccount;
  /** Optional ERC-8004 identity pointer, stored at `MemoryContent.meta.agent`. */
  agent?: AgentRef;
}

export interface PutResult {
  cid: string;
  commitmentHash: `0x${string}`;
  txHash: `0x${string}`;
  confirmed: boolean;
  /** The identity reference anchored in `meta.agent`, or null when omitted. */
  agent: AgentRef | null;
}

export async function put(deps: PutDeps, options: PutOptions): Promise<PutResult> {
  // Validate before putMany creates a capability, so a bad ref costs no pin
  // and no gas. The returned copy is also what the caller gets echoed back.
  const agent = options.agent === undefined ? null : parseAgentRef(options.agent);

  const batch = await putMany(deps, {
    intents: [{ text: options.text }],
    tags: options.tags ?? [],
    ...(options.prev === undefined ? {} : { prev: options.prev }),
    owner: options.owner,
    account: options.account,
    ...(agent === null ? {} : { agent }),
  });

  const first = batch.items[0];
  if (first === undefined) fail({ code: 'INVALID_BATCH_SIZE' });

  return {
    cid: first.cid,
    commitmentHash: first.commitmentHash,
    txHash: batch.txHash,
    confirmed: batch.confirmed,
    agent,
  };
}
