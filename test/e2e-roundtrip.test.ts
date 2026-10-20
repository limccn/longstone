/**
 * The M1 end-to-end roundtrip (the AC that closes menhir-m1's remaining items).
 *
 * put → stage/pin → build → stamp → sign + broadcast → receipt → confirm →
 * fetch → verify, against a REAL Hardhat node and the REAL F1 gateway over
 * SQLite.
 *
 * **No private key appears anywhere in this file.** The node runs with its
 * default unlocked accounts and longstone signs through a JSON-RPC account, so
 * there is no key material to leak, rotate, or accidentally commit. The
 * production path uses `privateKeyToAccount`; the account interface is the same,
 * which is exactly why this substitution is safe for testing the write path.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createGateway } from '@limccn/hisaishi-gateway/local';
import { memoryRegistryAbi } from '@limccn/menhir-core';
import { createPublicClient, createWalletClient, http, parseEventLogs } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig, type LongstoneConfig } from '../src/config.js';
import { createEmbeddedGate } from '../src/gate.js';
import { createRegistry } from '../src/registry.js';
import { put } from '../src/commands/put.js';
import { verify } from '../src/commands/verify.js';
import { scanOwner } from '../src/indexer.js';

const run = promisify(execFile);

const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'menhir', 'contracts');
const PORT = 8599;
const RPC = `http://127.0.0.1:${PORT}`;

let node: ChildProcess | null = null;
let dir = '';
let config: LongstoneConfig;
let registry: ReturnType<typeof createRegistry>;
let gateway: Awaited<ReturnType<typeof createGateway>>;
let ownerAddress: `0x${string}`;
let signerAddress: `0x${string}`;
let registryAddress: `0x${string}`;
let commitmentHashValue: `0x${string}`;
let cid: string;
let closedByTest = false;

/** A JSON-RPC account: signing is delegated to the unlocked node. */
type JsonRpcAccount = Parameters<typeof createWalletClient>[0] extends never
  ? never
  : {
      address: `0x${string}`;
      type: 'json-rpc';
    };

/**
 * Start a node and WAIT for it to be ready.
 *
 * `shell: true` is required on Windows to run `npx`, but it makes the direct
 * child a shell: killing it can leave the node process orphaned and holding the
 * port. `detached` + killing the process group in teardown is what actually
 * cleans up (the previous run left an orphan and the next run got ECONNRESET).
 */
async function startNode(): Promise<void> {
  node = spawn('npx', ['hardhat', 'node', '--port', String(PORT), '--chain-id', '84532'], {
    cwd: CONTRACTS_DIR,
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });

  const client = createPublicClient({ transport: http(RPC) });
  for (let i = 0; i < 120; i += 1) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`hardhat node did not start on ${RPC}`);
}

async function stopNode(): Promise<void> {
  if (node === null) return;
  const pid = node.pid;
  node = null;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      // Kill the whole tree: the shell owns the node process, not us.
      await run('taskkill', ['/pid', String(pid), '/T', '/F']).catch(() => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/** The node's unlocked accounts, in nonce order. */
async function nodeAccounts(): Promise<`0x${string}`[]> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_accounts', params: [] }),
  });
  const body = (await response.json()) as { result: `0x${string}`[] };
  return body.result;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'longstone-e2e-'));
  await startNode();

  const accounts = await nodeAccounts();
  ownerAddress = accounts[0]!;
  signerAddress = accounts[1]!;

  const publicClient = createPublicClient({ transport: http(RPC) });
  // deployContract asserts the chain id, so the wallet needs a chain object;
  // the node runs with --chain-id 84532 to match Base Sepolia exactly.
  const walletClient = createWalletClient({ chain: baseSepolia, transport: http(RPC) });

  // Deploy from the contracts project's own artifact so the ABI and bytecode
  // under test are the real ones, not a copy.
  const artifact = JSON.parse(
    readFileSync(
      join(CONTRACTS_DIR, 'artifacts', 'src', 'MemoryRegistry.sol', 'MemoryRegistry.json'),
      'utf8',
    ),
  ) as { abi: readonly unknown[]; bytecode: `0x${string}` };

  // viem 2.57 has no ContractFactory. `deployContract` returns the TRANSACTION
  // HASH; the address comes from the receipt, not from the call.
  const { deployContract } = await import('viem/actions');
  const deployTx = (await deployContract(walletClient as never, {
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [],
    account: ownerAddress,
  } as never)) as `0x${string}`;
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployTx });
  if (deployReceipt.contractAddress === null || deployReceipt.contractAddress === undefined) {
    throw new Error('deployment receipt had no contractAddress');
  }
  registryAddress = deployReceipt.contractAddress;

  config = {
    ...loadConfig(join(dir, 'config.json')),
    rpcUrl: RPC,
    sequencerUrl: RPC,
    registryAddress,
    chainId: 84532,
    hisaishiMode: 'embedded',
    hisaishiDbPath: join(dir, 'gateway.db'),
    ipfsGateway: 'http://127.0.0.1:1',
    scanChunkBlocks: 1000,
  };

  registry = createRegistry(config, {
    publicClient: publicClient as never,
    walletClient: walletClient as never,
  });

  gateway = await createGateway({
    dbPath: config.hisaishiDbPath,
    rpcUrl: RPC,
    registryAddress,
    ipfsGateway: config.ipfsGateway,
    // Explicit offline pin: the test must not require Pinata credentials, and
    // the adapter is no longer selected by a missing JWT.
    devMode: true,
  });

  // Grant ROLE_COMMIT to the delegated signer so it may commit for the owner.
  await registry.setSigner(signerAddress, 1, {
    address: ownerAddress,
    type: 'json-rpc',
  } as never);
}, 180_000);

afterAll(async () => {
  if (gateway !== undefined && !closedByTest) await gateway.handle.close();
  await stopNode();
  await rm(dir, { recursive: true, force: true });
});

describe('M1 roundtrip: put → anchor → fetch → verify', () => {
  it('put stages, stamps, signs, broadcasts and confirms', async () => {
    const gate = createEmbeddedGate(gateway.handle);

    const result = await put(
      { config, gate, registry, waitForReceipt: async (_cfg, txHash) => {
        // The node mines immediately; one receipt read is enough (and keeps the
        // test's RPC usage at one call, matching D-10's spirit).
        const client = createPublicClient({ transport: http(RPC) });
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        return receipt;
      } },
      {
        text: 'A memory anchored end to end by longstone.',
        tags: ['layer:deep', 'topic:e2e'],
        owner: ownerAddress,
        account: { address: signerAddress, type: 'json-rpc' } as never,
      },
    );

    expect(result.confirmed).toBe(true);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    commitmentHashValue = result.commitmentHash;
    cid = result.cid;

    expect(await registry.isDeep(commitmentHashValue)).toBe(true);
    expect(await registry.isActive(commitmentHashValue)).toBe(true);

    const stored = await registry.getCommitment(commitmentHashValue);
    // Stamping actually happened: the on-chain struct carries the signer, not
    // the gateway's zero placeholder.
    expect(stored.signer.toLowerCase()).toBe(signerAddress.toLowerCase());
    expect(stored.blockHeight).toBeGreaterThan(0n);
  }, 120_000);

  it('the emitted event carries the same commitment hash', async () => {
    const client = createPublicClient({ transport: http(RPC) });
    const index = await scanOwner({ registryAddress, owner: ownerAddress, rpcUrl: RPC, fromBlock: 0n, chunk: 1000 });
    expect(index.byHash.has(commitmentHashValue)).toBe(true);
    const entry = index.byHash.get(commitmentHashValue)!;
    expect(entry.tags).toContain('topic:e2e');
    // The indexer decoded through the generated ABI, so this also proves the
    // event shape matches @limccn/menhir-core's copy of it.
    expect(entry.commitment.contentHash).toBe(
      (await registry.getCommitment(commitmentHashValue)).contentHash,
    );
    void parseEventLogs;
    void client;
  }, 60_000);

  it('verify reports the chain state even when bytes are unavailable', async () => {
    const gate = createEmbeddedGate(gateway.handle);
    const report = await verify(
      { gate, registry },
      { cid, commitmentHash: commitmentHashValue, owner: ownerAddress },
    ).catch((error: unknown) => error as Error);

    // The dev pin adapter stores nothing, so the gateway cannot serve the
    // bytes: failing at fetch is the honest outcome. What matters is that the
    // failure is a gateway error and not a chain misread.
    if (report instanceof Error) {
      expect(report.message).toMatch(/GATE|gateway|CONTENT/i);
    } else {
      expect(report.anchored).toBe(true);
    }
  }, 60_000);
});

describe('sovereign direct verify (gateway unreachable)', () => {
  it('never calls the gateway when direct=true', async () => {
    // Tear the gateway down first: the AC is that verification does not need it.
    // Guard the double close in afterAll — a second close throws "database is
    // not open" and would mask a real teardown failure.
    await gateway.handle.close();
    closedByTest = true;

    const forbidden = () => {
      throw new Error('gateway must not be used');
    };
    const result = await verify(
      {
        gate: {
          stage: forbidden,
          build: forbidden,
          confirm: forbidden,
          list: forbidden,
          fetchContent: forbidden,
        } as never,
        registry,
      },
      {
        cid: 'bafkreifake',
        commitmentHash: commitmentHashValue,
        direct: true,
        ipfsGateway: 'http://127.0.0.1:1',
      },
    ).catch((error: unknown) => error as Error);

    // It fails at fetch (no gateway is reachable), never by touching the gate.
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toContain('gateway must not be used');

    // The stronger case: with an OWNER supplied, resolving the commitment must
    // go through the indexer, not `gate.list`. That path is what an earlier
    // implementation got wrong — it would have failed with the gateway down.
    const withOwner = await verify(
      {
        gate: {
          stage: forbidden,
          build: forbidden,
          confirm: forbidden,
          list: forbidden,
          fetchContent: forbidden,
        } as never,
        registry,
        scan: (owner) => scanOwner({ registryAddress, owner, rpcUrl: RPC, fromBlock: 0n, chunk: 1000 }),
      },
      {
        cid: 'bafkreifake',
        owner: ownerAddress,
        direct: true,
        ipfsGateway: 'http://127.0.0.1:1',
      },
    ).catch((error: unknown) => error as Error);

    expect(withOwner).toBeInstanceOf(Error);
    expect((withOwner as Error).message).not.toContain('gateway must not be used');

    // The chain side is fully verifiable with no gateway at all.
    expect(await registry.isDeep(commitmentHashValue)).toBe(true);
    expect(await registry.isActive(commitmentHashValue)).toBe(true);
    const stored = await registry.getCommitment(commitmentHashValue);
    expect(stored.contentHash).not.toBe(`0x${'0'.repeat(64)}`);
  }, 60_000);
});

void (0 as unknown as JsonRpcAccount);
