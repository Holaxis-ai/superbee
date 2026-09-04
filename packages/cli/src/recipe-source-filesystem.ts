// The filesystem acquisition adapter owns traversal and symlink containment. It returns bytes to
// the distribution-neutral parser and never interprets recipe semantics beyond choosing whether a
// definitions-only manifest requires a complete file inventory.
//
// Containment is decided on the RESOLVED path, so the read names that resolved path too. Reading
// the unresolved one would resolve the link a second time and could land on a target the
// containment check never saw; symlinks that stay inside the recipe root remain honored, because
// resolution happens before the read rather than during it.
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { parseMarkdown } from "@superbee/core";
import { parseRecipeFiles, type RecipeFile, type RecipeSource } from "./recipe-parser.js";
import { expandRecipePath, looksLikeRecipePath } from "./recipe-ref.js";

/**
 * Reads a containment-approved path over ONE descriptor: the regular-file decision and the bytes
 * come from the same open file, so no second lookup can land somewhere the check never saw.
 *
 * The two refusals stay apart because they mean opposite things to whoever reads the message: a
 * permission error is the user's own `chmod`, while a non-regular leaf is the containment story.
 *
 * `O_NOFOLLOW` costs nothing here and closes the last window: the path is already resolved, so a
 * legitimate in-root symlink was resolved away before this call and only a leaf swapped in AFTER
 * containment is refused. `O_NONBLOCK` keeps a leaf swapped for a FIFO from parking the open.
 */
type ContainedRead = { text: string } | { refusal: "irregular" | "unreadable" };

const CONTAINED_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function readContainedFile(real: string): Promise<ContainedRead> {
  const opened = await fs.open(real, CONTAINED_FLAGS).then(
    (handle) => ({ handle }),
    (error: NodeJS.ErrnoException) => ({ code: error.code }),
  );
  // ELOOP is the leaf turning into a symlink after containment resolved it, not a broken install.
  if (!("handle" in opened)) return { refusal: opened.code === "ELOOP" ? "irregular" : "unreadable" };
  const handle = opened.handle;
  try {
    if (!(await handle.stat()).isFile()) return { refusal: "irregular" };
    return { text: await handle.readFile("utf8") };
  } catch {
    return { refusal: "unreadable" };
  } finally {
    await handle.close();
  }
}

async function readRecipeDir(root: string): Promise<RecipeFile[]> {
  const files: RecipeFile[] = [];
  const rootReal = await fs.realpath(root);

  const manifestPath = path.join(root, "recipe.md");
  const manifestStat = await fs.stat(manifestPath).catch(() => null);
  if (manifestStat?.isFile()) {
    const manifestReal = await containedRealpath(manifestPath, rootReal, "recipe.md");
    const read = await readContainedFile(manifestReal);
    if ("refusal" in read) throw new RecipeUnsafePathSignal("recipe.md", read.refusal);
    const bytes = read.text;
    files.push({ path: "recipe.md", bytes });
    const { frontmatter } = parseMarkdown(bytes);
    if (frontmatter.content_policy === "definitions-only" || frontmatter.pages !== undefined) {
      await walkRecipeFiles(root, "", rootReal, files, new Set(["recipe.md"]));
      return files;
    }
  }

  const conventionsRoot = path.join(root, "conventions");
  const conventionsStat = await fs.stat(conventionsRoot).catch(() => null);
  if (conventionsStat?.isDirectory()) {
    await walkConventions(conventionsRoot, "conventions", rootReal, files);
  }
  return files;
}

async function walkRecipeFiles(
  dir: string,
  relPrefix: string,
  rootReal: string,
  out: RecipeFile[],
  skip: Set<string>,
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (skip.has(rel)) continue;
    // Fail fast on a dot-prefixed entry — BEFORE recursing into it or reading its bytes. The
    // recipe grammar can never accept a
    // dot-prefixed path (parseRecipeFiles's definitions-only check would reject it anyway, as an
    // undeclared file), so a `.git/` directory in a recipe root was previously walked and read
    // OBJECT-BY-OBJECT as UTF-8 before that rejection ever fired — same eventual strictness, now
    // with no wasted (and, for `.git`'s binary objects, potentially lossy/incorrect) reads.
    if (entry.name.startsWith(".")) {
      throw new RecipeUnsafePathSignal(rel, "dot-entry");
    }
    if (entry.isDirectory()) {
      await walkRecipeFiles(abs, rel, rootReal, out, skip);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const real = await containedRealpath(abs, rootReal, rel);
    const read = await readContainedFile(real);
    if ("refusal" in read) throw new RecipeUnsafePathSignal(rel, read.refusal);
    out.push({ path: rel, bytes: read.text });
  }
}

async function walkConventions(dir: string, relPrefix: string, rootReal: string, out: RecipeFile[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkConventions(abs, rel, rootReal, out);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!rel.endsWith(".md")) continue;

    const real = await containedRealpath(abs, rootReal, rel);
    const read = await readContainedFile(real);
    if ("refusal" in read) throw new RecipeUnsafePathSignal(rel, read.refusal);
    out.push({ path: rel, bytes: read.text });
  }
}

/**
 * Resolves a leaf and proves it stays under the recipe root. A path that will not resolve at all
 * is its own refusal: a dangling link escapes nothing, and saying it does sends the author looking
 * for a containment problem that is not there.
 */
async function containedRealpath(abs: string, rootReal: string, rel: string): Promise<string> {
  const real = await fs.realpath(abs).catch(() => null);
  if (!real) throw new RecipeUnsafePathSignal(rel, "unresolvable");
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new RecipeUnsafePathSignal(rel, "symlink-escape");
  }
  return real;
}

type RecipeRefusal = "symlink-escape" | "unresolvable" | "dot-entry" | "irregular" | "unreadable";

class RecipeUnsafePathSignal extends Error {
  rel: string;
  reason: RecipeRefusal;
  constructor(rel: string, reason: RecipeRefusal = "symlink-escape") {
    super(`unsafe path '${rel}' (${reason})`);
    this.rel = rel;
    this.reason = reason;
  }
}

function refusalMessage(ref: string, err: RecipeUnsafePathSignal): string {
  switch (err.reason) {
    case "dot-entry":
      return `recipe folder '${ref}' contains a dot-prefixed path, which the recipe grammar can never accept: '${err.rel}'`;
    case "irregular":
      return `recipe folder '${ref}' contains a path that is not a regular file: '${err.rel}'`;
    case "unreadable":
      return `recipe folder '${ref}' contains a file that could not be opened for reading (check its permissions): '${err.rel}'`;
    case "symlink-escape":
      return `recipe folder '${ref}' contains a symlink escaping the recipe root: '${err.rel}'`;
    case "unresolvable":
      return `recipe folder '${ref}' contains a path that does not resolve, most often a symlink whose target is gone: '${err.rel}'`;
  }
}

export function filesRecipeSource(): RecipeSource {
  return {
    kind: "files",
    async resolve(ref) {
      if (!looksLikeRecipePath(ref)) return null;
      const expanded = expandRecipePath(ref);
      const real = await fs.realpath(path.resolve(expanded)).catch(() => null);
      if (!real) {
        return { ok: false, error: { code: "RECIPE_NOT_FOUND", message: `no recipe folder at '${ref}'` } };
      }
      const stat = await fs.stat(real).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        return { ok: false, error: { code: "RECIPE_UNSAFE_PATH", message: `'${ref}' is not a directory` } };
      }
      let files: RecipeFile[];
      try {
        files = await readRecipeDir(real);
      } catch (err) {
        if (err instanceof RecipeUnsafePathSignal) {
          const message = refusalMessage(ref, err);
          return { ok: false, error: { code: "RECIPE_UNSAFE_PATH", message } };
        }
        throw err;
      }
      return parseRecipeFiles(files, real);
    },
  };
}
