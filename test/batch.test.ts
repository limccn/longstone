import { ZERO_BYTES32, type Commitment } from '@limccn/menhir-core';
import { describe, expect, it } from 'vitest';

import { selectLocalCommitments } from '../src/batch.js';
import { LongstoneFailure } from '../src/errors.js';

const OWNER = `0x${'11'.repeat(20)}` as const;
const ZERO_ADDR = `0x${'0'.repeat(40)}` as const;

function commitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    owner: OWNER,
    contentHash: `0x${'33'.repeat(32)}`,
    cidDigest: `0x${'44'.repeat(32)}`,
    signer: ZERO_ADDR,
    blockHeight: 0n,
    op: 0,
    prev: ZERO_BYTES32,
    ...overrides,
  };
}

function intent(overrides: Partial<Parameters<typeof selectLocalCommitments>[1][number]> = {}) {
  return {
    owner: OWNER,
    contentHash: commitment().contentHash,
    cidDigest: commitment().cidDigest,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LongstoneFailure) return error.error.code;
    throw error;
  }
  throw new Error('expected a LongstoneFailure');
}

describe('selectLocalCommitments — H-1 trust boundary', () => {
  it('selects only the locally computed commitment and its aligned tag list', () => {
    const attacker = commitment({
      owner: OWNER,
      contentHash: `0x${'aa'.repeat(32)}`,
      cidDigest: `0x${'bb'.repeat(32)}`,
    });
    const mine = commitment();
    const selected = selectLocalCommitments(
      {
        commitments: [attacker, mine],
        tagLists: [[`0x${'01'.repeat(32)}`], [`0x${'02'.repeat(32)}`]],
      },
      [intent()],
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]!.index).toBe(1);
    expect(selected[0]!.commitment.contentHash).toBe(mine.contentHash);
    expect(selected[0]!.tags).toEqual([`0x${'02'.repeat(32)}`]);
  });

  it('fails closed when the local commitment is absent', () => {
    const attacker = commitment({ contentHash: `0x${'aa'.repeat(32)}`, cidDigest: `0x${'bb'.repeat(32)}` });
    expect(() =>
      selectLocalCommitments({ commitments: [attacker], tagLists: [[]] }, [intent()]),
    ).toThrow(LongstoneFailure);
    expect(() =>
      selectLocalCommitments({ commitments: [attacker], tagLists: [[]] }, [intent()]),
    ).toThrow(/STAGED_ROW_MISSING|locally computed/);
  });

  it('refuses an ambiguous duplicate instead of guessing', () => {
    const mine = commitment();
    const code = codeOf(() =>
      selectLocalCommitments({ commitments: [mine, mine], tagLists: [[], []] }, [intent()]),
    );
    expect(code).toBe('AMBIGUOUS_BATCH_ROW');
  });

  it('rejects a tag list that is not bytes32', () => {
    expect(() =>
      selectLocalCommitments(
        { commitments: [commitment()], tagLists: [['not-a-tag' as `0x${string}`]] },
        [intent()],
      ),
    ).toThrow(/not bytes32/);
  });

  it('rejects positional misalignment', () => {
    const code = codeOf(() =>
      selectLocalCommitments({ commitments: [commitment()], tagLists: [] }, [intent()]),
    );
    expect(code).toBe('INVALID_BATCH_SIZE');
  });

  it('turns a malformed gateway row into a typed failure, not a TypeError', () => {
    const malformed = { owner: undefined } as unknown as Commitment;
    const code = codeOf(() =>
      selectLocalCommitments({ commitments: [malformed], tagLists: [[]] }, [intent()]),
    );
    expect(code).toBe('SCHEMA_VIOLATION');
  });

  it('turns a non-array tag list into a typed failure', () => {
    const code = codeOf(() =>
      selectLocalCommitments(
        { commitments: [commitment()], tagLists: [null as unknown as `0x${string}`[]] },
        [intent()],
      ),
    );
    expect(code).toBe('SCHEMA_VIOLATION');
  });

  it('selects multiple intents by index, never by gateway order', () => {
    const a = commitment({ contentHash: `0x${'aa'.repeat(32)}`, cidDigest: `0x${'ab'.repeat(32)}` });
    const b = commitment({ contentHash: `0x${'bb'.repeat(32)}`, cidDigest: `0x${'bc'.repeat(32)}` });
    const selected = selectLocalCommitments(
      { commitments: [b, a], tagLists: [[], []] },
      [
        { owner: OWNER, contentHash: a.contentHash, cidDigest: a.cidDigest },
        { owner: OWNER, contentHash: b.contentHash, cidDigest: b.cidDigest },
      ],
    );
    expect(selected.map((s) => s.index)).toEqual([1, 0]);
    expect(selected.map((s) => s.commitment.contentHash)).toEqual([a.contentHash, b.contentHash]);
  });

  it('does not accept a row whose cidDigest differs even when the contentHash matches', () => {
    const moved = commitment({ cidDigest: `0x${'99'.repeat(32)}` });
    const code = codeOf(() =>
      selectLocalCommitments({ commitments: [moved], tagLists: [[]] }, [intent()]),
    );
    expect(code).toBe('STAGED_ROW_MISSING');
  });
});
