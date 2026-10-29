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
  - `hisaishi`: `29562c44a0ff96ea80d35e787ca7ea0ab6da3627`
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`

`7c8c58e` (the `hisaishi` commit used for the first generation) and `29562c4`
differ only in `.github/workflows/ci.yml`. Regenerating at `29562c4` produced
the same bytes on 2026-10-29.

### Regenerate

Check out the two inputs at the recorded SHAs, lay them out as below, then run
pnpm from the workspace root. Delete any existing lockfile first so pnpm
resolves from scratch.

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
├── hisaishi/            # hisaishi at 29562c4...
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

## `longstone-ci.yaml`

- Workflow: `longstone/.github/workflows/ci.yml` (`verify`)
- Workspace packages: `longstone`, `hisaishi`, `menhir/ts`, `menhir/contracts`
- pnpm: `12.11.2`
- Node: `24`
- Generated: 2026-10-29
- Size: 126,193 bytes
- SHA-256: `5af88665af9e471950443da08f1424a96b686c2c923d5b9f0eeb6cbe4e3865bf`
- Inputs:
  - `longstone`: `a0333313dad8590748054df02ddd3932d6fb3186`
  - `hisaishi`: `29562c44a0ff96ea80d35e787ca7ea0ab6da3627`
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`

### Regenerate

Check out the three inputs at the recorded SHAs, lay them out as below, then run
pnpm from the workspace root. Delete any existing lockfile first so pnpm
resolves from scratch.

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
├── longstone/           # longstone at a033331...
├── hisaishi/            # hisaishi at 29562c4...
└── menhir/              # menhir at cf08e10...
```

`package.json`:

```json
{"name":"ci-workspace","private":true,"packageManager":"pnpm@12.11.2"}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "menhir/ts"
  - "menhir/contracts"
  - "hisaishi"
  - "longstone"
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

The result must be 126,193 bytes with the SHA-256 above. Update this file and
`.github/workflows/lockfile-check.yml` together when the ledger changes.

## `menhir-ci.yaml`

- Workflow: `menhir/.github/workflows/ci.yml` (`verify`)
- Workspace packages: `menhir/ts`, `menhir/contracts`
- pnpm: `12.11.2`
- Node: `24`
- Generated: 2026-10-29
- Size: 83,684 bytes
- SHA-256: `6face08a514032ec92ab9a4495d54cc576205727ab21474e3b25fa716379d35d`
- Inputs:
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`

### Regenerate

Check out the input at the recorded SHA, lay it out as below, then run pnpm from
the workspace root. Delete any existing lockfile first so pnpm resolves from
scratch.

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
└── menhir/              # menhir at cf08e10...
```

`package.json`:

```json
{"name":"ci-workspace","private":true,"packageManager":"pnpm@12.11.2"}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "menhir/ts"
  - "menhir/contracts"
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

The result must be 83,684 bytes with the SHA-256 above. Update this file and
`.github/workflows/lockfile-check.yml` together when the ledger changes.

## `longstone-surface-ci.yaml`

- Workflow: `longstone-surface/.github/workflows/ci.yml` (`verify`)
- Workspace packages: `surface` (`longstone-surface`), `menhir/ts`
- pnpm: `12.11.2`
- Node: `24`
- Generated: 2026-10-29
- Size: 47,215 bytes
- SHA-256: `23cb51fa7417213d1d2271faf422bdfd4a464b0b1d8f1edcfd9bac9af07dde2f`
- Inputs:
  - `longstone-surface`: `5dc5e3b0971187803b355e211a807d15b1fda584`
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`

### Regenerate

Check out the two inputs at the recorded SHAs, lay them out as below, then run
pnpm from the workspace root. Delete any existing lockfile first so pnpm
resolves from scratch.

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
├── surface/             # longstone-surface at 5dc5e3b...
└── menhir/ts            # menhir at cf08e10...
```

`package.json`:

```json
{"name":"ci-workspace","private":true,"packageManager":"pnpm@12.11.2"}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "surface"
  - "menhir/ts"
allowBuilds:
  "esbuild": true
```

```bash
rm -f pnpm-lock.yaml
corepack pnpm install --lockfile-only
sha256sum pnpm-lock.yaml
```

The result must be 47,215 bytes with the SHA-256 above. Update this file and
`.github/workflows/lockfile-check.yml` together when the ledger changes.

## `longstone-ext-ci-verify.yaml`

- Workflow: `longstone-ext/.github/workflows/ci.yml` (`verify`)
- Workspace packages: `app` (`longstone-ext`), `longstone-surface`,
  `longstone-wallet`, `menhir/ts`
- pnpm: `12.11.2`
- Node: `24`
- Generated: 2026-10-29
- Size: 81,969 bytes
- SHA-256: `69d8f2d381dc9176bbe2debe6ede5b83c16195494cd397ca81f8ccc7ae1371b3`
- Inputs:
  - `longstone-ext`: `9c80d550df4b2b11afce344790fff3db67960d04`
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`
  - `longstone-surface`: `5dc5e3b0971187803b355e211a807d15b1fda584`
  - `longstone-wallet`: `2df16b709b85d80d919645e8304eab73c1d70e8c`

The first generation used `menhir` `64cd72e` and `longstone-surface` `cad3aa7`;
those commits differ from the recorded SHAs only in `.github/workflows/ci.yml`.
Regenerating at the recorded SHAs produced the same bytes on 2026-10-29.

### Regenerate

Check out the four inputs at the recorded SHAs, lay them out as below, then run
pnpm from the workspace root. Delete any existing lockfile first so pnpm
resolves from scratch.

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
├── app/                 # longstone-ext at 9c80d55...
├── menhir/              # menhir at cf08e10...
├── longstone-surface/   # longstone-surface at 5dc5e3b...
└── longstone-wallet/    # longstone-wallet at 2df16b7...
```

`package.json`:

```json
{"name":"ci-workspace","private":true,"packageManager":"pnpm@12.11.2"}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "app"
  - "longstone-surface"
  - "longstone-wallet"
  - "menhir/ts"
allowBuilds:
  "esbuild": true
```

```bash
rm -f pnpm-lock.yaml
corepack pnpm install --lockfile-only
sha256sum pnpm-lock.yaml
```

The result must be 81,969 bytes with the SHA-256 above. Update this file and
`.github/workflows/lockfile-check.yml` together when the ledger changes.

## `longstone-ext-ci-e2e.yaml`

- Workflow: `longstone-ext/.github/workflows/ci.yml` (`e2e`)
- Workspace packages: `app` (`longstone-ext`), `longstone-surface`,
  `longstone-wallet`, `menhir/ts`, `menhir/contracts`
- pnpm: `12.11.2`
- Node: `24`
- Generated: 2026-10-29
- Size: 117,167 bytes
- SHA-256: `4ddb2475681c253ec006d8d091c5ef955162083f250a4a236881274e02fbbae8`
- Inputs:
  - `longstone-ext`: `9c80d550df4b2b11afce344790fff3db67960d04`
  - `menhir`: `cf08e105c526e2cdf3438854cc3cf3825ed3d4d3`
  - `longstone-surface`: `5dc5e3b0971187803b355e211a807d15b1fda584`
  - `longstone-wallet`: `2df16b709b85d80d919645e8304eab73c1d70e8c`

`e2e` adds `menhir/contracts` because `scripts/e2e.mjs` starts `hardhat node`
from that package. The sibling commits used for the first generation differ
from the recorded SHAs only in `.github/workflows/ci.yml`; the regenerated
bytes matched on 2026-10-29.

### Regenerate

Lay out the same four inputs as `longstone-ext-ci-verify.yaml`, then use:

```text
workspace/
├── pnpm-workspace.yaml
├── package.json
├── app/                 # longstone-ext at 9c80d55...
├── menhir/              # menhir at cf08e10...
├── longstone-surface/   # longstone-surface at 5dc5e3b...
└── longstone-wallet/    # longstone-wallet at 2df16b7...
```

`package.json`:

```json
{"name":"ci-workspace","private":true,"packageManager":"pnpm@12.11.2"}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "app"
  - "longstone-surface"
  - "longstone-wallet"
  - "menhir/ts"
  - "menhir/contracts"
allowBuilds:
  "esbuild": true
```

```bash
rm -f pnpm-lock.yaml
corepack pnpm install --lockfile-only
sha256sum pnpm-lock.yaml
```

The result must be 117,167 bytes with the SHA-256 above. Update this file and
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
