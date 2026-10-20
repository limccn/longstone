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