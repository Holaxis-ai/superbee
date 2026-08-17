// `intree.ts` — the IN-TREE board's READ-SIDE mechanics (board-git PR C, plans/board-git-package
// §"In-tree mode semantics: READ-SIDE ONLY (v1)").
//
// An in-tree board is the conventional bundle COMMITTED WITH CODE on the current branch (channel
// detection's `{mode: "in-tree"}`). This module is everything the mode does — and it is READ-SIDE
// only, by design:
//
//   • AWARENESS rides the branch's own tracking upstream: fetch the tracked remote (time-boxed,
//     fail-soft, never touching the working tree), then diff `<cursor>..<upstream>` through THE
//     one prefix-aware `diffDocsBetween` (ids prefix-STRIPPED before doc-id/reserved
//     interpretation, so a prefixed bundle `index.md` still reads as reserved). Enrichment stays
//     per-doc frontmatter at the upstream ref — never commit authors.
//   • DELIVERY is the user's normal `git pull`. Nothing here merges, rebases, or checks out —
//     sync's "touches nothing outside the board" invariant cannot survive a write-side in-tree
//     mode (pushing the code branch publishes code), so the write verbs refuse at the CLI.
//   • The UPSTREAM is a DECISION TABLE, never a guess: the branch's tracking config
//     (`branch.<name>.remote` + `%(upstream:short)`) if set → that ref; detached HEAD, no
//     tracking config, or a tracking ref that doesn't resolve → an explicit "no comparison
//     basis" outcome — honest nothing, not an error, and NEVER an assumed `origin/<branch>`.
//     (The porcelain's "EXPLICIT refs, never @{u}" invariant is about the BOARD branch's ops,
//     where no tracking config exists by construction; here the tracking config IS the table's
//     one sanctioned source.)
//   • The CURSOR is MODE-SCOPED: tier `"git-intree"` (vs branch mode's `"git"`). Both modes share
//     one repo object database AND one per-clone state key, so an existence-only token guard
//     would let a cursor minted in one mode survive a mode flip and diff across unrelated trees —
//     the tier makes a flipped cursor read as foreign, taking the honest re-anchor path instead.
//   • BACKSTOPS are PREFIX-SCOPED (`status --porcelain -- <prefix>`, `<upstream>..HEAD --
//     <prefix>`) — a dirty or unpushed CODE tree must never read as board activity.
//   • NO AUTOPULL (v1): autopull's zero-spawn pre-gate keys on the `.git`-FILE worktree
//     signature; an in-tree bundle is a plain directory, so board-reading commands never spawn
//     for it. In-tree awareness refreshes via session-start (and the explicit `sync --pull-only`
//     fetch-and-report) only.
import {
  NETWORK_TIMEOUT_MS,
  countUncommitted,
  runGit,
  type BundleDirName,
  type DocChange,
  type NetworkBudgetOptions,
} from "./porcelain.js";
import { diffDocsBetween } from "./diff.js";
import { BoardGitError, classifyGitError, isBoardGitError } from "./errors.js";
import { toDeltaRows } from "./engine.js";
import { type SyncStore } from "./cursor.js";

/** The in-tree awareness cursor's tier — mode-scoped so a branch-mode (`"git"`) cursor reads as foreign. */
export const IN_TREE_CURSOR_TIER = "git-intree";

/** The branch's resolved tracking config — the upstream decision table's ONE sanctioned source. */
export interface InTreeUpstreamConfig {
  /** The checked-out branch's short name. */
  branch: string;
  /** The tracking ref's short name (e.g. `origin/main`) — resolvable or not. */
  ref: string;
  /** The remote to fetch, or `null` for a local (`.`) tracking target (nothing to fetch). */
  remote: string | null;
}

export type InTreeUpstreamResolution =
  | { state: "ok"; config: InTreeUpstreamConfig }
  /** No comparison basis exists — report nothing, honestly; never guess `origin/<branch>`. */
  | { state: "none"; reason: "detached-head" | "no-upstream" };

/**
 * Resolve the current branch's tracking upstream from LOCAL config/refs only (no network). The
 * decision table's first two rows: detached HEAD → none; no tracking config → none. A configured
 * ref that does not currently RESOLVE is still returned (`state: "ok"`) — the caller's fetch may
 * materialize it; post-fetch resolution ({@link inTreeUpstreamSha}) decides "unusable".
 */
export function resolveInTreeUpstream(top: string): InTreeUpstreamResolution {
  const head = runGit(top, ["symbolic-ref", "-q", "--short", "HEAD"]);
  if (head.status !== 0) return { state: "none", reason: "detached-head" };
  const branch = head.stdout.trim();
  if (branch.length === 0) return { state: "none", reason: "detached-head" };

  const upstream = runGit(top, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]);
  const ref = upstream.status === 0 ? upstream.stdout.trim() : "";
  if (ref.length === 0) return { state: "none", reason: "no-upstream" };

  const remoteR = runGit(top, ["config", "--get", `branch.${branch}.remote`]);
  const remoteName = remoteR.status === 0 ? remoteR.stdout.trim() : "";
  const remote = remoteName.length === 0 || remoteName === "." ? null : remoteName;
  return { state: "ok", config: { branch, ref, remote } };
}

/** The commit a tracking ref resolves to, or `null` (never fetched / pruned / deleted upstream). */
export function inTreeUpstreamSha(top: string, ref: string): string | null {
  const r = runGit(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.status === 0 && sha.length > 0 ? sha : null;
}

/**
 * Board-touching upstream commits this checkout has not pulled (`HEAD..<upstream> -- <prefix>`)
 * — the "run `git pull` to get them" count. `null` when the range cannot be computed.
 */
export function inTreeBehindCount(top: string, upstream: string, prefix: BundleDirName): number | null {
  const r = runGit(top, ["rev-list", "--count", `HEAD..${upstream}`, "--", prefix]);
  if (r.status !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Board-touching commits on this branch not yet pushed to its upstream (`<upstream>..HEAD --
 * <prefix>`) — the in-tree unpushed backstop, prefix-scoped so code commits never count. `null`
 * when the range cannot be computed (no upstream basis).
 */
export function inTreeUnpushedCount(top: string, upstream: string, prefix: BundleDirName): number | null {
  const r = runGit(top, ["rev-list", "--count", `${upstream}..HEAD`, "--", prefix]);
  if (r.status !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** What one in-tree fetch-and-record step did — the session-start/`--pull-only` shared outcome. */
export type InTreeFetchOutcome =
  /** Fetched (or nothing to fetch), computed the upstream delta, and rewrote cursor + cache. */
  | {
      state: "refreshed";
      upstreamRef: string;
      upstreamSha: string;
      /** Prefix-stripped enriched doc changes `<baseline>..<upstream>` (empty after a re-anchor). */
      changes: DocChange[];
      /** Board-touching upstream commits not yet pulled into this checkout. */
      behind: number;
      unpushedCount: number;
      uncommittedCount: number;
      /** True when the stored cursor was unusable (gone or non-ancestor) — the honest re-anchor. */
      reanchored: boolean;
    }
  /** No comparison basis (decision-table rows 2–3) — nothing fetched, nothing recorded. */
  | { state: "no-upstream"; reason: "detached-head" | "no-upstream" }
  /** Tracking config exists but the ref doesn't resolve even after the fetch — nothing recorded. */
  | { state: "unusable-upstream"; ref: string }
  /** The fetch failed (offline/auth/busy/timeout) — classified, NOTHING recorded (state untouched). */
  | { state: "fetch-failed"; failure: BoardGitError };

/**
 * THE in-tree pull-step equivalent: resolve the upstream (decision table), fetch ONLY the tracked
 * remote (time-boxed, fail-soft posture decided by the CALLER — session-start swallows the typed
 * failure, `sync --pull-only` throws it), then compute the prefix-scoped enriched delta and
 * rewrite the mode-scoped cursor + awareness cache. Mirrors branch mode's `pullBoardAndRecord`
 * state discipline exactly: a failed fetch writes NOTHING (the cursor advances only on a
 * successful check), and an unusable stored cursor takes the honest re-anchor (empty delta +
 * {@link SyncStore.recordReanchor}'s note — never a silent skip, never fatal).
 *
 * Baseline selection: a stored `git-intree` cursor whose token still exists AND is an ancestor of
 * the upstream tip → `<token>..<upstream>`; a token that is gone or non-ancestor (history
 * rewritten under it — an upstream rebase, or a branch flip) → re-anchor; an absent or FOREIGN
 * (`"git"`-tier — the mode-flip case) cursor → first contact: `merge-base(HEAD, upstream)` ("what
 * this checkout already contains"), falling back to the upstream tip itself (empty delta) when no
 * merge base exists. The working tree is NEVER touched on any path.
 */
export async function inTreeFetchAndRecord(
  store: SyncStore,
  top: string,
  key: string,
  prefix: BundleDirName,
  budget: NetworkBudgetOptions = {},
  now: () => Date = () => new Date(),
): Promise<InTreeFetchOutcome> {
  const resolution = resolveInTreeUpstream(top);
  if (resolution.state === "none") return { state: "no-upstream", reason: resolution.reason };
  const { ref, remote } = resolution.config;

  if (remote !== null) {
    let failure: BoardGitError | undefined;
    try {
      const fetched = runGit(top, ["fetch", "--prune", remote], {
        timeoutMs: budget.fetchTimeoutMs ?? NETWORK_TIMEOUT_MS,
        connectTimeoutSeconds: budget.connectTimeoutSeconds,
      });
      if (fetched.status !== 0) {
        failure = classifyGitError({
          args: ["fetch", "--prune", remote],
          status: fetched.status,
          stdout: fetched.stdout,
          stderr: fetched.stderr,
        });
      }
    } catch (err) {
      // A fired time-box (or spawn-level failure) is already a classified BoardGitError.
      if (!isBoardGitError(err)) throw err;
      failure = err;
    }
    if (failure) return { state: "fetch-failed", failure };
  }

  const sha = inTreeUpstreamSha(top, ref);
  if (sha === null) return { state: "unusable-upstream", ref };

  const unpushedCount = inTreeUnpushedCount(top, sha, prefix) ?? 0;
  const uncommittedCount = countUncommitted(top, prefix);
  const behind = inTreeBehindCount(top, sha, prefix) ?? 0;

  const stored = await store.readCursor(key);
  const token =
    stored && stored.tier === IN_TREE_CURSOR_TIER && typeof stored.token === "string"
      ? stored.token
      : undefined;

  if (token !== undefined) {
    const exists = runGit(top, ["cat-file", "-e", `${token}^{commit}`]).status === 0;
    const isAncestorOfUpstream = exists && runGit(top, ["merge-base", "--is-ancestor", token, sha]).status === 0;
    if (!isAncestorOfUpstream) {
      // Gone OR non-ancestor: the delta across a rewrite/reposition is unknowable — re-anchor.
      await store.recordReanchor(key, { tier: IN_TREE_CURSOR_TIER, token: sha }, { unpushedCount, uncommittedCount }, now);
      return {
        state: "refreshed",
        upstreamRef: ref,
        upstreamSha: sha,
        changes: [],
        behind,
        unpushedCount,
        uncommittedCount,
        reanchored: true,
      };
    }
  }

  let baseline: string;
  if (token !== undefined) {
    baseline = token;
  } else {
    const mb = runGit(top, ["merge-base", "HEAD", sha]);
    baseline = mb.status === 0 && mb.stdout.trim().length > 0 ? mb.stdout.trim() : sha;
  }

  const changes = diffDocsBetween(top, baseline, sha, { prefix });
  await store.writeCursor(key, { tier: IN_TREE_CURSOR_TIER, token: sha });
  await store.writeCache(key, {
    updatedAt: now().toISOString(),
    delta: toDeltaRows(changes),
    unpushedCount,
    uncommittedCount,
  });
  return {
    state: "refreshed",
    upstreamRef: ref,
    upstreamSha: sha,
    changes,
    behind,
    unpushedCount,
    uncommittedCount,
    reanchored: false,
  };
}
