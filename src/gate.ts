/**
 * Gateway client (design v0.2 §3, D2/D2b).
 *
 * Two transports, ONE result type. `GatewayResult` comes from
 * `@limccn/hisaishi-gateway` — the same discriminated union the embedded handle
 * returns — so this file maps transport differences (HTTP body vs direct
 * object) and nothing else. Adding a second error model here would mean the
 * embedded path could fail differently from the HTTP path.
 *
 * Wire detail (hisaishi R15): `blockHeight` arrives as a decimal string over
 * HTTP because JSON cannot carry a bigint. It is parsed back here, at the edge,
 * so nothing downstream sees two shapes.
 */

import type { GatewayHandle, GatewayResult } from '@limccn/hisaishi-gateway';
import type { Commitment } from '@limccn/menhir-core';

import type { LongstoneConfig } from './config.js';
import { fail } from './errors.js';

export interface StagedResponse {
  cid: string;
  cidDigest: `0x${string}`;
  status: string;
}

export interface BuiltResponse {
  batchId: string;
  commitments: Commitment[];
  tagLists: `0x${string}`[][];
}

export interface ConfirmOutcome {
  status: 'anchored' | 'rejected' | 'pending';
  confirmed?: number;
  rejected?: number;
  retryAfter?: number;
}

export interface MemoryRowResponse {
  cid: string;
  contentHash: `0x${string}`;
  cidDigest: `0x${string}`;
  owner: `0x${string}`;
  tags: string[];
  status: 'staged' | 'batched' | 'anchored' | 'rejected';
  batchId: string | null;
  txHash: `0x${string}` | null;
  createdAt: number;
  commitmentHash: `0x${string}` | null;
}

export interface GateClient {
  stage(input: {
    owner: `0x${string}`;
    content: unknown;
    contentHash: `0x${string}`;
    tags: string[];
  }): Promise<StagedResponse>;
  build(input: { owner: `0x${string}`; limit?: number }): Promise<BuiltResponse>;
  confirm(input: { owner: `0x${string}`; txHash: `0x${string}` }): Promise<ConfirmOutcome>;
  list(input: { owner: `0x${string}`; status?: string; limit?: number }): Promise<MemoryRowResponse[]>;
  fetchContent(cid: string): Promise<Uint8Array>;
}

/** Turn a `GatewayResult` failure into the typed longstone error. */
function unwrap<T>(result: GatewayResult<T>): T {
  if (result.ok) return result.value;
  // The gate's own code is far more actionable than a generic rejection, so it
  // is preserved rather than flattened.
  fail({
    code: 'GATE_REJECTED',
    gateCode: result.error.code,
    ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
  });
}

/** HTTP form (F2 remote, or F1 standalone `serve`). */
export function createHttpGate(config: LongstoneConfig): GateClient {
  const base = config.hisaishiBaseUrl.replace(/\/+$/, '');

  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      });
    } catch (error) {
      fail({ code: 'GATE_UNREACHABLE', detail: `${base}${path} (${(error as Error).message})` });
    }
  }

  async function jsonBody(response: Response): Promise<unknown> {
    const body = (await response.json()) as { code?: string; detail?: string };
    if (!response.ok) {
      fail({
        code: 'GATE_REJECTED',
        ...(body.code === undefined ? {} : { gateCode: body.code }),
        ...(body.detail === undefined ? {} : { detail: body.detail }),
      });
    }
    return body;
  }

  return {
    async stage(input) {
      const response = await request('/v1/memories', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return (await jsonBody(response)) as StagedResponse;
    },

    async build(input) {
      const response = await request('/v1/batches/build', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      const body = (await jsonBody(response)) as {
        batchId: string;
        commitments: Array<Record<string, unknown>>;
        tagLists: `0x${string}`[][];
      };
      return {
        batchId: body.batchId,
        tagLists: body.tagLists,
        // R15: parse the decimal string back into the bigint the hasher needs.
        commitments: body.commitments.map((c) => ({
          ...(c as unknown as Commitment),
          blockHeight: BigInt(c.blockHeight as string),
        })),
      };
    },

    async confirm(input) {
      const response = await request('/v1/batches/confirm', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (response.status === 202) {
        // Pending is a successful call with a "come back later" answer, not a
        // rejection — D-10 makes the caller the retry driver.
        const body = (await response.json()) as { retryAfter?: number };
        return { status: 'pending', ...(body.retryAfter === undefined ? {} : { retryAfter: body.retryAfter }) };
      }
      return (await jsonBody(response)) as ConfirmOutcome;
    },

    async list(input) {
      const params = new URLSearchParams({ owner: input.owner });
      if (input.status !== undefined) params.set('status', input.status);
      if (input.limit !== undefined) params.set('limit', String(input.limit));
      const response = await request(`/v1/memories?${params.toString()}`);
      const body = (await jsonBody(response)) as { rows: MemoryRowResponse[] };
      return body.rows;
    },

    async fetchContent(cid) {
      const response = await request(`/v1/content?cid=${encodeURIComponent(cid)}`);
      if (response.status === 404) {
        fail({ code: 'GATE_REJECTED', gateCode: 'CONTENT_NOT_FOUND', detail: cid });
      }
      if (!response.ok) {
        fail({ code: 'GATE_REJECTED', gateCode: 'GATEWAY_UPSTREAM', detail: String(response.status) });
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** Embedded form (F1 in-process): no HTTP hop, identical result type. */
export function createEmbeddedGate(handle: GatewayHandle): GateClient {
  return {
    async stage(input) {
      return unwrap(await handle.stage(input));
    },
    async build(input) {
      // The embedded handle returns the bigint directly, so there is no wire
      // decoding here; the two transports converge on the same BuiltResponse.
      return unwrap(await handle.build(input));
    },
    async confirm(input) {
      return unwrap(await handle.confirm(input)) as ConfirmOutcome;
    },
    async list(input) {
      return unwrap(await handle.list(input));
    },
    async fetchContent(cid) {
      return unwrap(await handle.content(cid));
    },
  };
}

/** Select a transport from configuration. */
export async function createGate(
  config: LongstoneConfig,
  embeddedHandle?: GatewayHandle,
): Promise<GateClient> {
  if (config.hisaishiMode === 'remote') return createHttpGate(config);
  if (config.hisaishiMode === 'direct-rpc') {
    fail({
      code: 'GATE_UNREACHABLE',
      detail: 'hisaishiMode=direct-rpc has no staging gateway; writes are unavailable in this mode',
    });
  }
  if (embeddedHandle !== undefined) return createEmbeddedGate(embeddedHandle);
  fail({
    code: 'GATE_UNREACHABLE',
    detail:
      `hisaishiMode=${config.hisaishiMode} requires an embedded handle or a running local server; ` +
      'pass createGateway() or set hisaishiMode=remote with a base URL',
  });
}
