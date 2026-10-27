#!/usr/bin/env node
/**
 * Smoke test for the Copilot MCP configuration examples.
 *
 * For every file under examples/copilot/ this script:
 *   1. reads the JSON, extracts the `longstone` server spec, and asserts that
 *      the launch shape is exactly `npx -y @limccn/longstone@<exact> serve`
 *      (ranges and `latest` are rejected — `npx -y` does not consult a
 *      lockfile, so the pin is the supply-chain control, PS-5);
 *   2. starts the configured command in a fresh temporary directory with
 *      LONGSTONE_KEY, LONGSTONE_OWNER_KEY and LONGSTONE_MCP_READ_ONLY removed,
 *      proving the server starts and registers all seven tools with no key;
 *   3. performs BOTH MCP handshakes against the same config:
 *        - legacy `initialize` (2025-11-25) + `tools/list`
 *        - modern `server/discover` (2026-07-28) with the envelope at
 *          `params._meta` + `tools/list`
 *      and asserts the seven tool names and that `instructions` is present in
 *      both eras;
 *   4. scans examples/copilot/** for 64-hex literals and key-looking values
 *      (PS-1) and fails if any are found;
 *   5. asserts that no example sits at a path a host auto-discovers
 *      (`<repo>/.mcp.json`, `<repo>/.vscode/mcp.json`,
 *      `<repo>/.github/mcp.json`), so nothing here executes by itself (PS-6).
 *
 * Default and CI path: the published npm package. LONGSTONE_SMOKE_LOCAL=1 is
 * an offline debugging escape hatch that runs `node dist/cli.js serve` from a
 * local build; it validates protocol logic only, never the registry artifact.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // examples/copilot
const REPO_ROOT = path.resolve(HERE, '..', '..');

const PACKAGE_NAME = '@limccn/longstone';
const EXPECTED_VERSION = '0.1.2';
const EXPECTED_TOOLS = Object.freeze([
  'memory_acl',
  'memory_get',
  'memory_put',
  'memory_put_batch',
  'memory_retract',
  'memory_stage_status',
  'memory_verify',
]);
const INSTRUCTIONS_MARKER = 'untrusted data';

const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const MODERN_META = Object.freeze({
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
});

// Generous: a cold `npx` run downloads and extracts the package before the
// server can answer. Overridable for slow local networks.
const TIMEOUT_MS = positiveInt(process.env.LONGSTONE_SMOKE_TIMEOUT_MS, 300_000);
const LOCAL_MODE = process.env.LONGSTONE_SMOKE_LOCAL === '1';

const CONFIG_ENTRIES = Object.freeze([
  { id: 'portable', surface: 'Portable harness', file: '.mcp.json', rootKey: 'mcpServers', vsCode: false },
  { id: 'vscode', surface: 'VS Code', file: '.vscode/mcp.json', rootKey: 'servers', vsCode: true },
  { id: 'copilot-cli', surface: 'Copilot CLI', file: '.github/mcp.json', rootKey: 'mcpServers', vsCode: false },
]);

// Paths a host scans on its own. None may exist at the repository root; the
// examples are copied deliberately, never auto-loaded (PS-6).
const AUTO_DISCOVERED_PATHS = Object.freeze(['.mcp.json', '.vscode/mcp.json', '.github/mcp.json']);

class SmokeError extends Error {}

function fail(message) {
  throw new SmokeError(message);
}

function positiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SmokeError(`LONGSTONE_SMOKE_TIMEOUT_MS must be a positive number; got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

function extractServerSpec(entry, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    fail(`${entry.file}: invalid JSON: ${error.message}`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    fail(`${entry.file}: expected a JSON object at the top level`);
  }

  const servers = json[entry.rootKey];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    fail(`${entry.file}: expected a "${entry.rootKey}" object (${entry.vsCode ? 'VS Code' : 'portable/CLI'} shape)`);
  }

  const spec = servers.longstone;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    fail(`${entry.file}: no "longstone" server under "${entry.rootKey}"`);
  }

  if (entry.vsCode) {
    if (spec.type !== 'stdio') {
      fail(`${entry.file}: VS Code server must declare "type": "stdio"; got ${JSON.stringify(spec.type)}`);
    }
  } else if (spec.type !== undefined && spec.type !== 'stdio') {
    fail(`${entry.file}: only "stdio" is supported; got ${JSON.stringify(spec.type)}`);
  }

  return { json, spec };
}

function assertLaunchShape(entry, spec, text) {
  if (spec.command !== 'npx') {
    fail(`${entry.file}: command must be exactly "npx"; got ${JSON.stringify(spec.command)}`);
  }
  if (!Array.isArray(spec.args) || spec.args.length === 0 || !spec.args.every((arg) => typeof arg === 'string')) {
    fail(`${entry.file}: "args" must be a non-empty array of strings`);
  }

  if (spec.args.length !== 3) {
    fail(`${entry.file}: args must be exactly ["-y", "${PACKAGE_NAME}@<exact>", "serve"]; got ${JSON.stringify(spec.args)}`);
  }
  if (spec.args[0] !== '-y') {
    fail(`${entry.file}: args[0] must be "-y" so npx runs non-interactively; got ${JSON.stringify(spec.args[0])}`);
  }
  if (spec.args[2] !== 'serve') {
    fail(`${entry.file}: args[2] must be "serve"; got ${JSON.stringify(spec.args[2])}`);
  }

  const reference = spec.args[1];
  const match = /^(@limccn\/longstone)@(.+)$/.exec(reference);
  if (match === null) {
    fail(`${entry.file}: args[1] must be ${PACKAGE_NAME}@<exact version>; got ${JSON.stringify(reference)}`);
  }
  const version = match[2];
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(
      `${entry.file}: ${PACKAGE_NAME} must be pinned to an exact version; got ${JSON.stringify(version)}. ` +
        'Ranges, tags such as "latest", and prereleases are rejected because `npx -y` executes whatever the registry resolves (PS-5).',
    );
  }
  if (version !== EXPECTED_VERSION) {
    fail(
      `${entry.file}: pin ${PACKAGE_NAME}@${version}, but this smoke test expects ` +
        `${PACKAGE_NAME}@${EXPECTED_VERSION}. Update all three examples and EXPECTED_VERSION together.`,
    );
  }

  // Key material never travels in a distributed file; the default carries no
  // env values at all (design §4.1, PS-1).
  if (Object.hasOwn(spec, 'env')) {
    const env = spec.env;
    if (env === null || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 0) {
      fail(`${entry.file}: "env" must be absent or empty. Keys come from the host environment or envFile, never a committed value (PS-1).`);
    }
  }

  // The committed default must not prompt for a key. The `${input:…}` variant
  // is local-harness-only and documented in README.md, never shipped here.
  if (text.includes('${input:')) {
    fail(`${entry.file}: the default configuration must not use "\${input:…}"; that variant is local-harness-only (README.md).`);
  }
  if (/"inputs"\s*:/.test(text)) {
    fail(`${entry.file}: the default configuration must not declare top-level "inputs"; add them only in a local harness copy.`);
  }
}

async function loadAndValidate(entry) {
  const file = path.join(HERE, entry.file);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    fail(`${entry.file}: cannot read ${file}: ${error.message}`);
  }
  const { spec } = extractServerSpec(entry, text);
  assertLaunchShape(entry, spec, text);
  return { entry, spec };
}

// ---------------------------------------------------------------------------
// Secret and auto-discovery scans
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = Object.freeze([
  { label: '0x-prefixed 64-hex-or-longer literal (key-shaped)', regex: /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g },
  { label: '64-hex-or-longer literal (key-shaped)', regex: /(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g },
  { label: 'PEM private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { label: 'API token literal', regex: /\b(?:sk|rk)-[A-Za-z0-9_-]{24,}\b/g },
  { label: 'GitHub token literal', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { label: 'AWS access key literal', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: 'literal key-valued JSON field',
    regex:
      /"(?:privateKey|private_key|secretKey|secret_key|ownerKey|owner_key|longstoneKey|longstone_key|LONGSTONE_KEY|LONGSTONE_OWNER_KEY|mnemonic|seedPhrase|seed_phrase)"\s*:\s*"(?!\$)[^"]{8,}"/g,
  },
  {
    label: 'literal LONGSTONE key assignment',
    regex: /\bLONGSTONE_(?:OWNER_)?KEY\s*=\s*(?!\$)[^\s"'`]{8,}/g,
  },
]);

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function scanForSecrets() {
  const files = await walkFiles(HERE);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    for (const { label, regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match !== null) {
        fail(
          `${relative}:${lineNumberAt(text, match.index)}: found a ${label} (content redacted). ` +
            'Key values must never be committed; pass key names, never values (PS-1).',
        );
      }
    }
  }
  console.log(`[smoke] secret scan: ${files.length} file(s) under examples/copilot/ carry no key-shaped literals`);
}

function assertNoAutoDiscoveredConfigs() {
  for (const relative of AUTO_DISCOVERED_PATHS) {
    const full = path.join(REPO_ROOT, relative);
    if (existsSync(full)) {
      fail(
        `${relative}: a host-auto-discovered MCP configuration exists at the repository root. ` +
          'Examples must stay under examples/copilot/ and be copied deliberately after review (PS-6).',
      );
    }
  }
  console.log('[smoke] auto-discovery scan: no MCP config at a host-discovered root path');
}

// ---------------------------------------------------------------------------
// Child process plumbing
// ---------------------------------------------------------------------------

function createTail(limit = 8192) {
  let text = '';
  return {
    push(chunk) {
      text = (text + chunk).slice(-limit);
    },
    value() {
      return text;
    },
  };
}

function createLineReader(stream) {
  let buffer = '';
  const queue = [];
  const waiters = [];
  let failure = null;

  const settle = (message) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) {
      queue.push(message);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  };

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') {
        try {
          settle(JSON.parse(line));
        } catch {
          // A non-JSON stdout line is not part of the protocol; ignore it.
          // Server diagnostics go to stderr and are captured separately.
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  return {
    fail(error) {
      if (failure !== null) return;
      failure = error;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    },
    next(predicate, what) {
      const queued = queue.findIndex(predicate);
      if (queued !== -1) return Promise.resolve(queue.splice(queued, 1)[0]);
      if (failure !== null) return Promise.reject(failure);

      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new SmokeError(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`));
        }, TIMEOUT_MS);
        waiters.push(waiter);
      });
    },
  };
}

function launchSpec(spec) {
  if (!LOCAL_MODE) {
    return { command: spec.command, args: [...spec.args], local: false };
  }

  const cli = path.join(REPO_ROOT, 'dist', 'cli.js');
  if (!existsSync(cli)) {
    fail('LONGSTONE_SMOKE_LOCAL=1 requires a local build: dist/cli.js is missing. Run "pnpm build" first.');
  }
  return { command: process.execPath, args: [cli, 'serve'], local: true };
}

function spawnServer(launch, cwd, label) {
  const env = { ...process.env };
  // The no-key start is an assertion: remove every key channel and the
  // read-only switch so the server must boot with its writable default.
  for (const name of ['LONGSTONE_KEY', 'LONGSTONE_OWNER_KEY', 'LONGSTONE_MCP_READ_ONLY']) {
    delete env[name];
  }

  const isWindows = process.platform === 'win32';
  // Windows: `npx` on PATH is `npx.cmd`, a batch shim. Node's spawn cannot
  // CreateProcess a .cmd file, so spawning "npx" without a shell fails with
  // ENOENT (not a missing package). Spawn `npx.cmd` through cmd.exe with
  // `shell: true`. Node warns (DEP0190) that shell args are concatenated, not
  // escaped; that is acceptable here because command and args come from
  // reviewed, constant JSON and are validated before this point — no user
  // input is interpolated.
  const useShell = isWindows && !launch.local;
  const executable = useShell ? `${launch.command}.cmd` : launch.command;

  const child = spawn(executable, launch.args, {
    cwd,
    env,
    shell: useShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX: give the child its own process group so a failed run can kill
    // npx and the server it spawned, not just the wrapper.
    detached: !isWindows,
  });

  // A failed spawn produces EPIPE on the first write; the 'error'/'exit'
  // handlers turn that into a clear message instead of a crash.
  child.stdin.on('error', () => {});
  child.on('error', () => {});

  return { child, useShell, executable, label };
}

async function stopChild(child, useShell) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  // EOF is the polite shutdown for a stdio server.
  try {
    child.stdin.end();
  } catch {
    // already closed
  }
  await delay(300);
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (useShell && process.platform === 'win32' && child.pid !== undefined) {
    // child.kill() terminates cmd.exe only; the node process npx started can
    // survive and keep the pipe open. taskkill /T kills the whole tree.
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
  } else if (process.platform === 'win32') {
    child.kill('SIGTERM');
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }

  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

function writeMessage(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

// ---------------------------------------------------------------------------
// Protocol assertions
// ---------------------------------------------------------------------------

function resultOf(message, what, label) {
  if (message === null || typeof message !== 'object') {
    fail(`${label}: ${what} produced no JSON-RPC message`);
  }
  if (message.error !== undefined) {
    fail(`${label}: ${what} returned a JSON-RPC error: ${JSON.stringify(message.error)}`);
  }
  if (message.result === null || typeof message.result !== 'object') {
    fail(`${label}: ${what} returned no result object`);
  }
  return message.result;
}

function assertInstructions(result, label, era) {
  const instructions = result.instructions;
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    fail(`${label} (${era}): the server returned no "instructions" string; every host must inherit the untrusted-memory rule (PS-3).`);
  }
  if (!instructions.toLowerCase().includes(INSTRUCTIONS_MARKER)) {
    fail(
      `${label} (${era}): "instructions" does not contain ${JSON.stringify(INSTRUCTIONS_MARKER)}. ` +
        `Got ${JSON.stringify(instructions)}`,
    );
  }
}

function assertTools(result, label, era) {
  if (!Array.isArray(result.tools)) {
    fail(`${label} (${era}): tools/list returned no "tools" array`);
  }
  const names = result.tools
    .map((tool) => (tool === null || typeof tool !== 'object' ? undefined : tool.name))
    .filter((name) => typeof name === 'string')
    .sort();
  const expected = [...EXPECTED_TOOLS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail(
      `${label} (${era}): expected tools ${expected.join(', ')}; got ${names.length === 0 ? '(none)' : names.join(', ')}. ` +
        'LONGSTONE_MCP_READ_ONLY is removed for this test, so the writable default must register all seven.',
    );
  }
}

async function runHandshake({ spec, cwd, era, label }) {
  const launch = launchSpec(spec);
  const { child, useShell, executable } = spawnServer(launch, cwd, label);
  const stderr = createTail();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const reader = createLineReader(child.stdout);
  let finished = false;
  const stderrSuffix = () => {
    const text = stderr.value().trim();
    return text === '' ? '' : `\n--- server stderr (tail) ---\n${text}`;
  };

  child.on('error', (error) => {
    reader.fail(
      new SmokeError(
        `${label} (${era}): failed to start ${JSON.stringify(executable)}: ${error.message}. ` +
          'On Windows, a host that cannot spawn npx needs the "cmd /c npx …" fallback documented in README.md.' +
          stderrSuffix(),
      ),
    );
  });
  child.on('exit', (code, signal) => {
    if (finished) return;
    reader.fail(
      new SmokeError(
        `${label} (${era}): server exited before the handshake completed ` +
          `(code ${code === null ? 'null' : code}${signal === null ? '' : `, signal ${signal}`}).` +
          stderrSuffix(),
      ),
    );
  });

  try {
    let initResult;
    let toolsResult;

    if (era === 'legacy') {
      writeMessage(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'longstone-copilot-smoke', version: '1' },
        },
      });
      initResult = resultOf(await reader.next((message) => message.id === 1, 'initialize response'), 'initialize', label);
      if (initResult.protocolVersion !== LEGACY_PROTOCOL_VERSION) {
        fail(
          `${label} (legacy): expected negotiated protocolVersion ${LEGACY_PROTOCOL_VERSION}; ` +
            `got ${JSON.stringify(initResult.protocolVersion)}`,
        );
      }
      if (initResult.serverInfo === null || typeof initResult.serverInfo !== 'object' || initResult.serverInfo.name !== 'longstone') {
        fail(`${label} (legacy): initialize did not identify the server as "longstone"`);
      }

      writeMessage(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
      writeMessage(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      toolsResult = resultOf(await reader.next((message) => message.id === 2, 'tools/list response'), 'tools/list', label);
    } else {
      writeMessage(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: MODERN_META },
      });
      initResult = resultOf(await reader.next((message) => message.id === 1, 'server/discover response'), 'server/discover', label);
      if (!Array.isArray(initResult.supportedVersions) || !initResult.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
        fail(
          `${label} (modern): server/discover must advertise ${MODERN_PROTOCOL_VERSION}; ` +
            `got ${JSON.stringify(initResult.supportedVersions)}`,
        );
      }

      // Every modern request carries the version/capabilities envelope.
      writeMessage(child, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { _meta: MODERN_META },
      });
      toolsResult = resultOf(await reader.next((message) => message.id === 2, 'tools/list response'), 'tools/list', label);
    }

    assertInstructions(initResult, label, era);
    assertTools(toolsResult, label, era);

    return { tools: toolsResult.tools.length };
  } finally {
    finished = true;
    await stopChild(child, useShell);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[smoke] longstone Copilot MCP configuration smoke test');
  console.log(`[smoke] expected launch: npx -y ${PACKAGE_NAME}@${EXPECTED_VERSION} serve`);
  if (LOCAL_MODE) {
    console.log('[smoke] LOCAL MODE: running node dist/cli.js serve (offline debugging only; CI uses the published package)');
  }

  const loaded = [];
  for (const entry of CONFIG_ENTRIES) {
    loaded.push(await loadAndValidate(entry));
  }
  console.log(`[smoke] configs: ${loaded.map(({ entry }) => entry.file).join(', ')} passed shape and exact-pin checks`);

  assertNoAutoDiscoveredConfigs();
  await scanForSecrets();

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'longstone-copilot-smoke-'));
  try {
    for (const { entry, spec } of loaded) {
      const cwd = await mkdtemp(path.join(tempRoot, `${entry.id}-`));
      console.log(`\n[smoke] ${entry.surface} -> ${entry.file} (cwd ${cwd})`);

      const legacy = await runHandshake({ spec, cwd, era: 'legacy', label: entry.file });
      console.log(`[smoke]   legacy initialize ${LEGACY_PROTOCOL_VERSION} + tools/list: ${legacy.tools} tools, instructions present`);

      const modern = await runHandshake({ spec, cwd, era: 'modern', label: entry.file });
      console.log(`[smoke]   server/discover ${MODERN_PROTOCOL_VERSION} + tools/list: ${modern.tools} tools, instructions present`);

      console.log(`[smoke] PASS ${entry.file}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n[smoke] PASS all ${loaded.length} Copilot configurations (no key, both protocol eras, seven tools)`);
}

main().catch((error) => {
  if (error instanceof SmokeError) {
    console.error(`\n[smoke] FAIL: ${error.message}`);
  } else {
    console.error('\n[smoke] FAIL (unexpected):', error);
  }
  // Set the code rather than calling process.exit(), so piped stdout/stderr
  // are flushed. Every child is stopped in runHandshake's finally block, so
  // the event loop drains.
  process.exitCode = 1;
});