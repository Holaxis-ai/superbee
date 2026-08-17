// `diff.ts` — the ONE ref-to-ref doc diff family (board-git A1, carved from the porcelain
// module it rides): `diffDocsBetween` is the consolidated diff-parse-enrich path; `changesSince`
// (the cursor feed) and `originDocsBetween` (the sync receipt's origin-side delta) are its two
// named projections. Do not reintroduce a per-caller copy of the name-status parse or the
// enrichment — porcelain.ts's `stageAndCommit`/`snapshotBundleCommit` share the same vocabulary
// (`nameStatusRows`/`verbOf`/`enrichDocChange`), which is why it lives there and is imported here.
import {
  enrichDocChange,
  isConceptDocPath,
  mustGit,
  nameStatusRows,
  runGit,
  verbOf,
  type DocChange,
} from "./porcelain.js";

// ── the ONE ref-to-ref doc diff (changes-since + the receipt's origin delta) ──

export interface DiffDocsOptions {
  /**
   * Scope the delta to docs under this repo-relative prefix (e.g. `.superbee/`), stripping
   * it BEFORE doc-id/reserved-file interpretation — so `<prefix>/index.md` still reads as
   * reserved. The seam for in-tree mode (plan board-git PR C); unused by today's callers (a
   * board worktree's root IS the bundle root).
   */
  prefix?: string;
  /**
   * True: a failed diff reads as "no changes" (the receipt's origin-delta tolerance — two
   * already-verified refs that cannot diff yield an empty delta, never a failed sync). Default
   * false: a failed diff throws classified (the cursor feed's posture). Spawn-level failures
   * (no git binary, fired timeout) throw either way.
   */
  tolerateDiffFailure?: boolean;
}

/**
 * The consolidated enriched delta pipeline: every concept doc changed between `fromRef..toRef`
 * (two-dot — snapshot-to-snapshot, requiring object EXISTENCE not ancestry), each row read from
 * the doc's OWN frontmatter at `toRef` (or, for a deletion, at `fromRef`). This is the ONE
 * diff-parse-enrich path — {@link changesSince} (the cursor feed) and sync's receipt delta both
 * ride it; do not reintroduce a per-caller copy of the name-status parse or the enrichment.
 */
export function diffDocsBetween(
  dir: string,
  fromRef: string,
  toRef: string,
  opts: DiffDocsOptions = {},
): DocChange[] {
  // Push a prefix scope down as git's own `-- <pathspec>` so git
  // computes the diff over just that subtree instead of the whole repo, which matters once an
  // in-tree bundle sits in a large code repo. The JS-side prefix-strip/filter below is unchanged
  // (still correct on an already-scoped diff) — this is a cost cut, not a behavior change.
  const args = [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    `${fromRef}..${toRef}`,
    ...(opts.prefix ? ["--", opts.prefix] : []),
  ];
  let out: string;
  if (opts.tolerateDiffFailure) {
    const r = runGit(dir, args);
    if (r.status !== 0) return [];
    out = r.stdout;
  } else {
    out = mustGit(dir, args);
  }
  const prefix =
    !opts.prefix ? undefined : opts.prefix.endsWith("/") ? opts.prefix : `${opts.prefix}/`;
  const changes: DocChange[] = [];
  for (const { letter, relPath } of nameStatusRows(out)) {
    let idPath = relPath;
    if (prefix !== undefined) {
      if (!relPath.startsWith(prefix)) continue;
      idPath = relPath.slice(prefix.length);
    }
    if (!isConceptDocPath(idPath)) continue;
    const verb = verbOf(letter);
    if (!verb) continue;
    changes.push(enrichDocChange(dir, relPath, verb, verb === "deleted" ? fromRef : toRef, {}, idPath));
  }
  return changes;
}

// ── changes since a cursor token ──────────────────────────────────────────────

export type ChangesSinceOutcome =
  | { ok: true; changes: DocChange[] }
  /** The cursor token no longer resolves to a commit (history rewritten) — the caller re-anchors. */
  | { ok: false; reason: "dangling" };

/**
 * The enriched delta feed since a cursor token — {@link diffDocsBetween} over `<token>..HEAD`,
 * guarded by `git cat-file -e <token>^{commit}` so a rewritten-away cursor reports `dangling`
 * instead of a fatal `Invalid revision range` — the honest re-anchor path is the CURSOR module's
 * job.
 */
export function changesSince(boardPath: string, token: string): ChangesSinceOutcome {
  if (runGit(boardPath, ["cat-file", "-e", `${token}^{commit}`]).status !== 0) {
    return { ok: false, reason: "dangling" };
  }
  return { ok: true, changes: diffDocsBetween(boardPath, token, "HEAD") };
}

// ── the receipt's origin-side delta (moved from the CLI's sync command, board-git A1) ─────────

/**
 * The RECEIPT's `pulled`/`incoming` delta: the concept docs that changed strictly between two
 * EXPLICIT origin/board refs (before/after a sync run's own fetch), NEVER touching local HEAD or
 * local commit history — a HEAD-anchored diff would double-count self-authored/unpushed docs as
 * "incoming". `null`/equal refs (no known baseline, or genuinely nothing new fetched) and a diff
 * between refs that cannot be compared both yield an empty result rather than a failed sync —
 * the receipt tolerance, layered onto the ONE consolidated {@link diffDocsBetween}.
 */
export function originDocsBetween(boardPath: string, fromRef: string | null, toRef: string | null): DocChange[] {
  if (!fromRef || !toRef || fromRef === toRef) return [];
  return diffDocsBetween(boardPath, fromRef, toRef, { tolerateDiffFailure: true });
}
