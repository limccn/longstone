# longstone Agent Skill

The open-format Agent Skill for `@limccn/longstone@0.1.2`: durable memory, recall
with on-chain proof, and verification of a claimed memory.

## Install

```bash
npx skills add limccn/longstone --skill longstone
```

Windows, or any host where symlinks are unavailable:

```bash
npx skills add limccn/longstone --skill longstone --copy
```

The installer discovers `skills/longstone/SKILL.md` in this repository and
installs it for the agent you select. Add `-a <agent>` to target one host
(`-a '*'` targets all supported agents); `-y` skips confirmation prompts.

## Version and tag

- This skill targets **0.1.2**, and every recipe pins
  `npx -y @limccn/longstone@0.1.2`.
- The `v0.1.1` tag predates `skills/`; the skill first shipped from the
  **`v0.1.1-skills`** tag, which contains this directory. From then on it
  changes in the same release as the CLI/MCP tool schemas, and each skill tag
  names the client version it documents.
- `npx skills add limccn/longstone` resolves the repository's default branch, so a
  later install can pick up newer content. That moving-branch risk is why updates
  must be reviewed.

## Updates and lockfile review

- The installer records installed skills in `skills-lock.json` in the project
  where you install, including the source and a content hash.
- Commit that lockfile so the installed content is reproducible.
- Before running `npx skills update`, review the diff of the new `SKILL.md` and
  `references/`. A skill is executable guidance; an unreviewed update is an
  unreviewed instruction source.
- Do not edit an installed copy by hand; reinstall from the repository instead.
