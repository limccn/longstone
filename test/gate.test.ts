/**
 * F2 — HTTP error mapping at the gateway edge.
 *
 * A proxy or load balancer answers 429/5xx with HTML or plain text. That must
 * become a typed `GATE_REJECTED` carrying `httpStatus`, never a bare
 * `SyntaxError` from `response.json()`: the confirm retry helper branches on
 * the status, not on message text.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULTS } from '../src/config.js';
import { LongstoneFailure } from '../src/errors.js';
import { surfaceJson, surfaceText } from '../src/error-surface.js';
import { createHttpGate } from '../src/gate.js';

const CONFIG = { ...DEFAULTS, hisaishiBaseUrl: 'http://127.0.0.1:9' };
const OWNER = `0x${'11'.repeat(20)}` as const;
const HASH = `0x${'33'.repeat(32)}` as const;

function stubFetch(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
}

async function failureOf(promise: Promise<unknown>): Promise<LongstoneFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LongstoneFailure) return error;
    throw error;
  }
  throw new Error('expected a LongstoneFailure');
}

function stage(gate = createHttpGate(CONFIG)) {
  return gate.stage({
    owner: OWNER,
    content: {},
    contentHash: HASH,
    tags: [],
    capability: 'a'.repeat(32),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHttpGate — non-JSON error bodies', () => {
  it('maps a non-JSON 429 to GATE_REJECTED with httpStatus (no SyntaxError)', async () => {
    stubFetch(
      new Response('<html><body>slow down</body></html>', {
        status: 429,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const failure = await failureOf(stage());
    expect(failure.error).toMatchObject({
      code: 'GATE_REJECTED',
      httpStatus: 429,
      detail: 'HTTP 429',
    });
  });

  it('maps a non-JSON 503 to GATE_REJECTED with httpStatus', async () => {
    stubFetch(new Response('upstream connect error', { status: 503 }));

    const failure = await failureOf(stage());
    expect(failure.error).toMatchObject({
      code: 'GATE_REJECTED',
      httpStatus: 503,
      detail: 'HTTP 503',
    });
  });

  it('maps a JSON `null` error body without throwing a TypeError', async () => {
    // Valid JSON that is not an object must not turn into an untyped TypeError
    // on the error path; the status is still the actionable information.
    stubFetch(
      new Response('null', { status: 502, headers: { 'content-type': 'application/json' } }),
    );

    const failure = await failureOf(stage());
    expect(failure.error).toMatchObject({
      code: 'GATE_REJECTED',
      httpStatus: 502,
      detail: 'HTTP 502',
    });
  });

  it('preserves a JSON gateway code and also carries the HTTP status', async () => {
    stubFetch(
      new Response(JSON.stringify({ code: 'RPC_UNAVAILABLE', detail: 'upstream 429' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const failure = await failureOf(stage());
    expect(failure.error).toEqual({
      code: 'GATE_REJECTED',
      gateCode: 'RPC_UNAVAILABLE',
      detail: 'upstream 429',
      httpStatus: 502,
    });
  });

  it('redacts credentials, path and query from a gateway detail (L-1)', async () => {
    // Defence in depth for the client boundary: even if a gateway version in
    // the wild still echoes a credential-bearing URL, stderr and MCP results
    // must not. Removing `redactError` from `fail()` makes this test fail.
    const secret = 'https://user:pass@rpc.example/v2/SECRET?token=abc';
    stubFetch(
      new Response(JSON.stringify({ code: 'GATEWAY_UPSTREAM', detail: secret }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const failure = await failureOf(stage());
    for (const output of [surfaceText(failure), surfaceJson(failure)]) {
      expect(output).not.toContain('user:pass');
      expect(output).not.toContain('SECRET');
      expect(output).not.toContain('token=abc');
      expect(output).not.toContain('/v2/');
      expect(output).toContain('rpc.example');
    }
  });

  it('leaves a success body unchanged', async () => {
    stubFetch(
      new Response(JSON.stringify({ cid: 'bafy', cidDigest: HASH, status: 'staged' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await stage();
    expect(response).toEqual({ cid: 'bafy', cidDigest: HASH, status: 'staged' });
  });
});
