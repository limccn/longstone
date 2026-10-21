/**
 * `verify` — dual-fetch, dual-digest, chain-only expected values (design §2.2).
 *
 * Resolution and comparison are separate steps:
 *
 *   resolve H  ← explicit | gateway row's post-confirm hash | indexer
 *   compare    ← `getCommitment(H)` only. Nothing returned by the gateway is
 *                ever used as an expected value.
 *
 * `--direct` is an acceptance criterion: verification must work with the
 * gateway unreachable, because the claim is that chain state plus the bytes
 * are sufficient.
 */

import { buildGatewayUrl } from '@limccn/hisaishi-gateway';
import { cidDigest, contentHash, parseMemoryContent } from '@limccn/menhir-core';

import type { GateClient } from '../gate.js';
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
  /** deep on chain AND both digests match — "these bytes are anchored". */
  anchored: boolean;
  /** active on chain AND both digests match. */
  active: boolean;
  blockHeight: string | null;
  /** Where the resolved hash came from; values are always read from chain. */
  hashSource: 'explicit' | 'gateway' | 'indexer';
  commitmentHash: `0x${string}`;
  owner: `0x${string}`;
  /** Expected values, read from `getCommitment(H)`. */
  contentHash: `0x${string}`;
  cidDigest: `0x${string}`;
  /** Values recomputed over the fetched bytes. */
  computedContentHash: `0x${string}`;
  computedCidDigest: `0x${string}`;
  /** Raw chain state for the resolved commitment (diagnostics). */
  chainDeep: boolean;
  chainActive: boolean;
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
 * bare `/<cid>`.
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

interface Resolved {
  hash: `0x${string}`;
  source: VerifyReport['hashSource'];
}

/**
 * Resolve a candidate commitment hash. The gateway may only nominate a hash;
 * it never supplies a value that is compared. A gateway candidate that is not
 * a live chain commitment, or that belongs to another owner, is discarded in
 * favour of the indexer — a lying gateway can cost availability, never truth.
 */
async function resolve(
  deps: VerifyDeps,
  options: VerifyOptions,
  computedCidDigest: `0x${string}`,
): Promise<Resolved> {
  if (options.commitmentHash !== undefined) {
    return { hash: options.commitmentHash, source: 'explicit' };
  }

  if (options.direct !== true && options.owner !== undefined) {
    let candidate: `0x${string}` | null = null;
    try {
      const rows = await deps.gate.list({ owner: options.owner, limit: 200 });
      // Match on the content-derived digest, never on the caller-supplied CID.
      const row = rows.find(
        (entry) =>
          entry.commitmentHash !== null &&
          entry.cidDigest.toLowerCase() === computedCidDigest.toLowerCase(),
      );
      candidate = row?.commitmentHash ?? null;
    } catch {
      // Gateway down: fall through to the indexer. Verification does not
      // depend on the gateway's availability.
    }

    if (candidate !== null) {
      const commitment = await deps.registry.getCommitment(candidate);
      const live = await deps.registry.isDeep(candidate);
      const ownerOk =
        options.owner === undefined ||
        commitment.owner.toLowerCase() === options.owner.toLowerCase();
      if (live && ownerOk) return { hash: candidate, source: 'gateway' };
      // A stale/forged candidate is not a verdict; fall back to chain events.
    }
  }

  if (options.owner !== undefined && deps.scan !== undefined) {
    const index = await deps.scan(options.owner);
    const hit = index.order.find((hash) => {
      const entry = index.byHash.get(hash);
      return (
        entry !== undefined &&
        entry.commitment.cidDigest.toLowerCase() === computedCidDigest.toLowerCase()
      );
    });
    if (hit !== undefined) return { hash: hit, source: 'indexer' };
  }

  fail({
    code: 'HASH_UNRESOLVED',
    detail:
      'pass --commitment-hash, or --owner with an anchored commitment that ' +
      'matches these bytes (the indexer scan starts at the registry deployment block)',
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
  const bytes =
    options.direct === true
      ? await fetchDirect(options.ipfsGateway ?? '', cid)
      : await gate.fetchContent(cid);

  const computedContentHash = contentHash(parseMemoryContent(decodeContent(bytes)));
  const computedCidDigest = cidDigest(bytes);

  // 2. resolve the commitment hash (explicit → gateway candidate → indexer).
  const resolved = await resolve(deps, options, computedCidDigest);

  // 3–4. every expected value comes from the chain.
  const commitment = await registry.getCommitment(resolved.hash);
  const chainDeep = await registry.isDeep(resolved.hash);
  const chainActive = await registry.isActive(resolved.hash);

  if (!chainDeep) {
    fail({
      code: 'HASH_UNRESOLVED',
      detail: `commitment ${resolved.hash} is not on chain`,
    });
  }
  if (
    options.owner !== undefined &&
    commitment.owner.toLowerCase() !== options.owner.toLowerCase()
  ) {
    fail({
      code: 'OWNER_MISMATCH',
      expected: options.owner,
      actual: commitment.owner,
    });
  }

  const expectedContentHash = commitment.contentHash;
  const expectedCidDigest = commitment.cidDigest;
  const hashMatch = expectedContentHash.toLowerCase() === computedContentHash.toLowerCase();
  const digestMatch = expectedCidDigest.toLowerCase() === computedCidDigest.toLowerCase();

  return {
    hashMatch,
    digestMatch,
    // "Anchored" describes these bytes, not merely the existence of a hash.
    anchored: chainDeep && hashMatch && digestMatch,
    active: chainActive && hashMatch && digestMatch,
    blockHeight: commitment.blockHeight.toString(),
    hashSource: resolved.source,
    commitmentHash: resolved.hash,
    owner: commitment.owner,
    contentHash: expectedContentHash,
    cidDigest: expectedCidDigest,
    computedContentHash,
    computedCidDigest,
    chainDeep,
    chainActive,
  };
}

function decodeContent(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail({ code: 'GATE_REJECTED', gateCode: 'CONTENT_NOT_FOUND', detail: 'bytes are not canonical JSON' });
  }
}
