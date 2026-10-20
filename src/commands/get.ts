/**
 * `get` — staging visibility plus indexed chain state (design §2).
 *
 * Reads are sovereign: they use the registry RPC and (optionally) the gateway's
 * list route, never a signing path.
 */

import type { GateClient, MemoryRowResponse } from '../gate.js';
import type { ChainIndex } from '../indexer.js';
import { isActive, isDeep } from '../indexer.js';

export interface GetOptions {
  owner: `0x${string}`;
  status?: string;
  limit?: number;
  tag?: string;
  activeOnly?: boolean;
}

export interface GetResult {
  staged: MemoryRowResponse[];
  indexed: Array<{
    commitmentHash: `0x${string}`;
    contentHash: `0x${string}`;
    tags: string[];
    deep: boolean;
    active: boolean;
    blockNumber: string;
    replacedBy: `0x${string}` | null;
  }>;
}

export interface GetDeps {
  gate: GateClient;
  scan: (owner: `0x${string}`) => Promise<ChainIndex>;
}

export async function get(deps: GetDeps, options: GetOptions): Promise<GetResult> {
  const rows = await deps.gate.list({
    owner: options.owner,
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  const index = await deps.scan(options.owner);

  const indexed = index.order
    .map((hash) => {
      const entry = index.byHash.get(hash);
      return entry === undefined
        ? null
        : {
            commitmentHash: hash,
            contentHash: entry.commitment.contentHash,
            tags: entry.tags,
            deep: isDeep(index, hash),
            active: isActive(index, hash),
            blockNumber: entry.blockNumber.toString(),
            replacedBy: entry.replacedBy,
          };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    // Tag filtering is client-side: tags ride event data, not topics (menhir
    // §2.6), so a filter cannot be pushed into the log query.
    .filter((entry) => options.tag === undefined || entry.tags.includes(options.tag))
    .filter((entry) => options.activeOnly !== true || entry.active);

  return { staged: rows, indexed };
}
