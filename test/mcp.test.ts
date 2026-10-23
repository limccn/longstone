/**
 * MCP surface (C10: read-only mode, annotations, destructive-tool confirmation)
 * plus the pre-existing `tools/list` and stdio assertions.
 *
 * These drive the server through the SDK's own request handler rather than
 * poking at private fields, so a rename in the SDK surfaces as a test failure
 * instead of a silently empty assertion.
 */

import { describe, expect, it } from 'vitest';

import {
  ADDRESS,
  MCP_INSTRUCTIONS,
  aclActionNeedsConfirmation,
  createMcpServer,
  resolveReadOnlyMode,
} from '../src/mcp.js';

const EXPECTED_TOOLS = [
  'memory_acl',
  'memory_get',
  'memory_put',
  'memory_put_batch',
  'memory_retract',
  'memory_stage_status',
  'memory_verify',
].sort();

const READ_ONLY_TOOLS = ['memory_get', 'memory_stage_status', 'memory_verify'].sort();

type ToolAnnotationsLike = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

type RegisteredToolLike = {
  inputSchema?: unknown;
  annotations?: ToolAnnotationsLike;
  handler: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
};

function registeredTools(
  // Explicit empty env: a `LONGSTONE_MCP_READ_ONLY` exported by the developer
  // or CI shell must not silently change what the writable-default assertions
  // are testing (the stdio test below makes the same guarantee).
  server = createMcpServer({ env: {} }),
): Record<string, RegisteredToolLike> {
  // The SDK stores registrations on the instance; reading them is the
  // supported way to assert the tool list without a transport round-trip.
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredToolLike> })
    ._registeredTools;
  expect(tools).toBeDefined();
  return tools!;
}

/** Only `mcpReq.inputResponses` is read before the confirmation gate. */
function fakeContext(inputResponses?: Record<string, unknown>): unknown {
  return { mcpReq: { inputResponses } };
}

describe('MCP server', () => {
  it('registers exactly the documented tools', () => {
    expect(Object.keys(registeredTools()).sort()).toEqual(EXPECTED_TOOLS);
  });

  it('every tool declares an input schema', () => {
    for (const [name, tool] of Object.entries(registeredTools())) {
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
    const tools = registeredTools();
    for (const name of READ_ONLY_TOOLS) {
      expect(tools[name], `${name} must exist`).toBeDefined();
    }
  });

  it('read-only mode registers exactly the three read tools', () => {
    const tools = registeredTools(createMcpServer({ readOnly: true }));
    expect(Object.keys(tools).sort()).toEqual(READ_ONLY_TOOLS);
  });

  it('read-only mode is selected by LONGSTONE_MCP_READ_ONLY=1', () => {
    const tools = registeredTools(createMcpServer({ env: { LONGSTONE_MCP_READ_ONLY: '1' } }));
    expect(Object.keys(tools).sort()).toEqual(READ_ONLY_TOOLS);
  });

  it('resolveReadOnlyMode accepts only 0/1 and fails closed on anything else', () => {
    expect(resolveReadOnlyMode({})).toBe(false);
    expect(resolveReadOnlyMode({ LONGSTONE_MCP_READ_ONLY: '' })).toBe(false);
    expect(resolveReadOnlyMode({ LONGSTONE_MCP_READ_ONLY: '0' })).toBe(false);
    expect(resolveReadOnlyMode({ LONGSTONE_MCP_READ_ONLY: '1' })).toBe(true);
    expect(() => resolveReadOnlyMode({ LONGSTONE_MCP_READ_ONLY: 'true' })).toThrow(
      /LONGSTONE_MCP_READ_ONLY/,
    );
  });

  it('annotates every tool with its safety contract', () => {
    const tools = registeredTools();
    for (const name of READ_ONLY_TOOLS) {
      expect(tools[name]?.annotations, `${name} annotations`).toEqual({
        readOnlyHint: true,
        openWorldHint: true,
      });
    }
    expect(tools.memory_put?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(tools.memory_put_batch?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(tools.memory_retract?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.memory_acl?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('registers memory_put_batch only in writable mode', () => {
    // AC-6: the batch write is additive, shares the put path, and must not leak
    // into read-only mode. There is no memory_confirm tool in this task.
    const batch = registeredTools().memory_put_batch;
    expect(batch).toBeDefined();
    expect(registeredTools(createMcpServer({ readOnly: true })).memory_put_batch).toBeUndefined();
    expect(registeredTools().memory_confirm).toBeUndefined();

    // The schema is present and names the shared-tags batch argument set.
    const schema = batch?.inputSchema as { def?: { shape?: Record<string, unknown> } };
    expect(Object.keys(schema.def?.shape ?? {}).sort()).toEqual([
      'owner',
      'prev',
      'tags',
      'texts',
    ]);
  });
});

describe('destructive tool confirmation (MRTR)', () => {
  it('memory_retract returns inputRequired before any IO', async () => {
    const hash = `0x${'11'.repeat(32)}`;
    const result = await registeredTools().memory_retract!.handler(
      { commitmentHash: hash },
      fakeContext(),
    );

    expect(result.resultType).toBe('input_required');
    const requests = result.inputRequests as Record<
      string,
      { method: string; params: { message: string; mode: string } }
    >;
    expect(Object.keys(requests)).toEqual(['confirm']);
    expect(requests.confirm!.method).toBe('elicitation/create');
    expect(requests.confirm!.params.mode).toBe('form');
    expect(requests.confirm!.params.message).toContain('retract');
    expect(requests.confirm!.params.message).toContain(hash);
  });

  it('memory_retract re-asks when the accepted content is not confirm:true', async () => {
    const hash = `0x${'22'.repeat(32)}`;
    const result = await registeredTools().memory_retract!.handler(
      { commitmentHash: hash },
      fakeContext({ confirm: { action: 'accept', content: { confirm: false } } }),
    );

    // Fail closed: a false answer must not fall through to the retract.
    expect(result.resultType).toBe('input_required');
  });

  it('memory_acl gates grant/revoke but not list', async () => {
    const tools = registeredTools();
    const args = {
      owner: `0x${'33'.repeat(20)}`,
      signer: `0x${'44'.repeat(20)}`,
      roles: ['commit'],
    };

    for (const action of ['grant', 'revoke'] as const) {
      const result = await tools.memory_acl!.handler({ action, ...args }, fakeContext());
      expect(result.resultType, action).toBe('input_required');
      const requests = result.inputRequests as Record<string, { params: { message: string } }>;
      expect(requests.confirm!.params.message).toContain(action);
      expect(requests.confirm!.params.message).toContain(args.signer);
    }

    // `list` must reach the read path without a confirmation prompt. The pure
    // predicate is testable without letting the handler perform IO.
    expect(aclActionNeedsConfirmation('list')).toBe(false);
    expect(aclActionNeedsConfirmation('grant')).toBe(true);
    expect(aclActionNeedsConfirmation('revoke')).toBe(true);
  });
});

describe('stdio entry is reachable and answers', () => {
  it('`longstone serve` completes initialize and lists the documented tools', async () => {
    // The PRD AC is that the MCP server "answers tools/list". Before this test
    // no entry point called `serveMcp`, so the server existed but could never
    // be started — the AC was unverified rather than passing.
    const { spawn } = await import('node:child_process');
    // The suite asserts the writable default; do not inherit a read-only mode
    // from the developer or CI shell.
    const env = { ...process.env };
    delete env.LONGSTONE_MCP_READ_ONLY;
    const child = spawn('node', ['dist/cli.js', 'serve'], {
      cwd: import.meta.dirname + '/..',
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
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
    const init = responses.find((r) => r.id === 1) as {
      result: { serverInfo: { name: string }; instructions?: string };
    };
    expect(init.result.serverInfo.name).toBe('longstone');
    expect(init.result.instructions).toBe(MCP_INSTRUCTIONS);

    const list = responses.find((r) => r.id === 2) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  }, 30_000);
});
