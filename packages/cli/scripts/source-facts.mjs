// Build-time Git evidence about the tree a bundle is built from. The library build and the
// distribution build both record it, so they read it through this one owner.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// packages/cli/scripts -> repo root
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function gitFact(args, fallback) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

/** Build-time source evidence. Unknown is represented explicitly, never invented. */
export function currentSourceFacts() {
  const commit = gitFact(["rev-parse", "HEAD"], "");
  const status = gitFact(["status", "--porcelain=v1", "--untracked-files=all"], null);
  return {
    commit: commit || null,
    dirty: status === null ? null : status.length > 0,
  };
}
