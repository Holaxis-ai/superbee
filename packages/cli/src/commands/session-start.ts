// `superbee session-start` — the SessionStart hook payload.
//
// One subcommand, pull-then-render in-process — never two hook entries or a compound shell string:
//
//   1. a TIME-BOXED, best-effort board pull ({@link sessionStartPull}): provision the board
//      worktree if needed (loud, per the board-branch-sync rider-2 announcements) → fetch →
//      ff-only merge `origin/board` → write the awareness cache + advance the cursor + refresh
//      the board-pending marker;
//   2. THEN the home render, in-process, fs-only — home's own offline guarantee untouched.
//
// TIME BOX (pull budget ≤ 7s total, connect ≤ 5s, under the 10s hook timeout). The
// enforcement is layered:
//   • every network-touching git op gets `timeoutMs` = the REMAINING budget (spawnSync's kill is
//     the hard stop — a hung fetch dies inside the budget, whatever the transport is doing), and
//     ssh ConnectTimeout is lowered to 5s so a black-holed ssh host fails faster still;
//   • the command layer ADDITIONALLY races the whole pull step against the budget
//     ({@link sessionStart}), so even a misbehaving injected/async pull can never delay the
//     render — the GUARANTEED fall-through. (The default pull runs synchronous git and is bounded
//     by the per-op kills; the race is the belt to that suspenders.)
// A pull that loses its time box is ABANDONED (its in-flight git op is killed); this run renders
// the last-known cache with the pinned offline note, and the NEXT session's pull refreshes it.
//
// Budget floor and local-op contract:
//   • Every NETWORK boundary (the provision fetch, ffPull's fetch) is double-protected: a
//     {@link MIN_USEFUL_BUDGET_MS} guard immediately before the op takes the offline path when
//     the budget is effectively spent, AND git.ts's runGitBytes chokepoint treats a non-positive
//     `timeoutMs` as an IMMEDIATE fired timeout without spawning — because Node's spawnSync
//     treats `timeout: 0` as NO timeout, a slice that decays to 0 in the guard-to-spawn gap
//     (local ops run between the check and the spawn) would otherwise hang unpreemptably.
//   • LOCAL ops are deliberately NOT budget-sliced: rev-parse/status/symbolic-ref, the ff-only
//     merge of already-fetched objects, and state-file reads ride git.ts's LOCAL_TIMEOUT (30s)
//     unbudgeted. Realistic latency is milliseconds; slicing them would turn a slow-but-
//     succeeding local op into a spurious failure. The accepted residual: a pathological
//     filesystem stall can exceed the 10s hook window, in which case the hook harness kills the
//     render (the session is unharmed). Recorded on tasks/sync-sessionstart.
//
// FAIL-SOFT MATRIX: every failure — no repo, no board, provisioning refusal, offline fetch, auth,
// a held lock, a missing git binary, a thrown anything — is swallowed into the render. This
// command NEVER exits nonzero for board reasons and the render ALWAYS appears (test-pinned).
// Network-unreachable classes render the pinned "board sync offline — showing last known state"
// note; local-state classes (diverged, dirty, conflict…) render an honest pointer at `sync`,
// which reports the full story with real exit codes.
//
// STATE DISCIPLINE (test-pinned): the CURSOR advances only on a SUCCESSFUL pull; the MARKER is
// refreshed by every pull step that confirmed a provisioned board; the cache is written only on a
// successful pull (mirroring sync's step 5 — the render's backstop counts are computed LIVE by
// home's board probe, so they stay honest even when the network pull failed). The pull-and-record
// step itself is SHARED, not owned here: autopull.ts's `pullBoardAndRecord` (extracted from this
// command) is the ONE code path both this hook and the opportunistic read-command trigger use —
// do not fork the state-write discipline back into either caller.
import { parseArgs } from "node:util";
import path from "node:path";

import {
  BUNDLE_DIR,
  detectBoardChannel,
  inTreeFetchAndRecord,
  provisionAnnouncement,
  provisionBoardWorktree,
  repoTopLevel,
  resolveBundleKey,
  retargetBoardInterior,
  type ChannelDetection,
  type ProvisionOutcome,
} from "@superbee/board-git";
import { defaultSyncStore } from "../cursor.js";
import { pullBoardAndRecord } from "../autopull.js";
import { defaultSummarizeBundle, discoverSummarizeBundle, home, type BoardPullOutcome } from "./home.js";
import { cliInvocation } from "../invocation.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { syncOutcomeLine } from "../sync-outcomes.js";

/** Pull budget: ≤ 7s total, under hook.ts's 10s HOOK_TIMEOUT_SECONDS. */
export const SESSION_START_PULL_BUDGET_MS = 7_000;
/** ssh connect budget: ≤ 5s. */
export const SESSION_START_CONNECT_TIMEOUT_SECONDS = 5;
/**
 * The explicit budget floor: below this remaining budget, EVERY network boundary (the provision
 * fetch and ffPull's fetch — both guarded) takes the offline path outright instead of spawning
 * with a decayed slice. See the module header's BUDGET FLOOR contract; the runGitBytes
 * non-positive-timeout floor closes the residual guard-to-spawn decay race.
 */
export const MIN_USEFUL_BUDGET_MS = 250;

export const SESSION_START_USAGE = `superbee session-start — the SessionStart hook payload (pull the board, then render home)

Usage:
  superbee session-start [--dir <path>] [--json] [--no-update-check]

Runs a time-boxed, best-effort pull of this repo's shared board (provisioning the checkout from
origin/board on a fresh clone — announced, never silent), then renders the home view with registered
workspace orientation and the board-awareness block: what changed since this machine last synced,
attributed per teammate, plus the unpushed/uncommitted backstop. Every pull failure — offline, auth,
a busy repo, a lost time box — falls through to the render (exit 0): you always get the last known
state, honestly labeled.

This is the command \`hook install\` wires as the SessionStart hook for Claude Code, Codex, and
OpenCode. Run it directly to see exactly what a new session will see.

Default TOON may show a cached latest-track release notice and launch one detached refresh per
24-hour attempt window; rendering never waits for npm. The fixed public request names only
superbee and sends no installed version, cwd, bundle, actor, or usage data beyond ordinary
network metadata. Presence of SUPERBEE_NO_UPDATE_CHECK, legacy ASLITE_NO_UPDATE_CHECK,
NO_UPDATE_NOTIFIER, or CI disables both display and refresh.

Options:
  --dir <path>       Directory to run from (default: the cwd)
  --json             Emit stable compact JSON; no update display or refresh work
  --no-update-check  Disable cached update display and refresh for this run
  -h, --help         Show this help
`;

/** `ffPull` swallow reasons that mean "could not reach/verify the remote" → the offline note. */
const OFFLINE_REASONS = new Set(["network", "auth", "busy", "git-missing"]);

/** The same offline classes as {@link OFFLINE_REASONS}, in `BoardGitError.code` vocabulary (in-tree fetch). */
const OFFLINE_CODES = new Set(["TRANSIENT", "AUTH_REQUIRED", "GIT_BUSY", "GIT_MISSING"]);

/** Injectable seam for the fall-through tests. */
export interface SessionStartDeps {
  stdout: (s: string) => void;
  /** The pull step. Default: {@link sessionStartPull}. */
  pull: (dir: string | undefined, budgetMs: number) => Promise<BoardPullOutcome | undefined>;
  /** Pull budget override (tests shrink it). Default {@link SESSION_START_PULL_BUDGET_MS}. */
  budgetMs: number;
  /** Injected final renderer for argv-forwarding tests; production uses {@link home}. */
  renderHome: typeof home;
}

/**
 * The pull step: provision → ff-pull → state writes, all inside `budgetMs`. Returns the
 * {@link BoardPullOutcome} the render consumes, or `undefined` when there is no board in play
 * (no repo / no board anywhere / provisioning refused — home's own probe-gated first-contact
 * logic covers those renders). NEVER throws.
 */
export async function sessionStartPull(
  dir: string | undefined,
  budgetMs: number = SESSION_START_PULL_BUDGET_MS,
  now: () => number = Date.now,
): Promise<BoardPullOutcome | undefined> {
  const deadline = now() + budgetMs;
  const remaining = () => Math.max(0, deadline - now());
  try {
    const startDir = retargetBoardInterior(dir ?? process.cwd());

    // Budget guard at the first network boundary: retargetBoardInterior above
    // already spent local-git time, and a tiny/zero injected budget can be spent at entry — never
    // hand a decayed slice to the provision fetch. (The residual guard-to-spawn decay race is
    // closed at the runGitBytes floor — see the module header.)
    if (remaining() < MIN_USEFUL_BUDGET_MS) return { offline: true };

    // CHANNEL DETECTION (board-git PR C), computed fresh at THIS pull's own resolution point.
    // Routing mirrors sync's: only a positively detected `in-tree` channel leaves today's flow —
    // `branch` continues into the provisioning path below unchanged; `local-only` and the
    // fail-closed `indeterminate` outcome return undefined exactly where provisioning's
    // no_repo/no_board outcomes did; a tracked-folder refusal arm (pre-share-window/dual-board)
    // thrown here lands in the same calm-render catch provisioning's own throw did.
    let detection: ChannelDetection;
    try {
      detection = detectBoardChannel(startDir, {
        budget: { fetchTimeoutMs: remaining(), connectTimeoutSeconds: SESSION_START_CONNECT_TIMEOUT_SECONDS },
      });
    } catch {
      return undefined;
    }
    if (detection.kind === "indeterminate") return undefined;
    if (detection.channel.mode === "local-only") return undefined;
    if (detection.channel.mode === "in-tree") {
      const top = repoTopLevel(startDir);
      if (!top) return undefined;
      const boardPath = path.join(top, BUNDLE_DIR);
      const key = resolveBundleKey(boardPath);
      // Marker refresh: every pull step that confirmed a board exists for this repo.
      await defaultSyncStore.refreshMarker(key);
      if (remaining() < MIN_USEFUL_BUDGET_MS) return { offline: true, boardPath };
      // The in-tree fetch-and-report step (NO merge/rebase/checkout — the working tree is never
      // touched; delivery is the user's own `git pull`). State discipline mirrors the branch
      // pull: cursor/cache rewritten only on a successful check; a dead remote degrades silently
      // into the offline note; the decision table's no-comparison-basis outcomes report nothing.
      const result = await inTreeFetchAndRecord(defaultSyncStore, top, key, {
        fetchTimeoutMs: remaining(),
        connectTimeoutSeconds: SESSION_START_CONNECT_TIMEOUT_SECONDS,
      });
      if (result.state === "refreshed") return { offline: false, refreshed: true, boardPath };
      if (result.state === "fetch-failed") {
        if (OFFLINE_CODES.has(result.failure.code)) return { offline: true, boardPath };
        return {
          offline: false,
          boardPath,
          notes: [
            syncOutcomeLine("line.session-start.fetch-skipped", { code: result.failure.code, inv: cliInvocation() }),
          ],
        };
      }
      return { offline: false, boardPath };
    }

    // Provision if needed (self-healing first contact — sync's own step 1, detection-gated inside
    // provisionBoardWorktree: it probes origin/board and only then materializes the worktree).
    let outcome: ProvisionOutcome;
    try {
      outcome = provisionBoardWorktree(startDir, {
        fetchTimeoutMs: remaining(),
        connectTimeoutSeconds: SESSION_START_CONNECT_TIMEOUT_SECONDS,
        allowLocalBranch: false,
      });
    } catch {
      // Provisioning refused (a stray non-board directory, unrepairable pointers, …): the render's
      // probe-gated first-contact line points at `sync`, which reports the full refusal guidance
      // with real exit codes — this hook stays calm and renders.
      return undefined;
    }
    if (outcome.kind === "no_repo" || outcome.kind === "no_board" || outcome.kind === "local_board") return undefined;
    const boardPath = outcome.boardPath;
    const announcement = provisionAnnouncement(outcome);

    const key = resolveBundleKey(boardPath);
    // Marker refresh: EVERY pull step that confirmed a provisioned board, regardless of
    // how the network half goes below.
    await defaultSyncStore.refreshMarker(key);

    if (remaining() < MIN_USEFUL_BUDGET_MS) {
      return { offline: true, boardPath, ...(announcement ? { announcement } : {}) };
    }

    // THE shared pull-and-record step (autopull.ts's `pullBoardAndRecord` — extracted from this
    // command so the opportunistic read-command trigger shares ONE state-write discipline): ff-only
    // pull; on success the cursor advances to the post-pull HEAD and the cache is rewritten
    // (mirroring sync's step 5, with an honest re-anchor on a dangling cursor); a swallowed pull
    // writes NOTHING ("cursor advanced only on a successful pull").
    const pulled = await pullBoardAndRecord(boardPath, key, {
      fetchTimeoutMs: remaining(),
      connectTimeoutSeconds: SESSION_START_CONNECT_TIMEOUT_SECONDS,
    });
    if (pulled.swallowed !== undefined) {
      // Offline-class reasons get the pinned note; local-state classes get an honest pointer at
      // the interactive verb.
      if (OFFLINE_REASONS.has(pulled.swallowed)) {
        return { offline: true, boardPath, ...(announcement ? { announcement } : {}) };
      }
      return {
        offline: false,
        boardPath,
        ...(announcement ? { announcement } : {}),
        notes: [syncOutcomeLine("line.session-start.pull-skipped", { reason: pulled.swallowed, inv: cliInvocation() })],
      };
    }
    // The ONE outcome that rewrote the cache — the render may skip its as_of freshness label.
    return { offline: false, refreshed: true, boardPath, ...(announcement ? { announcement } : {}) };
  } catch {
    // The last defense of the fail-soft matrix: an unexpected throw means this run could not
    // verify the board's currency — render the last-known state with the offline note. (The note
    // only ever renders next to a REAL provisioned board: home's probe returning null/unprovisioned
    // ignores the pull outcome's offline flag.)
    return { offline: true };
  }
}

/**
 * CLI entry: time-boxed pull, then the home render IN-PROCESS — the render appears no matter what
 * the pull did (fall-through is test-pinned). Exit 0 in every board state; only a usage error
 * (unknown flag) exits nonzero, matching every other command's argv contract.
 */
export async function sessionStart(argv: string[], deps: Partial<SessionStartDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));

  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          dir: { type: "string" },
          json: { type: "boolean" },
          "no-update-check": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.sessionStart,
  );
  if (values.help) {
    stdout(SESSION_START_USAGE);
    return;
  }

  const budgetMs = deps.budgetMs ?? SESSION_START_PULL_BUDGET_MS;
  const pull = deps.pull ?? sessionStartPull;

  // The belt to the pull step's internal per-op suspenders: race the WHOLE pull against the
  // budget, so even a pull that hangs in ways the per-op kills can't see (an injected async dep,
  // an unforeseen await) never delays the render. A losing pull keeps running detached within
  // this process (harmless: its state writes are atomic and next session reads them) — its
  // rejection is swallowed so it can never surface later.
  let timer: NodeJS.Timeout | undefined;
  let outcome: BoardPullOutcome | undefined;
  try {
    const raced = await Promise.race<BoardPullOutcome | undefined | "timeout">([
      Promise.resolve()
        .then(() => pull(values.dir, budgetMs))
        .catch((): BoardPullOutcome => ({ offline: true })),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), budgetMs);
      }),
    ]);
    outcome = raced === "timeout" ? { offline: true } : raced;
  } catch {
    outcome = { offline: true };
  } finally {
    if (timer) clearTimeout(timer);
  }

  // GUARANTEED fall-through: the home render, in-process. home itself never throws; its optional
  // update orientation is cached local work plus a detached child and never extends this budget.
  //
  // `--dir` SEMANTICS BRIDGE: this verb's `--dir` names the directory to run from and may be
  // nested inside a project; home's explicit resolution never walks upward to select an ancestor.
  // So with an explicit --dir the dashboard's summarizer is redirected: board resolved →
  // summarize the BOARD bundle itself; no board (a boardless project with a committed
  // `.agentstate-lite/`, the in-tree/window shape) → home's normal DISCOVERY walk,
  // started from the given dir instead of the cwd. A bare (cwd) invocation — the installed
  // hook's shape — keeps home's byte-identical conventional discovery.
  const homeArgv: string[] = [];
  if (values.dir !== undefined) homeArgv.push("--dir", values.dir);
  if (values.json) homeArgv.push("--json");
  if (values["no-update-check"]) homeArgv.push("--no-update-check");
  const boardPath = outcome?.boardPath;
  const projectDir = values.dir;
  await (deps.renderHome ?? home)(homeArgv, {
    stdout,
    // ALWAYS a defined boardPull — session-start IS the pull step, so home's own opportunistic
    // trigger must never run under it. A pull that resolved to `undefined`
    // (no repo / no board anywhere / provisioning refused or threw) is handed to home as a plain
    // non-refreshing outcome: home's render ignores the offline flag unless a REAL provisioned
    // board is probed (buildBoardBlock's own contract), so the render is unchanged — but a fresh
    // network pull outside this command's budget race is now structurally impossible.
    boardPull: outcome ?? { offline: true },
    ...(projectDir !== undefined
      ? {
          summarizeBundle: () =>
            boardPath !== undefined
              ? defaultSummarizeBundle(boardPath)
              : discoverSummarizeBundle(projectDir),
        }
      : {}),
  });
}
