/**
 * CLI surface for the ERC-8004 agent pointer (method A).
 *
 * These spawn the built CLI, so they exercise the real commander wiring: the
 * both-or-neither guard and `parseAgentRef` must fire before a key is loaded or
 * a gateway request is made. No network is involved: every case fails before
 * `createContext`.
 *
 * CI builds before it tests (`.github/workflows/ci.yml`); `dist/cli.js` is the
 * same artifact the MCP stdio test already uses.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');
const ROOT = join(import.meta.dirname, '..');

const REGISTRY = 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with no signing keys, so a `NO_KEY` result means the guard did not fire first. */
async function cli(args: string[]): Promise<CliResult> {
  const env = { ...process.env };
  delete env.LONGSTONE_KEY;
  delete env.LONGSTONE_OWNER_KEY;
  delete env.LONGSTONE_MCP_READ_ONLY;

  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

describe('longstone put — agent flags', () => {
  it('documents both flags and the pointer-only rule in --help', async () => {
    const result = await cli(['put', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--agent-registry');
    expect(result.stdout).toContain('--agent-id');
    expect(result.stdout).toContain('pointer only');
    expect(result.stdout).toContain("ownership and ACL remain menhir's");
  });

  it('rejects --agent-registry without --agent-id before loading a key', async () => {
    const result = await cli(['put', '--text', 'x', '--agent-registry', REGISTRY]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SCHEMA_VIOLATION');
    expect(result.stderr).toContain('--agent-registry');
    expect(result.stderr).toContain('--agent-id');
    expect(result.stderr).not.toContain('NO_KEY');
  });

  it('rejects --agent-id without --agent-registry before loading a key', async () => {
    const result = await cli(['put', '--text', 'x', '--agent-id', '42']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SCHEMA_VIOLATION');
    expect(result.stderr).toContain('--agent-registry');
    expect(result.stderr).not.toContain('NO_KEY');
  });

  it('rejects a malformed registry before loading a key', async () => {
    const result = await cli([
      'put',
      '--text',
      'x',
      '--agent-registry',
      'eip155:84532:0xnothex',
      '--agent-id',
      '42',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SCHEMA_VIOLATION');
    expect(result.stderr).toContain('meta.agent.registry');
    expect(result.stderr).not.toContain('NO_KEY');
  });

  it('rejects a non-decimal agent id before loading a key', async () => {
    const result = await cli([
      'put',
      '--text',
      'x',
      '--agent-registry',
      REGISTRY,
      '--agent-id=12x',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SCHEMA_VIOLATION');
    expect(result.stderr).toContain('meta.agent.agentId');
    expect(result.stderr).not.toContain('NO_KEY');
  });
});
