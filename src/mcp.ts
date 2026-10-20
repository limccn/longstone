/**
 * MCP server (design §2).
 *
 * Tools wrap the SAME command functions the CLI calls. Nothing is reimplemented
 * here: the Zod schemas describe arguments, and the handler delegates. A
 * behaviour that exists only in MCP is a behaviour the CLI cannot reproduce, and
 * that divergence is what the parity test exists to prevent.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { acl } from './commands/acl.js';
import { get } from './commands/get.js';
import { put } from './commands/put.js';
import { retract } from './commands/retract.js';
import { stageStatus } from './commands/stage-status.js';
import { verify } from './commands/verify.js';
import { LongstoneFailure } from './errors.js';
import { pickSigningAccount } from './keybox.js';
import { createContext } from './context.js';
import { loadConfig } from './config.js';

/** Exported so tests can assert validation without a transport round-trip. */
export const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, '20-byte hex address');
export const BYTES32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, '32-byte hex');

/** Bigints become decimal strings — the project-wide wire convention. */
function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

function toolError(error: unknown) {
  const message =
    error instanceof LongstoneFailure
      ? JSON.stringify(error.error)
      : JSON.stringify({ code: 'UNKNOWN_ERROR', detail: (error as Error).message });
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'longstone', version: '0.1.0' });

  server.registerTool(
    'memory_put',
    {
      description:
        'Store a memory: canonicalize, stage through the keyless gateway, sign locally and anchor on chain.',
      inputSchema: {
        text: z.string().min(1),
        tags: z.array(z.string()).optional(),
        prev: BYTES32.optional(),
        owner: ADDRESS.optional(),
      },
    },
    async (args: { text: string; tags?: string[] | undefined; prev?: string | undefined; owner?: string | undefined }) => {
      const ctx = await createContext({ config: loadConfig(), requireKeys: 'signer' });
      try {
        const account = ctx.keys!.signer!;
        const result = await put(
          { config: ctx.config, gate: ctx.gate, registry: ctx.registry },
          {
            text: args.text,
            tags: args.tags ?? [],
            ...(args.prev === undefined ? {} : { prev: args.prev as `0x${string}` }),
            owner: (args.owner ?? account.address) as `0x${string}`,
            account,
          },
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(toJson(result)) }] };
      } catch (error) {
        return toolError(error);
      } finally {
        await ctx.close();
      }
    },
  );

  server.registerTool(
    'memory_get',
    {
      description: 'List staging rows and indexed on-chain commitments for an owner.',
      inputSchema: {
        owner: ADDRESS,
        status: z.enum(['staged', 'batched', 'anchored', 'rejected']).optional(),
        tag: z.string().optional(),
        activeOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args: {
      owner: string;
      status?: 'staged' | 'batched' | 'anchored' | 'rejected' | undefined;
      tag?: string | undefined;
      activeOnly?: boolean | undefined;
      limit?: number | undefined;
    }) => {
      const ctx = await createContext({ config: loadConfig(), requireKeys: false });
      try {
        const result = await get(
          { gate: ctx.gate, scan: ctx.scan },
          {
            owner: args.owner as `0x${string}`,
            ...(args.status === undefined ? {} : { status: args.status }),
            ...(args.tag === undefined ? {} : { tag: args.tag }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
            activeOnly: args.activeOnly === true,
          },
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(toJson(result)) }] };
      } catch (error) {
        return toolError(error);
      } finally {
        await ctx.close();
      }
    },
  );

  server.registerTool(
    'memory_verify',
    {
      description:
        'Fetch bytes and verify both digests against a commitment. Works with the gateway unreachable when direct=true.',
      inputSchema: {
        cid: z.string().min(1),
        commitmentHash: BYTES32.optional(),
        owner: ADDRESS.optional(),
        direct: z.boolean().optional(),
      },
    },
    async (args: { cid: string; commitmentHash?: string | undefined; owner?: string | undefined; direct?: boolean | undefined }) => {
      const ctx = await createContext({
        config: loadConfig(),
        requireKeys: false,
        // `--direct` verifies without staging; it still uses the configured
        // dedicated gateway, never a public fallback.
      });
      try {
        const result = await verify(
          { gate: ctx.gate, registry: ctx.registry, scan: ctx.scan },
          {
            cid: args.cid,
            ...(args.commitmentHash === undefined
              ? {}
              : { commitmentHash: args.commitmentHash as `0x${string}` }),
            ...(args.owner === undefined ? {} : { owner: args.owner as `0x${string}` }),
            direct: args.direct === true,
            ipfsGateway: ctx.config.ipfsGateway,
          },
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(toJson(result)) }] };
      } catch (error) {
        return toolError(error);
      } finally {
        await ctx.close();
      }
    },
  );

  server.registerTool(
    'memory_retract',
    {
      description: 'Tombstone a commitment, optionally naming its successor.',
      inputSchema: { commitmentHash: BYTES32, replacedBy: BYTES32.optional() },
    },
    async (args: { commitmentHash: string; replacedBy?: string | undefined }) => {
      const ctx = await createContext({ config: loadConfig(), requireKeys: 'any' });
      try {
        const result = await retract(
          { registry: ctx.registry },
          {
            commitmentHash: args.commitmentHash as `0x${string}`,
            ...(args.replacedBy === undefined
              ? {}
              : { replacedBy: args.replacedBy as `0x${string}` }),
            account: pickSigningAccount(ctx.keys!),
          },
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(toJson(result)) }] };
      } catch (error) {
        return toolError(error);
      } finally {
        await ctx.close();
      }
    },
  );

  server.registerTool(
    'memory_acl',
    {
      description: 'Inspect or change a signer role mask (owner key required for writes).',
      inputSchema: {
        action: z.enum(['grant', 'revoke', 'list']),
        owner: ADDRESS,
        signer: ADDRESS,
        roles: z.array(z.enum(['commit', 'retract'])).optional(),
      },
    },
    async (args: {
      action: 'grant' | 'revoke' | 'list';
      owner: string;
      signer: string;
      roles?: Array<'commit' | 'retract'> | undefined;
    }) => {
      const need = args.action === 'list' ? false : ('owner' as const);
      const ctx = await createContext({ config: loadConfig(), requireKeys: need });
      try {
        const result = await acl(
          { registry: ctx.registry },
          {
            action: args.action,
            owner: args.owner as `0x${string}`,
            signer: args.signer as `0x${string}`,
            ...(args.roles === undefined ? {} : { roles: args.roles }),
            ...(ctx.keys === null ? {} : { ownerAccount: ctx.keys.owner! }),
          },
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(toJson(result)) }] };
      } catch (error) {
        return toolError(error);
      } finally {
        await ctx.close();
      }
    },
  );

  server.registerTool(
    'memory_stage_status',
    {
      description: 'Staging visibility only — works when the chain is unreachable.',
      inputSchema: {
        owner: ADDRESS,
        status: z.enum(['staged', 'batched', 'anchored', 'rejected']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args: { owner: string; status?: string | undefined; limit?: number | undefined }) => {
      const ctx = await createContext({ config: loadConfig(), requireKeys: false });
      try {
        const result = await stageStatus(
          { gate: ctx.gate },
          {
            owner: args.owner as `0x${string}`,
            ...(args.status === undefined ? {} : { status: args.status }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          },
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(toJson(result)) }] };
      } catch (error) {
        return toolError(error);
      } finally {
        await ctx.close();
      }
    },
  );

  return server;
}

/**
 * stdio entry used by agent hosts.
 *
 * `serveStdio` takes a FACTORY, not an instance: the SDK builds one server per
 * connection, so a single shared instance would leak tool registrations across
 * reconnects.
 */
export async function serveMcp(): Promise<void> {
  await serveStdio(() => createMcpServer());
  process.stderr.write('longstone MCP server ready on stdio\n');
}
