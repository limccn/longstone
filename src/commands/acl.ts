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
  roles?: Array<'commit' | 'retract'>;
  ownerAccount?: PrivateKeyAccount;
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
      : (options.roles ?? ['commit']).reduce(
          (acc, role) => acc | (role === 'commit' ? ROLE_COMMIT : ROLE_RETRACT),
          0,
        );

  const txHash = await deps.registry.setSigner(options.signer, mask, options.ownerAccount);
  return { txHash, owner: options.owner, signer: options.signer, roles: mask };
}
