/**
 * Configuration (design v0.2 §8).
 *
 * Precedence: CLI flags > environment > config file > defaults. Keys are never
 * stored here — they come from env only, because a config file gets copied,
 * shared and committed by accident.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type HisaishiMode = 'remote' | 'local' | 'embedded' | 'direct-rpc';

export interface LongstoneConfig {
  rpcUrl: string;
  sequencerUrl: string;
  registryAddress: `0x${string}`;
  chainId: number;
  hisaishiMode: HisaishiMode;
  hisaishiBaseUrl: string;
  hisaishiDbPath: string;
  ipfsGateway: string;
  scanChunkBlocks: number;
}

/** Defaults for Base Sepolia (menhir spec §10.5 endpoints). */
export const DEFAULTS: LongstoneConfig = {
  rpcUrl: 'https://sepolia.base.org',
  sequencerUrl: 'https://sepolia-sequencer.base.org',
  registryAddress: '0xC85ed11d3065739F1829A114e420584bEC3FDFEF',
  chainId: 84532,
  hisaishiMode: 'embedded',
  hisaishiBaseUrl: '',
  hisaishiDbPath: '.longstone/hisaishi.db',
  // Empty means "not configured": verify still works via the hisaishi proxy or
  // `--direct` with an explicit gateway, and the UI shows an honest empty state
  // rather than silently substituting a public host (M1-9).
  ipfsGateway: '',
  scanChunkBlocks: 200,
};

export const CONFIG_PATH = '.longstone/config.json';

export function loadConfig(path = CONFIG_PATH, env: NodeJS.ProcessEnv = process.env): LongstoneConfig {
  let file: Partial<LongstoneConfig> = {};
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Partial<LongstoneConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const merged: LongstoneConfig = {
    ...DEFAULTS,
    ...file,
    // Environment wins over the file, which is the order an operator expects
    // when overriding for one run.
    ...(env.LONGSTONE_RPC_URL === undefined ? {} : { rpcUrl: env.LONGSTONE_RPC_URL }),
    ...(env.LONGSTONE_REGISTRY_ADDRESS === undefined
      ? {}
      : { registryAddress: env.LONGSTONE_REGISTRY_ADDRESS as `0x${string}` }),
  };

  validate(merged);
  return merged;
}

export function validate(config: LongstoneConfig): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.registryAddress)) {
    throw new Error(`registryAddress is not a 20-byte hex address: ${config.registryAddress}`);
  }
  if (!/^https?:\/\//.test(config.rpcUrl)) {
    throw new Error(`rpcUrl must be an http(s) URL: ${config.rpcUrl}`);
  }
  // The gateway is required before any staging call, and an empty value must
  // fail here rather than at the first fetch.
  if (config.hisaishiMode === 'remote' && config.hisaishiBaseUrl === '') {
    throw new Error('hisaishiMode=remote requires hisaishiBaseUrl');
  }
  if (config.hisaishiMode !== 'direct-rpc' && config.hisaishiMode !== 'remote') {
    if (config.hisaishiDbPath === '') {
      throw new Error(`hisaishiMode=${config.hisaishiMode} requires hisaishiDbPath`);
    }
  }
  if (!Number.isInteger(config.chainId) || config.chainId <= 0) {
    throw new Error(`chainId must be a positive integer: ${config.chainId}`);
  }
}

export function saveConfig(config: LongstoneConfig, path = CONFIG_PATH): void {
  validate(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function configPathFor(cwd: string): string {
  return join(cwd, CONFIG_PATH);
}
