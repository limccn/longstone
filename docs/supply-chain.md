# Supply-chain notes: CI permissions, action pins, and the L-6 lockfile exception

Status as of 2026-10-29. This file is the canonical explanation for the
`pnpm install --no-frozen-lockfile` comments in the component workflows, the
reviewed-lockfile ledgers in `ci/lockfiles/`, and the security claims in the
component repositories.

## Scope

Eight independent Git repositories make up MemoryOverEth:

`menhir`, `hisaishi`, `longstone`, `longstone-surface`, `longstone-ext`,
`longstone-vscode`, `longstone-wallet`, and `longstone-ui`.

Their twelve GitHub Actions workflows cover build, deploy, registry, skill, and
lockfile checks. The seven build and deploy workflows assemble a temporary pnpm
workspace at run time; `dsh-plugin`, `mcp-registry`, `skill`, and
`longstone-wallet` run without assembling one. `longstone`'s `lockfile-check`
assembles the `longstone-ui`, `hisaishi`, `longstone`, `menhir`, and
`longstone-surface` layouts only to verify the reviewed ledgers. The
project root (`d:\Workspace\MemoryOverEth`) is **not** a Git repository, so no
root-level lockfile is available to CI.

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

## Reviewed lockfile ledger (B′)

`longstone-ui` is the first assembled workflow migrated to a reviewed lockfile.
`longstone/ci/lockfiles/longstone-ui-deploy.yaml` records the full lockfile for
the exact `app` / `longstone-surface` / `menhir/ts` layout and input commits.
Both `longstone-ui` `verify` and `deploy` checkout `limccn/longstone`, copy the
ledger to `workspace/pnpm-lock.yaml`, and run
`pnpm install --frozen-lockfile`. A missing or stale ledger fails the job; there
is no non-frozen fallback.

`hisaishi` is the second workflow migrated. Its
`longstone/ci/lockfiles/hisaishi-ci.yaml` records the `hisaishi` /
`menhir/ts` layout; `hisaishi`'s `ci` workflow copies it to
`workspace/pnpm-lock.yaml` and installs with `--frozen-lockfile`.

`longstone`'s own `ci` workflow is the third migration. Its
`longstone/ci/lockfiles/longstone-ci.yaml` records the `longstone` /
`hisaishi` / `menhir` layout. Because this is the ledger-host repository, the
workflow checks the ledger out explicitly at `main` so a pull request cannot
install from a ledger it changes itself.

`menhir` is the fourth migration. Its `longstone/ci/lockfiles/menhir-ci.yaml`
records the `menhir/ts` and `menhir/contracts` layout; `menhir`'s `ci` workflow
copies it to `workspace/pnpm-lock.yaml` and installs with
`--frozen-lockfile`.

`longstone-surface` is the fifth migration. Its
`longstone/ci/lockfiles/longstone-surface-ci.yaml` records the `surface` /
`menhir/ts` layout; its `ci` workflow copies it to
`workspace/pnpm-lock.yaml` and installs with `--frozen-lockfile`.

`longstone/ci/lockfiles/README.md` records the input SHAs and regeneration
steps. `longstone`'s `lockfile-check` workflow regenerates each lockfile from
its recorded inputs and compares it byte-for-byte with the ledger.

This is a per-workflow rollout, not a blanket claim. The remaining assembled
workflows (`longstone-ext` and `longstone-vscode`) still use
`--no-frozen-lockfile` under the L-6 exception below.

## Current controls

- Exact versions in every `package.json`; no ranges for runtime dependencies.
- CI builds and tests the assembled workspace on every pull request and push.
- `longstone-ui` runs `pnpm audit --prod` as part of its deploy workflow, and
  both its `verify` and `deploy` jobs install from the reviewed
  `longstone/ci/lockfiles/longstone-ui-deploy.yaml` ledger with
  `--frozen-lockfile`.
- `hisaishi` installs from `longstone/ci/lockfiles/hisaishi-ci.yaml` with
  `--frozen-lockfile`; `lockfile-check` regenerates the `hisaishi` /
  `menhir/ts` layout from the recorded input SHAs.
- `longstone`'s own `ci` workflow installs from
  `longstone/ci/lockfiles/longstone-ci.yaml` with `--frozen-lockfile`, checking
  the ledger out explicitly at `main`.
- `menhir` installs from `longstone/ci/lockfiles/menhir-ci.yaml` with
  `--frozen-lockfile`.
- `longstone-surface` installs from
  `longstone/ci/lockfiles/longstone-surface-ci.yaml` with
  `--frozen-lockfile`.
- `longstone-wallet` has a committed `pnpm-lock.yaml` and a frozen install; it
  is the only component whose lockfile lives in its own repository.
- The remaining assembled-workspace workflows (`longstone-ext` with two
  installs and `longstone-vscode`) keep `--no-frozen-lockfile` with a comment
  pointing at this file. This is a
  documented exception, not a claim that those workspaces are frozen.
- `longstone`'s `lockfile-check` workflow verifies each committed ledger against
  its recorded inputs on every pull request and push to `main`.

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

The evaluation task `10-27-lockfile-assembled-workspace` selected B′
(`longstone`-hosted ledger). The rollout task `10-29-lockfile-ledger-rollout`
migrated `longstone-ui`; the follow-up task `10-29-lockfile-ledger-rollout-rest`
continues in order with `hisaishi`, `longstone`, `menhir`, and
`longstone-surface` (all migrated) and the remaining workflows.
Until a workflow is listed above as migrated, it remains non-frozen, and no
repository or CI text should claim otherwise.
