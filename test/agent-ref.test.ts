/**
 * AC-8 (method A): an invalid ERC-8004 reference fails with a typed error
 * before any staging happens.
 *
 * `parseAgentRef` is the single validator used by the put core, the CLI flags
 * and the MCP tool, so these cases pin the wire contract in one place.
 */

import { describe, expect, it } from 'vitest';

import {
  DECIMAL_RE,
  REGISTRY_RE,
  agentRefFromFlags,
  parseAgentRef,
} from '../src/agent-ref.js';
import { LongstoneFailure } from '../src/errors.js';

// Deployments observed on 2026-10-21 (research/eip-8004-fit.md §2). They are
// examples of the wire shape, not canonical addresses: nothing defaults to them.
const BASE_MAINNET = 'eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const BASE_SEPOLIA = 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e';

function failureOf(run: () => unknown): LongstoneFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof LongstoneFailure) return error;
    throw error;
  }
  throw new Error('expected a LongstoneFailure');
}

describe('parseAgentRef — accepts the documented wire shape', () => {
  it('accepts a Base mainnet reference', () => {
    expect(parseAgentRef({ registry: BASE_MAINNET, agentId: '42' })).toEqual({
      registry: BASE_MAINNET,
      agentId: '42',
    });
  });

  it('accepts a Base Sepolia reference with agentId 0', () => {
    expect(parseAgentRef({ registry: BASE_SEPOLIA, agentId: '0' })).toEqual({
      registry: BASE_SEPOLIA,
      agentId: '0',
    });
  });

  it('accepts an uppercase hex registry address (the regex is case-insensitive there)', () => {
    const upper = 'eip155:8453:0x8004A169FB4A3325136EB29FA0CEB6D2E539A432';
    expect(REGISTRY_RE.test(upper)).toBe(true);
    expect(parseAgentRef({ registry: upper, agentId: '1' }).registry).toBe(upper);
  });

  it('accepts a uint256-sized decimal id (strings carry bigints on the wire)', () => {
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    expect(DECIMAL_RE.test(huge)).toBe(true);
    expect(parseAgentRef({ registry: BASE_MAINNET, agentId: huge }).agentId).toBe(huge);
  });

  it('returns a plain copy, so a later mutation cannot change what was validated', () => {
    const input = { registry: BASE_MAINNET, agentId: '7' };
    const parsed = parseAgentRef(input);
    input.agentId = '8';
    expect(parsed.agentId).toBe('7');
    expect(parsed).not.toBe(input);
  });
});

describe('parseAgentRef — rejects malformed references with SCHEMA_VIOLATION', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['missing registry', { agentId: '1' }, /meta\.agent\.registry is required/],
    ['missing agentId', { registry: BASE_MAINNET }, /meta\.agent\.agentId is required/],
    ['number agentId', { registry: BASE_MAINNET, agentId: 42 }, /meta\.agent\.agentId must be a decimal string/],
    ['null agentId', { registry: BASE_MAINNET, agentId: null }, /meta\.agent\.agentId must be a decimal string/],
    ['negative agentId', { registry: BASE_MAINNET, agentId: '-1' }, /meta\.agent\.agentId must be a decimal/],
    ['leading-zero agentId', { registry: BASE_MAINNET, agentId: '007' }, /meta\.agent\.agentId must be a decimal/],
    ['decimal-point agentId', { registry: BASE_MAINNET, agentId: '1.0' }, /meta\.agent\.agentId must be a decimal/],
    ['whitespace agentId', { registry: BASE_MAINNET, agentId: ' 1' }, /meta\.agent\.agentId must be a decimal/],
    ['registry without chain id', { registry: 'eip155:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: '1' }, /meta\.agent\.registry must look like/],
    ['uppercase namespace', { registry: 'EIP155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: '1' }, /meta\.agent\.registry must look like/],
    ['short address', { registry: 'eip155:8453:0x1234', agentId: '1' }, /meta\.agent\.registry must look like/],
    ['registry is not a string', { registry: 8453, agentId: '1' }, /meta\.agent\.registry must be a string/],
    ['unknown key', { registry: BASE_MAINNET, agentId: '1', chain: 'base' }, /meta\.agent has unknown key "chain"/],
    ['null input', null, /meta\.agent must be an object/],
    ['array input', [BASE_MAINNET, '1'], /meta\.agent must be an object/],
    ['string input', BASE_MAINNET, /meta\.agent must be an object/],
  ];

  it.each(cases)('%s', (_name, input, detailPattern) => {
    const failure = failureOf(() => parseAgentRef(input));
    expect(failure.error.code).toBe('SCHEMA_VIOLATION');
    const detail = (failure.error as { detail?: string }).detail ?? '';
    expect(detail).toMatch(detailPattern);
  });

  it('names the bad field in the human message too', () => {
    const failure = failureOf(() => parseAgentRef({ registry: BASE_MAINNET, agentId: 42 }));
    expect(failure.message).toContain('SCHEMA_VIOLATION');
    expect(failure.message).toContain('meta.agent.agentId');
  });
});

describe('agentRefFromFlags — both-or-neither', () => {
  it('returns undefined when neither flag is supplied', () => {
    expect(agentRefFromFlags(undefined, undefined)).toBeUndefined();
  });

  it('rejects a registry without an id before any IO', () => {
    const failure = failureOf(() => agentRefFromFlags(BASE_MAINNET, undefined));
    expect(failure.error.code).toBe('SCHEMA_VIOLATION');
    expect((failure.error as { detail?: string }).detail).toContain('--agent-registry');
    expect((failure.error as { detail?: string }).detail).toContain('--agent-id');
  });

  it('rejects an id without a registry', () => {
    const failure = failureOf(() => agentRefFromFlags(undefined, '42'));
    expect(failure.error.code).toBe('SCHEMA_VIOLATION');
    expect((failure.error as { detail?: string }).detail).toContain('--agent-registry');
  });

  it('validates the pair together when both are supplied', () => {
    expect(agentRefFromFlags(BASE_SEPOLIA, '42')).toEqual({
      registry: BASE_SEPOLIA,
      agentId: '42',
    });
    const failure = failureOf(() => agentRefFromFlags('not-a-registry', '42'));
    expect(failure.error.code).toBe('SCHEMA_VIOLATION');
    expect((failure.error as { detail?: string }).detail).toContain('meta.agent.registry');
  });
});
