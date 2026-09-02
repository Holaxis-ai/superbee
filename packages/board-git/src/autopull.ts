// `autopull.ts` — opportunistic board freshness: the stale-cache pull the CLI's board-reading
// commands run (real-time ladder rung 1, product-native — tasks/sync-opportunistic-pull;
// relocated from the CLI by board-git A1 with the store + bundle-root seams injected — the
// trigger's CALL SITES and the wiring of those seams stay in the CLI's `autopull.ts`).
//
// THE MECHANIC (the Homebrew pattern): a board-READING command (`list`, `doc read`, `status`,
// `home`, `link show`) on a PROVISIONED board checkout checks the awareness cache's age and — when
// it is older than {@link AUTO_PULL_STALE_MS} — runs the SAME time-boxed, ff-only, fail-soft pull
// step session-start uses, THEN serves the read. Silent when current, silent when it pulls, silent
// when it fails: the pull's only observable products are the refreshed board content the read now
// serves and the same cursor/cache/marker writes a session-start pull would have made.
//
// INLINE, NOT DETACHED: firing a one-shot `sync --pull-only` child and serving this read from the
// old state would make only the next read fresh. Inline pull is required because:
//   1. It serves the triggering read STALE by construction. The demand signal is "regular,
//      automatic, silent board freshness"; a detached child delivers freshness only to a read
//      that may never come, while the read that detected the staleness — the one moment we KNOW
//      the data is wanted — still gets the old state.
//   2. It mutates the worktree AFTER the command exited: an unsupervised background git process
//      is exactly the observability problem the no-daemon non-goal exists to avoid (rider 2's
//      "never a silent git mutation" is about announceability — a mutation nothing can announce
//      because its parent already returned is the spirit-violation, even if a one-shot child is
//      inside the letter). It also manufactures the very GIT_BUSY contention we have structured
//      handling for: the detached fetch races the NEXT command's own git ops.
//   3. Inline is synchronous and deterministic — testable with the existing hang://-helper and
//      injectable-clock house patterns; detached needs polling and leaves orphaned children on
//      short-lived CI runners.
// Inline's honest price — bounded added latency (≤ {@link AUTO_PULL_BUDGET_MS} worst case against
// a black-holed remote, sub-second typical) — is paid at most ONCE per staleness window per clone:
// the attempt-side throttle below backs off failing pulls too, so an offline machine pays one
// bounded probe per window, not one per read.
//
// DEFAULT-ON, INCLUDING NON-TTY, with the {@link SUPERBEE_NO_AUTOPULL_ENV} or legacy
// {@link NO_AUTOPULL_ENV} opt-out ({@code SUPERBEE_NO_AUTOPULL=1} or
// {@code AGENTSTATE_LITE_NO_AUTOPULL=1}) for scripted/CI contexts. The CLI's
// primary consumers are AGENTS driving it non-interactively (stdout is a pipe in every Claude
// Code/Codex session) — a TTY gate would disable the feature for exactly its target audience. CI
// is protected structurally, not by sniffing: the trigger is DETECTION-GATED (a CI checkout has no
// provisioned board worktree unless a step deliberately provisioned one), fail-soft (an offline
// runner pays at most one bounded fetch attempt per staleness window), and the env knob covers the
// rest. This repo's own test suite sets the knob globally (packages/cli package.json's test
// script) so suites that don't inject the seam stay hermetic on machines whose checkout has a
// provisioned, stale board.
//
// CONSTRAINTS (all binding, from the task):
//   • ff-only ONLY — the pull is `ffPull` (fetch + merge --ff-only), NEVER a rebase; a
//     diverged board is swallowed per ffPull's matrix and left exactly as it was (the interactive
//     `sync` verb reports that state with real exit codes — this trigger never does).
//   • DETECTION-GATED — a read must NEVER provision: nothing on this path calls
//     `provisionBoardWorktree`. On an unprovisioned checkout the trigger simply doesn't fire
//     (provisioning stays sync/session-start's job).
//   • DETECTION IS CHEAP, not just correct: the check runs on EVERY non-triggering
//     read, so its cost is the tax everyone pays): checks are ordered cheapest-first.
//     (1) An FS-ONLY pre-gate ({@link findBoardCandidate}: either the `.git`-FILE linked-worktree
//     signature or a standalone root whose `.git/HEAD` names `board`) locates a
//     provisioned-LOOKING board checkout with ZERO process spawns, so a
//     non-repo dir, a plain bundle, and an unprovisioned checkout all exit spawn-free.
//     (2) The bundle-scope check is fs-only too. (3) The state file is read next, so a FRESH
//     cache proves itself with exactly ONE spawn (`remote get-url` — the state key's remote
//     component). (4) Only the STALE path — reached at most once per staleness window per clone,
//     thanks to the attempt throttle — pays the full spawn-level active-board-path verification
//     (which is what tells a genuine board worktree apart from a submodule or an unrelated
//     worktree that merely shares the `.git`-file signature) before the network pull.
//   • ONE code path for the state writes: {@link pullBoardAndRecord} below IS session-start's
//     pull-and-record step, extracted verbatim (session-start.ts now calls it too) — the
//     cursor-advance-only-on-success / cache-on-success / re-anchor-on-dangling discipline is
//     shared, not forked.
//   • Scope: the trigger additionally requires (for the bundle commands) that the bundle the
//     command is about to read IS the board checkout — a read of an unrelated bundle that merely
//     lives inside a board-sharing repo must not spend network on the board. `home` (which always
//     renders the board block) passes {@link AutoPullOptions.requireBoardBundle} = false.
import path from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";

import {
  BOARD_BRANCH,
  BUNDLE_DIRS,
  countUncommitted,
  currentHead,
  ffPull,
  repoTopLevel,
  resolveProvisionedBoardPath,
  unpushedCount,
  type NetworkBudgetOptions,
} from "./porcelain.js";
import { changesSince } from "./diff.js";
import { type SyncStore } from "./cursor.js";
import { resolveBundleKey, toDeltaRows } from "./engine.js";

/** How old the awareness cache may get before a board-reading command refreshes it (~5m). */
export const AUTO_PULL_STALE_MS = 5 * 60_000;
/**
 * The trigger's whole network budget, in ms — the fetch's spawnSync kill slice (the hard stop a
 * hanging remote dies against). Deliberately far under session-start's 7s: this latency rides ON
 * a read the user asked for, not on a session boundary.
 */
export const AUTO_PULL_BUDGET_MS = 2_000;
/** ssh ConnectTimeout for the trigger's fetch, in seconds (a black-holed ssh host fails fast). */
export const AUTO_PULL_CONNECT_TIMEOUT_SECONDS = 2;
/** Set (to any non-empty value) to disable the opportunistic pull entirely — the CI/scripting knob. */
export const NO_AUTOPULL_ENV = "AGENTSTATE_LITE_NO_AUTOPULL";
export const SUPERBEE_NO_AUTOPULL_ENV = "SUPERBEE_NO_AUTOPULL";

/** realpath when the path exists; the path unchanged otherwise (stable comparisons). */
function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** True for git's linked-worktree/submodule marker shape: a `.git` FILE, not a directory. */
function hasGitFileSignature(p: string): boolean {
  try {
    return statSync(path.join(p, ".git")).isFile();
  } catch {
    return false;
  }
}

/** Zero-spawn signature for a standalone root currently attached to the board branch. */
function hasStandaloneBoardSignature(p: string): boolean {
  try {
    if (!statSync(path.join(p, ".git")).isDirectory()) return false;
    if (!statSync(path.join(p, "index.md")).isFile()) return false;
    return readFileSync(path.join(p, ".git", "HEAD"), "utf8").trim() === `ref: refs/heads/${BOARD_BRANCH}`;
  } catch {
    return false;
  }
}

/**
 * The FS-ONLY pre-gate (module header, "detection is cheap"): walk up from `start` looking for a
 * provisioned-LOOKING board checkout — either a standalone root whose `.git/HEAD` names `board`,
 * an ancestor with a recognized bundle name carrying the `.git`-FILE signature (the caller may
 * stand inside the board worktree, so this retarget is resolved without a spawn), or an ancestor
 * directory whose recognized child has a `.git` file (the conventional project-top shape). ZERO
 * process spawns.
 * A hit is a CANDIDATE only — a
 * submodule or an unrelated linked worktree shares this signature — so the STALE path re-verifies
 * with the real spawn-level active-board resolver before any state write or network op; the fresh-cache
 * and non-board paths never need the distinction (a false candidate keys a state file that no
 * pull step ever writes, so its cache is always absent and the stale path's verification refuses
 * it before anything observable happens).
 */
export function findBoardCandidate(start: string): { top: string; boardPath: string } | null {
  let cur = path.resolve(start);
  for (;;) {
    if (hasStandaloneBoardSignature(cur)) return { top: cur, boardPath: cur };
    if (BUNDLE_DIRS.includes(path.basename(cur) as (typeof BUNDLE_DIRS)[number]) && hasGitFileSignature(cur)) {
      return { top: path.dirname(cur), boardPath: cur };
    }
    const candidates = BUNDLE_DIRS.map((name) => path.join(cur, name)).filter(hasGitFileSignature);
    if (candidates.length > 1) return null;
    if (candidates[0]) return { top: cur, boardPath: candidates[0] };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** What {@link pullBoardAndRecord} did — session-start maps this into its render outcome. */
export interface BoardPullRecordResult {
  /** `ffPull`'s swallow reason when the pull did not complete (offline, diverged, dirty, …). */
  swallowed?: string;
  /** True when the pull SUCCEEDED and the cursor/cache were rewritten (incl. the re-anchor path). */
  refreshed: boolean;
}

/**
 * THE shared pull-and-record step (extracted VERBATIM from session-start's pull — one code path,
 * per the task's binding constraint): versioned-cursor read → ff-only pull → on success, the
 * cursor advanced to the post-pull HEAD + the awareness cache rewritten with the enriched delta
 * and live backstop counts (mirroring sync's step 5), with an honest re-anchor when the stored
 * cursor's object no longer exists. A swallowed pull writes NOTHING (the cursor advances only on
 * a successful pull — test-pinned in the session-start suite). The caller owns provisioning
 * detection, the marker refresh, and budget slicing; this step owns the state discipline.
 */
export async function pullBoardAndRecord(
  store: SyncStore,
  boardPath: string,
  key: string,
  budget: NetworkBudgetOptions = {},
  now: () => Date = () => new Date(),
): Promise<BoardPullRecordResult> {
  const storedCursor = await store.readCursor(key);
  const startHead = currentHead(boardPath);
  const ff = ffPull(boardPath, budget);
  if (ff.swallowed) {
    // No cursor advance, no cache write (the pull did not succeed).
    return { swallowed: ff.swallowed, refreshed: false };
  }

  // Successful pull: mirror sync's step 5 — cursor-based delta (self-inclusive; the render
  // filters self-authored rows), cursor advanced to the post-pull HEAD, cache refreshed.
  const cursorToken =
    storedCursor && storedCursor.tier === "git" && typeof storedCursor.token === "string"
      ? storedCursor.token
      : undefined;
  const postPullHead = currentHead(boardPath);
  const delta = changesSince(boardPath, cursorToken ?? startHead);
  if (delta.ok) {
    await store.writeCursor(key, { tier: "git", token: postPullHead });
    await store.writeCache(key, {
      updatedAt: now().toISOString(),
      delta: toDeltaRows(delta.changes),
      unpushedCount: unpushedCount(boardPath) ?? 0,
      uncommittedCount: countUncommitted(boardPath),
    });
  } else {
    // Dangling cursor (history rewritten) — honestly re-anchor with an empty delta + note, never a
    // silent skip, never fatal.
    await store.recordReanchor(
      key,
      { tier: "git", token: postPullHead },
      { unpushedCount: unpushedCount(boardPath) ?? 0, uncommittedCount: countUncommitted(boardPath) },
      now,
    );
  }
  return { refreshed: true };
}

/**
 * Why {@link maybeAutoPull} did (or did not) pull — a diagnostic return for tests and callers;
 * the trigger itself is SILENT on every path (no stdout, no throw).
 */
export type AutoPullOutcome =
  /** The {@link NO_AUTOPULL_ENV} knob is set. */
  | "disabled"
  /** No git repo / no provisioned board checkout here — the trigger never provisions. */
  | "no-board"
  /** The bundle this read targets is not the board checkout (an unrelated bundle in the repo). */
  | "different-bundle"
  /** The awareness cache is younger than the staleness threshold. */
  | "fresh"
  /** A recent ATTEMPT (successful or not) already ran this window — backed off. */
  | "throttled"
  /** The ff-only pull ran and the cursor/cache were refreshed. */
  | "pulled"
  /** The pull ran but was swallowed (offline, diverged, dirty, …) — state untouched, no retry this window. */
  | "skipped"
  /** An unexpected throw — swallowed (the read must never fail or slow down for board reasons). */
  | "error";

/** The injected seams a HOST wires once: WHERE state lives and HOW a bundle root resolves. */
export interface AutoPullDeps {
  /** The per-clone sync state store (the CLI wires its `defaultSyncStore`). */
  store: SyncStore;
  /**
   * Resolve the bundle root a read with NO explicit --dir targets (the CLI wires its
   * conventional-folder discovery walk). Only consulted for the bundle-scope check.
   */
  resolveBundleRoot: (start: string) => Promise<string | null>;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface AutoPullOptions {
  /** Staleness threshold override (default {@link AUTO_PULL_STALE_MS}). */
  staleMs?: number;
  /** Network budget override (default {@link AUTO_PULL_BUDGET_MS}). */
  budgetMs?: number;
  /** ssh connect budget override (default {@link AUTO_PULL_CONNECT_TIMEOUT_SECONDS}). */
  connectTimeoutSeconds?: number;
  /** Env override (default `process.env`) - the autopull opt-out knobs are read from here. */
  env?: Record<string, string | undefined>;
  /** Injectable clock (the house pattern) — feeds the staleness check AND the state writes. */
  now?: () => Date;
  /**
   * Require the bundle the command will read to BE the board checkout (default true). `home`
   * passes false: it has no single target bundle and always renders the board block.
   */
  requireBoardBundle?: boolean;
}

/**
 * The opportunistic-freshness trigger. NEVER throws, NEVER writes to stdout/stderr, NEVER
 * provisions; the returned {@link AutoPullOutcome} is diagnostic only. Ordering is cheap-first
 * (module header, "detection is cheap"): env knob → the FS-ONLY candidate walk (zero spawns) →
 * the fs-only bundle-scope check → the state read behind ONE spawn (the key's `remote get-url`) —
 * so a fresh cache costs one spawn and every non-board path costs none — and only the STALE path
 * pays the spawn-level provisioning verification and the time-boxed network pull,
 * attempt-recorded FIRST so a hanging/failing pull still backs off for a full window.
 */
export async function maybeAutoPull(
  deps: AutoPullDeps,
  dir?: string,
  opts: AutoPullOptions = {},
): Promise<AutoPullOutcome> {
  try {
    const env = opts.env ?? process.env;
    if (env[SUPERBEE_NO_AUTOPULL_ENV] || env[NO_AUTOPULL_ENV]) return "disabled";
    const now = opts.now ?? (() => new Date());
    const staleMs = opts.staleMs ?? AUTO_PULL_STALE_MS;

    // FS-ONLY pre-gate (zero spawns): a provisioned-LOOKING board checkout, or nothing to do.
    const start = dir ?? process.cwd();
    const candidate = findBoardCandidate(start);
    if (!candidate) return "no-board";
    const boardPath = candidate.boardPath;

    // Scope (fs-only): the read must actually target the BOARD bundle (openBundle semantics
    // mirrored — an explicit --dir names a literal bundle root; otherwise the conventional walk).
    if (opts.requireBoardBundle !== false) {
      const root = dir !== undefined ? path.resolve(dir) : await deps.resolveBundleRoot(start);
      if (!root || realOrSame(root) !== realOrSame(boardPath)) return "different-bundle";
    }

    // The state key's remote component is the ONE spawn a fresh cache pays (`remote get-url`,
    // inside resolveBundleKey) — deliberately BEFORE any other git op, so the state file can
    // prove freshness without further process cost.
    const key = resolveBundleKey(boardPath);
    const state = await deps.store.readSyncState(key);
    const nowMs = now().getTime();
    const ageOk = (iso: string | undefined | null): boolean =>
      typeof iso === "string" && nowMs - Date.parse(iso) <= staleMs;
    if (ageOk(state.cache?.updatedAt)) return "fresh";
    if (ageOk(state.autoPullAttemptAt)) return "throttled";

    // STALE path only (at most once per window per clone): the candidate was an FS-signature
    // guess — verify with real git before any state write or network op that (a) the candidate
    // IS the conventional board of ITS OWN enclosing repo (a submodule or an unrelated linked
    // worktree squatting at the name fails here), and (b) it is genuinely provisioned (the
    // exact active board path proven by the shared topology resolver).
    const gitTop = repoTopLevel(candidate.top);
    const activeBoardPath = gitTop ? resolveProvisionedBoardPath(gitTop) : null;
    if (!activeBoardPath || realOrSame(activeBoardPath) !== realOrSame(boardPath)) {
      return "no-board";
    }

    // Attempt recorded BEFORE the network op: a pull that hangs into its kill or fails outright
    // must still back off for a full window (otherwise an offline machine pays the budget on
    // EVERY read). Marker refreshed too — every pull step that confirmed a provisioned board
    // refreshes it, matching sync's and session-start's pull steps.
    await deps.store.recordAutoPullAttempt(key, now);
    await deps.store.refreshMarker(key, now);

    const result = await pullBoardAndRecord(
      deps.store,
      boardPath,
      key,
      {
        fetchTimeoutMs: opts.budgetMs ?? AUTO_PULL_BUDGET_MS,
        connectTimeoutSeconds: opts.connectTimeoutSeconds ?? AUTO_PULL_CONNECT_TIMEOUT_SECONDS,
      },
      now,
    );
    return result.refreshed ? "pulled" : "skipped";
  } catch {
    // The trigger is strictly best-effort: a read command must never fail — or even complain —
    // because a background freshness probe hit something unexpected.
    return "error";
  }
}
