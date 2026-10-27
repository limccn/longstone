/**
 * L-8 through the real CLI.
 *
 * The unit tests cover path resolution; this test proves commander wiring and
 * precedence survive the built artifact: a cwd `.longstone/config.json` is
 * ignored (with one warning), `--config` selects it, and `LONGSTONE_CONFIG`
 * selects another file.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');
const DEFAULTS_CHAIN_ID = 84532;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'longstone-cli-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

/** A child env that cannot read the developer's real user config. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.LONGSTONE_CONFIG;
  return env;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('longstone config — L-8 path selection', () => {
  it('ignores a cwd project config by default and warns once', async () => {
    const cwd = tempDir();
    const home = tempDir();
    writeConfig(join(cwd, '.longstone', 'config.json'), { chainId: 999 });

    const result = await cli(['config'], { cwd, env: isolatedEnv(home) });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { chainId: number }).chainId).toBe(DEFAULTS_CHAIN_ID);
    expect(result.stderr).toContain('ignoring project config');
    expect(result.stderr).toContain('--config');
  });

  it('reads a project config selected with --config', async () => {
    const cwd = tempDir();
    const home = tempDir();
    const projectPath = join(cwd, '.longstone', 'config.json');
    writeConfig(projectPath, { chainId: 999 });

    const result = await cli(['config', '--config', projectPath], {
      cwd,
      env: isolatedEnv(home),
    });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { chainId: number }).chainId).toBe(999);
    expect(result.stderr).not.toContain('ignoring project config');
  });

  it('writes to the user-level file when no config is selected', async () => {
    const cwd = tempDir();
    const home = tempDir();

    const result = await cli(['config', '--set', `chainId=${DEFAULTS_CHAIN_ID}`], {
      cwd,
      env: isolatedEnv(home),
    });
    expect(result.code).toBe(0);
    const userPath = join(home, '.longstone', 'config.json');
    expect((JSON.parse(readFileSync(userPath, 'utf8')) as { chainId: number }).chainId).toBe(
      DEFAULTS_CHAIN_ID,
    );
    expect(result.stderr).not.toContain('ignoring project config');
  });

  it('writes to LONGSTONE_CONFIG when config set runs without --config', async () => {
    const cwd = tempDir();
    const home = tempDir();
    const target = join(tempDir(), 'nested', 'config.json');
    const env = { ...isolatedEnv(home), LONGSTONE_CONFIG: target };

    const result = await cli(['config', '--set', `chainId=${DEFAULTS_CHAIN_ID}`], { cwd, env });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { chainId: number }).chainId).toBe(DEFAULTS_CHAIN_ID);
    expect((JSON.parse(readFileSync(target, 'utf8')) as { chainId: number }).chainId).toBe(
      DEFAULTS_CHAIN_ID,
    );
  });

  it('writes to the --config file when given', async () => {
    const cwd = tempDir();
    const home = tempDir();
    const target = join(tempDir(), 'nested', 'explicit.json');

    const result = await cli(['config', '--config', target, '--set', `chainId=${DEFAULTS_CHAIN_ID}`], {
      cwd,
      env: isolatedEnv(home),
    });
    expect(result.code).toBe(0);
    expect((JSON.parse(readFileSync(target, 'utf8')) as { chainId: number }).chainId).toBe(
      DEFAULTS_CHAIN_ID,
    );
  });
});
