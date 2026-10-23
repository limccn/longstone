/**
 * Indexer + depth predicates (design v0.2 §5, D5).
 *
 * Adaptive `getLogs` windows: the caller supplies a ceiling, the module adopts a
 * numeric cap the provider states, halves when it states none, treats an opaque
 * 400/413/414/422 as a range cap, and backs off on 429/transient. Numeric
 * statuses are word-bounded — a block number like `48314429` contains `429`.
 *
 * `deep` = a MemoryCommitted was seen. `active` = deep ∧ ¬retracted.
 */

import { createPublicClient, http, parseEventLogs, type PublicClient } from 'viem';
import { memoryRegistryAbi, type Commitment } from '@limccn/menhir-core';

import { fail } from './errors.js';
import { classifyError, failClassified } from './rpc-errors.js';

export interface IndexedCommitment {
  commitmentHash: `0x${string}`;
  commitment: Commitment;
  tags: string[];
  blockNumber: bigint;
  txHash: `0x${string}`;
  retracted: boolean;
  replacedBy: `0x${string}` | null;
}

export interface ChainIndex {
  byHash: Map<`0x${string}`, IndexedCommitment>;
  order: `0x${string}`[];
  scannedTo: bigint;
  /** Effective first block scanned: `max(requested, deploymentBlock)`. */
  startBlock: bigint;
  /** What the caller/config asked for; differs when clamped to deployment. */
  requestedStartBlock: bigint;
}

export interface ScanOptions {
  registryAddress: `0x${string}`;
  owner: `0x${string}`;
  /**
   * Required unless `client` is supplied. A default transport with no URL
   * fails at the first request with a confusing `UrlRequiredError`, so the
   * absence is rejected up front instead.
   */
  rpcUrl?: string;
  chainId?: number;
  fromBlock?: bigint;
  /** Initial ceiling; the scanner discovers the provider's real cap. */
  chunk?: number;
  /**
   * Growth ceiling for the adaptive window. Defaults to `chunk`, so direct
   * callers that omit it keep a fixed window; the CLI/MCP path always supplies
   * `config.scanMaxChunkBlocks`.
   */
  maxChunk?: number;
  /** Backoff injection for tests; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  client?: PublicClient;
  maxAttempts?: number;
}

const RETRYABLE = /\b(?:429|502|503|504)\b/;
const RANGE_REJECTION = /\b(?:400|413|414|422)\b|unexpected status code|block range|range is too large|limited to/i;

/**
 * Deployment-block cache, per RPC endpoint + registry.
 *
 * The floor is a property of the deployment, not of the scan, so it is
 * discovered once per process. `client`-injected scans (tests, embedders) are
 * not cached: a different client is a different chain view.
 */
const DEPLOY_BLOCK_CACHE = new Map<string, bigint>();

/**
 * Learned `getLogs` range ceiling, per RPC endpoint.
 *
 * A provider that rejected a window will reject it again, so a successful
 * convergence is remembered for the process. Only a range rejection lowers the
 * entry; transient 429/timeout failures never do.
 */
const SCAN_CAP_CACHE = new Map<string, bigint>();

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deployBlockCacheKey(options: ScanOptions): string | null {
  if (options.rpcUrl === undefined) return null;
  return `${options.rpcUrl}|${options.registryAddress.toLowerCase()}`;
}

/**
 * First block at which the registry has code.
 *
 * No contract can emit `MemoryCommitted` before it exists, so the deployment
 * block is a hard floor: scanning below it is provably empty work. The search
 * is a plain binary search over `eth_getCode` (~log2(head) calls) and handles
 * a contract that was present at genesis.
 */
export async function findDeployBlock(
  client: PublicClient,
  registryAddress: `0x${string}`,
  latest: bigint,
): Promise<bigint | null> {
  const codeAt = async (block: bigint): Promise<boolean> => {
    const code = await client.getCode({ address: registryAddress, blockNumber: block });
    return code !== undefined && code !== '0x';
  };

  if (!(await codeAt(latest))) return null;
  if (await codeAt(0n)) return 0n;

  // Invariant: no code at `lo`, code at `hi`.
  let lo = 0n;
  let hi = latest;
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (await codeAt(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function classify(message: string): 'retryable' | 'range' | 'fatal' {
  // Word-bounded so a block number containing 429 is not read as a rate limit.
  if (RETRYABLE.test(message)) return 'retryable';
  if (RANGE_REJECTION.test(message)) return 'range';
  return 'fatal';
}

/** Extract a provider-stated numeric cap, e.g. "limited to a 200 range". */
function statedCap(message: string): number | null {
  const match = /(\d[\d,]*) (?:block )?range/i.exec(message) ?? /limited to (\d[\d,]*)/i.exec(message);
  if (match === null) return null;
  const value = Number(match[1]!.replace(/,/g, ''));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Scan one owner's events with adaptive windows.
 *
 * Progress is success-only: the cursor advances by exactly the span of a
 * successful request, so a retry cannot duplicate or skip blocks.
 */
export async function scanOwner(options: ScanOptions): Promise<ChainIndex> {
  if (options.client === undefined && options.rpcUrl === undefined) {
    throw new Error('scanOwner requires either `client` or `rpcUrl`');
  }
  const client = options.client ?? createPublicClient({ transport: http(options.rpcUrl) });
  const maxAttempts = options.maxAttempts ?? 6;

  let latest: bigint;
  try {
    latest = await client.getBlockNumber();
  } catch (error) {
    // Without this, the first network failure of a scan reaches CLI/MCP as a
    // raw error (INTERNAL_ERROR at the surface) — the exact misclassification
    // this change exists to prevent.
    failClassified(error);
  }
  const configured = options.fromBlock ?? 0n;

  const key = deployBlockCacheKey(options);
  let deployment = key === null ? undefined : DEPLOY_BLOCK_CACHE.get(key);
  if (deployment === undefined) {
    let discovered: bigint | null;
    try {
      discovered = await findDeployBlock(client, options.registryAddress, latest);
    } catch (error) {
      // A getCode transport failure is an outage; a broken request is a client
      // bug. One classifier keeps this honest in both directions.
      failClassified(error);
    }
    if (discovered === null) {
      fail({
        code: 'REGISTRY_NOT_CONFIGURED',
        address: options.registryAddress,
        chainId: options.chainId ?? 0,
      });
    }
    deployment = discovered;
    if (key !== null) DEPLOY_BLOCK_CACHE.set(key, deployment);
  }

  // A configured start above head can only be stale or wrong. Returning an
  // empty index would be indistinguishable from "no memories".
  if (configured > latest) {
    fail({
      code: 'REGISTRY_NOT_CONFIGURED',
      address: options.registryAddress,
      chainId: options.chainId ?? 0,
      detail: `configured start block ${configured} is above head ${latest}`,
    });
  }

  // Hard floor: no commitment can predate the registry's code.
  const start = configured > deployment ? configured : deployment;

  // Only reachable when a cached deployment outlives a height regression
  // (e.g. a restarted dev node behind a long-lived process). Scanning would be
  // a silent no-op, so say what happened.
  if (start > latest) {
    fail({
      code: 'REGISTRY_NOT_CONFIGURED',
      address: options.registryAddress,
      chainId: options.chainId ?? 0,
      detail: `deployment block ${deployment} is above head ${latest}; the chain may have been reset`,
    });
  }

  let chunk = BigInt(options.chunk ?? 200);
  let maxChunk = BigInt(options.maxChunk ?? options.chunk ?? 200);
  const cachedCap = options.rpcUrl === undefined ? undefined : SCAN_CAP_CACHE.get(options.rpcUrl);
  if (cachedCap !== undefined) maxChunk = minBigInt(maxChunk, cachedCap);
  chunk = minBigInt(chunk, maxChunk);
  const sleep = options.sleep ?? defaultSleep;

  const byHash = new Map<`0x${string}`, IndexedCommitment>();
  const order: `0x${string}`[] = [];
  let cursor = start;
  let lastGoodChunk = 0n;
  let successStreak = 0;

  while (cursor <= latest) {
    let advanced = false;

    for (let attempt = 1; attempt <= maxAttempts && !advanced; attempt += 1) {
      // Recompute on every attempt: after a shrink the retry itself must ask
      // for the smaller span, not the window that just failed.
      const end = minBigInt(cursor + chunk - 1n, latest);
      try {
        const rawLogs = await client.getLogs({
          address: options.registryAddress,
          fromBlock: cursor,
          toBlock: end,
          // No `pending` anywhere: cursor/end are mined block numbers.
        });

        // Decode through the generated ABI: a hand-written event fragment is a
        // second copy of the event shape and would drift from the contract.
        const logs = parseEventLogs({ abi: memoryRegistryAbi, logs: rawLogs });

        for (const log of logs) {
          if (log.eventName === 'MemoryCommitted') {
            const args = log.args as unknown as {
              owner: `0x${string}`;
              commitmentHash: `0x${string}`;
              commitment: Commitment;
              tags: `0x${string}`[];
            };
            if (args.owner.toLowerCase() !== options.owner.toLowerCase()) continue;
            const entry: IndexedCommitment = {
              commitmentHash: args.commitmentHash,
              commitment: args.commitment,
              tags: args.tags.map(decodeTag),
              blockNumber: log.blockNumber ?? 0n,
              txHash: log.transactionHash ?? '0x',
              retracted: false,
              replacedBy: null,
            };
            byHash.set(args.commitmentHash, entry);
            if (!order.includes(args.commitmentHash)) order.push(args.commitmentHash);
          } else if (log.eventName === 'MemoryRetracted') {
            const args = log.args as unknown as {
              commitmentHash: `0x${string}`;
              replacedBy: `0x${string}`;
            };
            const existing = byHash.get(args.commitmentHash);
            if (existing !== undefined) {
              existing.retracted = true;
              existing.replacedBy = /^0x0{64}$/.test(args.replacedBy) ? null : args.replacedBy;
            }
          }
        }
        // Success: adopt the window and advance exactly by it.
        cursor = end + 1n;
        advanced = true;
        successStreak += 1;
        lastGoodChunk = chunk;
        if (successStreak >= 3 && chunk < maxChunk) {
          chunk = minBigInt(maxChunk, chunk * 2n);
          successStreak = 0;
        }
      } catch (error) {
        const message = (error as Error).message ?? '';
        // Two axes: the class-based classifier (is this an outage?) and the
        // existing text heuristic (does the provider hint at retry/range?).
        const transport = classifyError(error).kind === 'transport';
        const kind = classify(message);

        if (kind === 'fatal' && !transport) {
          // A permanent CLIENT failure must not disguise itself as a slow one.
          // Transport errors whose text looks fatal (a connection refusal
          // names no 429/5xx) deliberately fall through to the retry path.
          fail(
            {
              code: 'INTERNAL_ERROR',
              detail:
                `getLogs failed for blocks ${cursor}..${end} (cursor ${cursor}, chunk ${chunk}, ` +
                `${attempt} attempts): ${message}`,
            },
            { cause: error },
          );
        }
        successStreak = 0;
        const cap = statedCap(message);
        if (kind === 'range') {
          // The ceiling can only fall: a stated provider cap, the last window
          // that worked, or half the current window when nothing has worked.
          const ceiling =
            cap !== null
              ? BigInt(cap)
              : lastGoodChunk > 0n
                ? lastGoodChunk
                : maxBigInt(1n, chunk / 2n);
          maxChunk = minBigInt(maxChunk, ceiling);
          // A failed attempt never grows the next request, even when the
          // provider states a cap above the window that just failed.
          chunk = minBigInt(chunk, maxChunk);
          if (options.rpcUrl !== undefined) SCAN_CAP_CACHE.set(options.rpcUrl, maxChunk);
        } else if (kind === 'retryable' || transport) {
          // Transient: halve the current window on the first attempt, but never
          // lower the ceiling — a recovered provider may grow again.
          if (attempt === 1) chunk = maxBigInt(1n, chunk / 2n);
        }
        if (attempt >= maxAttempts) {
          fail({
            code: 'RPC_UNAVAILABLE',
            detail:
              `getLogs failed for blocks ${cursor}..${end} (cursor ${cursor}, chunk ${chunk}, ` +
              `${attempt} attempts): ${message}`,
          });
        }
        // Backoff before the next attempt; the window is recomputed above.
        await sleep(Math.min(2000, 100 * attempt));
      }
    }
  }

  return { byHash, order, scannedTo: latest, startBlock: start, requestedStartBlock: configured };
}

function decodeTag(bytes32: `0x${string}`): string {
  const hex = bytes32.slice(2);
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (byte === 0) break;
    bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function isDeep(index: ChainIndex, hash: `0x${string}`): boolean {
  return index.byHash.has(hash);
}

export function isActive(index: ChainIndex, hash: `0x${string}`): boolean {
  const entry = index.byHash.get(hash);
  return entry !== undefined && !entry.retracted;
}

export function activeHashes(index: ChainIndex): `0x${string}`[] {
  return index.order.filter((hash) => isActive(index, hash));
}
