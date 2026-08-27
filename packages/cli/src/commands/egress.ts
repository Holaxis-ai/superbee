import path from "node:path";
import { promises as fs } from "node:fs";

import { isReservedFile, type Bundle } from "@superbee/core";

/**
 * Classify what a whole-document byte export does when its destination lands inside a local
 * bundle. Raw document bytes may be copied there deliberately, so this authority warns rather
 * than refuses; non-Markdown targets are inert to the next bundle walk.
 */
export async function inBundlePollutionWarning(bundle: Bundle, out: string): Promise<string | undefined> {
  if (bundle.backend) return undefined;
  const root = await fs.realpath(path.resolve(bundle.root)).catch(() => path.resolve(bundle.root));
  const resolvedOut = await effectiveOutputPath(path.resolve(out));
  const isInside = resolvedOut === root || resolvedOut.startsWith(root + path.sep);
  if (!isInside) return undefined;

  if (isReservedFile(resolvedOut)) {
    return (
      `--out ${out} resolves to ${resolvedOut}, which is INSIDE this bundle (${root}) at a reserved ` +
      `OKF filename — the write will CLOBBER that reserved file (index.md/log.md is never re-parsed ` +
      `as a concept doc). Pass a path outside the bundle if that is not intended.`
    );
  }
  if (!resolvedOut.endsWith(".md")) return undefined;
  return (
    `--out ${out} resolves to ${resolvedOut}, which is INSIDE this bundle (${root}) — the exported ` +
    `file will be re-ingested as a new concept doc on the next bundle walk (list/query/status). ` +
    `Pass a path outside the bundle if that is not intended.`
  );
}

/** Resolve the path a write reaches, including symlink ancestors and a dangling final symlink. */
export async function effectiveOutputPath(absoluteTarget: string, seen = new Set<string>()): Promise<string> {
  let probe = absoluteTarget;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(probe), ...missingSuffix);
    } catch {
      try {
        if ((await fs.lstat(probe)).isSymbolicLink()) {
          if (seen.has(probe)) return absoluteTarget;
          seen.add(probe);
          const target = await fs.readlink(probe);
          return effectiveOutputPath(path.resolve(path.dirname(probe), target, ...missingSuffix), seen);
        }
      } catch {
        // Missing or unreadable: anchor the suffix at the nearest usable ancestor.
      }
      const parent = path.dirname(probe);
      if (parent === probe) return absoluteTarget;
      missingSuffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
}
