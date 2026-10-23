/**
 * F5 — the classifier's only job: decide whether a failure is a contract
 * revert, a transport outage, or a client-side bug. No network.
 */

import { memoryRegistryAbi } from '@limccn/menhir-core';
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InternalRpcError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  ResourceUnavailableRpcError,
  SocketClosedError,
  TimeoutError,
  UnknownRpcError,
  WebSocketRequestError,
  encodeErrorResult,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { LongstoneFailure } from '../src/errors.js';
import { classifyError, classifyToLongstoneError, failClassified } from '../src/rpc-errors.js';

const URL = 'https://rpc.example/v2/SECRETKEY?apikey=xyz';
const OWNER = `0x${'22'.repeat(20)}` as const;
const SIGNER = `0x${'11'.repeat(20)}` as const;

function httpError(status?: number): HttpRequestError {
  return new HttpRequestError({
    url: URL,
    ...(status === undefined ? {} : { status }),
  });
}

/** A decodable revert; a 4-byte-only selector makes viem's decoder throw. */
function notAuthorizedRevert(): ContractFunctionRevertedError {
  const data = encodeErrorResult({
    abi: memoryRegistryAbi,
    errorName: 'NotAuthorized',
    args: [OWNER, SIGNER, 1n],
  });
  return new ContractFunctionRevertedError({
    abi: memoryRegistryAbi,
    data,
    functionName: 'commitBatch',
  });
}

describe('classifyError — transport', () => {
  it('classifies HttpRequestError 429 as transport', () => {
    expect(classifyError(httpError(429)).kind).toBe('transport');
  });

  it('classifies HttpRequestError 503 as transport', () => {
    expect(classifyError(httpError(503)).kind).toBe('transport');
  });

  it('classifies a connection failure (no status) as transport', () => {
    // A real connection refusal surfaces as HttpRequestError with no status,
    // NOT as a bare TypeError (verified against viem 2.57.7).
    expect(classifyError(httpError()).kind).toBe('transport');
  });

  it('classifies TimeoutError as transport', () => {
    expect(classifyError(new TimeoutError({ body: {}, url: URL })).kind).toBe('transport');
  });

  it.each([
    ['SocketClosedError', () => new SocketClosedError({ url: URL })],
    ['WebSocketRequestError', () => new WebSocketRequestError({ url: URL })],
    ['LimitExceededRpcError', () => new LimitExceededRpcError(new Error('-32005'))],
    ['ResourceUnavailableRpcError', () => new ResourceUnavailableRpcError(new Error('-32002'))],
    ['InternalRpcError', () => new InternalRpcError(new Error('-32603'))],
    ['UnknownRpcError', () => new UnknownRpcError(new Error('-32000'))],
  ])('classifies %s as transport', (_name, build) => {
    expect(classifyError(build()).kind).toBe('transport');
  });

  it('finds a transport failure through the cause chain (walk)', () => {
    const wrapped = new BaseError('rpc request failed', { cause: httpError(503) });
    expect(classifyError(wrapped).kind).toBe('transport');
  });

  it('finds a transport failure wrapped in ContractFunctionExecutionError', () => {
    const wrapped = new ContractFunctionExecutionError(httpError(), {
      abi: memoryRegistryAbi,
      args: [],
      functionName: 'commitBatch',
    });
    expect(classifyError(wrapped).kind).toBe('transport');
  });
});

describe('classifyError — internal (client bugs)', () => {
  it('classifies a TypeError as internal and keeps the class in detail', () => {
    const classified = classifyError(
      new TypeError("Cannot read properties of undefined (reading 'length')"),
    );
    expect(classified).toMatchObject({ kind: 'internal' });
    expect((classified as { detail: string }).detail).toMatch(/^TypeError: /);
  });

  it('classifies a plain Error as internal', () => {
    const classified = classifyError(new Error('boom'));
    expect(classified).toMatchObject({ kind: 'internal', detail: 'Error: boom' });
  });

  it('classifies a non-Error throw as internal', () => {
    expect(classifyError('boom')).toMatchObject({ kind: 'internal', detail: 'boom' });
  });

  it('classifies HttpRequestError 400 as internal (do not retry a bad request)', () => {
    expect(classifyError(httpError(400)).kind).toBe('internal');
  });

  it('classifies InvalidParamsRpcError as internal', () => {
    expect(classifyError(new InvalidParamsRpcError(new Error('bad params'))).kind).toBe('internal');
  });
});

describe('classifyError — contract reverts', () => {
  it('classifies a decoded revert with its name and args', () => {
    const classified = classifyError(notAuthorizedRevert());
    expect(classified).toMatchObject({ kind: 'contract', name: 'NotAuthorized' });
    expect((classified as { args: readonly unknown[] }).args).toEqual([OWNER, SIGNER, 1n]);
  });

  it('finds a revert nested in ContractFunctionExecutionError', () => {
    const wrapped = new ContractFunctionExecutionError(notAuthorizedRevert(), {
      abi: memoryRegistryAbi,
      args: [],
      functionName: 'commitBatch',
    });
    expect(classifyError(wrapped)).toMatchObject({ kind: 'contract', name: 'NotAuthorized' });
  });
});

describe('classifyToLongstoneError', () => {
  it('maps transport to RPC_UNAVAILABLE', () => {
    expect(classifyToLongstoneError(httpError(503))).toMatchObject({
      code: 'RPC_UNAVAILABLE',
    });
  });

  it('maps internal to INTERNAL_ERROR', () => {
    expect(classifyToLongstoneError(new TypeError('x is not a function'))).toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('maps a revert to its contract code', () => {
    expect(classifyToLongstoneError(notAuthorizedRevert())).toEqual({
      code: 'NOT_AUTHORIZED',
      role: 'commit',
    });
  });
});

describe('failClassified', () => {
  it('passes an existing LongstoneFailure through as the same instance', () => {
    const original = new LongstoneFailure({ code: 'NO_KEY', detail: 'absent' });
    try {
      failClassified(original);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  it('keeps the original error as cause for INTERNAL_ERROR', () => {
    const original = new TypeError('bad encoding');
    try {
      failClassified(original);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LongstoneFailure);
      const typed = error as LongstoneFailure;
      expect(typed.error.code).toBe('INTERNAL_ERROR');
      expect(typed.cause).toBe(original);
    }
  });

  it('does not attach a cause to transport errors (URL redaction stays a string)', () => {
    const original = httpError(503);
    try {
      failClassified(original);
      expect.unreachable('must throw');
    } catch (error) {
      const typed = error as LongstoneFailure;
      expect(typed.error.code).toBe('RPC_UNAVAILABLE');
      expect(typed.cause).toBeUndefined();
      expect(JSON.stringify(typed.error)).not.toContain('SECRETKEY');
    }
  });
});
