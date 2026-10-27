/**
 * L-8: the default config is user-level, never the process cwd.
 *
 * A working directory is attacker-controlled in the threat model (a cloned
 * repository), so a `.longstone/config.json` there must not redirect `rpcUrl`,
 * `hisaishiBaseUrl`, `registryAddress` or `chainId` unless the caller opts in
 * with `--config` or `LONGSTONE_CONFIG`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULTS,
  loadConfig,
  projectConfigPath,
  resetConfigWarningForTests,
  resolveConfigPath,
  saveConfig,
  userConfigPath,
  validate,
  type LongstoneConfig,
} from '../src/config.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'longstone-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(path: string, value: Partial<LongstoneConfig>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function readConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetConfigWarningForTests();
});

describe('config path resolution', () => {
  it('places the user config under the platform home', () => {
    const home = join('fake', 'home');
    expect(userConfigPath(home)).toBe(join(home, '.longstone', 'config.json'));
  });

  it('places the project config under the given cwd', () => {
    const cwd = join('some', 'project');
    expect(projectConfigPath(cwd)).toBe(join(cwd, '.longstone', 'config.json'));
  });

  it('prefers an explicit path over the environment', () => {
    expect(resolveConfigPath('/explicit.json', { LONGSTONE_CONFIG: '/env.json' }, '/fake/home')).toEqual({
      path: '/explicit.json',
      source: 'explicit',
    });
  });

  it('uses LONGSTONE_CONFIG when no explicit path is given', () => {
    expect(resolveConfigPath(undefined, { LONGSTONE_CONFIG: '/env.json' }, '/fake/home')).toEqual({
      path: '/env.json',
      source: 'env',
    });
  });

  it('defaults to the user config, not the cwd', () => {
    const home = join('fake', 'home');
    expect(resolveConfigPath(undefined, {}, home)).toEqual({
      path: join(home, '.longstone', 'config.json'),
      source: 'user',
    });
  });
});

describe('loadConfig defaults', () => {
  it('does not read a cwd project config and warns once', () => {
    const cwd = tempDir();
    const projectPath = projectConfigPath(cwd);
    writeConfig(projectPath, { chainId: 999 });

    const envPath = join(tempDir(), 'does-not-exist.json');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const warn = vi.fn();

    const config = loadConfig(undefined, { LONGSTONE_CONFIG: envPath }, warn);
    expect(config.chainId).toBe(DEFAULTS.chainId);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(projectPath);
    expect(warn.mock.calls[0]?.[0]).toContain('--config');

    // Once per process, not once per tool call.
    loadConfig(undefined, { LONGSTONE_CONFIG: envPath }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads a config file named by LONGSTONE_CONFIG', () => {
    const path = join(tempDir(), 'env.json');
    writeConfig(path, { chainId: 1234 });

    expect(loadConfig(undefined, { LONGSTONE_CONFIG: path }, () => {}).chainId).toBe(1234);
  });

  it('reads an explicitly selected project config', () => {
    const path = join(tempDir(), '.longstone', 'config.json');
    writeConfig(path, { chainId: 4321 });

    expect(loadConfig(path, {}, () => {}).chainId).toBe(4321);
  });

  it('does not warn when the environment selects the cwd project config itself', () => {
    const cwd = tempDir();
    const projectPath = projectConfigPath(cwd);
    writeConfig(projectPath, { chainId: 777 });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const warn = vi.fn();

    expect(loadConfig(undefined, { LONGSTONE_CONFIG: projectPath }, warn).chainId).toBe(777);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for an explicit path', () => {
    const cwd = tempDir();
    writeConfig(projectConfigPath(cwd), { chainId: 999 });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const warn = vi.fn();

    loadConfig(join(tempDir(), 'explicit.json'), {}, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('saveConfig default location', () => {
  it('writes to LONGSTONE_CONFIG when set', () => {
    const target = join(tempDir(), 'nested', 'config.json');
    vi.stubEnv('LONGSTONE_CONFIG', target);

    saveConfig({ ...DEFAULTS, chainId: 84532 });
    expect(readConfig(target).chainId).toBe(84532);
  });

  it('writes to an explicit path when given', () => {
    const target = join(tempDir(), 'explicit.json');
    saveConfig({ ...DEFAULTS, chainId: 84532 }, target);
    expect(readConfig(target).chainId).toBe(84532);
  });
});

describe('validation is unchanged', () => {
  it('still rejects an insecure remote endpoint', () => {
    expect(() => validate({ ...DEFAULTS, rpcUrl: 'http://rpc.example.com' })).toThrow();
  });

  it('still allows loopback http for local development', () => {
    expect(() => validate({ ...DEFAULTS, rpcUrl: 'http://127.0.0.1:8545' })).not.toThrow();
  });
});
