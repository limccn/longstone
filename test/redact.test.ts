/**
 * AC-6: transport details must not leak credentials embedded in endpoint URLs.
 */

import { describe, expect, it } from 'vitest';

import { LongstoneFailure, fail } from '../src/errors.js';
import { redactEndpoint, redactText } from '../src/redact.js';

describe('redaction', () => {
  it('keeps scheme and host, drops userinfo, path, query and fragment', () => {
    expect(redactEndpoint('https://user:pass@rpc.example/v2/SECRETKEY?apikey=xyz#frag')).toBe(
      'https://rpc.example/<redacted>',
    );
    expect(redactEndpoint('http://127.0.0.1:8545/v1/abcdef?token=1')).toBe(
      'http://127.0.0.1:8545/<redacted>',
    );
  });

  it('redacts URLs embedded in a larger message', () => {
    const text = 'fetch failed: request to https://gw.example/ipfs/QmSecret?token=abc timed out';
    const redacted = redactText(text);
    expect(redacted).toContain('https://gw.example/<redacted>');
    expect(redacted).not.toContain('QmSecret');
    expect(redacted).not.toContain('token=abc');
    expect(redacted).toContain('timed out');
  });

  it('leaves non-URL text untouched', () => {
    const text = '0xabc123 commitment missing';
    expect(redactText(text)).toBe(text);
  });

  it('applies at the typed-error creation point', () => {
    try {
      fail({
        code: 'GATE_UNREACHABLE',
        detail: 'https://user:pass@gateway.example/v1/secret?token=abc (ECONNREFUSED)',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LongstoneFailure);
      const typed = (error as LongstoneFailure).error;
      expect(typed.code).toBe('GATE_UNREACHABLE');
      if (typed.code === 'GATE_UNREACHABLE') {
        expect(typed.detail).toContain('https://gateway.example/<redacted>');
        expect(typed.detail).not.toContain('user:pass');
        expect(typed.detail).not.toContain('secret');
        expect(typed.detail).not.toContain('token=abc');
      }
    }
  });
});
