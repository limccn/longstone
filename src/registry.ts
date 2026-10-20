/**
 * Registry client (design v0.2 §2, D4/D6/D7).
 *
 * A thin viem wrapper over `@limccn/menhir-core`'s generated ABI. Three rules live
 * here and nowhere else:
 *
 *   - revert data is decoded against the ABI (never surfaced raw);
 *   - `getTransactionCount` takes a BLOCK NUMBER, never the `pending` tag;
 *   - a `NotAuthorized` failure tells the caller to grant the role.
 */

import {
  encodeFunctionData,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { memoryRegistryAbi, type Commitment } from '@limccn/menhir-core';
import type { PrivateKeyAccount } from 'viem/accounts';

import type { LongstoneConfig } from './config.js';
import { fail, fromContractError } from './errors.js';

export interface RegistryClient {
  getCommitment(hash: `0x${string}`): Promise<Commitment>;
  isDeep(hash: `0x${string}`): Promise<boolean>;
  isActive(hash: `0x${string}`): Promise<boolean>;
  replacedByOf(hash: `0x${string}`): Promise<`0x${string}`>;
  rolesOf(owner: `0x${string}`, signer: `0x${string}`): Promise<bigint>;
  blockNumber(): Promise<bigint>;
  /** Simulate, then broadcast. Both go through the sequencer for writes. */
  commitBatch(
    commitments: readonly Commitment[],
    tagLists: `0x${string}`[][],
    account: PrivateKeyAccount,
  ): Promise<`0x${string}`>;
  retract(
    hash: `0x${string}`,
    replacedBy: `0x${string}`,
    account: PrivateKeyAccount,
  ): Promise<`0x${string}`>;
  setSigner(
    signer: `0x${string}`,
    roles: number,
    account: PrivateKeyAccount,
  ): Promise<`0x${string}`>;
}

/** Translate a viem error into the typed union, never a raw revert string. */
function translate(error: unknown): never {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? 'unknown';
      fail(fromContractError(name, reverted.data?.args));
    }
  }
  fail({ code: 'RPC_UNAVAILABLE', detail: (error as Error).message });
}

/**
 * Sign locally, broadcast a raw transaction.
 *
 * The sequencer endpoint accepts **only** `eth_sendRawTransaction` (M1-18).
 * viem's `writeContract` prepares a transaction first (`eth_chainId`,
 * `eth_estimateGas`, `eth_getTransactionCount`), and those calls are rejected
 * there — the failure reads "rpc method is not allowed". So every field is
 * prepared against the general endpoint and the write path is reduced to one
 * `sendRawTransaction`.
 */
async function prepareAndSend(
  publicClient: PublicClient,
  broadcastClient: PublicClient,
  walletClient: WalletClient,
  account: PrivateKeyAccount | { address: `0x${string}`; type: 'json-rpc' },
  request: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[] },
): Promise<`0x${string}`> {
  // Simulate on the general endpoint: an unauthorized signer, a duplicate or a
  // bad prev fails here without spending gas.
  await publicClient.simulateContract({
    address: request.address,
    abi: request.abi as never,
    functionName: request.functionName,
    args: request.args as never,
    account,
  });

  // The ABI is `memoryRegistryAbi`, so the function name and args are known at
  // runtime; the casts keep the generic call site readable.
  const data = encodeFunctionData({
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
  } as never);

  // Prepare every field on the GENERAL endpoint. The sequencer accepts only
  // `eth_sendRawTransaction` (M1-18), so nothing may be filled in there — viem's
  // `writeContract` would call `eth_chainId`/`eth_estimateGas` and fail with
  // "rpc method is not allowed".
  const prepared = await publicClient.prepareTransactionRequest({
    account,
    to: request.address,
    data,
    chain: null,
  } as never);

  // Production uses a LOCAL account: sign here (model A), then hand the raw
  // bytes to the sequencer. A JSON-RPC account (local Hardhat tests) has no
  // `signTransaction`; there the node signs, so the normal write path is used.
  if ('signTransaction' in account && typeof account.signTransaction === 'function') {
    const serialized = await account.signTransaction(prepared as never);
    return broadcastClient.sendRawTransaction({ serializedTransaction: serialized });
  }

  return walletClient.writeContract({
    address: request.address,
    abi: request.abi as never,
    functionName: request.functionName as never,
    args: request.args as never,
    account: account as never,
    chain: null,
  } as never);
}

export function createRegistry(
  config: LongstoneConfig,
  /** Override for tests; production uses the configured endpoints. */
  clients?: { publicClient?: PublicClient; walletClient?: WalletClient },
): RegistryClient {
  const publicClient =
    clients?.publicClient ??
    (createPublicClient({ transport: http(config.rpcUrl) }) as unknown as PublicClient);

  // Reads go to the general endpoint; writes go to the sequencer, which accepts
  // ONLY eth_sendRawTransaction (M1-18).
  // A public client pointed at the sequencer, used ONLY for
  // `eth_sendRawTransaction` (M1-18). Any other call there is rejected.
  const broadcastClient =
    clients?.publicClient ??
    (createPublicClient({ transport: http(config.sequencerUrl) }) as unknown as PublicClient);

  // Used only for JSON-RPC accounts (local tests): the node signs, so the
  // normal viem write path is appropriate there.
  const walletClient =
    clients?.walletClient ??
    (createWalletClient({ transport: http(config.rpcUrl) }) as unknown as WalletClient);

  const address = config.registryAddress;
  const abi = memoryRegistryAbi;

  return {
    async getCommitment(hash) {
      try {
        return (await publicClient.readContract({
          address,
          abi,
          functionName: 'getCommitment',
          args: [hash],
        })) as unknown as Commitment;
      } catch (error) {
        translate(error);
      }
    },

    async isDeep(hash) {
      try {
        return (await publicClient.readContract({ address, abi, functionName: 'isDeep', args: [hash] })) as boolean;
      } catch (error) {
        translate(error);
      }
    },

    async isActive(hash) {
      try {
        return (await publicClient.readContract({ address, abi, functionName: 'isActive', args: [hash] })) as boolean;
      } catch (error) {
        translate(error);
      }
    },

    async replacedByOf(hash) {
      try {
        return (await publicClient.readContract({
          address,
          abi,
          functionName: 'replacedByOf',
          args: [hash],
        })) as `0x${string}`;
      } catch (error) {
        translate(error);
      }
    },

    async rolesOf(owner, signer) {
      try {
        return (await publicClient.readContract({
          address,
          abi,
          functionName: 'rolesOf',
          args: [owner, signer],
        })) as bigint;
      } catch (error) {
        translate(error);
      }
    },

    async blockNumber() {
      try {
        return await publicClient.getBlockNumber();
      } catch (error) {
        translate(error);
      }
    },

    async commitBatch(commitments, tagLists, account) {
      const args = [commitments, tagLists] as const;
      try {
        return await prepareAndSend(publicClient, broadcastClient, walletClient, account, {
          address,
          abi,
          functionName: 'commitBatch',
          args,
        });
      } catch (error) {
        translate(error);
      }
    },

    async retract(hash, replacedBy, account) {
      try {
        return await prepareAndSend(publicClient, broadcastClient, walletClient, account, {
          address,
          abi,
          functionName: 'retract',
          args: [hash, replacedBy],
        });
      } catch (error) {
        translate(error);
      }
    },

    async setSigner(signer, roles, account) {
      try {
        return await prepareAndSend(publicClient, broadcastClient, walletClient, account, {
          address,
          abi,
          functionName: 'setSigner',
          args: [signer, BigInt(roles)],
        });
      } catch (error) {
        translate(error);
      }
    },
  };
}

/**
 * Poll a receipt. Never the `pending` tag (M1-7), bounded attempts, and the
 * caller decides how long to wait.
 */
export async function waitForReceipt(
  config: LongstoneConfig,
  txHash: `0x${string}`,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<Awaited<ReturnType<PublicClient['getTransactionReceipt']>>> {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const attempts = options.attempts ?? 30;
  const interval = options.intervalMs ?? 1000;

  for (let i = 0; i < attempts; i += 1) {
    const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (receipt !== null) return receipt;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  fail({ code: 'RPC_UNAVAILABLE', detail: `no receipt for ${txHash} after ${attempts} attempts` });
}
