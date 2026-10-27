/**
 * Configuration (design v0.2 §8).
 *
 * Precedence: CLI flags > environment > config file > defaults. Keys are never
 * stored here — they come from env only, because a config file gets copied,
 * shared and committed by accident.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
   * Growth ceiling for adaptive `getLogs` windows. Scans start at
   * `scanChunkBlocks`, double after three consecutive successes, and never
   * exceed this value. Range rejections lower it for the current process.
   */
  scanMaxChunkBlocks: number;
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
  scanMaxChunkBlocks: 10_000,
  scanStartBlock: 0,
};

export const CONFIG_PATH = '.longstone/config.json';

/** Test hook: the project-config warning is once per process by design. */
let warnedProjectConfig = false;

export function resetConfigWarningForTests(): void {
  warnedProjectConfig = false;
}

/** The user-level default: `~/.longstone/config.json`, never the cwd. */
export function userConfigPath(home = homedir()): string {
  return join(home, '.longstone', 'config.json');
}

/** The project location — read only when selected explicitly (L-8). */
export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, '.longstone', 'config.json');
}

/**
 * CLI flag > `LONGSTONE_CONFIG` > user-level file. There is deliberately no
 * cwd fallback: a cloned repository must not be able to redirect chain or
 * gateway endpoints.
 */
export function resolveConfigPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { path: string; source: 'explicit' | 'env' | 'user' } {
  if (explicit !== undefined && explicit !== '') return { path: explicit, source: 'explicit' };
  const fromEnv = env.LONGSTONE_CONFIG;
  if (fromEnv !== undefined && fromEnv !== '') return { path: fromEnv, source: 'env' };
  return { path: userConfigPath(home), source: 'user' };
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function loadConfig(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = defaultWarn,
): LongstoneConfig {
  const resolved = resolveConfigPath(path, env);

  // A cwd config is invisible by design. Say so once, so an operator whose
  // project has one is not silently running against defaults. An explicit
  // path (or an env path naming that same file) is the opt-in.
  if (resolved.source !== 'explicit' && !warnedProjectConfig) {
    const projectPath = projectConfigPath();
    if (resolve(projectPath) !== resolve(resolved.path) && existsSync(projectPath)) {
      warnedProjectConfig = true;
      warn(
        `longstone: ignoring project config at ${projectPath}; ` +
          'use --config <path> or LONGSTONE_CONFIG to opt in ' +
          `(default: ${userConfigPath()})`,
      );
    }
  }

  let file: Partial<LongstoneConfig> = {};
  try {
    file = JSON.parse(readFileSync(resolved.path, 'utf8')) as Partial<LongstoneConfig>;
  } catch (error) {
    // Only a missing file is empty. An unreadable or malformed file must fail
    // loudly instead of silently falling back to defaults.
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
  // Both scan keys are bounds on eth_getLogs: the first request uses
  // scanChunkBlocks, growth stops at scanMaxChunkBlocks. A config that predates
  // scanMaxChunkBlocks keeps the 10_000 default, so a larger scanChunkBlocks
  // must set the ceiling explicitly rather than being silently clamped.
  if (!Number.isInteger(config.scanChunkBlocks) || config.scanChunkBlocks <= 0) {
    throw new Error(`scanChunkBlocks must be a positive integer: ${config.scanChunkBlocks}`);
  }
  if (!Number.isInteger(config.scanMaxChunkBlocks) || config.scanMaxChunkBlocks <= 0) {
    throw new Error(`scanMaxChunkBlocks must be a positive integer: ${config.scanMaxChunkBlocks}`);
  }
  if (config.scanChunkBlocks > config.scanMaxChunkBlocks) {
    throw new Error(
      `scanChunkBlocks (${config.scanChunkBlocks}) must not exceed scanMaxChunkBlocks ` +
        `(${config.scanMaxChunkBlocks}); raise scanMaxChunkBlocks to scan at the larger window`,
    );
  }
  if (config.scanMaxChunkBlocks > 5_000_000) {
    throw new Error(
      `scanMaxChunkBlocks must not exceed 5000000: ${config.scanMaxChunkBlocks}`,
    );
  }
}

export function saveConfig(config: LongstoneConfig, path?: string): void {
  validate(config);
  const target = resolveConfigPath(path).path;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
}

export function configPathFor(cwd: string): string {
  return projectConfigPath(cwd);
}
