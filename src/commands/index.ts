/**
 * The command layer (design §2).
 *
 * CLI and MCP both call these functions. Neither transport contains logic; they
 * differ only in argument parsing and output shape, which is what keeps a fix
 * from landing in one and not the other.
 */

export { acl, normalizeRoles, ROLE_COMMIT, ROLE_RETRACT } from './acl.js';
export { get } from './get.js';
export { put } from './put.js';
export { retract } from './retract.js';
export { verify } from './verify.js';
export { stageStatus } from './stage-status.js';

export type { AclOptions, AclResult } from './acl.js';
export type { GetOptions, GetResult } from './get.js';
export type { PutOptions, PutResult } from './put.js';
export type { RetractOptions, RetractResult } from './retract.js';
export type { VerifyOptions, VerifyReport } from './verify.js';
