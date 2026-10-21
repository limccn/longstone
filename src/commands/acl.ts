/**
 * `acl` — signer management with the OWNER key (design §2, menhir §2.5).
 *
 * `grant`/`revoke` are owner-only operations. `revoke` is `roles = 0`, which is
 * how the contract models revocation (there is no "revoke all").
 */

import type { PrivateKeyAccount } from 'viem/accounts';

import type { RegistryClient } from '../registry.js';
import { fail } from '../errors.js';

export const ROLE_COMMIT = 1;
export const ROLE_RETRACT = 2;

export type AclAction = 'grant' | 'revoke' | 'list';

export interface AclOptions {
  action: AclAction;
  owner: `0x${string}`;
  signer?: `0x${string}`;
  /** Raw tokens from the CLI or MCP; validated at this boundary. */
  roles?: readonly string[];
  ownerAccount?: PrivateKeyAccount;
}

const ROLE_TOKENS = new Set(['commit', 'retract']);

/**
 * Validate role tokens strictly.
 *
 * The CLI used to map any non-`commit` string to ROLE_RETRACT, so a typo, an
 * uppercase token, or `--roles ""` granted retract. Trimming is accepted
 * (shell quoting is noisy); case folding is not, because the MCP surface uses
 * `z.enum` and the two transports must agree.
 *
 * An absent list on `grant` keeps the documented `commit` default. An
 * explicitly empty or partially invalid list is an error, never a silent
 * revoke.
 */
export function normalizeRoles(
  input: readonly string[] | undefined,
  action: AclAction,
): Array<'commit' | 'retract'> {
  if (action === 'revoke') return [];
  if (input === undefined) return ['commit'];

  const roles: Array<'commit' | 'retract'> = [];
  for (const raw of input) {
    const token = raw.trim();
    if (!ROLE_TOKENS.has(token)) {
      fail({
        code: 'SCHEMA_VIOLATION',
        detail: `invalid role ${JSON.stringify(raw)}; expected "commit" or "retract"`,
      });
    }
    const role = token as 'commit' | 'retract';
    if (!roles.includes(role)) roles.push(role);
  }
  if (roles.length === 0) {
    fail({
      code: 'SCHEMA_VIOLATION',
      detail: 'grant requires at least one role ("commit" or "retract")',
    });
  }
  return roles;
}

export interface AclResult {
  txHash?: `0x${string}`;
  owner: `0x${string}`;
  signer?: `0x${string}`;
  roles?: number;
}

export async function acl(deps: { registry: RegistryClient }, options: AclOptions): Promise<AclResult> {
  if (options.action === 'list') {
    if (options.signer === undefined) {
      fail({
        code: 'SCHEMA_VIOLATION',
        detail: 'acl list needs a signer address (there is no enumerable role index on chain)',
      });
    }
    const mask = await deps.registry.rolesOf(options.owner, options.signer);
    return { owner: options.owner, signer: options.signer, roles: Number(mask) };
  }

  if (options.signer === undefined || options.ownerAccount === undefined) {
    fail({
      code: 'SCHEMA_VIOLATION',
      detail: `${options.action} needs a signer address and LONGSTONE_OWNER_KEY`,
    });
  }

  const mask =
    options.action === 'revoke'
      ? 0
      : normalizeRoles(options.roles, options.action).reduce(
          (acc, role) => acc | (role === 'commit' ? ROLE_COMMIT : ROLE_RETRACT),
          0,
        );

  const txHash = await deps.registry.setSigner(options.signer, mask, options.ownerAccount);
  return { txHash, owner: options.owner, signer: options.signer, roles: mask };
}
