/**
 * Local build-intent selection (H-1, design §2.1).
 *
 * The gateway returns commitments for the rows it selected. The only trusted
 * statement of what this client is about to sign is the set of values it
 * computed BEFORE staging. This module intersects the two and fails closed:
 *
 *   - a missing local commitment means the gateway did not include our row
 *     (an attacker-filled batch, a stale row, a broken gateway) — sign nothing;
 *   - an ambiguous match means the gateway returned the same content twice or
 *     reordered rows — refuse to guess;
 *   - the tag list travels with the selected index because the gateway builds
 *     commitments and tagLists positionally from the same rows.
 *
 * The function takes a list of intents even though `put` passes one: a future
 * multi-memory batch must present an explicit allowlist of everything it is
 * willing to sign, never "whatever came back".
 */

import type { Commitment } from '@limccn/menhir-core';

import { fail } from './errors.js';

export interface LocalCommitmentIntent {
  owner: `0x${string}`;
  contentHash: `0x${string}`;
  cidDigest: `0x${string}`;
}

export interface BuiltBatch {
  commitments: readonly Commitment[];
  tagLists: readonly `0x${string}`[][];
}

export interface SelectedCommitment {
  /** Gateway placeholder struct; still needs stamping. */
  commitment: Commitment;
  /** Positionally aligned tag list, validated as bytes32. */
  tags: `0x${string}`[];
  /** Index in the built batch, for diagnostics. */
  index: number;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The gateway is untrusted, so its wire shape is checked before any field is
 * read. A malformed row must produce a typed failure, not a TypeError from
 * `toLowerCase` on `undefined`.
 */
function assertBuiltShape(built: BuiltBatch): void {
  if (!Array.isArray(built.commitments) || !Array.isArray(built.tagLists)) {
    fail({ code: 'SCHEMA_VIOLATION', detail: 'gateway build response is not a batch' });
  }
  if (built.commitments.length !== built.tagLists.length) {
    // The gateway's own contract is positional alignment; a mismatch means the
    // response is malformed and no index can be trusted.
    fail({ code: 'INVALID_BATCH_SIZE' });
  }
  for (const commitment of built.commitments) {
    const value = commitment as unknown as Record<string, unknown> | null;
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.owner !== 'string' ||
      typeof value.contentHash !== 'string' ||
      typeof value.cidDigest !== 'string' ||
      typeof value.signer !== 'string' ||
      typeof value.prev !== 'string' ||
      typeof value.blockHeight !== 'bigint' ||
      typeof value.op !== 'number'
    ) {
      fail({
        code: 'SCHEMA_VIOLATION',
        detail: 'gateway returned a malformed commitment',
      });
    }
  }
  for (const list of built.tagLists) {
    if (!Array.isArray(list)) {
      fail({ code: 'SCHEMA_VIOLATION', detail: 'gateway returned a non-array tag list' });
    }
    for (const tag of list) {
      if (typeof tag !== 'string') {
        fail({ code: 'SCHEMA_VIOLATION', detail: 'gateway returned a non-string tag' });
      }
    }
  }
}

export function selectLocalCommitments(
  built: BuiltBatch,
  intents: readonly LocalCommitmentIntent[],
): SelectedCommitment[] {
  assertBuiltShape(built);

  const selected: SelectedCommitment[] = [];
  const used = new Set<number>();

  for (const intent of intents) {
    const matches: number[] = [];
    for (let index = 0; index < built.commitments.length; index += 1) {
      const commitment = built.commitments[index]!;
      if (
        sameHex(commitment.owner, intent.owner) &&
        sameHex(commitment.contentHash, intent.contentHash) &&
        sameHex(commitment.cidDigest, intent.cidDigest)
      ) {
        matches.push(index);
      }
    }

    if (matches.length === 0) {
      fail({
        code: 'STAGED_ROW_MISSING',
        owner: intent.owner,
        contentHash: intent.contentHash,
      });
    }
    if (matches.length > 1) {
      fail({
        code: 'AMBIGUOUS_BATCH_ROW',
        contentHash: intent.contentHash,
        count: matches.length,
      });
    }

    const index = matches[0]!;
    if (used.has(index)) {
      // Two intents naming the same row would sign duplicate commitments; the
      // contract rejects those, but failing here costs no gas and names the
      // real problem.
      fail({ code: 'INVALID_BATCH_SIZE' });
    }
    used.add(index);

    const tags = built.tagLists[index]!;
    for (const tag of tags) {
      if (!BYTES32.test(tag)) {
        fail({ code: 'SCHEMA_VIOLATION', detail: `tag ${tag} is not bytes32` });
      }
    }

    selected.push({ commitment: built.commitments[index]!, tags: [...tags], index });
  }

  return selected;
}
