/**
 * One description of a failure, two transports (F5, R4).
 *
 * Typed failures keep their existing output byte-for-byte: the CLI prints
 * `describe()`, MCP serializes the union object. Untyped failures previously
 * diverged — the CLI printed a bare message with no code, MCP invented its own
 * undocumented fallback code — so both now derive from `internalError()`.
 * Sharing the formatters (rather than reimplementing the branch in each
 * surface) is what makes the parity test exercise the real code paths.
 */

import { LongstoneFailure, describe, internalError } from './errors.js';

/** CLI: human text on stderr. */
export function surfaceText(error: unknown): string {
  return error instanceof LongstoneFailure ? describe(error.error) : describe(internalError(error));
}

/** MCP: the JSON `{ code, detail }` body. */
export function surfaceJson(error: unknown): string {
  return JSON.stringify(error instanceof LongstoneFailure ? error.error : internalError(error));
}
