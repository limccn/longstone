# @limccn/longstone-dsh

A DeepSeek Harness (DSH) plugin bundle that exposes longstone's MCP memory
server to a DSH profile. It contains no native plugin code: `cordis.patch.yml`
inserts one row for the official `@deepseek-ai/dsh-mcp-client`, pointed at
`npx @limccn/longstone@0.1.1 serve`.

## Preview status

Built and probed against these DSH release candidates:

| Package | Probed version |
|---|---|
| `@deepseek-ai/dsh` | `0.2.1-rc.2` |
| `@deepseek-ai/dsh-mcp-client` | `0.0.1-rc.1` |

DSH is in developer preview and warns about breaking changes. The bundle only
uses the documented bundle/patch format and the MCP-client config row, so it
does not import preview TypeScript APIs; the row may need updating when the
preview stabilises.

## Install

From npm:

```sh
dsh plugin --profile <name> add @limccn/longstone-dsh
```

From a local checkout of this directory:

```sh
cd longstone/dsh
dsh plugin --profile <name> add .
```

Installation forwards to pnpm and writes under `$DSH_HOME/profiles/<name>/`.
Config layers apply in order: bundles → profile patch → user patch → `--patch`.

## Verify

```sh
dsh --profile <name> --dump-config
```

The dump must contain the inserted row: id `longstone-memory`, name
`@deepseek-ai/dsh-mcp-client`, `serverName: longstone`, `transport: stdio`,
`command: npx`, and args `['-y', '@limccn/longstone@0.1.1', 'serve']`.

After the profile boots, longstone's tools appear as `mcp__longstone__*`:
`mcp__longstone__memory_put`, `mcp__longstone__memory_get`,
`mcp__longstone__memory_verify`, `mcp__longstone__memory_retract`,
`mcp__longstone__memory_acl`, `mcp__longstone__memory_stage_status`.

The version is pinned exactly (`@limccn/longstone@0.1.1`); `npx -y` downloads
that version on first boot and reuses the npx cache afterwards.

## Key channel

The patch carries **no key literal**. longstone reads its signing key only
from the environment of the server process. Pick one channel:

- **Omit `env`** (what this bundle does) and put `LONGSTONE_KEY` in the
  environment that launches `dsh`; or
- Reference the profile environment explicitly in a profile patch, e.g.
  `LONGSTONE_KEY: !!js process.env.LONGSTONE_KEY`.

Never wire `LONGSTONE_OWNER_KEY` into a DSH profile: owner actions (`acl`
grant/revoke, `retract-any`) stay outside agent sessions. A 64-hex literal in
`cordis.patch.yml` is a bug, and `test.mjs` rejects one.

### Missing key degrades to typed write errors

`failOnStartupError: false` keeps a failed MCP-server startup (for example an
`npx` or network failure) from aborting the DSH profile.

Without `LONGSTONE_KEY`, longstone still starts and registers all six tools.
Reads (`memory_get`, `memory_verify`, `memory_stage_status`) work, while writes
(`memory_put`, `memory_retract`, `memory_acl` grant/revoke) fail with the typed
`NO_KEY` error; `memory_acl list` remains a read. Provide the key through the
channel above and restart the profile to enable writes.

## Test

From a repository checkout (the test file is not part of the published
package):

```sh
node test.mjs
```

Dependency-free checks: the `dsh.bundle.patch` pointer, the exact MCP-client
row and 0.1.1 pin, and the absence of key material (`LONGSTONE_OWNER_KEY`,
a `LONGSTONE_KEY:` assignment, or a 64-hex literal) in the published files.

## License

Apache-2.0. See `LICENSE`.
