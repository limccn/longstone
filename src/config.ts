/**
 * Configuration (design v0.2 §8).
 *
 * Precedence: CLI flags > environment > config file > defaults. Keys are never
 * stored here — they come from env only, because a config file gets copied,
 * shared and committed by accident.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fail } from './errors.js';

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
  /**
   * Lower bound for chain scans. `0` means "discover the deployment block".
   * The effective start is always `max(scanStartBlock, deploymentBlock)`:
   * no commitment can predate the registry's code.
   */
  scanStartBlock: number;
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
  scanStartBlock: 0,
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

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Remote endpoints must be https; loopback http is the local-development
 * exception (Hardhat, Playwright, an embedded F1 gateway). Plaintext to a
 * remote host lets a network attacker rewrite chain reads or gateway rows.
 */
function assertSecureUrl(field: string, value: string, allowEmpty = false): void {
  if (value === '') {
    if (allowEmpty) return;
    fail({ code: 'INSECURE_ENDPOINT', field, detail: 'must not be empty' });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail({ code: 'INSECURE_ENDPOINT', field, detail: 'not an absolute URL' });
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return;
  fail({
    code: 'INSECURE_ENDPOINT',
    field,
    detail: `${url.protocol}//${url.hostname} is not https and is not a loopback host`,
  });
}

export function validate(config: LongstoneConfig): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.registryAddress)) {
    throw new Error(`registryAddress is not a 20-byte hex address: ${config.registryAddress}`);
  }
  assertSecureUrl('rpcUrl', config.rpcUrl);
  assertSecureUrl('sequencerUrl', config.sequencerUrl);
  assertSecureUrl('ipfsGateway', config.ipfsGateway, true);
  assertSecureUrl('hisaishiBaseUrl', config.hisaishiBaseUrl, true);
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
  if (!Number.isInteger(config.scanStartBlock) || config.scanStartBlock < 0) {
    throw new Error(`scanStartBlock must be a non-negative integer: ${config.scanStartBlock}`);
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
