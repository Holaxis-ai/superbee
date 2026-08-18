// One invariant between Superbee's two local filesystem domains: private operational state is
// never a Knowledge Bundle. Enforce this by physical identity rather than by today's names so a
// symlink, HOME override, or future rename cannot turn private state into publishable board data.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { CliError } from "./errors.js";
import { canonicalUserStateDir } from "./user-state.js";

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Resolve an existing path, or anchor its missing suffix beneath the nearest existing real dir. */
function physicalCoordinate(candidate: string, seenLinks: Set<string> = new Set()): string {
  if (!path.isAbsolute(candidate)) {
    throw new CliError("RUNTIME", "private state and bundle identities require absolute filesystem paths");
  }
  let cursor = path.normalize(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.resolve(realpathSync(cursor), ...missing.reverse());
    } catch (error) {
      if (code(error) !== "ENOENT") {
        throw new CliError("RUNTIME", "cannot verify that the bundle is separate from private Superbee state");
      }
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          if (seenLinks.has(cursor)) {
            throw new CliError("RUNTIME", "cannot resolve the private-state filesystem boundary");
          }
          seenLinks.add(cursor);
          const linked = path.resolve(path.dirname(cursor), readlinkSync(cursor));
          return physicalCoordinate(path.resolve(linked, ...missing.reverse()), seenLinks);
        }
      } catch (linkError) {
        if (linkError instanceof CliError) throw linkError;
        if (code(linkError) !== "ENOENT") {
          throw new CliError("RUNTIME", "cannot verify that the bundle is separate from private Superbee state");
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new CliError("RUNTIME", "cannot resolve the private-state filesystem boundary");
      }
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function assertBundleOutsidePrivateState(
  bundleRoot: string,
  home: string = homedir(),
): void {
  const bundleIdentity = physicalCoordinate(path.resolve(bundleRoot));
  const stateIdentity = physicalCoordinate(canonicalUserStateDir(home));
  if (bundleIdentity !== stateIdentity) return;
  throw new CliError(
    "CONFLICT",
    "Superbee's private user-state directory cannot be used as an OKF bundle",
    {
      help: "choose a project .superbee directory, then rerun superbee setup",
    },
  );
}
