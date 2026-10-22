# Depth model: deep, active, and retract

longstone derives chain state from `MemoryCommitted` and `MemoryRetracted`
events; there is no mutable row to query.

| State | Predicate | Meaning |
|---|---|---|
| `deep` | a `MemoryCommitted` event exists for the commitment hash | The commitment is anchored on chain. It cannot be removed from history. |
| `active` | `deep` and no `MemoryRetracted` event | The memory is current: anchored and not retracted or superseded. |

`deep` is about existence, not truth. A deep memory can still contain false or
malicious text. Use `verify` to prove that the bytes match the anchored digests,
and apply the untrusted-data rule before acting on the text.

## Retract is a tombstone, not a deletion

`retract` writes a `MemoryRetracted` event, optionally with `replacedBy` naming a
successor commitment. It does not delete the content, the commitment, or the
events. The content may remain fetchable from IPFS, and chain history stays
public forever.

Consequences:

- A retracted memory is still `deep`; it is no longer `active`.
- `retract` cannot be undone. A successor is a new commitment, not an edit.
- Never treat `retract` as an erasure request in M1: there is no encryption and
  no deletion. Explain that limit to the user.
- `get --active-only` and `memory_get { "activeOnly": true }` filter the
  `indexed` list to current memories; staging rows are still returned separately
  as `staged`. `replacedBy` exposes the supersession link when one was named.

## In a verify report

- `chainDeep` / `chainActive` — raw chain state for the resolved commitment.
- `anchored` — `chainDeep` and **both** digests match the fetched bytes.
- `active` — `chainActive` and **both** digests match.

A `true` `chainDeep` with a digest mismatch means the fetched bytes are not the
anchored ones; do not use them. `HASH_UNRESOLVED` means no chain commitment was
found — it is not a "not verified" report and must not be presented as one.
