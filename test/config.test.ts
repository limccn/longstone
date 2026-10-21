/**
 * AC-3: every remote endpoint is https; loopback http is the only exception.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULTS, validate, type LongstoneConfig } from '../src/config.js';
import { LongstoneFailure } from '../src/errors.js';

function config(overrides: Partial<LongstoneConfig> = {}): LongstoneConfig {
  return { ...DEFAULTS, ...overrides };
}

function fieldOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LongstoneFailure && error.error.code === 'INSECURE_ENDPOINT') {
      return error.error.field;
    }
    throw error;
  }
  throw new Error('expected INSECURE_ENDPOINT');
}

describe('endpoint schemes', () => {
  it('accepts the https defaults', () => {
    expect(() => validate(config())).not.toThrow();
  });

  it('accepts loopback http for every endpoint', () => {
    expect(() =>
      validate(
        config({
          rpcUrl: 'http://127.0.0.1:8545',
          sequencerUrl: 'http://127.0.0.1:8545',
          ipfsGateway: 'http://localhost:8080/ipfs',
          hisaishiMode: 'remote',
          hisaishiBaseUrl: 'http://[::1]:8787',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects plaintext remote endpoints, naming the field', () => {
    expect(fieldOf(() => validate(config({ rpcUrl: 'http://rpc.example' })))).toBe('rpcUrl');
    expect(fieldOf(() => validate(config({ sequencerUrl: 'http://seq.example' })))).toBe(
      'sequencerUrl',
    );
    expect(fieldOf(() => validate(config({ ipfsGateway: 'http://gw.example/ipfs' })))).toBe(
      'ipfsGateway',
    );
    expect(
      fieldOf(() =>
        validate(
          config({ hisaishiMode: 'remote', hisaishiBaseUrl: 'http://gateway.example' }),
        ),
      ),
    ).toBe('hisaishiBaseUrl');
  });

  it('rejects a malformed endpoint instead of treating it as insecure', () => {
    expect(fieldOf(() => validate(config({ rpcUrl: 'not-a-url' })))).toBe('rpcUrl');
  });

  it('allows an empty optional gateway, but a remote mode still requires one', () => {
    expect(() => validate(config({ ipfsGateway: '', hisaishiBaseUrl: '' }))).not.toThrow();
    expect(() =>
      validate(config({ hisaishiMode: 'remote', hisaishiBaseUrl: '' })),
    ).toThrow(/requires hisaishiBaseUrl/);
  });
});
