// The one naming convention for the temp file a filesystem replacement writes beside its target.
// Kept apart from the identity module so a publisher (a board sync) can recognize leftovers without
// reaching the identity protocol.
import { randomUUID } from "node:crypto";

/**
 * The name of the temp file a replacement writes beside its target before the atomic rename. A
 * crash can leave one behind, so anything that publishes a folder's files (a board sync) skips
 * names {@link isIdentityTempName} matches.
 */
export function identityTempName(leaf: string): string {
  // Unique per call, not per process: one process can issue two writes to the same
  // target within a millisecond, and the second's temp file must not clobber the first's.
  return `.${leaf}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

const IDENTITY_TEMP_NAME = /^\..+\.\d+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** True for a file name a filesystem replacement uses for its temp file (the last path segment). */
export function isIdentityTempName(name: string): boolean {
  return IDENTITY_TEMP_NAME.test(name);
}

