/**
 * L-8: an MCP host that cannot pass CLI flags selects its config through
 * `createMcpServer({ configPath })`; `longstone serve --config <path>` forwards
 * it. The handler must load that file, not `LONGSTONE_CONFIG` or the user-level
 * default.
 *
 * The selected file is deliberately invalid (`hisaishiMode=remote` without a
 * base URL) so the failure names the file that was loaded. The environment
 * points at a *valid* fallback: if `configPath` were dropped, the handler would
 * instead reach the direct-rpc gate error, and this test would fail.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpServer } from '../src/mcp.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'longstone-mcp-config-'));
  tempDirs.push(dir);
  return dir;
}

interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}

function tool(server: ReturnType<typeof createMcpServer>, name: string): RegisteredToolLike {
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })
    ._registeredTools;
  expect(tools?.[name]).toBeDefined();
  return tools![name]!;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('MCP config selection (L-8)', () => {
  it('loads the host-selected configPath instead of the environment default', async () => {
    const dir = tempDir();
    const selected = join(dir, 'selected.json');
    writeFileSync(selected, JSON.stringify({ hisaishiMode: 'remote' }));
    const envFallback = join(dir, 'env.json');
    writeFileSync(envFallback, JSON.stringify({ hisaishiMode: 'direct-rpc' }));
    vi.stubEnv('LONGSTONE_CONFIG', envFallback);

    const server = createMcpServer({ readOnly: true, configPath: selected, env: {} });
    const handler = tool(server, 'memory_get').handler;

    await expect(handler({ owner: `0x${'11'.repeat(20)}` }, {})).rejects.toThrow(
      /hisaishiMode=remote requires hisaishiBaseUrl/,
    );
    // The selected file was read, not created or mutated.
    expect(JSON.parse(readFileSync(selected, 'utf8'))).toEqual({ hisaishiMode: 'remote' });
  });
});
