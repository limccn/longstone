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
  /** Delegated signing key — stamps `signer` and signs transactions. */
  signer: PrivateKeyAccount;
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

export function loadKeys(env: NodeJS.ProcessEnv = process.env): Keybox {
  const signer = readKey('LONGSTONE_KEY', env);
  if (signer === null) {
    fail({
      code: 'NO_KEY',
      detail:
        'LONGSTONE_KEY is required for put/retract/acl. ' +
        'Set it to a funded testnet throwaway key; longstone signs and broadcasts locally (model A).',
    });
  }
  return { signer, owner: readKey('LONGSTONE_OWNER_KEY', env) };
}

/** The banner must appear every time a key loads, not once per machine. */
export function warnThrowawayKey(signerAddress: string, log: (line: string) => void = console.error): void {
  log('TESTNET THROWAWAY KEY — do not use for mainnet');
  log(`  signer address: ${signerAddress}`);
}
