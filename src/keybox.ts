/**
 * Keys (design §6).
 *
 * longstone is the ONLY component that holds a wallet key (model A). This file
 * is therefore the single place key material enters the process, and it is
 * deliberately small so that claim stays reviewable.
 *
 * M1 keys are testnet throwaways. There is no keystore: encrypted key material
 * arrives in M2 with the content-key work.
 */

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { fail } from './errors.js';

export interface Keybox {
  /**
   * Delegated signing key — stamps `signer` and signs transactions.
   * Null when only an owner operation was requested (acl), which does not need
   * it. Requiring both keys for an owner-only command was a real failure: the
   * grant could not run with the owner key alone.
   */
  signer: PrivateKeyAccount | null;
  /** Owner key, when present (acl grant/revoke, retract-any). */
  owner: PrivateKeyAccount | null;
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

function readKey(name: string, env: NodeJS.ProcessEnv): PrivateKeyAccount | null {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (!HEX_KEY.test(value)) {
    // Never echo the value — a malformed key is still a secret.
    fail({ code: 'NO_KEY', detail: `${name} is not a 32-byte hex private key` });
  }
  return privateKeyToAccount(value as `0x${string}`);
}

export type KeyNeed = 'signer' | 'owner' | 'any' | false;

export function loadKeys(env: NodeJS.ProcessEnv = process.env, need: KeyNeed = 'any'): Keybox {
  const signer = readKey('LONGSTONE_KEY', env);
  const owner = readKey('LONGSTONE_OWNER_KEY', env);

  if (need === 'signer' && signer === null) {
    fail({
      code: 'NO_KEY',
      detail:
        'LONGSTONE_KEY is required to sign and broadcast. Set it to a funded ' +
        'testnet throwaway key (model A: signing happens locally).',
    });
  }
  if (need === 'owner' && owner === null) {
    fail({
      code: 'NO_KEY',
      detail: 'LONGSTONE_OWNER_KEY is required for acl grant/revoke.',
    });
  }
  if (need !== false && signer === null && owner === null) {
    fail({
      code: 'NO_KEY',
      detail: 'Set LONGSTONE_KEY (signing) and/or LONGSTONE_OWNER_KEY (owner ops).',
    });
  }
  return { signer, owner };
}

/**
 * The account to sign with: owner when present (implicit superuser), otherwise
 * the delegated signer. Fails when neither key was loaded.
 */
export function pickSigningAccount(keys: Keybox): PrivateKeyAccount {
  const account = keys.owner ?? keys.signer;
  if (account === null) {
    fail({ code: 'NO_KEY', detail: 'no signing key loaded' });
  }
  return account;
}

/** The banner must appear every time a key loads, not once per machine. */
export function warnThrowawayKey(signerAddress: string, log: (line: string) => void = console.error): void {
  log('TESTNET THROWAWAY KEY — do not use for mainnet');
  log(`  signer address: ${signerAddress}`);
}
