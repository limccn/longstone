/**
 * Confirm recovery (F2).
 *
 * `gate.confirm` is a read of the gateway's post-confirm state; it is not the
 * broadcast. A transport failure there must not turn an already-mined write into
 * a failed write, and a 429/5xx is worth retrying with bounded backoff instead
 * of asking the operator to replay the whole staging flow.
 *
 * What is retried is deliberately narrow:
 *
 *   - `GATE_UNREACHABLE` — fetch rejected, including runtime/undici timeouts;
 *   - `GATE_REJECTED` answered with 429 or any 5xx, JSON or not (the status is
 *     mapped by `gate.ts` before it reaches here);
 *   - gateway codes that mean "try later": RATE_LIMITED, RPC_UNAVAILABLE,
 *     GATEWAY_UPSTREAM, INTERNAL.
 *
 * Everything else — CONTENT_NOT_FOUND, UNKNOWN_TX, other 4xx, contract errors,
 * INTERNAL_ERROR — is terminal. A gateway or programming bug must not be
 * disguised as "confirmed later".
 */

import { LongstoneFailure, type LongstoneError } from './errors.js';
import type { ConfirmOutcome, GateClient } from './gate.js';

export interface ConfirmRetryOptions {
  /** Total attempts, including the first call. */
  attempts?: number;
  /** First backoff; doubles per retry (250 → 500 → 1000 ms). */
  baseMs?: number;
}

const RETRYABLE_GATE_CODES = new Set(['RATE_LIMITED', 'RPC_UNAVAILABLE', 'GATEWAY_UPSTREAM', 'INTERNAL']);

/** True when the failure is a transport-style outage worth retrying. */
export function isRetryableConfirmError(error: unknown): boolean {
  if (!(error instanceof LongstoneFailure)) return false;
  const typed: LongstoneError = error.error;

  if (typed.code === 'GATE_UNREACHABLE') return true;
  if (typed.code !== 'GATE_REJECTED') return false;

  if (typed.httpStatus === 429 || (typed.httpStatus !== undefined && typed.httpStatus >= 500)) {
    return true;
  }
  return typed.gateCode !== undefined && RETRYABLE_GATE_CODES.has(typed.gateCode);
}

/**
 * Call `gate.confirm` with bounded backoff. A `pending` outcome (202) is a
 * successful call and returns immediately; the caller decides whether to poll.
 */
export async function confirmWithRetry(
  gate: GateClient,
  input: { owner: `0x${string}`; txHash: `0x${string}` },
  options: ConfirmRetryOptions = {},
): Promise<ConfirmOutcome> {
  const attempts = options.attempts ?? 3;
  const baseMs = options.baseMs ?? 250;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await gate.confirm(input);
    } catch (error) {
      const lastAttempt = attempt === attempts - 1;
      if (!isRetryableConfirmError(error) || lastAttempt) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** attempt));
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('confirmWithRetry exhausted without an outcome');
}
