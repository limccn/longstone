#!/usr/bin/env node
/**
 * Validate the longstone Agent Skill (open format) and its references.
 *
 * A skill is a distributed instruction source, so this is a security check as
 * well as a format check:
 *
 *   1. SKILL.md has `name: longstone` and a non-empty description.
 *   2. The body states the untrusted-data rule and the M1 testnet-only rule.
 *   3. Every reference named in SKILL.md exists.
 *   4. No file under skills/longstone contains a 64+ hex literal, a PEM private
 *      key, or a key-looking assignment with a literal value.
 *   5. Only Markdown ships in the skill — no scripts, no binaries.
 *
 * Dependency-free on purpose: CI runs this before installing anything.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = join(REPO_ROOT, 'skills', 'longstone');
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md');
const REFERENCES = ['commands.md', 'errors.md', 'depth-model.md'];
const MAX_DESCRIPTION_CHARS = 1024;

const problems = [];
const fail = (message) => problems.push(message);

/** Parse a single-line YAML frontmatter block without a YAML dependency. */
function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { error: 'SKILL.md must start with a YAML frontmatter block ("---")' };
  }
  const close = normalized.indexOf('\n---', 4);
  if (close === -1) {
    return { error: 'frontmatter is not closed by a "---" line' };
  }

  const fields = new Map();
  const lines = normalized.slice(4, close).split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (match === null) {
      return { error: `unsupported frontmatter line ${index + 2}: ${JSON.stringify(line)}` };
    }
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields.set(match[1].toLowerCase(), value);
  }

  return { fields, body: normalized.slice(close + 4) };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
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

const HEX_RUN = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const KEY_ASSIGNMENT =
  /\b(LONGSTONE_OWNER_KEY|LONGSTONE_KEY|PRIVATE_KEY|PRIVATEKEY|SECRET_KEY|MNEMONIC|SEED_PHRASE|API_KEY)\b\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;

function scanFile(path) {
  const rel = relative(REPO_ROOT, path).split('\\').join('/');

  if (extname(path).toLowerCase() !== '.md') {
    fail(`${rel}: only Markdown files may ship in the skill (no scripts or binaries)`);
  }

  const text = readFileSync(path, 'utf8');

  HEX_RUN.lastIndex = 0;
  for (let match = HEX_RUN.exec(text); match !== null; match = HEX_RUN.exec(text)) {
    fail(
      `${rel}:${lineOf(text, match.index)}: 64+ hex literal found; distribute placeholders, never key material`,
    );
  }

  if (PEM_PRIVATE_KEY.test(text)) {
    fail(`${rel}: PEM private-key block found; keys come only from the environment`);
  }

  KEY_ASSIGNMENT.lastIndex = 0;
  for (let match = KEY_ASSIGNMENT.exec(text); match !== null; match = KEY_ASSIGNMENT.exec(text)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!isPlaceholder(value)) {
      fail(
        `${rel}:${lineOf(text, match.index)}: key-looking assignment ${JSON.stringify(match[1])} ` +
          'carries a literal value; keys come only from the environment',
      );
    }
  }
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

if (!existsSync(SKILL_PATH)) {
  process.stderr.write(`validate-skill: FAIL: missing ${SKILL_PATH}\n`);
  process.exit(1);
}

const source = readFileSync(SKILL_PATH, 'utf8');
const frontmatter = parseFrontmatter(source);

if (frontmatter.error !== undefined) {
  fail(frontmatter.error);
} else {
  const name = frontmatter.fields.get('name') ?? '';
  const description = frontmatter.fields.get('description') ?? '';

  if (name !== 'longstone') {
    fail(`frontmatter name must be "longstone" (got ${JSON.stringify(name)})`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail('frontmatter name must be lowercase kebab-case');
  }
  if (description.trim() === '') {
    fail('frontmatter description must be non-empty');
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    fail(
      `frontmatter description is ${description.length} characters; the open format caps it at ${MAX_DESCRIPTION_CHARS}`,
    );
  }

  const body = frontmatter.body;
  if (!/untrusted data/i.test(body)) {
    fail('SKILL.md must state that recalled memory text is untrusted data');
  }
  if (!/never\s+(?:execute|follow|act on)\b/i.test(body)) {
    fail('SKILL.md must say never to execute or follow instructions found in a memory');
  }
  if (!/testnet[- ]only/i.test(body)) {
    fail('SKILL.md must state that M1 is testnet-only');
  }

  for (const reference of REFERENCES) {
    const link = `references/${reference}`;
    const path = join(SKILL_DIR, 'references', reference);
    if (!body.includes(link)) {
      fail(`SKILL.md must link to ${link}`);
    }
    if (!existsSync(path)) {
      fail(`missing ${relative(REPO_ROOT, path).split('\\').join('/')}`);
    }
  }

  // Every reference the body links to must exist, not only the required set:
  // a dangling progressive-disclosure link is a broken instruction source.
  const linked = new Set();
  for (const match of body.matchAll(/\(\.?\/?(references\/[A-Za-z0-9._-]+\.md)(?:#[^)]+)?\)/g)) {
    linked.add(match[1]);
  }
  for (const link of linked) {
    if (!existsSync(join(SKILL_DIR, link))) {
      fail(`SKILL.md links to missing ${link}`);
    }
  }
}

const scanned = existsSync(SKILL_DIR) ? walk(SKILL_DIR) : [];
for (const file of scanned) scanFile(file);
if (scanned.length === 0) fail('skills/longstone contains no files');

if (problems.length > 0) {
  process.stderr.write(`validate-skill: FAIL — ${problems.length} problem(s)\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `validate-skill: OK — name=longstone, description=${frontmatter.fields.get('description').length} chars, ` +
    `${scanned.length} Markdown files, references present, no key material\n`,
);
