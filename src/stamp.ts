/**
 * Placeholder stamping (design v0.2 §3, P0-1/R2).
 *
 * The gateway is keyless, so `build` returns commitments with
 * `prev = 0`, `blockHeight = 0`, `signer = 0x0`. Before signing, longstone must
 * overwrite **all three**:
 *
 *   signer      ← the address of LONGSTONE_KEY   (contract: c.signer == msg.sender)
 *   blockHeight ← block.number at sign time      (contract: <= block.number + 1)
 *   prev        ← the caller's predecessor, or 0
 *
 * A missed `signer` reverts loudly (`SignerMismatch`); a missed `blockHeight` or
 * `prev` would anchor wrong metadata silently, which is worse. That asymmetry is
 * why this is a function with tests rather than three inline assignments.
 */

import type { Commitment } from '@menhir/core';

export interface StampContext {
  signer: `0x${string}`;
  blockHeight: bigint;
  /** Applied to every row of this batch (single-memory puts pass one value). */
  prev: `0x${string}`;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as const;
const ZERO32 = `0x${'0'.repeat(64)}` as const;

/** True when a commitment still carries the gateway's placeholders. */
export function needsStamping(commitment: Commitment): boolean {
  return (
    commitment.signer.toLowerCase() === ZERO_ADDRESS ||
    commitment.blockHeight === 0n ||
    commitment.prev === ZERO32
  );
}

/**
 * Return stamped copies. Pure: the gateway's structs are never mutated, so the
 * hash longstone computes is provably the stamped one.
 */
export function stampCommitments(
  commitments: readonly Commitment[],
  context: StampContext,
): Commitment[] {
  if (!/^0x[0-9a-fA-F]{40}$/.test(context.signer) || context.signer.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('stamp requires a real signer address, not a placeholder');
  }
  if (context.blockHeight <= 0n) {
    throw new Error('stamp requires a positive blockHeight');
  }

  return commitments.map((commitment) => {
    // M1 accepts only op = 0. The contract reverts on anything else, so a
    // non-zero op reaching broadcast wastes gas on a simulation that was going
    // to fail — but more importantly, this is the seam where M3's derive op
    // will land, and the check should move then rather than be rediscovered.
    if (commitment.op !== 0) {
      throw new Error(`unsupported op ${commitment.op}: M1 anchors puts only`);
    }
    return {
      ...commitment,
      signer: context.signer,
      blockHeight: context.blockHeight,
      prev: context.prev,
    };
  });
}
