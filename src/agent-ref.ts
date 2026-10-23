/**
 * ERC-8004 identity sidecar reference (design §3.2).
 *
 * A memory may name the 8004 agent that wrote it. The reference lives at
 * `MemoryContent.meta.agent`, so it is covered by the same canonicalization
 * and hashing gate as every other byte of the content — but it is a POINTER:
 * nothing on the verify path reads it. Ownership and ACL remain menhir's
 * (`owner` + `setSigner`); an 8004 agent NFT is transferable and upgradeable,
 * so it must never become a write-authorization source.
 *
 * Validation uses the shared typed union (`SCHEMA_VIOLATION` + `detail`)
 * instead of a bespoke error class: CLI and MCP already branch on `code`, and
 * one more union member would be a second place for the mapping to drift.
 * `detail` names `meta.agent` and the exact bad field, because the bare code
 * does not tell a caller what to fix.
 *
 * There is deliberately NO default registry: the 8004 spec does not define
 * canonical addresses (the current deployments are community convention), so a
 * default would silently write a mainnet reference on a testnet.
 */

import { fail } from './errors.js';

/** `{namespace}:{chainId}:{identityRegistry}` — e.g. `eip155:8453:0x8004…`. */
export const REGISTRY_RE = /^[a-z0-9-]+:[0-9]+:0x[0-9a-fA-F]{40}$/;

/** uint256 token id as a decimal string — never a JSON number (2^53 rule). */
export const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

export interface AgentRef {
  /** `eip155:{chainId}:{identityRegistry}` — no chain-specific default. */
  registry: string;
  /** `agentId` = the 8004 ERC-721 token id, as a decimal string. */
  agentId: string;
}

function violation(detail: string): never {
  fail({ code: 'SCHEMA_VIOLATION', detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted agent reference and return a plain copy.
 *
 * Both fields are required, unknown keys are rejected, and the result is a
 * fresh object: a getter on the caller's object cannot supply different bytes
 * than the ones that were checked.
 */
export function parseAgentRef(input: unknown): AgentRef {
  if (!isRecord(input)) {
    violation('meta.agent must be an object with registry and agentId');
  }

  for (const key of Object.keys(input)) {
    if (key !== 'registry' && key !== 'agentId') {
      violation(`meta.agent has unknown key ${JSON.stringify(key)}; only registry and agentId are allowed`);
    }
  }

  const registry = input.registry;
  if (registry === undefined) violation('meta.agent.registry is required');
  if (typeof registry !== 'string') violation('meta.agent.registry must be a string');
  if (!REGISTRY_RE.test(registry)) {
    violation(
      'meta.agent.registry must look like {namespace}:{chainId}:0x{40 hex} ' +
        `(e.g. eip155:8453:0x…); got ${JSON.stringify(registry)}`,
    );
  }

  const agentId = input.agentId;
  if (agentId === undefined) violation('meta.agent.agentId is required');
  if (typeof agentId !== 'string') {
    violation(`meta.agent.agentId must be a decimal string, not a JSON ${typeof agentId}`);
  }
  if (!DECIMAL_RE.test(agentId)) {
    violation(
      'meta.agent.agentId must be a decimal uint256 string ' +
        `(no sign, no leading zeros); got ${JSON.stringify(agentId)}`,
    );
  }

  return { registry, agentId };
}

/**
 * CLI flag folding: `--agent-registry` and `--agent-id` are both-or-neither.
 *
 * A half-supplied reference is an invocation error, not a memory: it must fail
 * before `put` creates a context, loads a key, or stages anything.
 */
export function agentRefFromFlags(
  registry: string | undefined,
  agentId: string | undefined,
): AgentRef | undefined {
  if (registry === undefined && agentId === undefined) return undefined;
  if (registry === undefined || agentId === undefined) {
    violation(
      '--agent-registry and --agent-id must be supplied together; a partial agent reference is not valid',
    );
  }
  return parseAgentRef({ registry, agentId });
}
