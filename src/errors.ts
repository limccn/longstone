/**
 * longstone's typed error union (design v0.2 §7).
 *
 * Three sources collapse here: `@limccn/menhir-core` validation, contract custom
 * errors, and gateway transport/business rejections. A caller must be able to
 * branch on `code` alone; the human text is secondary.
 */

export type LongstoneError =
  // @limccn/menhir-core pass-through; `detail` carries the core message when there is
  // one, because "SCHEMA_VIOLATION" alone does not tell a caller what to fix.
  | {
      code: 'NON_NORMALIZED_INPUT' | 'TAG_TOO_LONG' | 'SCHEMA_VIOLATION' | 'UNKNOWN_KEY' | 'INVALID_HEX';
      detail?: string;
    }
  // contract custom errors — names match MemoryRegistry.sol
  | { code: 'PREDECESSOR_UNKNOWN'; which: 'prev' | 'replacedBy' }
  | { code: 'NOT_AUTHORIZED'; role: 'commit' | 'retract' }
  | { code: 'SIGNER_MISMATCH'; provided: string; actual: string }
  | { code: 'DUPLICATE_COMMITMENT' }
  | { code: 'UNKNOWN_COMMITMENT' }
  | { code: 'INVALID_BATCH_SIZE' | 'INVALID_ROLES' | 'INVALID_COMMITMENT' | 'INVALID_OP' | 'FUTURE_BLOCK_HEIGHT' }
  // gateway transport / business
  | { code: 'GATE_UNREACHABLE' | 'GATE_REJECTED'; gateCode?: string; detail?: string }
  | { code: 'UNKNOWN_REVERT'; selector: `0x${string}` }
  // local
  | { code: 'NO_KEY'; detail: string }
  | { code: 'RPC_UNAVAILABLE'; detail: string };

export class LongstoneFailure extends Error {
  readonly error: LongstoneError;

  constructor(error: LongstoneError) {
    super(describe(error));
    this.name = 'LongstoneFailure';
    this.error = error;
  }
}

/**
 * A message a caller can act on.
 *
 * `SIGNER_MISMATCH` and `NOT_AUTHORIZED` carry the most common operational
 * mistakes behind them (a skipped stamp; a missing grant), so they say what to
 * do instead of restating the revert.
 */
export function describe(error: LongstoneError): string {
  switch (error.code) {
    case 'SIGNER_MISMATCH':
      return (
        `commitment.signer is ${error.provided} but msg.sender is ${error.actual}. ` +
        'longstone must stamp the signing key address into every commitment before signing ' +
        '(the gateway returns a zero placeholder).'
      );
    case 'NOT_AUTHORIZED':
      return (
        `signer lacks ROLE_${error.role.toUpperCase()} for this owner. ` +
        `fix: longstone acl grant <signer-address> ${error.role}`
      );
    case 'PREDECESSOR_UNKNOWN':
      return `${error.which} references a commitment that does not exist on chain`;
    case 'GATE_REJECTED':
      return `gateway rejected the request${error.gateCode === undefined ? '' : ` (${error.gateCode})`}${error.detail === undefined ? '' : `: ${error.detail}`}`;
    case 'GATE_UNREACHABLE':
      return `gateway unreachable${error.detail === undefined ? '' : `: ${error.detail}`}`;
    case 'UNKNOWN_REVERT':
      return `unrecognized revert selector ${error.selector} — the ABI may be stale`;
    case 'NO_KEY':
      return error.detail;
    case 'RPC_UNAVAILABLE':
      return `rpc unavailable: ${error.detail}`;
    case 'SCHEMA_VIOLATION':
    case 'NON_NORMALIZED_INPUT':
    case 'TAG_TOO_LONG':
    case 'UNKNOWN_KEY':
    case 'INVALID_HEX':
      return error.detail === undefined ? error.code : `${error.code}: ${error.detail}`;
    default:
      return error.code;
  }
}

export function fail(error: LongstoneError): never {
  throw new LongstoneFailure(error);
}

/** Map a decoded viem custom error name onto the union. */
export function fromContractError(
  name: string,
  args: readonly unknown[] | undefined,
): LongstoneError {
  switch (name) {
    case 'InvalidOp':
      return { code: 'INVALID_OP' };
    case 'InvalidCommitment':
      return { code: 'INVALID_COMMITMENT' };
    case 'SignerMismatch':
      return {
        code: 'SIGNER_MISMATCH',
        provided: String(args?.[0] ?? ''),
        actual: String(args?.[1] ?? ''),
      };
    case 'FutureBlockHeight':
      return { code: 'FUTURE_BLOCK_HEIGHT' };
    case 'NotAuthorized':
      return {
        code: 'NOT_AUTHORIZED',
        role: Number(args?.[2] ?? 0) === 2 ? 'retract' : 'commit',
      };
    case 'PredecessorUnknown':
      return { code: 'PREDECESSOR_UNKNOWN', which: 'prev' };
    case 'DuplicateCommitment':
      return { code: 'DUPLICATE_COMMITMENT' };
    case 'UnknownCommitment':
      return { code: 'UNKNOWN_COMMITMENT' };
    case 'TooManyCommitments':
    case 'ArrayLengthMismatch':
      return { code: 'INVALID_BATCH_SIZE' };
    case 'InvalidRoles':
    case 'ZeroAddress':
      return { code: 'INVALID_ROLES' };
    default:
      return { code: 'UNKNOWN_REVERT', selector: '0x00000000' };
  }
}
