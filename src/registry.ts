/**
 * Registry client (design v0.2 §2, D4/D6/D7).
 *
 * A thin viem wrapper over `@menhir/core`'s generated ABI. Three rules live
 * here and nowhere else:
 *
 *   - revert data is decoded against the ABI (never surfaced raw);
 *   - `getTransactionCount` takes a BLOCK NUMBER, never the `pending` tag;
 *   - a `NotAuthorized` failure tells the caller to grant the role.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { memoryRegistryAbi, type Commitment } from '@menhir/core';
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
  const walletClient =
    clients?.walletClient ??
    (createWalletClient({ transport: http(config.sequencerUrl) }) as unknown as WalletClient);

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
        // Simulate first: an unauthorized signer, a duplicate, or a bad prev
        // fails here without spending gas.
        await publicClient.simulateContract({
          address,
          abi,
          functionName: 'commitBatch',
          args: args as never,
          account,
        });
        return await walletClient.writeContract({
          address,
          abi,
          functionName: 'commitBatch',
          args: args as never,
          account,
          chain: null,
        });
      } catch (error) {
        translate(error);
      }
    },

    async retract(hash, replacedBy, account) {
      try {
        await publicClient.simulateContract({
          address,
          abi,
          functionName: 'retract',
          args: [hash, replacedBy],
          account,
        });
        return await walletClient.writeContract({
          address,
          abi,
          functionName: 'retract',
          args: [hash, replacedBy],
          account,
          chain: null,
        });
      } catch (error) {
        translate(error);
      }
    },

    async setSigner(signer, roles, account) {
      try {
        await publicClient.simulateContract({
          address,
          abi,
          functionName: 'setSigner',
          args: [signer, BigInt(roles)],
          account,
        });
        return await walletClient.writeContract({
          address,
          abi,
          functionName: 'setSigner',
          args: [signer, BigInt(roles)],
          account,
          chain: null,
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
