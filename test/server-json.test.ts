/**
 * MCP Registry metadata (C10): `server.json` must stay in lockstep with the
 * package it describes. A mismatch makes `mcp-publisher validate` or the
 * registry listing reject the release.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageJson {
  name: string;
  version: string;
  mcpName?: string;
}

interface ServerJson {
  $schema?: string;
  name: string;
  description: string;
  version: string;
  packages: Array<{
    registryType: string;
    registryBaseUrl?: string;
    identifier: string;
    version: string;
    transport: { type: string };
  }>;
}

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
const server = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8')) as ServerJson;

describe('MCP Registry metadata', () => {
  it('server.json matches package.json and the registry contract', () => {
    expect(server.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
    expect(pkg.mcpName).toBeDefined();
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.description.length).toBeLessThanOrEqual(100);

    expect(server.packages).toHaveLength(1);
    const entry = server.packages[0]!;
    expect(entry.registryType).toBe('npm');
    expect(entry.identifier).toBe(pkg.name);
    expect(entry.version).toBe(pkg.version);
    expect(entry.transport.type).toBe('stdio');
  });
});
