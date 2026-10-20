#!/usr/bin/env node
/**
 * CLI (design §2).
 *
 * stdout carries JSON (the data channel); progress and the throwaway-key banner
 * go to stderr so `longstone get | jq` cannot be corrupted by a warning.
 */

import { Command } from 'commander';

import { acl } from './commands/acl.js';
import { get } from './commands/get.js';
import { put } from './commands/put.js';
import { retract } from './commands/retract.js';
import { stageStatus } from './commands/stage-status.js';
import { verify } from './commands/verify.js';
import { loadConfig, saveConfig, type LongstoneConfig } from './config.js';
import { LongstoneFailure, describe } from './errors.js';
import { warnThrowawayKey } from './keybox.js';
import { createContext } from './context.js';

const program = new Command();
program.name('longstone').description('Sovereign agent memory client (MCP + CLI)').version('0.1.0');

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, replacer)}\n`);
}

/** Bigints are decimal strings on every wire and file in this project. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function withContext<T>(
  requireKeys: boolean,
  fn: (ctx: Awaited<ReturnType<typeof createContext>>) => Promise<T>,
): Promise<T> {
  const ctx = await createContext({ config: loadConfig(), requireKeys });
  try {
    if (ctx.keys !== null) warnThrowawayKey(ctx.keys.signer.address);
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function handleError(error: unknown): never {
  if (error instanceof LongstoneFailure) {
    process.stderr.write(`${describe(error.error)}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
  throw error;
}

program
  .command('put')
  .description('stage, build, sign and anchor one memory')
  .requiredOption('--text <text>', 'memory text')
  .option('--tags <tags>', 'comma-separated tags', (value) => value.split(',').filter(Boolean))
  .option('--prev <hash>', 'predecessor commitment hash')
  .option('--owner <address>', 'owner address (defaults to the signing key)')
  .action(async (options) => {
    try {
      const result = await withContext(true, async (ctx) => {
        const account = ctx.keys!.signer;
        return put(
          { config: ctx.config, gate: ctx.gate, registry: ctx.registry },
          {
            text: options.text,
            tags: options.tags ?? [],
            ...(options.prev === undefined ? {} : { prev: options.prev }),
            owner: (options.owner ?? account.address) as `0x${string}`,
            account,
          },
        );
      });
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('get')
  .description('list staging rows and indexed chain commitments')
  .requiredOption('--owner <address>')
  .option('--status <status>')
  .option('--limit <n>', '', Number)
  .option('--tag <tag>')
  .option('--active-only', '', false)
  .action(async (options) => {
    try {
      const result = await withContext(false, async (ctx) =>
        get(
          { gate: ctx.gate, scan: ctx.scan },
          {
            owner: options.owner,
            ...(options.status === undefined ? {} : { status: options.status }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.tag === undefined ? {} : { tag: options.tag }),
            activeOnly: options.activeOnly === true,
          },
        ),
      );
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('verify')
  .description('verify content bytes against a commitment (dual digest)')
  .requiredOption('--cid <cid>')
  .option('--commitment-hash <hash>')
  .option('--owner <address>')
  .option('--direct', 'fetch from the configured gateway instead of hisaishi', false)
  .action(async (options) => {
    try {
      const result = await withContext(false, async (ctx) =>
        verify(
          { gate: ctx.gate, registry: ctx.registry, scan: ctx.scan },
          {
            cid: options.cid,
            ...(options.commitmentHash === undefined
              ? {}
              : { commitmentHash: options.commitmentHash }),
            ...(options.owner === undefined ? {} : { owner: options.owner }),
            direct: options.direct === true,
            ipfsGateway: ctx.config.ipfsGateway,
          },
        ),
      );
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('retract')
  .description('tombstone a commitment, optionally naming its successor')
  .requiredOption('--commitment-hash <hash>')
  .option('--replaced-by <hash>')
  .action(async (options) => {
    try {
      const result = await withContext(true, async (ctx) =>
        retract(
          { registry: ctx.registry },
          {
            commitmentHash: options.commitmentHash,
            ...(options.replacedBy === undefined ? {} : { replacedBy: options.replacedBy }),
            account: ctx.keys!.owner ?? ctx.keys!.signer,
          },
        ),
      );
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

const aclCommand = program.command('acl').description('signer management (owner key)');
aclCommand
  .command('grant')
  .requiredOption('--owner <address>')
  .requiredOption('--signer <address>')
  .option('--roles <roles>', 'comma-separated: commit,retract', (v) => v.split(','))
  .action(async (options) => {
    try {
      const result = await withContext(true, async (ctx) =>
        acl(
          { registry: ctx.registry },
          {
            action: 'grant',
            owner: options.owner,
            signer: options.signer,
            roles: (options.roles ?? ['commit']) as Array<'commit' | 'retract'>,
            ownerAccount: ctx.keys!.owner ?? ctx.keys!.signer,
          },
        ),
      );
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

aclCommand
  .command('revoke')
  .requiredOption('--owner <address>')
  .requiredOption('--signer <address>')
  .action(async (options) => {
    try {
      const result = await withContext(true, async (ctx) =>
        acl(
          { registry: ctx.registry },
          {
            action: 'revoke',
            owner: options.owner,
            signer: options.signer,
            ownerAccount: ctx.keys!.owner ?? ctx.keys!.signer,
          },
        ),
      );
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

aclCommand
  .command('list')
  .requiredOption('--owner <address>')
  .requiredOption('--signer <address>')
  .action(async (options) => {
    try {
      const result = await withContext(false, async (ctx) =>
        acl({ registry: ctx.registry }, { action: 'list', owner: options.owner, signer: options.signer }),
      );
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('stage-status')
  .requiredOption('--owner <address>')
  .option('--status <status>')
  .option('--limit <n>', '', Number)
  .action(async (options) => {
    try {
      const result = await withContext(false, async (ctx) =>
        stageStatus(
          { gate: ctx.gate },
          {
            owner: options.owner,
            ...(options.status === undefined ? {} : { status: options.status }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
        ),
      );
      emit(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('config')
  .description('show or update configuration')
  .option('--set <key=value...>', 'set one or more keys', (v, acc: string[]) => [...acc, v], [])
  .action(async (options) => {
    try {
      const config = loadConfig();
      if ((options.set as string[]).length === 0) {
        emit(config);
        return;
      }
      const next: LongstoneConfig = { ...config };
      for (const pair of options.set as string[]) {
        const [key, ...rest] = pair.split('=');
        const value = rest.join('=');
        if (key === undefined || value === '') throw new Error(`bad --set value: ${pair}`);
        switch (key) {
          case 'rpcUrl':
            next.rpcUrl = value;
            break;
          case 'sequencerUrl':
            next.sequencerUrl = value;
            break;
          case 'registryAddress':
            next.registryAddress = value as `0x${string}`;
            break;
          case 'chainId':
            next.chainId = Number(value);
            break;
          case 'hisaishiMode':
            next.hisaishiMode = value as LongstoneConfig['hisaishiMode'];
            break;
          case 'hisaishiBaseUrl':
            next.hisaishiBaseUrl = value;
            break;
          case 'hisaishiDbPath':
            next.hisaishiDbPath = value;
            break;
          case 'ipfsGateway':
            next.ipfsGateway = value;
            break;
          case 'scanChunkBlocks':
            next.scanChunkBlocks = Number(value);
            break;
          default:
            throw new Error(`unknown config key: ${key}`);
        }
      }
      saveConfig(next);
      emit(next);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command('serve')
  .description('run the MCP server over stdio (for agent hosts)')
  .action(async () => {
    try {
      // Imported lazily: a CLI invocation that never serves should not pay the
      // MCP SDK's import cost, and a broken SDK should not break `longstone --help`.
      const { serveMcp } = await import('./mcp.js');
      await serveMcp();
    } catch (error) {
      handleError(error);
    }
  });

program.parseAsync(process.argv).catch(() => {
  process.exitCode = 1;
});
