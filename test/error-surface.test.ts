/**
 * R4 — one untyped failure must read the same on both surfaces. These are the
 * exact functions the CLI and MCP call.
 */

import { describe, expect, it } from 'vitest';

import { surfaceJson, surfaceText } from '../src/error-surface.js';
import { LongstoneFailure, describe as describeError } from '../src/errors.js';

describe('surface parity for untyped failures', () => {
  it('reports INTERNAL_ERROR with the same detail on both surfaces', () => {
    const typed = JSON.parse(surfaceJson(new TypeError('x is not a function'))) as {
      code: string;
      detail: string;
    };
    expect(typed.code).toBe('INTERNAL_ERROR');
    expect(typed.detail).toBe('TypeError: x is not a function');

    const text = surfaceText(new TypeError('x is not a function'));
    expect(text).toContain('internal error (client-side bug; do not retry):');
    expect(text).toContain(typed.detail);
  });

  it('does not invent UNKNOWN_ERROR', () => {
    expect(surfaceJson(new Error('boom'))).not.toContain('UNKNOWN_ERROR');
    expect(surfaceJson(new Error('boom'))).toContain('INTERNAL_ERROR');
  });

  it('redacts a credential-bearing endpoint URL in both strings', () => {
    const error = new Error(
      'request to https://user:pass@rpc.example/v2/SECRETKEY?apikey=xyz failed',
    );
    for (const rendered of [surfaceText(error), surfaceJson(error)]) {
      expect(rendered).toContain('https://rpc.example/<redacted>');
      expect(rendered).not.toContain('user:pass');
      expect(rendered).not.toContain('SECRETKEY');
      expect(rendered).not.toContain('apikey=xyz');
    }
  });
});

describe('typed failures keep their existing output', () => {
  it('surfaceText is describe(), byte-for-byte', () => {
    const failure = new LongstoneFailure({ code: 'NOT_AUTHORIZED', role: 'commit' });
    expect(surfaceText(failure)).toBe(describeError(failure.error));
  });

  it('surfaceJson is the union object, byte-for-byte', () => {
    const failure = new LongstoneFailure({ code: 'NOT_AUTHORIZED', role: 'commit' });
    expect(surfaceJson(failure)).toBe(JSON.stringify(failure.error));
  });

  it('never serializes the cause object', () => {
    const failure = new LongstoneFailure(
      { code: 'NO_KEY', detail: 'absent' },
      { cause: new Error('CAUSE-MARKER') },
    );
    for (const rendered of [surfaceText(failure), surfaceJson(failure)]) {
      expect(rendered).not.toContain('CAUSE-MARKER');
      expect(rendered).not.toContain('"cause"');
    }
  });
});
