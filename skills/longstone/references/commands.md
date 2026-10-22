# longstone command recipes

Targets `@limccn/longstone@0.1.1`. CLI output is JSON on stdout; progress and the
throwaway-key banner go to stderr. Every recipe is copyable as-is except for the
`<placeholders>`.

## Launch the MCP server

```bash
npx -y @limccn/longstone@0.1.1 serve
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
      "args": ["-y", "@limccn/longstone@0.1.1", "serve"]
    }
  }
}
```

## CLI

Run the pinned package without installing:

```bash
npx -y @limccn/longstone@0.1.1 <command>
```

### put — remember one fact

```bash
npx -y @limccn/longstone@0.1.1 put \
  --text "<memory text>" \
  --tags "layer:deep,topic:prefs" \
  [--prev 0x<commitment-hash>] \
  [--owner 0x<owner-address>]
```

Returns `{ cid, commitmentHash, txHash, confirmed }`. `--owner` defaults to the
signing key's address. Tags are comma-separated; `--prev` names the predecessor
commitment (the new commitment is its successor).

### get — recall

```bash
npx -y @limccn/longstone@0.1.1 get \
  --owner 0x<owner-address> \
  [--active-only] \
  [--tag <tag>] \
  [--status staged|batched|anchored|rejected] \
  [--limit <n>]
```

Returns `{ staged, indexed }`. Each indexed row carries `commitmentHash`,
`contentHash`, `tags`, `deep`, `active`, `blockNumber`, and `replacedBy`.

### verify — prove a memory

```bash
# O(1): the commitment hash is known
npx -y @limccn/longstone@0.1.1 verify \
  --cid <cid> \
  --commitment-hash 0x<commitment-hash> \
  [--owner 0x<owner-address>]

# resolve the commitment by scanning the owner's chain events
npx -y @limccn/longstone@0.1.1 verify \
  --cid <cid> \
  --owner 0x<owner-address>

# fetch bytes from the configured dedicated IPFS gateway instead of hisaishi
npx -y @limccn/longstone@0.1.1 verify \
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

Require `anchored: true` before relying on the bytes. `active: true` adds "not
retracted". `hashSource` is `explicit`, `gateway`, or `indexer` and says how `H`
was found — not where the compared values came from.

### retract — tombstone (destructive)

```bash
npx -y @limccn/longstone@0.1.1 retract \
  --commitment-hash 0x<commitment-hash> \
  [--replaced-by 0x<successor-commitment-hash>]
```

Only with explicit user intent. Returns `{ txHash, replacedBy }`. A repeated
retract is a no-op on chain.

### acl — signer roles (owner key)

```bash
# inspect
npx -y @limccn/longstone@0.1.1 acl list \
  --owner 0x<owner-address> --signer 0x<signer-address>

# grant (default role: commit)
npx -y @limccn/longstone@0.1.1 acl grant \
  --owner 0x<owner-address> --signer 0x<signer-address> \
  [--roles commit,retract]

# revoke all roles
npx -y @limccn/longstone@0.1.1 acl revoke \
  --owner 0x<owner-address> --signer 0x<signer-address>
```

`grant` and `revoke` require `LONGSTONE_OWNER_KEY` in the environment and
explicit user intent.

### stage-status — staging only

```bash
npx -y @limccn/longstone@0.1.1 stage-status \
  --owner 0x<owner-address> \
  [--status staged|batched|anchored|rejected] \
  [--limit <n>]
```

Works when the chain is unreachable; returns `{ rows }`.

## MCP tools

Launch shape: `npx -y @limccn/longstone@0.1.1 serve` over stdio. Tool arguments
are the JSON objects below. A failure is `isError: true` with a JSON
`{ "code": ... }` body — branch on `code` (see `errors.md`).

### memory_put

```json
{ "text": "<memory text>", "tags": ["layer:deep", "topic:prefs"], "prev": "0x<commitment-hash>", "owner": "0x<owner-address>" }
```

`prev` and `owner` are optional.

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
