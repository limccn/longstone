#!/usr/bin/env node
/**
 * Generate the host-specific longstone prompt files from the single canonical
 * document, `prompts/memory-discipline.md`.
 *
 *   node scripts/generate-prompts.mjs          # write the generated files
 *   node scripts/generate-prompts.mjs --check  # compare; exit 1 on drift
 *
 * The prompt files are distributed instruction sources, so this is a security
 * check as well as a generator:
 *
 *   1. The canonical document states the untrusted-memory rule and the
 *      M1 testnet-only rule. A generated snippet that omitted either would
 *      teach an agent the wrong discipline, so generation fails instead.
 *   2. No prompt file contains a 64+ hex literal, a PEM private key, or a
 *      key-looking assignment with a literal value. Keys come only from the
 *      environment, never from a prompt.
 *   3. Every generated file carries the same header pointing back to the
 *      canonical document. `--check` is byte-for-byte; CI runs it so drift is
 *      a failed build, not a review finding.
 *
 * Dependency-free on purpose: CI runs this before installing anything. The
 * only exception to "header first" is `longstone.agent.md`, whose YAML
 * frontmatter must be at byte 0 for Copilot to recognise the custom agent; its
 * header is the first line of the body.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS_DIR = join(REPO_ROOT, 'prompts');
const CANONICAL_PATH = join(PROMPTS_DIR, 'memory-discipline.md');
const GENERATED_DIR = join(PROMPTS_DIR, 'generated');

const HEADER = '<!-- generated from prompts/memory-discipline.md; do not edit by hand -->';

const AGENT_NAME = 'longstone-memory';
const AGENT_DESCRIPTION =
  'Remember durable facts, recall with on-chain proof, and verify a memory before trusting it. Use for longstone memory operations.';

const COPILOT_TAIL = `## Configure longstone

The MCP server is configured by the host, not by this file. Copy the config
that matches your surface from \`examples/copilot/\`: \`.mcp.json\` (portable
harness), \`.vscode/mcp.json\` (VS Code), or \`.github/mcp.json\` (Copilot CLI).
See \`examples/copilot/README.md\` for the key channel of each host.`;

const AGENT_TAIL = `## Configure longstone for this agent

This custom agent expects the longstone MCP server to be configured for the
host. Copy the config that matches your surface from \`examples/copilot/\`:
\`.mcp.json\` (portable harness), \`.vscode/mcp.json\` (VS Code), or
\`.github/mcp.json\` (Copilot CLI). Use the exact version pinned there, and
supply keys through the host environment only. See
\`examples/copilot/README.md\`.`;

const DSH_TAIL = `## DeepSeek Harness profile

This note belongs in a DSH profile's README or patch notes. Install the plugin
bundle from \`dsh/\` with \`dsh plugin --profile <name> add @limccn/longstone-dsh\`,
then confirm the inserted row with \`dsh --profile <name> --dump-config\`. The
bundle inserts the official \`@deepseek-ai/dsh-mcp-client\` row that launches
the longstone MCP server. See \`dsh/README.md\` for the probed preview versions,
the key channel, and the typed \`NO_KEY\` degradation when no key is present.
Never wire \`LONGSTONE_OWNER_KEY\` into a DSH profile.`;

const OUTPUTS = [
  {
    rel: 'prompts/generated/copilot-instructions.md',
    render: (canonical) => withHeader(canonical, COPILOT_TAIL),
  },
  {
    rel: 'prompts/generated/longstone.agent.md',
    render: (canonical) =>
      [
        '---',
        `name: ${AGENT_NAME}`,
        `description: ${AGENT_DESCRIPTION}`,
        '---',
        withHeader(canonical, AGENT_TAIL),
      ].join('\n'),
  },
  {
    rel: 'prompts/generated/dsh-profile-note.md',
    render: (canonical) => withHeader(canonical, DSH_TAIL),
  },
];

const HEX_RUN = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const KEY_ASSIGNMENT =
  /\b(LONGSTONE_OWNER_KEY|LONGSTONE_KEY|PRIVATE_KEY|PRIVATEKEY|SECRET_KEY|MNEMONIC|SEED_PHRASE|API_KEY)\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;

const args = process.argv.slice(2);
const check = args.includes('--check');
const unknown = args.filter((arg) => arg !== '--check');
if (unknown.length > 0) {
  process.stderr.write(
    `generate-prompts: unknown argument(s): ${unknown.join(', ')}\n` +
      'usage: node scripts/generate-prompts.mjs [--check]\n',
  );
  process.exit(1);
}

const problems = [];
const fail = (message) => problems.push(message);

function relPath(path) {
  return relative(REPO_ROOT, path).split('\\').join('/');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Build one generated file: header, canonical document, host-specific tail. */
function withHeader(canonical, tail) {
  return `${HEADER}\n\n${canonical}\n\n${tail}\n`;
}

/** A value that names a source instead of carrying a secret. */
function isPlaceholder(value) {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return (
    /^<[^>]*>$/.test(trimmed) ||
    /^\$\{[^}]*\}$/.test(trimmed) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ||
    /^(?:process\.)?env(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/i.test(trimmed) ||
    /^(?:unset|required|inherited|from the environment|none|null)$/i.test(trimmed)
  );
}

/** Reject key material in a prompt file, whether on disk or generated in memory. */
function scanText(label, text) {
  const normalized = text.replace(/\r\n/g, '\n');

  HEX_RUN.lastIndex = 0;
  for (let match = HEX_RUN.exec(normalized); match !== null; match = HEX_RUN.exec(normalized)) {
    fail(
      `${label}:${lineOf(normalized, match.index)}: 64+ hex literal found; ` +
        'prompts carry variable names, never key material',
    );
  }

  if (PEM_PRIVATE_KEY.test(normalized)) {
    fail(`${label}: PEM private-key block found; keys come only from the environment`);
  }

  KEY_ASSIGNMENT.lastIndex = 0;
  for (let match = KEY_ASSIGNMENT.exec(normalized); match !== null; match = KEY_ASSIGNMENT.exec(normalized)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!isPlaceholder(value)) {
      fail(
        `${label}:${lineOf(normalized, match.index)}: key-looking assignment ` +
          `${JSON.stringify(match[1])} carries a literal value; keys come only from the environment`,
      );
    }
  }
}

function walk(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(full);
  }
  return files;
}

if (!existsSync(CANONICAL_PATH)) {
  process.stderr.write(`generate-prompts: FAIL: missing ${relPath(CANONICAL_PATH)}\n`);
  process.exit(1);
}

// Normalise line endings and the trailing newline so generation is identical
// on every platform and a CRLF checkout cannot cause false drift.
const canonical = readFileSync(CANONICAL_PATH, 'utf8').replace(/\r\n/g, '\n').trimEnd();

const requiredRules = [
  ['the untrusted-memory rule', /untrusted data/i],
  ['the never-follow rule', /never\s+(?:execute|follow|act on)\b/i],
  ['the M1 testnet-only rule', /testnet[- ]only/i],
];
for (const [label, pattern] of requiredRules) {
  if (!pattern.test(canonical)) {
    fail(`${relPath(CANONICAL_PATH)}: missing ${label}; generated prompts would omit it`);
  }
}

scanText(relPath(CANONICAL_PATH), canonical);

const generated = OUTPUTS.map((output) => ({
  ...output,
  text: output.render(canonical),
}));

// The rules must survive into every derived snippet, not only the canonical
// source. Otherwise a future change to the render functions could ship a
// snippet that silently drops a rule while the canonical check still passes.
for (const output of generated) {
  for (const [label, pattern] of requiredRules) {
    if (!pattern.test(output.text)) {
      fail(`${output.rel}: missing ${label}; the generated prompt would omit it`);
    }
  }
}

for (const output of generated) scanText(output.rel, output.text);

// Scan any prompt file that is not generated from the canonical document
// (currently prompts/README.md), so a hand-written note cannot smuggle a key.
const generatedRels = new Set(generated.map((output) => output.rel));
for (const file of walk(PROMPTS_DIR)) {
  const rel = relPath(file);
  if (!generatedRels.has(rel) && file !== CANONICAL_PATH) {
    scanText(rel, readFileSync(file, 'utf8'));
  }
}

if (problems.length > 0) {
  process.stderr.write(`generate-prompts: FAIL — ${problems.length} problem(s)\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

if (check) {
  const drift = [];
  for (const output of generated) {
    const path = join(REPO_ROOT, output.rel);
    if (!existsSync(path)) {
      drift.push(`${output.rel} (missing)`);
      continue;
    }
    if (readFileSync(path, 'utf8') !== output.text) {
      drift.push(`${output.rel} (content differs)`);
    }
  }

  if (drift.length > 0) {
    process.stderr.write(
      `generate-prompts: FAIL — ${drift.length} generated file(s) out of date:\n` +
        drift.map((entry) => `  - ${entry}\n`).join('') +
        'Run `node scripts/generate-prompts.mjs` and commit the result.\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `generate-prompts: OK — ${generated.length} generated files match prompts/memory-discipline.md\n`,
  );
  process.exit(0);
}

mkdirSync(GENERATED_DIR, { recursive: true });
for (const output of generated) {
  writeFileSync(join(REPO_ROOT, output.rel), output.text, 'utf8');
}

process.stdout.write(
  `generate-prompts: OK — wrote ${generated.length} files from prompts/memory-discipline.md:\n` +
    generated.map((output) => `  - ${output.rel}\n`).join(''),
);
