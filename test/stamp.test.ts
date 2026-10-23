import { commitmentHash, ZERO_BYTES32, type Commitment } from '@limccn/menhir-core';
import { describe, expect, it } from 'vitest';

import { needsStamping, stampCommitments, type StampContext } from '../src/stamp.js';

const SIGNER = `0x${'11'.repeat(20)}` as const;
const OWNER = `0x${'22'.repeat(20)}` as const;
const ZERO_ADDR = `0x${'0'.repeat(40)}` as const;

function placeholder(overrides: Partial<Commitment> = {}): Commitment {
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

describe('placeholder stamping (P0-1 / R2)', () => {
  it('overwrites all three placeholders before hashing', () => {
    const before = placeholder();
    const [after] = stampCommitments([before], {
      signer: SIGNER,
      blockHeight: 123n,
      prev: `0x${'55'.repeat(32)}`,
    });

    expect(after!.signer).toBe(SIGNER);
    expect(after!.blockHeight).toBe(123n);
    expect(after!.prev).toBe(`0x${'55'.repeat(32)}`);

    // The returned hash must be of the STAMPED struct — the one that anchors.
    expect(commitmentHash(after!)).not.toBe(commitmentHash(before));
  });

  it('does not mutate the gateway’s structs', () => {
    const original = placeholder();
    stampCommitments([original], { signer: SIGNER, blockHeight: 1n, prev: ZERO_BYTES32 });
    expect(original.signer).toBe(ZERO_ADDR);
    expect(original.blockHeight).toBe(0n);
  });

  it('an unstamped struct is detected', () => {
    expect(needsStamping(placeholder())).toBe(true);
    const [stamped] = stampCommitments([placeholder()], {
      signer: SIGNER,
      blockHeight: 1n,
      prev: `0x${'66'.repeat(32)}`,
    });
    expect(needsStamping(stamped!)).toBe(false);
  });

  it('refuses to stamp with a zero signer or block height', () => {
    // Stamping with a placeholder would produce a struct that looks treated but
    // still reverts on chain — a failure that belongs at the call site.
    expect(() =>
      stampCommitments([placeholder()], { signer: ZERO_ADDR, blockHeight: 1n, prev: ZERO_BYTES32 }),
    ).toThrow();
    expect(() =>
      stampCommitments([placeholder()], { signer: SIGNER, blockHeight: 0n, prev: ZERO_BYTES32 }),
    ).toThrow();
  });

  it('stamps every row of a batch, not just the first', () => {
    const rows = [placeholder(), placeholder({ contentHash: `0x${'77'.repeat(32)}` })];
    const stamped = stampCommitments(rows, { signer: SIGNER, blockHeight: 9n, prev: ZERO_BYTES32 });
    for (const row of stamped) {
      expect(row.signer).toBe(SIGNER);
      expect(row.blockHeight).toBe(9n);
    }
  });
});

describe('prev guard (F4)', () => {
  /** Simulates a JS/embedder caller TypeScript cannot guard. */
  const context = (prev: unknown): StampContext =>
    ({ signer: SIGNER, blockHeight: 1n, prev }) as unknown as StampContext;

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a truncated value', '0x1234'],
    ['31 bytes', `0x${'55'.repeat(31)}`],
    ['a non-hex string', `0x${'zz'.repeat(32)}`],
    ['a number', 0],
  ])('rejects %s prev before encoding', (_label, prev) => {
    // Left unguarded, `prev` reaches viem's encoder and throws
    // "Cannot read properties of undefined (reading 'length')" — a message
    // that names neither the field nor the fix.
    expect(() => stampCommitments([placeholder()], context(prev))).toThrow(/bytes32 prev/);
  });

  it('names the field and the zero root in the message', () => {
    expect(() => stampCommitments([placeholder()], context(undefined))).toThrow(
      /prev.*use zero for a root/i,
    );
  });

  it('accepts the zero root', () => {
    const [stamped] = stampCommitments([placeholder()], {
      signer: SIGNER,
      blockHeight: 1n,
      prev: ZERO_BYTES32,
    });
    expect(stamped!.prev).toBe(ZERO_BYTES32);
  });

  it('accepts an uppercase 32-byte value', () => {
    const uppercase = `0x${'AA'.repeat(32)}` as const;
    const [stamped] = stampCommitments([placeholder()], {
      signer: SIGNER,
      blockHeight: 1n,
      prev: uppercase,
    });
    expect(stamped!.prev).toBe(uppercase);
  });

  it('accepts a real predecessor hash', () => {
    const prev = `0x${'55'.repeat(32)}` as const;
    const [stamped] = stampCommitments([placeholder()], {
      signer: SIGNER,
      blockHeight: 1n,
      prev,
    });
    expect(stamped!.prev).toBe(prev);
  });
});

describe('op guard', () => {
  it('rejects a non-zero op before broadcast', () => {
    // M1 anchors puts only; the contract reverts on anything else. Failing here
    // costs nothing, failing at simulation costs a round trip, and failing on
    // chain costs gas.
    const derived = placeholder({ op: 1 });
    expect(() =>
      stampCommitments([derived], { signer: SIGNER, blockHeight: 1n, prev: ZERO_BYTES32 }),
    ).toThrow(/unsupported op 1/);
  });

  it('accepts op 0', () => {
    expect(() =>
      stampCommitments([placeholder()], { signer: SIGNER, blockHeight: 1n, prev: ZERO_BYTES32 }),
    ).not.toThrow();
  });
});
