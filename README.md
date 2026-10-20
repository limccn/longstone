# longstone

Sovereign agent-memory client for MemoryOverEth. An MCP server and a CLI that
store memories on an Ethereum-compatible chain and verify them on read.

longstone is the **only component that holds a wallet key**. It stages content
through a keyless gateway, then signs and broadcasts locally — so an agent never
hands its key to a server.

## What it does

```
put     canonicalize → stage (keyless gateway) → build → stamp → sign → broadcast → confirm
get     list staging rows + indexed on-chain commitments with deep/active state
verify  fetch bytes → check BOTH digests → check on-chain state
retract tombstone a commitment, optionally naming its successor
acl     grant/revoke a delegated signer's role mask (owner key)
config  show or update configuration
```

`verify` works with the gateway unreachable (`--direct`): chain state plus the
content bytes are sufficient, by design.

## Requirements

- Node 24 (uses `node:sqlite` through the gateway's F1 adapter)
- A funded **testnet** key for writes. M1 keys are throwaways — there is no
  keystore yet.

## Install

From npmjs (also on GitHub Packages):

```bash
npm install -g @limccn/longstone@0.1.0
longstone --help
```

From this workspace:

```powershell
pnpm install
pnpm build
```

## Configure

Configuration lives in `.longstone/config.json` (gitignored). Defaults target
Base Sepolia:

```powershell
node dist/cli.js config --set rpcUrl=https://sepolia.base.org
node dist/cli.js config --set registryAddress=0xC85ed11d3065739F1829A114e420584bEC3FDFEF
node dist/cli.js config --set hisaishiMode=embedded
node dist/cli.js config --set hisaishiDbPath=.longstone/hisaishi.db
node dist/cli.js config --set ipfsGateway=https://your-dedicated-gateway.example
```

Environment overrides the file: `LONGSTONE_RPC_URL`,
`LONGSTONE_REGISTRY_ADDRESS`. Keys come **only** from the environment:

| Variable | Use |
|---|---|
| `LONGSTONE_KEY` | delegated signing key (stamps `signer`, signs transactions) |
| `LONGSTONE_OWNER_KEY` | owner key for `acl` / `retract-any` |

The CLI prints `TESTNET THROWAWAY KEY` every time a key loads. Never point this
at mainnet in M1.

## Use

### CLI

```powershell
$env:LONGSTONE_KEY = '<funded testnet key>'

node dist/cli.js acl grant --owner 0x<owner> --signer 0x<delegated> --roles commit
node dist/cli.js put --text "用户偏好：Python 用于脚本" --tags layer:deep,topic:prefs
node dist/cli.js get --owner 0x<owner> --active-only
node dist/cli.js verify --cid bafkrei... --commitment-hash 0x...
node dist/cli.js stage-status --owner 0x<owner>
```

Output is JSON on stdout; the key banner and progress go to stderr, so
`longstone get | jq` is safe.

### MCP

```jsonc
{
  "mcpServers": {
    "longstone": {
      "command": "node",
      "args": ["<path-to-longstone>/dist/cli.js", "serve"],
      "env": { "LONGSTONE_KEY": "<funded testnet key>" }
    }
  }
}
```

Tools: `memory_put`, `memory_get`, `memory_verify`, `memory_retract`,
`memory_acl`, `memory_stage_status`. Tool failures return a typed `code`, not a
raw revert string.

## How the write path works

1. Content is canonicalized with `@limccn/menhir-core` — the same code the contract,
   the browser and the seed script use.
2. The keyless gateway stages it, recomputes both digests, and pins it.
3. `build` returns commitments with **placeholders**: `prev = 0`,
   `blockHeight = 0`, `signer = 0x0`.
4. longstone overwrites all three, then signs locally and broadcasts.
5. `confirm` makes **one** receipt call; longstone drives any retry.

A missed `signer` stamp reverts loudly (`SignerMismatch`). A missed
`prev`/`blockHeight` would anchor wrong metadata silently, which is why
stamping is one function with its own tests rather than three assignments.

## Tests

```powershell
pnpm test          # 15 tests, incl. a full roundtrip against a real Hardhat node
pnpm typecheck
```

The roundtrip deploys the real contract, runs put → anchor → event/indexer
agreement → sovereign verify, and uses the node's unlocked accounts so **no
private key appears in the test file**.

## Known limits (M1)

- **hisaishi F2 is not implemented.** `hisaishiMode=remote` works against any
  running gateway, but the Workers form does not exist yet.
- **`hisaishiMode=local` (spawn a server) is not implemented** and fails with an
  explicit message rather than silently behaving like `embedded`.
- Keys are env-only; encrypted keystore and content keys are M2.
- Encryption is M2. Everything anchored in M1 is public.

## License

See [LICENSE](./LICENSE).
