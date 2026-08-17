// The home surface's sharing-chip classifier (designs/home-surface; plans/home-surface-build
// PR-B). Maps this bundle's board-channel evidence into ui-server's `SharingSummary` — the CLI
// owns the mapping, ui-server owns the shape vocabulary, the SPA owns the words.
//
// OFFLINE LOCAL-EVIDENCE ONLY: no `ls-remote`, no network — the
// classification reads only what git already holds locally (fetched refs, remote config, HEAD
// trees), reusing board-git's ONE porcelain layer rather than growing a second git-parsing path.
// Consequence, stated: a shallow/single-branch clone whose shared board was never fetched can read
// `private` until its first fetch — `as_of` plus the sync-driven config refetch bound the window.
// The plan's "async spawns" is deliberately traded for porcelain reuse: the sync git reads run
// only on TTL expiry (~30s), tens of milliseconds, not per request.
//
// TRUTHFULNESS RULES (pinned by test/ui-sharing.test.ts):
//  - never fabricate in EITHER direction — a wrong "shared" equals a wrong "private";
//  - any classification failure is `unavailable` with a reason, never a guessed state;
//  - the WRONG-TARGET guard: sharing is claimed ONLY for the repo's conventional board
//    (`<top>/.superbee` or legacy `<top>/.agentstate-lite`); any other served bundle inside a repo is `unscoped` (no claim).
import path from "node:path";
import { realpathSync } from "node:fs";
import type { SharingSummary, WorkspaceSummaryEntry } from "@superbee/ui-server";
import {
  BOARD_BRANCH,
  BOARD_REF,
  BOARD_REMOTE,
  bundleDirNameForProject,
  committedBundleAtHead,
  hasWorktreeSignature,
  localBranchExists,
  probeRepoTopLevel,
  resolveInTreeUpstream,
  runGit,
  worktreeRootResolvesForOwner,
} from "@superbee/board-git";
import { loadCatalog } from "../catalog.js";

/** How long one classification is served before the local git evidence is re-read. */
export const SHARING_TTL_MS = 30_000;

/** Best-effort realpath (a missing path passes through — the comparison below just won't match). */
function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Humanize a git remote URL for the chip: a GitHub-shaped URL (https or scp-like ssh) degrades to
 * `org/repo`; anything else degrades to its host, else its path tail.
 */
export function humanizeRemote(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, "");
  const scpLike = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scpLike) {
    const [, host, tail] = scpLike;
    const parts = tail!.split("/").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join("/") : `${host}:${tail}`;
  }
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join("/") : parsed.host;
  } catch {
    const parts = trimmed.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || trimmed;
  }
}

/** Local-evidence reads, isolated for the classifier below. */
function localEvidence(
  top: string, tracked: boolean,
): { originUrl: string | undefined; fetchedBoardRef: boolean; tracked: boolean } {
  const origin = runGit(top, ["remote", "get-url", BOARD_REMOTE]);
  const fetchedBoardRef = runGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]).status === 0;
  return {
    originUrl: origin.status === 0 ? origin.stdout.trim() : undefined,
    fetchedBoardRef,
    tracked,
  };
}

/** Classify NOW (no cache) — exported pure-ish core, one row per truth-table state. */
export function classifySharing(bundleRoot: string, now: () => Date = () => new Date()): SharingSummary {
  const asOf = now().toISOString();
  try {
    const root = realOr(bundleRoot);
    // The board lives at a recognized conventional child; probe the PROJECT (the parent), so a linked
    // board WORKTREE (whose own top-level is the board folder itself) still anchors on the repo.
    const repo = probeRepoTopLevel(path.dirname(root));
    if (repo.kind === "not_repo") return { kind: "private", as_of: asOf }; // a plain folder shares nothing
    if (repo.kind === "unavailable") return { kind: "unavailable", reason: repo.reason, as_of: asOf };
    const top = repo.top;
    const committed = committedBundleAtHead(top);
    const bundleDir = committed?.bundleDir ?? bundleDirNameForProject(top);
    if (realOr(path.join(top, bundleDir)) !== root) return { kind: "unscoped", as_of: asOf };

    const evidence = localEvidence(top, committed !== null);
    const branchMode =
      (hasWorktreeSignature(root) && worktreeRootResolvesForOwner(root, top)) ||
      (!evidence.tracked && localBranchExists(top, BOARD_BRANCH));

    if (branchMode) {
      // Shared requires EVIDENCE the branch left this machine (a fetched origin/board ref) —
      // "origin exists" alone is a code remote, not a shared board.
      if (evidence.fetchedBoardRef && evidence.originUrl) {
        return { kind: "shared_branch", remote: humanizeRemote(evidence.originUrl), as_of: asOf };
      }
      return { kind: "private_local_branch", as_of: asOf };
    }

    if (evidence.tracked) {
      if (evidence.fetchedBoardRef) {
        // Both a committed folder AND a shared branch: sync's pre-share-window/dual-board zone.
        // A determinate refusal state — reported as unavailable-with-reason, never a guess.
        return {
          kind: "unavailable",
          reason: `both a committed ${bundleDir}/ folder and a fetched ${BOARD_REF} exist — run sync for guidance`,
          as_of: asOf,
        };
      }
      if (!evidence.originUrl) return { kind: "private_intree_no_remote", as_of: asOf };
      // shared_intree is EVIDENCE-GATED, like the branch arm: the committed
      // folder must be PRESENT on the branch's fetched tracking upstream — resolved through
      // intree.ts's decision table (never a guessed origin/<branch>), checked with a local
      // cat-file. A commit that never provably reached the remote reads not-yet-pushed, and the
      // remote NAMED is the tracking remote's, not origin's.
      const upstream = resolveInTreeUpstream(top);
      if (upstream.state === "ok" && upstream.config.remote !== null) {
        const onUpstream = runGit(top, ["cat-file", "-e", `${upstream.config.ref}:${bundleDir}`]).status === 0;
        if (onUpstream) {
          const tracking = runGit(top, ["remote", "get-url", upstream.config.remote]);
          const url = tracking.status === 0 ? tracking.stdout.trim() : evidence.originUrl;
          return { kind: "shared_intree", remote: humanizeRemote(url), as_of: asOf };
        }
      }
      return { kind: "private_intree_not_pushed", as_of: asOf };
    }

    // Untracked local folder + a fetched origin/board: a shared board EXISTS, but the SERVED
    // folder is not connected to it (provisioning's foreign-dir refusal zone — the chip describes
    // the served bundle, not the project's board location). Never "shared" over
    // content that never left this machine.
    if (evidence.fetchedBoardRef) {
      return {
        kind: "unavailable",
        reason: `a shared '${BOARD_BRANCH}' branch exists on ${BOARD_REMOTE}, but this folder is not connected to it — run sync for guidance`,
        as_of: asOf,
      };
    }
    return { kind: "private", as_of: asOf };
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err), as_of: asOf };
  }
}

/** TTL-cached loader for the ui server's config endpoint (the injection seam's dir-mode callback). */
export function createSharingLoader(bundleRoot: string, ttlMs: number = SHARING_TTL_MS): () => Promise<SharingSummary> {
  const effectiveTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : SHARING_TTL_MS;
  let cached: SharingSummary | undefined;
  let cachedAt = 0;
  return async () => {
    const nowMs = Date.now();
    if (!cached || nowMs - cachedAt >= effectiveTtlMs) {
      cached = { ...classifySharing(bundleRoot), refresh_after_ms: effectiveTtlMs };
      cachedAt = nowMs;
    }
    return cached;
  };
}

/** Registered-workspace rows for the home's collapsed block: labels + paths ONLY — deliberately NOT `listCatalogEntries` (its per-entry availability probes are the slow path home.ts also avoids). */
export function createWorkspacesLoader(bundleRoot: string): () => Promise<WorkspaceSummaryEntry[]> {
  const root = realOr(bundleRoot);
  return async () => {
    try {
      const catalog = await loadCatalog();
      return [...catalog.entries]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((entry) => ({
          label: entry.label,
          path: entry.locator.path,
          open: realOr(entry.locator.path) === root,
        }));
    } catch {
      return []; // best-effort block — a malformed catalog never breaks the home
    }
  };
}
