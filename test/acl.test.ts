/**
 * AC-5: unknown role strings must never map to ROLE_RETRACT.
 */

import { describe, expect, it } from 'vitest';

import { acl, normalizeRoles, ROLE_COMMIT, ROLE_RETRACT } from '../src/commands/acl.js';
import { LongstoneFailure } from '../src/errors.js';
import type { RegistryClient } from '../src/registry.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const SIGNER = `0x${'22'.repeat(20)}` as const;
const ACCOUNT = { address: OWNER } as never;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LongstoneFailure) return error.error.code;
    throw error;
  }
  throw new Error('expected a LongstoneFailure');
}

describe('normalizeRoles', () => {
  it('accepts the exact lowercase tokens', () => {
    expect(normalizeRoles(['commit'], 'grant')).toEqual(['commit']);
    expect(normalizeRoles(['commit', 'retract'], 'grant')).toEqual(['commit', 'retract']);
    expect(normalizeRoles([' commit ', 'retract'], 'grant')).toEqual(['commit', 'retract']);
    expect(normalizeRoles(['commit', 'commit'], 'grant')).toEqual(['commit']);
  });

  it('keeps the documented default for an absent list', () => {
    expect(normalizeRoles(undefined, 'grant')).toEqual(['commit']);
  });

  it('rejects uppercase, empty, trailing-comma and unknown tokens', () => {
    for (const input of [['COMMIT'], [''], ['commit', ''], ['commit', 'foo'], ['Commit']]) {
      expect(codeOf(() => normalizeRoles(input, 'grant'))).toBe('SCHEMA_VIOLATION');
    }
  });

  it('ignores roles on revoke', () => {
    expect(normalizeRoles(['whatever'], 'revoke')).toEqual([]);
  });
});

describe('acl grant', () => {
  function registrySpy(): { registry: RegistryClient; calls: number[] } {
    const calls: number[] = [];
    const registry = {
      async setSigner(_signer: string, roles: number) {
        calls.push(roles);
        return `0x${'ab'.repeat(32)}`;
      },
    } as unknown as RegistryClient;
    return { registry, calls };
  }

  it('grants the union of valid roles', async () => {
    const { registry, calls } = registrySpy();
    const result = await acl(
      { registry },
      {
        action: 'grant',
        owner: OWNER,
        signer: SIGNER,
        roles: ['commit', 'retract'],
        ownerAccount: ACCOUNT,
      },
    );
    expect(calls).toEqual([ROLE_COMMIT | ROLE_RETRACT]);
    expect(result.roles).toBe(ROLE_COMMIT | ROLE_RETRACT);
  });

  it('does not send a transaction for invalid input', async () => {
    for (const roles of [['COMMIT'], [''], ['commit', 'foo']]) {
      const { registry, calls } = registrySpy();
      await expect(
        acl(
          { registry },
          { action: 'grant', owner: OWNER, signer: SIGNER, roles, ownerAccount: ACCOUNT },
        ),
      ).rejects.toBeInstanceOf(LongstoneFailure);
      expect(calls).toHaveLength(0);
    }
  });

  it('revoke is still a zero mask', async () => {
    const { registry, calls } = registrySpy();
    await acl(
      { registry },
      { action: 'revoke', owner: OWNER, signer: SIGNER, ownerAccount: ACCOUNT },
    );
    expect(calls).toEqual([0]);
  });
});
