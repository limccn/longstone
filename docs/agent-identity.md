# Agent identity (ERC-8004) — an optional pointer

longstone can record **which ERC-8004 agent wrote a memory**. The reference is
one optional field inside the content object (`meta.agent`). It is a pointer,
not a trust claim:

- longstone never calls an 8004 contract, holds no 8004 key, and adds no RPC
  call; it only writes the pointer into the bytes it already anchors.
- `verify` never reads it. A memory is still verified by the on-chain `signer`
  and the two digests (`contentHash`, `cidDigest`).
- **Ownership and ACL remain menhir's.** The memory `owner` is the user wallet;
  an agent writes only through the delegated signer mask
  (`ROLE_COMMIT` / `ROLE_RETRACT`). An 8004 agent NFT is transferable and its
  registry is upgradeable, so it must never become the source of truth for
  either.

Writing a reference is optional. Without it the anchored bytes are identical
to 0.1.1.

## What ERC-8004 is — and is not

**It is** a set of three per-chain registries for *agent identity, reputation
and validation*:

- **Identity** — each agent is an ERC-721; `agentId` is the token id and
  `agentURI` points at a registration file. The global identifier is
  `{namespace}:{chainId}:{identityRegistry}` (for example
  `eip155:8453:0x8004A169…`).
- **Reputation** — clients publish feedback about an agent.
- **Validation** — a validator answers a request about an agent.

**It is not:**

- **Memory.** The specification explicitly excludes memory, persistent state and
  how an agent's cognition evolves. That axis is ERC-8350's, which this project
  tracks separately: 8004 answers "which agent", 8350 answers "which memory
  state trajectory". They are adjacent standards, not alternatives.
- **Proof that a memory is true** or that its text is correct. Nothing in 8004
  vouches for content; verify-on-read does.
- **An ownership or ACL system** for memories.
- **A canonical address registry.** Deployments are per-chain community facts,
  not spec-defined constants, and the identity registry is a UUPS-upgradeable
  proxy. Never hardcode one as a default or a trust root.
- **A liveness check.** `active: true` in a registration file is a claim.

## The `meta.agent` shape

```json
{
  "text": "…",
  "format": "text.v0",
  "meta": {
    "agent": {
      "registry": "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      "agentId": "42"
    }
  }
}
```

Rules (enforced before staging — a bad reference costs no pin and no gas):

| Field | Rule |
|---|---|
| `registry` | `^[a-z0-9-]+:[0-9]+:0x[0-9a-fA-F]{40}$` — namespace, chain id and the identity registry address. No default is applied. |
| `agentId` | Decimal string `/^(0\|[1-9][0-9]*)$/`, per the project rule that every bigint is a string on the wire. A JSON number is rejected. |
| Both fields | Required. Supplying one without the other is an error, never a partial write. |
| Other keys | Rejected. The hash preimage stays minimal and stable. |

CLI:

```bash
longstone put --text "…" \
  --agent-registry eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e \
  --agent-id 42
```

MCP `memory_put` takes the same object in an optional `agent` field. The CLI
and MCP results echo `agent` (or `null`) so a caller can confirm what was
anchored without re-deriving the content.

## What changes — and what does not

- `meta.agent` is part of the canonical content, so **adding it changes
  `contentHash` and therefore the dedup identity `(owner, contentHash)`**. The
  same text with and without a reference is two distinct memories. This is
  intentional: the reference is part of what was written.
- Omitting the flag produces byte-identical bytes, hash and dedup key to 0.1.1.
  There is no format version bump: `meta` was always a legal extension channel.
- `verify`, retract tombstones, and the ACL path are unchanged. No schema,
  route, contract, ABI or database change is involved; hisaishi pins the bytes
  verbatim.

## Registration file template

Publish this as the agent's `agentURI`. It advertises longstone/hisaishi as the
agent's memory service; it does not give 8004 any say over the memories.

```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "<agent name>",
  "description": "<what this agent remembers, and for whom>",
  "image": "<url>",
  "services": [
    { "name": "MCP", "endpoint": "<longstone MCP invocation or hosted descriptor>", "version": "0.1.1" },
    { "name": "web", "endpoint": "https://longstone-ui.pages.dev" }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    {
      "agentId": 42,
      "agentRegistry": "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
    }
  ]
}
```

**Number vs string.** The external spec's `registrations[].agentId` is a JSON
**number** in its examples; longstone's `meta.agent.agentId` is a **string**.
Use each shape where it belongs — do not "fix" one into the other. A token id
can exceed 2^53, which is why the memory-side wire form is a string.

`active: true` is a claim, not proof of liveness; 8004 does not validate it.

## Red lines

1. **No memory content in 8004 metadata or the registration file.** Registry
   metadata is public `bytes` and undeletable. Memories belong to menhir's
   commitment/retract semantics; putting them in 8004 creates a second, silent
   source of truth.
2. **No reputation as memory-trust evidence.** The spec acknowledges Sybil
   feedback. Trust a memory only through verify-on-read's dual digests and the
   on-chain `signer`.
3. **No Validation as content-correctness proof.** A validation response proves
   that a validator answered a request, not that a memory is true.
4. **Never use 8004 for owner or ACL.** The agent NFT is transferable, the
   registry is upgradeable, and menhir already owns "who may write".
5. **Never default the registry address** or treat a deployment as canonical.
6. **Never make 8004 a requirement for writing.** Memory writes must work for
   users who have never heard of 8004.

## Observed deployments (examples, not canonical)

Measured with `eth_getCode` / `name()` on 2026-10-21. Re-check before use; the
EIP (Draft) does not define canonical addresses.

| Chain | Identity registry | Reputation registry |
|---|---|---|
| Base mainnet (8453) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Base Sepolia (84532) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

The identity registry at both addresses is an ERC-1967 proxy with a UUPS
implementation. That upgrade authority is the main reason the identity must stay
an external pointer and never a trust root.

## Related

- ERC-8004 specification: <https://eips.ethereum.org/EIPS/eip-8004>
- Project boundary: ERC-8350 covers the memory state trajectory; 8004 covers
  identity. This project's 8350 stance remains track-only.
