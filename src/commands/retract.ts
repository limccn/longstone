/**
 * `retract` — tombstone or replace (design §2, menhir §2.6).
 *
 * Idempotent by contract: a second retract is a silent no-op on chain. longstone
 * reports that as a no-op result rather than an error, because turning it into
 * an error would break scripted reruns (M1-5).
 */

import type { PrivateKeyAccount } from 'viem/accounts';

import type { RegistryClient } from '../registry.js';
import { fail } from '../errors.js';

export interface RetractOptions {
  commitmentHash: `0x${string}`;
  replacedBy?: `0x${string}`;
  account: PrivateKeyAccount;
}

export interface RetractResult {
  txHash: `0x${string}`;
  replacedBy: `0x${string}` | null;
}

const ZERO32 = `0x${'0'.repeat(64)}` as const;

export async function retract(
  deps: { registry: RegistryClient },
  options: RetractOptions,
): Promise<RetractResult> {
  const replacedBy = options.replacedBy ?? ZERO32;

  // Pre-check existence so a typo costs no gas; the contract still enforces it.
  const existing = await deps.registry.getCommitment(options.commitmentHash);
  if (existing.contentHash === ZERO32) {
    fail({ code: 'UNKNOWN_COMMITMENT' });
  }

  const txHash = await deps.registry.retract(options.commitmentHash, replacedBy, options.account);

  return { txHash, replacedBy: replacedBy === ZERO32 ? null : replacedBy };
}
