# Supply-chain notes: CI permissions, action pins, and the L-6 lockfile exception

Status as of 2026-10-27. This file is the canonical explanation for the
`pnpm install --no-frozen-lockfile` comments in the component workflows and for
the security claims in the component repositories.

## Scope

Eight independent Git repositories make up MemoryOverEth:

`menhir`, `hisaishi`, `longstone`, `longstone-surface`, `longstone-ext`,
`longstone-vscode`, `longstone-wallet`, and `longstone-ui`.

Their eleven GitHub Actions workflows cover build, deploy, registry, and skill
checks. The seven build and deploy workflows assemble a temporary pnpm
workspace at run time; `dsh-plugin`, `mcp-registry`, `skill`, and
`longstone-wallet` run without assembling one. The project root
(`d:\Workspace\MemoryOverEth`) is **not** a Git repository, so no root-level
lockfile is available to CI.

## Why an assembled workspace cannot use a per-repo lockfile

A workflow checks out sibling repositories into paths such as
`workspace/menhir`, `workspace/hisaishi`, and `workspace/app`, then generates
the root `pnpm-workspace.yaml` and `package.json`. Package locations and
`workspace:*` links exist only in that generated layout.

A lockfile committed inside one component describes that component's standalone
layout. It cannot describe the sibling checkouts, the generated root manifest,
or the `workspace:*` resolution that CI actually uses. Committing it would make
CI and the developer checkout diverge while looking reproducible.

`longstone-wallet` is the exception: it has no sibling workspace dependency,
checks out only itself, and therefore commits a lockfile and installs with
`--frozen-lockfile`.

## Current controls

- Exact versions in every `package.json`; no ranges for runtime dependencies.
- CI builds and tests the assembled workspace on every pull request and push.
- `longstone-ui` runs `pnpm audit --prod` as part of its deploy workflow.
- `longstone-wallet` has a committed `pnpm-lock.yaml` and a frozen install; it
  is the only component for which the lockfile fully describes the tree.
- The assembled-workspace repositories keep `--no-frozen-lockfile` with a
  comment pointing at this file. This is a documented exception, not a claim
  that the workspace is frozen.

Adding `pnpm audit` gates to the remaining repositories is follow-up work, not
part of this exception.

## Action pinning

Third-party actions are pinned to full commit SHAs, resolved on 2026-10-27:

| Action | Ref | Commit SHA |
|---|---|---|
| `pnpm/action-setup` | v4 | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| `amondnet/vercel-action` | v25 | `16e87c0a08142b0d0d33b76aeaf20823c381b9b9` |

The `pnpm/action-setup` tag is annotated; the table uses the dereferenced
commit (`v4^{}`), not the tag object. Workflows retain a `# v4` / `# v25`
comment so upgrades remain reviewable.

GitHub-maintained actions (`actions/checkout`, `actions/setup-node`,
`actions/upload-artifact`) remain on major tags. They are maintained and
tag-protected by GitHub, and pinning every one of them would add maintenance
without removing the upstream trust boundary. This is an intentional exception.

## Permissions

Every workflow declares top-level:

```yaml
permissions:
  contents: read
```

No workflow uses `write-all`, `actions: write`, or `id-token: write`. The
`longstone-ui` deploy job inherits `contents: read`; its `VERCEL_TOKEN` and
`CLOUDFLARE_API_TOKEN` are repository secrets and do not depend on GitHub token
write scopes. The `verify` job does not receive either deploy secret.

## Local root lockfile

A local `pnpm-lock.yaml` exists at the project root for developer runs such as
the wallet-verification runbook. It is not tracked by Git, is not read by CI,
and cannot be committed to a component repository. It is not evidence that the
assembled workspace is frozen.

## Review and follow-up

Review this exception by **2027-01-31**, or earlier if the workspace layout or
package manager changes.

The follow-up task `10-27-lockfile-assembled-workspace` evaluates reproducible
assembly options (CI-generated lockfile and cache, a manifest repository, or
pinned transitive dependencies). Until that work lands, the assembled workspace
remains non-frozen, and no repository or CI text should claim otherwise.
