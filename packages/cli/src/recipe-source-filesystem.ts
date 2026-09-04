// The filesystem acquisition adapter owns traversal and symlink containment. It returns bytes to
// the distribution-neutral parser and never interprets recipe semantics beyond choosing whether a
// definitions-only manifest requires a complete file inventory.
//
// Containment is decided on the RESOLVED path, so the read names that resolved path too. Reading
// the unresolved one would resolve the link a second time and could land on a target the
// containment check never saw; symlinks that stay inside the recipe root remain honored.
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseMarkdown } from "@superbee/core";
import { parseRecipeFiles, type RecipeFile, type RecipeSource } from "./recipe-parser.js";
import { expandRecipePath, looksLikeRecipePath } from "./recipe-ref.js";

async function readRecipeDir(root: string): Promise<RecipeFile[]> {
  const files: RecipeFile[] = [];
  const rootReal = await fs.realpath(root);

  const manifestPath = path.join(root, "recipe.md");
  const manifestStat = await fs.stat(manifestPath).catch(() => null);
  if (manifestStat?.isFile()) {
    const manifestReal = await fs.realpath(manifestPath).catch(() => null);
    if (!manifestReal || (manifestReal !== rootReal && !manifestReal.startsWith(rootReal + path.sep))) {
      throw new RecipeUnsafePathSignal("recipe.md");
    }
    const bytes = await fs.readFile(manifestReal, "utf8");
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
    const real = await fs.realpath(abs).catch(() => null);
    if (!real || (real !== rootReal && !real.startsWith(rootReal + path.sep))) {
      throw new RecipeUnsafePathSignal(rel);
    }
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile()) throw new RecipeUnsafePathSignal(rel);
    out.push({ path: rel, bytes: await fs.readFile(real, "utf8") });
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

    const real = await fs.realpath(abs).catch(() => null);
    if (!real || (real !== rootReal && !real.startsWith(rootReal + path.sep))) {
      throw new RecipeUnsafePathSignal(rel);
    }
    out.push({ path: rel, bytes: await fs.readFile(real, "utf8") });
  }
}

class RecipeUnsafePathSignal extends Error {
  rel: string;
  reason: "symlink-escape" | "dot-entry";
  constructor(rel: string, reason: "symlink-escape" | "dot-entry" = "symlink-escape") {
    super(`unsafe path '${rel}' (${reason})`);
    this.rel = rel;
    this.reason = reason;
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
          const message =
            err.reason === "dot-entry"
              ? `recipe folder '${ref}' contains a dot-prefixed path, which the recipe grammar can never accept: '${err.rel}'`
              : `recipe folder '${ref}' contains a symlink escaping the recipe root: '${err.rel}'`;
          return { ok: false, error: { code: "RECIPE_UNSAFE_PATH", message } };
        }
        throw err;
      }
      return parseRecipeFiles(files, real);
    },
  };
}
