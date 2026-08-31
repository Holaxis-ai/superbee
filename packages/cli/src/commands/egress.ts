import path from "node:path";
import { promises as fs } from "node:fs";

import { isReservedFile, type Bundle } from "@superbee/core";
import { CliError } from "../errors.js";

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

/**
 * A body-only Markdown or rendered-HTML export is NOT an OKF concept document. Refuse any local
 * in-bundle `.md` target before writing, including symlinked aliases, because the next bundle walk
 * would either parse invalid content or the write would clobber an existing/reserved document.
 *
 * This is shared by every non-document egress channel; keeping the effective-path classification
 * here prevents sibling commands from quietly diverging at the same filesystem boundary.
 */
export async function assertSafeNonDocumentOutTarget(
  bundle: Bundle,
  flag: string,
  outValue: string,
  payload: string,
  help: string,
): Promise<void> {
  if (bundle.backend) return;
  const lexicalTarget = path.resolve(outValue);
  const rootReal = await fs.realpath(path.resolve(bundle.root)).catch(() => path.resolve(bundle.root));
  const effectiveTarget = await effectiveOutputPath(lexicalTarget);
  const inside = (candidate: string, base: string): boolean =>
    candidate === base || candidate.startsWith(base + path.sep);
  if (!inside(effectiveTarget, rootReal) || !effectiveTarget.endsWith(".md")) return;
  throw new CliError(
    "USAGE",
    `${flag} ${outValue} targets ${effectiveTarget}, a .md path INSIDE this bundle (${rootReal}); ` +
      `${payload} has no OKF frontmatter and cannot be written into the bundle.`,
    { help },
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
