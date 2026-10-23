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
import { putMany } from './commands/put-batch.js';
import { retract } from './commands/retract.js';
import { stageStatus } from './commands/stage-status.js';
import { verify } from './commands/verify.js';
import { confirmWithRetry } from './confirm.js';
import { loadConfig, saveConfig, type LongstoneConfig } from './config.js';
import { surfaceText } from './error-surface.js';
import { pickSigningAccount, warnThrowawayKey } from './keybox.js';
import { createContext } from './context.js';

const program = new Command();
program.name('longstone').description('Sovereign agent memory client (MCP + CLI)').version('0.1.1');

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, replacer)}\n`);
}

/** Bigints are decimal strings on every wire and file in this project. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function withContext<T>(
  requireKeys: import('./keybox.js').KeyNeed,
  fn: (ctx: Awaited<ReturnType<typeof createContext>>) => Promise<T>,
): Promise<T> {
  const ctx = await createContext({ config: loadConfig(), requireKeys });
  try {
    if (ctx.keys !== null) warnThrowawayKey(pickSigningAccount(ctx.keys).address);
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function handleError(error: unknown): never {
  // Typed failures print `describe()` unchanged; an untyped failure becomes
  // INTERNAL_ERROR with the same code and text MCP reports.
  process.stderr.write(`${surfaceText(error)}\n`);
  process.exitCode = 1;
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
      const result = await withContext('signer', async (ctx) => {
        const account = ctx.keys!.signer!;
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
  .command('put-batch')
  .description('stage, build, sign and anchor 1-64 memories in one transaction')
  .option(
    '--text <text>',
    'memory text (repeatable; 1-64 items share one transaction)',
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option(
    '--tags <tags>',
    'comma-separated tags shared by every item',
    (value) => value.split(',').filter(Boolean),
  )
  .option(
    '--prev <hash>',
    'predecessor commitment hash applied to every row (rows are not chained to each other)',
  )
  .option('--owner <address>', 'owner address (defaults to the signing key)')
  .action(async (options) => {
    try {
      const result = await withContext('signer', async (ctx) => {
        const account = ctx.keys!.signer!;
        return putMany(
          { config: ctx.config, gate: ctx.gate, registry: ctx.registry },
          {
            intents: (options.text as string[]).map((text) => ({ text })),
            tags: options.tags ?? [],
            ...(options.prev === undefined ? {} : { prev: options.prev as `0x${string}` }),
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
  .command('confirm')
  .description('re-confirm a broadcast write with the gateway (recovery for a failed confirm)')
  .requiredOption('--tx-hash <hash>', 'transaction hash returned by put or put-batch')
  .option(
    '--owner <address>',
    'owner address (defaults to the signing key; no key is needed when supplied)',
  )
  .action(async (options) => {
    try {
      const result = await withContext(options.owner === undefined ? 'signer' : false, async (ctx) => {
        const owner = (options.owner ?? pickSigningAccount(ctx.keys!).address) as `0x${string}`;
        return confirmWithRetry(ctx.gate, { owner, txHash: options.txHash as `0x${string}` });
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
  .description('verify content bytes against a chain commitment (dual digest)')
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
      const result = await withContext('any', async (ctx) =>
        retract(
          { registry: ctx.registry },
          {
            commitmentHash: options.commitmentHash,
            ...(options.replacedBy === undefined ? {} : { replacedBy: options.replacedBy }),
            account: pickSigningAccount(ctx.keys!),
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
      const result = await withContext('owner', async (ctx) =>
        acl(
          { registry: ctx.registry },
          {
            action: 'grant',
            owner: options.owner,
            signer: options.signer,
            ...(options.roles === undefined
              ? {}
              : { roles: options.roles as string[] }),
            ownerAccount: ctx.keys!.owner!,
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
      const result = await withContext('owner', async (ctx) =>
        acl(
          { registry: ctx.registry },
          {
            action: 'revoke',
            owner: options.owner,
            signer: options.signer,
            ownerAccount: ctx.keys!.owner!,
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
          case 'scanMaxChunkBlocks':
            next.scanMaxChunkBlocks = Number(value);
            break;
          case 'scanStartBlock':
            next.scanStartBlock = Number(value);
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
