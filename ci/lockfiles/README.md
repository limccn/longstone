# Assembled-workspace lockfile ledger

These files are reviewed `pnpm-lock.yaml` ledgers for component workflows that
assemble a temporary pnpm workspace from sibling repositories. A workflow copies
the matching ledger to `workspace/pnpm-lock.yaml` and runs
`pnpm install --frozen-lockfile`.

`ci/` is outside the npm package `files` list, so ledgers are not published in
`@limccn/longstone`.

## `longstone-ui-deploy.yaml`

- Workflow: `longstone-ui/.github/workflows/deploy.yml` (`verify` and `deploy`)
- Workspace packages: `app` (`longstone-ui`), `longstone-surface`, `menhir/ts`
- pnpm: `12.11.2`
- Node: `24`
- Generated: 2026-10-29
- Size: 182,220 bytes
- SHA-256: `ec9b743d42ad8066b314c059915dc9f799699509888902b9b78748c6668b3472`
- Inputs:
  - `longstone-ui`: `28655ec48baf7e6b35f4f377bccc8f51ce4010e4`
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`
  - `longstone-surface`: `5dc5e3b0971187803b355e211a807d15b1fda584`

The `verify` and `deploy` jobs differ only in whether `pnpm-workspace.yaml`
contains the `audit.ignore` entry. That entry does not affect dependency
resolution; both layouts produced the same lockfile bytes on 2026-10-29.

### Regenerate

Check out the three inputs at the recorded SHAs, lay them out as below, then run
pnpm from the workspace root. Delete any existing lockfile first so pnpm
resolves from scratch.

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
├── app/                 # longstone-ui at 28655ec...
├── menhir/ts            # menhir at cf08e10...
└── longstone-surface/   # longstone-surface at 5dc5e3b...
```

`package.json`:

```json
{"name":"ci-workspace","private":true,"packageManager":"pnpm@12.11.2"}
```

`pnpm-workspace.yaml` (the `verify` job's copy; remove `audit` for `deploy`):

```yaml
packages:
  - "app"
  - "longstone-surface"
  - "menhir/ts"
allowBuilds:
  "@reown/appkit": true
  "esbuild": true
audit:
  ignore:
    - "GHSA-mrhx-c7xc-m3w5"
```

```bash
rm -f pnpm-lock.yaml
corepack pnpm install --lockfile-only
sha256sum pnpm-lock.yaml
```

The result must be 182,220 bytes with the SHA-256 above. Update this file and
`.github/workflows/lockfile-check.yml` together when the ledger changes.

## `hisaishi-ci.yaml`

- Workflow: `hisaishi/.github/workflows/ci.yml` (`verify`)
- Workspace packages: `hisaishi`, `menhir/ts`
- pnpm: `12.11.2`
- Node: `24`
- Generated: 2026-10-29
- Size: 86,935 bytes
- SHA-256: `e5e863d25746493f00b303febcc622b6dcc2280fe732f1fb1768b2d6aad23f5f`
- Inputs:
  - `hisaishi`: `7c8c58ee250e4f85e207d7317cb545da6fc024ce`
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`

### Regenerate

Check out the two inputs at the recorded SHAs, lay them out as below, then run
pnpm from the workspace root. Delete any existing lockfile first so pnpm
resolves from scratch.

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
├── hisaishi/            # hisaishi at 7c8c58e...
└── menhir/ts            # menhir at cf08e10...
```

`package.json`:

```json
{"name":"ci-workspace","private":true,"packageManager":"pnpm@12.11.2"}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "menhir/ts"
  - "hisaishi"
allowBuilds:
  "esbuild": true
  "sharp": true
  "workerd": true
```

```bash
rm -f pnpm-lock.yaml
corepack pnpm install --lockfile-only
sha256sum pnpm-lock.yaml
```

The result must be 86,935 bytes with the SHA-256 above. Update this file and
`.github/workflows/lockfile-check.yml` together when the ledger changes.

### Update process

1. Change a component manifest or workspace input.
2. Regenerate the ledger against the new input SHAs.
3. Open a `longstone` pull request with the ledger, this README, and the
   `lockfile-check` input SHA updates.
4. After the ledger is on `longstone` `main`, merge the component change. Its
   workflow will copy the new ledger and install frozen.

The component workflow fails with `ERR_PNPM_OUTDATED_LOCKFILE` if the ledger and
manifest drift; do not fix that by reverting to `--no-frozen-lockfile`.
