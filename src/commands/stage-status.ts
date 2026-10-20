/**
 * `stage-status` — staging visibility only (design §2).
 *
 * Kept separate from `get` because it must work when the chain is unreachable:
 * an operator checking "what is waiting to be anchored" should not be blocked
 * by an RPC outage.
 */

import type { GateClient, MemoryRowResponse } from '../gate.js';

export interface StageStatusOptions {
  owner: `0x${string}`;
  status?: string;
  limit?: number;
}

export async function stageStatus(
  deps: { gate: GateClient },
  options: StageStatusOptions,
): Promise<{ rows: MemoryRowResponse[] }> {
  const rows = await deps.gate.list({
    owner: options.owner,
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return { rows };
}
