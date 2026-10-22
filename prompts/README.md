# longstone prompt kit

One canonical statement of the memory discipline, plus the host-specific files
generated from it.

**Edit only [`memory-discipline.md`](./memory-discipline.md).** Everything under
`generated/` is overwritten by the generator; a hand edit fails CI.

Run from the repository root:

```bash
node scripts/generate-prompts.mjs          # rewrite generated/
node scripts/generate-prompts.mjs --check  # CI: exit 1 on drift
```

## Generated files and destinations

| Generated file | Copy to | Host |
|---|---|---|
| [`generated/copilot-instructions.md`](./generated/copilot-instructions.md) | `.github/copilot-instructions.md` | GitHub Copilot repository instructions (VS Code, Copilot CLI, github.com coding agent) |
| [`generated/longstone.agent.md`](./generated/longstone.agent.md) | `.github/agents/longstone.agent.md` | GitHub Copilot custom agent named `longstone-memory` |
| [`generated/dsh-profile-note.md`](./generated/dsh-profile-note.md) | the DSH profile's README or patch notes | DeepSeek Harness |

The generated files assume the longstone MCP server is configured for the host.
Use the matching config from [`examples/copilot/`](../examples/copilot/README.md)
or the DSH bundle in [`dsh/`](../dsh/README.md).

## Header and drift

Every generated file begins with:

```text
<!-- generated from prompts/memory-discipline.md; do not edit by hand -->
```

The exception is `longstone.agent.md`: its YAML frontmatter must be the first
thing in the file for Copilot to recognize the custom agent, so the header is
the first line of the body.

`.github/workflows/ci.yml` runs `node scripts/generate-prompts.mjs --check` in
the `verify` job. The comparison is byte-for-byte; edit the canonical document
and regenerate instead of editing a generated file.

## Safety

The generator fails if the canonical document loses the untrusted-memory rule or
the M1 testnet-only rule, and it rejects 64-hex literals, PEM private keys, and
key-looking assignments with literal values in every prompt file. Keys come only
from the environment; these files carry variable names, never values.
