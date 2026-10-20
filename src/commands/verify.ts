/**
 * `verify` — dual-fetch, dual-digest (design v0.2 §4, D3).
 *
 * `--direct` is an acceptance criterion, not a nicety: verification must work
 * with the gateway unreachable, because the whole claim is that the chain plus
 * the bytes are sufficient.
 */

import { buildGatewayUrl } from '@limccn/hisaishi-gateway';
import { cidDigest, contentHash, parseMemoryContent } from '@limccn/menhir-core';

import type { GateClient, MemoryRowResponse } from '../gate.js';
import type { RegistryClient } from '../registry.js';
import type { ChainIndex } from '../indexer.js';
import { fail } from '../errors.js';

export interface VerifyOptions {
  /** At least one of cid / commitmentHash must be supplied. */
  cid?: string;
  commitmentHash?: `0x${string}`;
  owner?: `0x${string}`;
  direct?: boolean;
  /** Required for `direct`: the dedicated gateway to fetch from (M1-9). */
  ipfsGateway?: string;
}

export interface VerifyReport {
  hashMatch: boolean;
  digestMatch: boolean;
  anchored: boolean;
  active: boolean;
  blockHeight: string | null;
  /** Which commitment hash the verdict was computed against, and where it came from. */
  hashSource: 'explicit' | 'gate-row' | 'indexer' | 'none';
  contentHash: `0x${string}` | null;
  cidDigest: `0x${string}` | null;
}

export interface VerifyDeps {
  gate: GateClient;
  registry: RegistryClient;
  scan?: (owner: `0x${string}`) => Promise<ChainIndex>;
}

/**
 * Fetch from the configured dedicated gateway without touching hisaishi.
 *
 * Uses the shared `/ipfs/<cid>` builder: Pinata's gateways answer 400 for a
 * bare `/<cid>`, which is exactly what this path did before the fix — the
 * gateway proxy had been corrected but this second URL builder was missed.
 */
function fetchDirect(gateway: string, cid: string): Promise<Uint8Array> {
  const url = buildGatewayUrl(gateway, cid);
  return fetch(url).then(async (response) => {
    if (response.status === 403) {
      // Pinata says "not pinned" with 403, not 404.
      const body = await response.text().catch(() => '');
      if (/pinned|does not have this content/i.test(body)) {
        fail({ code: 'GATE_REJECTED', gateCode: 'CONTENT_NOT_FOUND', detail: `${cid} is not pinned` });
      }
    }
    if (!response.ok) {
      fail({
        code: 'GATE_REJECTED',
        gateCode: response.status === 404 ? 'CONTENT_NOT_FOUND' : 'GATEWAY_UPSTREAM',
        detail: `${url} returned ${response.status}`,
      });
    }
    return new Uint8Array(await response.arrayBuffer());
  });
}

export async function verify(deps: VerifyDeps, options: VerifyOptions): Promise<VerifyReport> {
  const { gate, registry } = deps;

  // 1. bytes: gateway proxy unless `--direct`, in which case the caller's
  //    dedicated gateway is used and hisaishi is never contacted.
  if (options.cid === undefined) {
    fail({ code: 'SCHEMA_VIOLATION' });
  }
  const cid = options.cid;
  const bytes = options.direct === true
    ? await fetchDirect(options.ipfsGateway ?? '', cid)
    : await gate.fetchContent(cid);

  const computedContentHash = contentHash(parseMemoryContent(decodeContent(bytes)));
  const computedCidDigest = cidDigest(bytes);

  // 2. resolve the commitment. An explicit hash wins; otherwise the gateway's
  //    row (R13) is the lookup aid; otherwise the indexer matches by cidDigest.
  let commitmentHashValue: `0x${string}` | null = options.commitmentHash ?? null;
  let hashSource: VerifyReport['hashSource'] = commitmentHashValue === null ? 'none' : 'explicit';
  let expectedContentHash: `0x${string}` | null = null;
  let expectedCidDigest: `0x${string}` | null = null;

  if (commitmentHashValue !== null) {
    const commitment = await registry.getCommitment(commitmentHashValue);
    expectedContentHash = commitment.contentHash;
    expectedCidDigest = commitment.cidDigest;
  } else if (options.owner !== undefined) {
    // `--direct` must not touch the gateway at all (PRD AC). Resolving through
    // the indexer first keeps that promise; the gateway's list route is only a
    // convenience path when the caller explicitly wants it.
    if (options.direct === true) {
      if (deps.scan !== undefined) {
        const index = await deps.scan(options.owner);
        const hit = index.order.find((h) => {
          const entry = index.byHash.get(h);
          return entry !== undefined && entry.commitment.cidDigest === computedCidDigest;
        });
        if (hit !== undefined) {
          const entry = index.byHash.get(hit)!;
          commitmentHashValue = hit;
          expectedContentHash = entry.commitment.contentHash;
          expectedCidDigest = entry.commitment.cidDigest;
          hashSource = 'indexer';
        }
      }
    } else {
      const rows: MemoryRowResponse[] = await gate.list({ owner: options.owner, limit: 200 });
      const matching = rows.find((row) => row.cid === cid || row.cidDigest === computedCidDigest);
      if (matching !== undefined) {
        commitmentHashValue = matching.commitmentHash;
        expectedContentHash = matching.contentHash;
        expectedCidDigest = matching.cidDigest;
        hashSource = 'gate-row';
        // A null derived hash means the row is not yet batched; the digests are
        // still comparable, and `anchored` below reports the truth.
        if (matching.commitmentHash === null) commitmentHashValue = null;
      } else if (deps.scan !== undefined) {
        const index = await deps.scan(options.owner);
        const hit = index.order.find((h) => {
          const entry = index.byHash.get(h);
          return entry !== undefined && entry.commitment.cidDigest === computedCidDigest;
        });
        if (hit !== undefined) {
          const entry = index.byHash.get(hit)!;
          commitmentHashValue = hit;
          expectedContentHash = entry.commitment.contentHash;
          expectedCidDigest = entry.commitment.cidDigest;
          hashSource = 'indexer';
        }
      }
    }
  }

  // 3–4. both roots over the same fetched bytes.
  const hashMatch = expectedContentHash !== null && expectedContentHash === computedContentHash;
  const digestMatch = expectedCidDigest !== null && expectedCidDigest === computedCidDigest;

  // 5. on-chain state, only if we have a hash to ask about.
  let anchored = false;
  let active = false;
  let blockHeight: string | null = null;
  if (commitmentHashValue !== null) {
    anchored = await registry.isDeep(commitmentHashValue);
    active = await registry.isActive(commitmentHashValue);
    const commitment = await registry.getCommitment(commitmentHashValue);
    blockHeight = commitment.blockHeight.toString();
  }

  return {
    hashMatch,
    digestMatch,
    anchored,
    active,
    blockHeight,
    hashSource,
    contentHash: expectedContentHash,
    cidDigest: expectedCidDigest,
  };
}

/**
 * The pinned bytes are the canonical JSON of a MemoryContent. Decoding them is
 * how a verify report can recompute `contentHash` from fetched bytes rather
 * than trusting the gateway's metadata.
 */
function decodeContent(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail({ code: 'GATE_REJECTED', gateCode: 'CONTENT_NOT_FOUND', detail: 'bytes are not canonical JSON' });
  }
}
