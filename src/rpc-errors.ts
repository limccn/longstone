/**
 * Honest classification of errors coming out of viem (F5).
 *
 * The distinction that matters to a caller is which response is correct:
 *
 *   transport → the RPC/provider is unwell; retry with backoff
 *   contract  → the chain answered with a decoded revert; map it to its code
 *   internal  → the CLIENT is wrong (bad encoding, bad args, bug); fix the call
 *
 * Before this module, `registry.translate` labelled everything that was not a
 * `BaseError` as `RPC_UNAVAILABLE`, so a missing field in a one-off script was
 * reported as an outage and troubleshooting went the wrong way twice.
 *
 * Transport detection is a CLASS allowlist, never message-text matching: the
 * package forbids numeric matching without word boundaries (a block number
 * `48314429` contains `429`), and viem class names are stable API.
 *
 * This module is imported by both `registry.ts` and `indexer.ts`; it lives
 * outside both so the indexer does not have to import the registry client.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InternalRpcError,
  LimitExceededRpcError,
  ResourceUnavailableRpcError,
  SocketClosedError,
  TimeoutError,
  UnknownRpcError,
  WebSocketRequestError,
} from 'viem';

import {
  LongstoneFailure,
  errorDetail,
  fail,
  fromContractError,
  type LongstoneError,
} from './errors.js';

export type ClassifiedError =
  | { kind: 'contract'; name: string; args: readonly unknown[] | undefined }
  | { kind: 'transport'; detail: string }
  | { kind: 'internal'; detail: string };

/**
 * Transport failures: the request did not get a usable answer from the
 * provider. `HttpRequestError` 4xx (other than 429) is deliberately NOT here —
 * a malformed or unauthorized request is a client/config bug.
 */
function isTransportFailure(error: BaseError): boolean {
  // `walk` visits the error itself AND its cause chain, so a failure wrapped in
  // `ContractFunctionExecutionError`/`CallExecutionError` is still recognized.
  return (
    error.walk((e) => {
      if (e instanceof HttpRequestError) {
        const status = e.status;
        return status === undefined || status === 429 || status >= 500;
      }
      return (
        e instanceof TimeoutError ||
        e instanceof SocketClosedError ||
        e instanceof WebSocketRequestError ||
        e instanceof LimitExceededRpcError ||
        e instanceof ResourceUnavailableRpcError ||
        e instanceof InternalRpcError ||
        e instanceof UnknownRpcError
      );
    }) !== null
  );
}

/** Pure: never throws, never touches the network. */
export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return {
        kind: 'contract',
        name: reverted.data?.errorName ?? 'unknown',
        args: reverted.data?.args,
      };
    }
    if (isTransportFailure(error)) return { kind: 'transport', detail: error.message };
  }
  return { kind: 'internal', detail: errorDetail(error) };
}

/** Map a classification onto the typed union. */
export function classifyToLongstoneError(error: unknown): LongstoneError {
  const classified = classifyError(error);
  switch (classified.kind) {
    case 'contract':
      return fromContractError(classified.name, classified.args);
    case 'transport':
      return { code: 'RPC_UNAVAILABLE', detail: classified.detail };
    case 'internal':
      return { code: 'INTERNAL_ERROR', detail: classified.detail };
  }
}

/**
 * Classify and throw. A `LongstoneFailure` passes through untouched — it is
 * already typed, and re-wrapping it as `internal` would lose the code.
 *
 * Only `INTERNAL_ERROR` keeps the original error as `cause`: a transport
 * message can embed the endpoint URL, and `fail()` can redact a string but not
 * an Error object, so attaching it would weaken the L-1 redaction guarantee.
 */
export function failClassified(error: unknown): never {
  if (error instanceof LongstoneFailure) throw error;
  const mapped = classifyToLongstoneError(error);
  fail(mapped, mapped.code === 'INTERNAL_ERROR' ? { cause: error } : undefined);
}
