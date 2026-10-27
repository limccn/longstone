# longstone command recipes

Targets `@limccn/longstone@0.1.2`. CLI output is JSON on stdout; progress and the
throwaway-key banner go to stderr. Every recipe is copyable as-is except for the
`<placeholders>`.

## Launch the MCP server

```bash
npx -y @limccn/longstone@0.1.2 serve
```

The host must supply `LONGSTONE_KEY` through its environment. Do not add a key
value to an MCP config. If the host neither inherits the environment nor provides
a secret channel, stop and ask the user to configure one.

A portable config needs only the command; the key is inherited:

```json
{
  "mcpServers": {
    "longstone": {
      "command": "npx",
      "args": ["-y", "@limccn/longstone@0.1.2", "serve"]
    }
  }
}
```

## CLI

Run the pinned package without installing:

```bash
npx -y @limccn/longstone@0.1.2 <command>
```

### put — remember one fact

```bash
npx -y @limccn/longstone@0.1.2 put \
  --text "<memory text>" \
  --tags "layer:deep,topic:prefs" \
  [--prev 0x<commitment-hash>] \
  [--owner 0x<owner-address>] \
  [--agent-registry <namespace>:<chainId>:0x<identity-registry> --agent-id <decimal>]
```

Returns `{ cid, commitmentHash, txHash, confirmed, agent }`; `agent` is the
anchored `{ registry, agentId }` pointer or `null`. `--owner` defaults to the
signing key's address. Tags are comma-separated; `--prev` names the predecessor
commitment (the new commitment is its successor).

`--agent-registry` and `--agent-id` are both-or-neither and write
`MemoryContent.meta.agent`. The reference is a pointer only: ownership and ACL
remain menhir's, and `verify` never reads it. It becomes part of the content, so
it changes the content hash and the `(owner, contentHash)` dedup identity.
Omitting both keeps the bytes identical to 0.1.1. There is no default registry.

If the transaction is broadcast and mined but the gateway confirm cannot be
reached, the command still returns `txHash` with `confirmed: false` and prints a
warning to stderr — the write happened. Recover with `confirm --tx-hash <hash>`
below; do not write the same text again while its row is batched.

### put-batch — remember 1-64 facts in one transaction

```bash
npx -y @limccn/longstone@0.1.2 put-batch \
  --text "<memory text 1>" \
  --text "<memory text 2>" \
  [--text "<memory text 3>" ...] \
  --tags "layer:deep,topic:prefs" \
  [--prev 0x<commitment-hash>] \
  [--owner 0x<owner-address>]
```

Returns `{ items: [{ cid, commitmentHash }, ...], txHash, confirmed }` in the
same order as the `--text` arguments. One capability, one build, one signature
and one `commitBatch`: the batch is atomic (all items anchor or none do).
Limits: 1-64 texts; duplicate content in one batch is rejected before signing;
`--tags` is shared by every item (per-item tags are not supported in v1). Every
row shares the same `--prev` (default 0); rows are **not** auto-chained to each
other inside a batch. Any item already anchored fails as `DUPLICATE_COMMITMENT`;
an item already in another batch fails as `STAGING_BATCHED` with its
`contentHash` and, when listable, `txHash` — wait for the staging TTL or run
`confirm --tx-hash`.

Per-item `verify` is not embedded in the write; verify each returned `cid` /
`commitmentHash` after anchoring.

### confirm — recover a broadcast but unconfirmed write

```bash
npx -y @limccn/longstone@0.1.2 confirm \
  --tx-hash 0x<transaction-hash> \
  [--owner 0x<owner-address>]
```

Calls the gateway's confirm endpoint with bounded backoff on transport failures
(fetch/429/5xx). Owner resolution: explicit `--owner`, else the signing key's
address — no key is required when `--owner` is supplied. Prints the gateway's
`ConfirmOutcome` (`anchored`, `rejected`, or `pending`). If the gateway is still
unreachable the command exits 1 with `GATE_UNREACHABLE`, but the transaction is
still recoverable by rerunning the command later. This is the recovery path for
a `put`/`put-batch` result that returned `confirmed: false`.

### get — recall

```bash
npx -y @limccn/longstone@0.1.2 get \
  --owner 0x<owner-address> \
  [--active-only] \
  [--tag <tag>] \
  [--status staged|batched|anchored|rejected] \
  [--limit <n>]
```

Returns `{ staged, indexed }`. Each indexed row carries `commitmentHash`,
`contentHash`, `tags`, `deep`, `active`, `blockNumber`, and `replacedBy`.

Full-history scans start at `scanChunkBlocks` (default 200) and grow after three
consecutive successes up to `scanMaxChunkBlocks` (default 10000); set both with
`longstone config --set scanChunkBlocks=<n>` / `--set scanMaxChunkBlocks=<n>`.
`config --set` writes the selected config file: user-level by default, or the
`--config <path>` file when given.
On a public RPC a full scan is slow and may hit 429s — use a dedicated RPC for
large owners. `verify --cid --owner` uses the same scanner.

### verify — prove a memory

```bash
# O(1): the commitment hash is known
npx -y @limccn/longstone@0.1.2 verify \
  --cid <cid> \
  --commitment-hash 0x<commitment-hash> \
  [--owner 0x<owner-address>]

# resolve the commitment by scanning the owner's chain events
npx -y @limccn/longstone@0.1.2 verify \
  --cid <cid> \
  --owner 0x<owner-address>

# fetch bytes from the configured dedicated IPFS gateway instead of hisaishi
npx -y @limccn/longstone@0.1.2 verify \
  --cid <cid> \
  --commitment-hash 0x<commitment-hash> \
  --direct
```

Chain-only semantics: expected `contentHash` and `cidDigest` always come from
`getCommitment(H)` on the registry. A gateway row may only nominate a candidate
`H`; it never supplies a value that is compared. `--direct` changes only where
the bytes are fetched (the configured `ipfsGateway`, never a public fallback),
not where the expected values come from. An unresolved lookup is the typed
`HASH_UNRESOLVED` error, never an empty report.

Seed fixtures written by `menhir/contracts/scripts/seed.ts` go straight to the
contract and are never pinned, so their CIDs return `CONTENT_NOT_FOUND` under
`--direct`. That is "not pinned", not "content mismatch": rebuild the seed text
from the script and compare both digests offline — they match the chain.
Explorer APIs are for diagnosis and listing only; they are never the read path
that verification trusts.

Require `anchored: true` before relying on the bytes. `active: true` adds "not
retracted". `hashSource` is `explicit`, `gateway`, or `indexer` and says how `H`
was found — not where the compared values came from.

### retract — tombstone (destructive)

```bash
npx -y @limccn/longstone@0.1.2 retract \
  --commitment-hash 0x<commitment-hash> \
  [--replaced-by 0x<successor-commitment-hash>]
```

Only with explicit user intent. Returns `{ txHash, replacedBy }`. A repeated
retract is a no-op on chain.

### acl — signer roles (owner key)

```bash
# inspect
npx -y @limccn/longstone@0.1.2 acl list \
  --owner 0x<owner-address> --signer 0x<signer-address>

# grant (default role: commit)
npx -y @limccn/longstone@0.1.2 acl grant \
  --owner 0x<owner-address> --signer 0x<signer-address> \
  [--roles commit,retract]

# revoke all roles
npx -y @limccn/longstone@0.1.2 acl revoke \
  --owner 0x<owner-address> --signer 0x<signer-address>
```

`grant` and `revoke` require `LONGSTONE_OWNER_KEY` in the environment and
explicit user intent.

### stage-status — staging only

```bash
npx -y @limccn/longstone@0.1.2 stage-status \
  --owner 0x<owner-address> \
  [--status staged|batched|anchored|rejected] \
  [--limit <n>]
```

Works when the chain is unreachable; returns `{ rows }`.

## MCP tools

Launch shape: `npx -y @limccn/longstone@0.1.2 serve` over stdio. Tool arguments
are the JSON objects below. A failure is `isError: true` with a JSON
`{ "code": ... }` body — branch on `code` (see `errors.md`).

### memory_put

```json
{ "text": "<memory text>", "tags": ["layer:deep", "topic:prefs"], "prev": "0x<commitment-hash>", "owner": "0x<owner-address>" }
```

`prev` and `owner` are optional.

### memory_put_batch

```json
{ "texts": ["<memory text 1>", "<memory text 2>"], "tags": ["layer:deep", "topic:prefs"], "prev": "0x<commitment-hash>", "owner": "0x<owner-address>" }
```

Stores 1-64 memories in one transaction with the same rules as `put-batch`:
shared tags/prev, atomic commit, duplicate content rejected before signing, and
the same `STAGING_BATCHED` / `DUPLICATE_COMMITMENT` failures. Returns
`{ items, txHash, confirmed }`. `tags`, `prev`, and `owner` are optional. Only
registered when the server is writable; there is no `memory_confirm` tool — use
the CLI `confirm --tx-hash` to recover.

### memory_get

```json
{ "owner": "0x<owner-address>", "status": "anchored", "tag": "<tag>", "activeOnly": true, "limit": 50 }
```

All fields except `owner` are optional.

### memory_verify

```json
{ "cid": "<cid>", "commitmentHash": "0x<commitment-hash>", "owner": "0x<owner-address>", "direct": false }
```

`commitmentHash`, `owner`, and `direct` are optional. The chain-only rule and
the `--direct` semantics above apply unchanged.

### memory_retract

```json
{ "commitmentHash": "0x<commitment-hash>", "replacedBy": "0x<successor-commitment-hash>" }
```

Destructive; requires explicit user intent. The server asks for confirmation
through the MCP `inputRequired` flow. `replacedBy` is optional.

### memory_acl

```json
{ "action": "grant", "owner": "0x<owner-address>", "signer": "0x<signer-address>", "roles": ["commit"] }
```

`action` is `grant`, `revoke`, or `list`; `roles` is optional and defaults to
`["commit"]` on grant. `grant` and `revoke` are destructive, need the owner key,
and require explicit user intent plus the confirmation flow. `list` is a read.

### memory_stage_status

```json
{ "owner": "0x<owner-address>", "status": "staged", "limit": 50 }
```

All fields except `owner` are optional.
