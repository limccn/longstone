# longstone error codes

Every failure is a typed object. The CLI prints it to stderr; MCP returns
`isError: true` with `content[0].text` set to a JSON `{ "code": ... }` body.
Branch on `code`; the human text is secondary and may be redacted.

| Code | Meaning | What an agent should do |
|---|---|---|
| `NO_KEY` | A key is required but absent from the environment. | Stop. Ask the user to set `LONGSTONE_KEY` (or `LONGSTONE_OWNER_KEY` for owner operations) in the host environment. Never request, accept, or store a key pasted into chat or a memory. |
| `NOT_AUTHORIZED` | The signer lacks `commit` or `retract` for this owner. | Stop. This is an owner ACL decision; do not retry. If the user explicitly wants it, the owner runs `acl grant` with the owner key. |
| `SIGNER_MISMATCH` | The commitment's `signer` is not the transaction sender. | Do not retry blindly; this is a client-side stamping bug. Stop and report. |
| `HASH_UNRESOLVED` | No chain commitment could be resolved for these bytes. | Treat the memory as **not verified**. Retry with an explicit `commitmentHash`, or an `owner` so the indexer can match the digest. Never substitute a gateway row or a CID claim. |
| `OWNER_MISMATCH` | The commitment belongs to a different owner than requested. | Stop. Do not present the memory as the requested owner's. |
| `STAGED_ROW_MISSING` | The gateway did not return the row this client staged. | Nothing was signed. Retry the `put` once; if it repeats, report a gateway problem. |
| `AMBIGUOUS_BATCH_ROW` | Several staged rows match the locally computed content. | Nothing was signed. Stop and report; never choose one arbitrarily. |
| `PREDECESSOR_UNKNOWN` | `prev` or `replacedBy` names a commitment that does not exist. | Fix the hash. Do not silently drop the link. |
| `DUPLICATE_COMMITMENT` | That commitment is already on chain. | Recall it with `get` / `memory_get` instead of writing it again. |
| `UNKNOWN_COMMITMENT` | The commitment hash is not on chain. | Re-resolve the hash; do not retract or verify a guess. |
| `INVALID_BATCH_SIZE`, `INVALID_ROLES`, `INVALID_COMMITMENT`, `INVALID_OP`, `FUTURE_BLOCK_HEIGHT` | Contract-level rejection. | Fix the request; do not retry unchanged. `FUTURE_BLOCK_HEIGHT` may indicate a clock or chain mismatch. |
| `SCHEMA_VIOLATION`, `NON_NORMALIZED_INPUT`, `TAG_TOO_LONG`, `UNKNOWN_KEY`, `INVALID_HEX` | Request validation. | Fix the arguments: address shape, bytes32 shape, tag length, canonical text. |
| `REGISTRY_NOT_CONFIGURED` | No registry code at the configured address/chain, or an impossible start block. | Configuration problem. Check `registryAddress`, `rpcUrl`, and `chainId`; do not write. |
| `RPC_UNAVAILABLE` | The chain RPC could not be reached. | Retry with backoff; if it persists, report. Do not present staging rows as chain state. |
| `INSECURE_ENDPOINT` | A remote endpoint is not `https://`. | Fix the configuration. Loopback `http://` is the only exception. |
| `GATE_UNREACHABLE` | The gateway could not be reached. | Reads may still work: chain reads use RPC, and `verify --direct` (with a configured `ipfsGateway`) fetches bytes without the gateway. Retry or report; never guess content. |
| `GATE_REJECTED` | The gateway rejected the request; read `gateCode`. | `CONTENT_NOT_FOUND` means the bytes are not staged or pinned — do not treat them as a memory. `CAPABILITY_REQUIRED` means the client is too old — upgrade to the pinned version. |
| `UNKNOWN_REVERT` | Unrecognized contract revert selector. | Likely a stale client or ABI. Stop and upgrade to the pinned version; do not retry. |
