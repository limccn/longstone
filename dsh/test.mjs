#!/usr/bin/env node
// Dependency-free checks for the longstone DSH bundle.
// Run with: node test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const passes = [];

function check(condition, message) {
  if (condition) {
    passes.push(message);
  } else {
    failures.push(message);
  }
}

function read(relative) {
  return readFileSync(join(here, relative), 'utf8');
}

let pkg;
let patch;
try {
  pkg = JSON.parse(read('package.json'));
  patch = read('cordis.patch.yml');
} catch (error) {
  console.error(`FAIL: cannot read bundle files: ${error.message}`);
  process.exit(1);
}

// package.json shape
check(pkg.name === '@limccn/longstone-dsh', 'package name is @limccn/longstone-dsh');
check(pkg.version === '0.1.0', 'package version is 0.1.0');
check(pkg.private === false, 'package is publishable (private: false)');
check(pkg.type === 'module', 'package type is module');
check(pkg.license === 'Apache-2.0', 'license is Apache-2.0');
check(
  pkg.repository?.url === 'git+https://github.com/limccn/longstone.git',
  'repository points at github.com/limccn/longstone'
);
check(
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'dsh.bundle.patch is ./cordis.patch.yml'
);
check(
  Array.isArray(pkg.files) &&
    pkg.files.includes('cordis.patch.yml') &&
    pkg.files.includes('README.md') &&
    pkg.files.includes('LICENSE'),
  'files includes cordis.patch.yml, README.md and LICENSE'
);
check(pkg.scripts?.test === 'node test.mjs', 'test script is node test.mjs');
check(pkg.engines?.node === '>=24', 'engines.node is >=24');
check(
  pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0,
  'no runtime dependencies'
);

// Patch contents: the officially supported MCP-client row, exact pin.
check(
  patch.includes("name: '@deepseek-ai/dsh-mcp-client'"),
  "patch inserts '@deepseek-ai/dsh-mcp-client'"
);
check(patch.includes('id: longstone-memory'), 'patch row id is longstone-memory');
check(patch.includes('serverName: longstone'), 'patch serverName is longstone');
check(patch.includes('transport: stdio'), 'patch transport is stdio');
check(patch.includes('command: npx'), 'patch command is npx');
check(
  patch.includes("args: ['-y', '@limccn/longstone@0.1.1', 'serve']"),
  'patch runs the exact @limccn/longstone@0.1.1 pin with serve'
);
check(
  !/@limccn\/longstone(?!@0\.1\.1(?![0-9A-Za-z.-]))/.test(patch),
  'patch has no unpinned @limccn/longstone reference'
);
check(patch.includes('toolCallTimeoutMs: 120000'), 'patch toolCallTimeoutMs is 120000');
check(patch.includes('failOnStartupError: false'), 'patch failOnStartupError is false');

// Key material must never live in the published bundle.
const scanned = [
  ['package.json', JSON.stringify(pkg, null, 2)],
  ['cordis.patch.yml', patch],
];
for (const [file, text] of scanned) {
  const ownerKey = /LONGSTONE_OWNER_KEY/.test(text);
  check(!ownerKey, `${file} does not mention LONGSTONE_OWNER_KEY`);

  // A standalone LONGSTONE_KEY key (YAML/env assignment); allow the
  // documented process.env.LONGSTONE_KEY reference in prose.
  const keyAssignment = /(^|[^.\w])["']?LONGSTONE_KEY["']?\s*:/.test(text);
  check(!keyAssignment, `${file} does not assign LONGSTONE_KEY`);

  const hexKey = /(^|[^0-9a-zA-Z])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/.test(text);
  check(!hexKey, `${file} contains no 64-hex key literal`);
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`FAIL: ${message}`);
  }
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

for (const message of passes) {
  console.log(`ok - ${message}`);
}
console.log(`\nAll ${passes.length} checks passed.`);
