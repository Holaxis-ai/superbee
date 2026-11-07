/**
 * The skip reason a resilient scan gives a document the host refused to read, and the one test
 * for it. Dependency-free so a browser bundle can tell a permission problem from a malformed
 * document without loading the scan.
 */

const PERMISSION_DENIED_PREFIX = "permission denied (";

/** The skip reason for a read refused with `code` (`EACCES` or `EPERM`); never the host path. */
export function permissionDeniedReason(code: "EACCES" | "EPERM"): string {
  return `${PERMISSION_DENIED_PREFIX}${code})`;
}

/** True when a scan skipped this document because the host refused to read it, not because it is malformed. */
export function isPermissionDeniedSkip(skip: { reason: string }): boolean {
  return skip.reason.startsWith(PERMISSION_DENIED_PREFIX);
}
