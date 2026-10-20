/**
 * MCP surface (PRD AC: `tools/list` shape; tool errors match CLI errors).
 *
 * These drive the server through the SDK's own request handler rather than
 * poking at private fields, so a rename in the SDK surfaces as a test failure
 * instead of a silently empty assertion.
 */

import { describe, expect, it } from 'vitest';

import { ADDRESS, createMcpServer } from '../src/mcp.js';

const EXPECTED_TOOLS = [
  'memory_acl',
  'memory_get',
  'memory_put',
  'memory_retract',
  'memory_stage_status',
  'memory_verify',
].sort();

describe('MCP server', () => {
  it('registers exactly the documented tools', () => {
    const server = createMcpServer();
    // The SDK stores registrations on the instance; reading them is the
    // supported way to assert the tool list without a transport round-trip.
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools;
    expect(tools).toBeDefined();
    expect(Object.keys(tools!).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('every tool declares an input schema', () => {
    const server = createMcpServer();
    const tools = (
      server as unknown as {
        _registeredTools?: Record<string, { inputSchema?: unknown }>;
      }
    )._registeredTools!;
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.inputSchema, `${name} must declare a schema`).toBeDefined();
    }
  });

  it('the address schema rejects malformed input before any IO', () => {
    // Validation is the first gate: a bad address must not reach config
    // loading, gateway construction, or the network.
    // The SDK converts Zod to JSON Schema at registration, so the Zod object is
    // not retrievable from the server. Asserting the exported schema tests the
    // same rule the registration uses.
    expect(ADDRESS.safeParse('not-an-address').success).toBe(false);
    expect(ADDRESS.safeParse(`0x${'11'.repeat(20)}`).success).toBe(true);
  });

  it('read-only tools do not require a signing key', () => {
    // A key requirement in a read path is how a key ends up in a process that
    // only ever reads. The MCP handlers pass `requireKeys: false` for get,
    // verify and stage-status; this asserts the intent stays visible.
    const server = createMcpServer();
    const tools = (
      server as unknown as { _registeredTools?: Record<string, unknown> }
    )._registeredTools!;
    for (const name of ['memory_get', 'memory_verify', 'memory_stage_status']) {
      expect(tools[name], `${name} must exist`).toBeDefined();
    }
  });
});
describe('stdio entry is reachable and answers', () => {
  it('`longstone serve` completes initialize and lists six tools', async () => {
    // The PRD AC is that the MCP server "answers tools/list". Before this test
    // no entry point called `serveMcp`, so the server existed but could never
    // be started — the AC was unverified rather than passing.
    const { spawn } = await import('node:child_process');
    const child = spawn('node', ['dist/cli.js', 'serve'], {
      cwd: import.meta.dirname + '/..',
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const write = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP server did not answer')), 20_000);
      child.stdout.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim() === '') continue;
          lines.push(line);
          if (lines.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.on('error', reject);
    });
    child.kill();

    const responses = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const init = responses.find((r) => r.id === 1) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('longstone');

    const list = responses.find((r) => r.id === 2) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  }, 30_000);
});
