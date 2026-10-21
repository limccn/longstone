/**
 * Wire the CLI/MCP runtime: config → transports → command dependencies.
 *
 * This is the only place that decides where a handle comes from. Commands stay
 * transport-agnostic, so the embedded and HTTP forms cannot diverge in logic.
 */

import { createGateway } from '@limccn/hisaishi-gateway/local';

import type { LongstoneConfig } from './config.js';
import { createGate, type GateClient } from './gate.js';
import { createRegistry, type RegistryClient } from './registry.js';
import { scanOwner, type ChainIndex } from './indexer.js';
import { loadKeys, type KeyNeed, type Keybox } from './keybox.js';

export interface CommandContext {
  config: LongstoneConfig;
  gate: GateClient;
  registry: RegistryClient;
  keys: Keybox | null;
  scan: (owner: `0x${string}`) => Promise<ChainIndex>;
  close(): Promise<void>;
}

export interface ContextOptions {
  config: LongstoneConfig;
  /** Which key the command needs; `false` loads none. */
  requireKeys?: KeyNeed;
  env?: NodeJS.ProcessEnv;
}

export async function createContext(options: ContextOptions): Promise<CommandContext> {
  const { config } = options;
  const env = options.env ?? process.env;

  let gate: GateClient;
  let close = async (): Promise<void> => {};

  if (config.hisaishiMode === 'embedded' || config.hisaishiMode === 'local') {
    // Both non-remote modes need an F1 process. `embedded` runs it in-process;
    // `local` would spawn a child, which M1 does not implement — fail honestly
    // rather than silently behaving like `embedded`.
    if (config.hisaishiMode === 'local') {
      throw new Error(
        'hisaishiMode=local (spawn a standalone server) is not implemented in M1; ' +
          'use embedded, or start `hisaishi-local` and set hisaishiMode=remote',
      );
    }
    const opened = await createGateway({
      dbPath: config.hisaishiDbPath,
      rpcUrl: config.rpcUrl,
      registryAddress: config.registryAddress,
      ipfsGateway: config.ipfsGateway,
      devMode: env.DEV_MODE === 'true',
    });
    gate = await createGate(config, opened.handle);
    close = async () => opened.handle.close();
  } else {
    gate = await createGate(config);
  }

  const registry = createRegistry(config);

  return {
    config,
    gate,
    registry,
    keys:
      options.requireKeys === undefined || options.requireKeys === false
        ? null
        : loadKeys(env, options.requireKeys),
    scan: (owner) =>
      scanOwner({
        registryAddress: config.registryAddress,
        owner,
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        chunk: config.scanChunkBlocks,
        ...(config.scanStartBlock > 0 ? { fromBlock: BigInt(config.scanStartBlock) } : {}),
      }),
    close,
  };
}
