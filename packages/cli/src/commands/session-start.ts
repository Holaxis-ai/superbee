import { renderUsage } from "../output.js";
import { detectBoardChannel } from "../board-runtime.js";
import { provisionBoardWorktree } from "../board-runtime.js";
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
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import path from "node:path";

import {
  bundleDirNameForProject,
  committedBundleAtHead,
  inTreeFetchAndRecord,
  provisionAnnouncement,
  repoTopLevel,
  resolveBundleKey,
  retargetBoardInterior,
  type ChannelDetection,
  type ProvisionOutcome,
} from "@superbee/board-git";
import { defaultSyncStore } from "../cursor.js";
import { pullBoardAndRecord } from "../autopull.js";
import { defaultSummarizeBundle, discoverSummarizeBundle, home, HOME_WORKSPACES_LIMIT, type BoardPullOutcome, type HomeWorkspace } from "./home.js";
import { loadCatalog } from "../catalog.js";
import { bundleHomeAt, lastFetch } from "../bundle-home.js";
import { findBundleRoot, resolveLocalBundleTarget } from "../bundle.js";
import { cliInvocation } from "../invocation.js";
import { commandFragment, commandLiteral, commandQuoted } from "../command-text.js";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { syncOutcomeLine } from "../sync-outcomes.js";
import { assertSearchDirOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { resolveLocalBundleRoute, resolveProjectBinding, type ResolvedLocalRoute } from "../bundle.js";
import { hostedAutoPullOptedOut, hostedCheckoutAt } from "../autopull.js";
import { CliError } from "../errors.js";
import { commandToken } from "../command-text.js";
import { render } from "../output.js";
import type { CheckoutBinding } from "../hosted/binding.js";
import { ageMs, backgroundSyncDeps, describeAge, readFreshness } from "../hosted/freshness.js";
import type { HostedPullResult, HostedSyncDeps } from "../hosted/sync.js";

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

The render also performs a local managed-Skill byte check. If a stale install passes the installer's
complete read-only preflight, it reports the exact refresh command and that the host must restart;
it never updates files itself.

Options:
  --dir <path>       Directory to run from (default: the cwd)
  --json             Emit stable compact JSON; suppress npm release display and refresh only
  --no-update-check  Disable cached update display and refresh for this run
  -h, --help         Show this help
`;

/**
 * What listing the other catalog bundles may add to a session start. Their homes come from private
 * state and local Git (a few short `git rev-parse` calls per Git board), never the network.
 */
export const SESSION_START_WORKSPACES_BUDGET_MS = 2_000;
/**
 * The probes' own deadline, under that budget: a Git probe is a blocking spawn that no timer can
 * cut short, so once this passes the remaining rows keep their label and are marked not checked,
 * and the block never falls back to "timed out".
 */
export const SESSION_START_PROBE_DEADLINE_MS = 1_000;

/** How current one other bundle's folder is, from its last pull or fetch. No network. */
async function bundleFreshness(root: string, userHome: string, now: Date): Promise<Pick<HomeWorkspace, "home" | "freshness">> {
  const facts = await bundleHomeAt(root, { home: userHome });
  if (facts.home === "hosted") {
    const age = ageMs((await readFreshness(userHome, facts.binding.checkout_id).catch(() => null))?.pulled_at ?? null, now);
    return { home: "hosted", freshness: age === null ? "never pulled" : `pulled ${describeAge(age)} ago` };
  }
  if (facts.home === "git") {
    if (!facts.board.shared) return { home: "git", freshness: "not shared yet" };
    const age = ageMs(await lastFetch(facts.board.top).catch(() => null), now);
    return { home: "git", freshness: age === null ? "never fetched" : `fetched ${describeAge(age)} ago` };
  }
  return { home: "local", freshness: "local only" };
}

/**
 * The catalog bundles other than the one this session is in, each with its home and how fresh it
 * is, so an agent knows what else exists and which copies are stale. The catalog, private state
 * and local Git only: nothing is pulled, and no path or id is shown (`catalog resolve` gives them).
 */
export async function otherCatalogBundles(
  currentRoot: string | null,
  options: { home?: string; signal?: AbortSignal; now?: Date; deadlineMs?: number } = {},
): Promise<HomeWorkspace[]> {
  const userHome = options.home ?? homedir();
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.deadlineMs ?? SESSION_START_PROBE_DEADLINE_MS);
  const current = currentRoot === null ? null : await realpath(currentRoot).catch(() => path.resolve(currentRoot));
  const entries = [...(await loadCatalog(userHome, options.signal)).entries].sort((a, b) => a.label.localeCompare(b.label));
  const others: { label: string; root: string }[] = [];
  for (const entry of entries) {
    const root = await realpath(entry.locator.path).catch(() => null);
    if (root !== null && root === current) continue;
    others.push({ label: entry.label, root: root ?? entry.locator.path });
  }
  const rows: HomeWorkspace[] = [];
  for (const [index, other] of others.entries()) {
    // Only the rows the block shows are probed; the rest are counted.
    if (index >= HOME_WORKSPACES_LIMIT || options.signal?.aborted || Date.now() >= deadline) {
      rows.push({ label: other.label, home: "unknown", freshness: "not checked" });
      continue;
    }
    let available = false;
    try {
      available = (await resolveLocalBundleTarget(other.root)).canonicalRoot === other.root;
    } catch {
      available = false;
    }
    rows.push({
      label: other.label,
      ...(available ? await bundleFreshness(other.root, userHome, now).catch(() => ({ home: "unknown", freshness: "unreadable" })) : { home: "unknown", freshness: "folder missing" }),
    });
  }
  return rows;
}

/** The bundle this session start renders, so the catalog listing can leave it out. Never throws. */
async function sessionBundleRoot(dir: string | undefined, known: string | undefined): Promise<string | null> {
  if (known !== undefined) return known;
  try {
    if (dir !== undefined) return (await findBundleRoot(path.resolve(dir))) ?? null;
    return (await resolveLocalBundleTarget(undefined)).canonicalRoot;
  } catch {
    return null;
  }
}

/** `ffPull` swallow reasons that mean "could not reach/verify the remote" → the offline note. */
const OFFLINE_REASONS = new Set(["network", "auth", "busy", "git-missing"]);

/** The same offline classes as {@link OFFLINE_REASONS}, in `BoardGitError.code` vocabulary (in-tree fetch). */
const OFFLINE_CODES = new Set(["TRANSIENT", "AUTH_REQUIRED", "GIT_BUSY", "GIT_MISSING"]);

/** How the session-start pull of a hosted checkout went. */
export type HostedSessionPull = "pulled" | "disabled" | "signed_out" | "offline" | "busy" | "failed";

/**
 * The session-start pull of a hosted checkout: one pull-only pass within the budget (never a
 * sign-in, never a send), reported as the `hosted_checkout` block after the home view. Opt out
 * with SUPERBEE_NO_AUTOPULL, which also stops the automatic pull on reads.
 */
export async function hostedSessionStartPull(
  binding: CheckoutBinding,
  budgetMs: number,
  deps: { env?: Record<string, string | undefined>; sync?: Partial<HostedSyncDeps>; pull?: (binding: CheckoutBinding, deps: Partial<HostedSyncDeps>) => Promise<HostedPullResult> } = {},
): Promise<Record<string, unknown>> {
  const home = deps.sync?.auth?.home ?? homedir();
  const state = await sessionPullState(binding, budgetMs, home, deps);
  const counts: Record<string, number> = typeof state === "object" ? state : {};
  const pulledAt = (await readFreshness(home, binding.checkout_id).catch(() => null))?.pulled_at ?? null;
  const sync = `${cliInvocation()} sync --dir ${commandToken(binding.path)}`;
  return {
    folder: binding.path,
    bundle_id: binding.bundle_id,
    host: binding.origin,
    pull: typeof state === "object" ? "pulled" : state,
    ...counts,
    last_pulled: pulledAt,
    note:
      state === "signed_out"
        ? "not signed in: run sync, and relay the sign-in link it returns"
        : state === "busy"
          ? "another superbee command is using this checkout, so it was not pulled; sync when it finishes"
          : typeof state === "object"
          ? "edit files here, then sync at the end of a batch of edits"
          : "showing the folder as last pulled; sync reports the full story",
    help: [sync],
  };
}

/**
 * The pull itself: never a sign-in (a dead or missing session is left for an explicit command),
 * and every request and lock bounded by the budget.
 */
async function sessionPullState(
  binding: CheckoutBinding,
  budgetMs: number,
  home: string,
  deps: { env?: Record<string, string | undefined>; sync?: Partial<HostedSyncDeps>; pull?: (binding: CheckoutBinding, deps: Partial<HostedSyncDeps>) => Promise<HostedPullResult> },
): Promise<Exclude<HostedSessionPull, "pulled"> | { refreshed: number; removed: number; kept_local_edits: number }> {
  if (hostedAutoPullOptedOut(deps.env ?? process.env)) return "disabled";
  try {
    const pullOnce = deps.pull ?? (await import("../hosted/sync.js")).hostedPull;
    const result = await pullOnce(binding, backgroundSyncDeps(deps.sync, home, Date.now() + budgetMs));
    if (result.state === "pulled") return { refreshed: result.refreshed, removed: result.removed, kept_local_edits: result.kept };
    return result.state === "busy" ? "busy" : "signed_out";
  } catch (error) {
    if (error instanceof CliError) return error.code === "AUTH_REQUIRED" ? "signed_out" : error.code === "TRANSIENT" ? "offline" : "failed";
    return "offline";
  }
}

/** Injectable seam for the fall-through tests. */
export interface SessionStartDeps {
  stdout: (s: string) => void;
  /** The pull step. Default: {@link sessionStartPull}. */
  pull: (dir: string | undefined, budgetMs: number) => Promise<BoardPullOutcome | undefined>;
  /** Pull budget override (tests shrink it). Default {@link SESSION_START_PULL_BUDGET_MS}. */
  budgetMs: number;
  /** Injected final renderer for argv-forwarding tests; production uses {@link home}. */
  renderHome: typeof home;
  /** The hosted checkout the run is in (default: found from --dir or the cwd). */
  hostedCheckout: (dir: string | undefined) => Promise<CheckoutBinding | null>;
  /** The hosted session-start pull (default {@link hostedSessionStartPull}). */
  hostedPull: (binding: CheckoutBinding, budgetMs: number) => Promise<Record<string, unknown>>;
  /** The other catalog bundles (default {@link otherCatalogBundles}). */
  otherBundles: (currentRoot: string | null, signal?: AbortSignal) => Promise<HomeWorkspace[]>;
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
    // A run directory that IS or lives INSIDE a guarded root has no board to pull, and must not be
    // silently replaced by one derived from an enclosing repo — the render owes the conflict, which
    // it can only report while `boardPath` stays undefined. The throw lands in this function's
    // fail-soft catch (its documented posture for every "could not verify the board" outcome).
    assertSearchDirOutsidePrivateState(path.resolve(dir ?? process.cwd()));
    const route: ResolvedLocalRoute | undefined = dir === undefined && await resolveProjectBinding(process.cwd())
      ? await resolveLocalBundleRoute(undefined)
      : undefined;
    if (route?.kind === "bound-board" && route.readiness !== "ready") return undefined;
    const owner = route?.kind === "bound-board" ? route.owner : undefined;
    const startDir = owner?.ownerRoot ?? (route?.kind === "bound-local" ? route.target.root : retargetBoardInterior(dir ?? process.cwd()));

    // A plain binding selects documents only. It cannot direct a session-start Git or state probe
    // at either its enclosing project or the invoking checkout.
    if (route?.kind === "bound-local") return undefined;

    // Budget guard at the first network boundary: retargetBoardInterior above
    // already spent local-git time, and a tiny/zero injected budget can be spent at entry — never
    // hand a decayed slice to the provision fetch. (The residual guard-to-spawn decay race is
    // closed at the runGitBytes floor — see the module header.)
    if (remaining() < MIN_USEFUL_BUDGET_MS) return { offline: true };

    if (owner) {
      // A bound session never classifies/provisions from the public checkout. The sole board
      // candidate, state key, and fetch cwd are the owner capability frozen above.
      await defaultSyncStore.refreshMarker(owner.stateKey);
      if (remaining() < MIN_USEFUL_BUDGET_MS) return { offline: true, boardPath: owner.bundleRoot };
      const pulled = await pullBoardAndRecord(owner.bundleRoot, owner.stateKey, {
        fetchTimeoutMs: remaining(),
        connectTimeoutSeconds: SESSION_START_CONNECT_TIMEOUT_SECONDS,
      });
      if (pulled.swallowed !== undefined) {
        return OFFLINE_REASONS.has(pulled.swallowed)
          ? { offline: true, boardPath: owner.bundleRoot }
          : { offline: false, boardPath: owner.bundleRoot, notes: [syncOutcomeLine("line.session-start.pull-skipped", { reason: pulled.swallowed, inv: cliInvocation() })] };
      }
      return { offline: false, refreshed: true, boardPath: owner.bundleRoot };
    }

    // CHANNEL DETECTION (board-git PR C), computed fresh at THIS pull's own resolution point.
    // Routing mirrors sync's: only a positively detected `in-tree` channel leaves today's flow —
    // `branch` continues into provisioning; `local-only` needs no board orientation, while
    // indeterminate discovery must survive into the render instead of suggesting creation.
    // A tracked-folder refusal arm (pre-share-window/dual-board)
    // thrown here lands in the same calm-render catch provisioning's own throw did.
    let detection: ChannelDetection;
    try {
      detection = detectBoardChannel(startDir, {
        budget: { fetchTimeoutMs: remaining(), connectTimeoutSeconds: SESSION_START_CONNECT_TIMEOUT_SECONDS },
      });
    } catch {
      return undefined;
    }
    if (detection.kind === "indeterminate") {
      const target = dir === undefined ? commandLiteral("") : commandFragment` --dir ${commandQuoted(dir)}`;
      return {
        offline: true,
        discoveryUnknown: `${detection.reason}; restore repository access or connectivity, then retry \`${cliInvocation()} session-start${target}\` before creating a bundle`,
      };
    }
    if (detection.channel.mode === "local-only") {
      return repoTopLevel(startDir) ? { offline: false, discoveryAbsent: true } : undefined;
    }
    if (detection.channel.mode === "in-tree") {
      const top = repoTopLevel(startDir);
      if (!top) return undefined;
      const bundleDir = committedBundleAtHead(top)?.bundleDir ?? bundleDirNameForProject(top);
      const boardPath = path.join(top, bundleDir);
      const key = resolveBundleKey(boardPath);
      // Marker refresh: every pull step that confirmed a board exists for this repo.
      await defaultSyncStore.refreshMarker(key);
      if (remaining() < MIN_USEFUL_BUDGET_MS) return { offline: true, boardPath };
      // The in-tree fetch-and-report step (NO merge/rebase/checkout — the working tree is never
      // touched; delivery is the user's own `git pull`). State discipline mirrors the branch
      // pull: cursor/cache rewritten only on a successful check; a dead remote degrades silently
      // into the offline note; the decision table's no-comparison-basis outcomes report nothing.
      const result = await inTreeFetchAndRecord(defaultSyncStore, top, key, bundleDir, {
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
        ensureIgnore: true,
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
    stdout(renderUsage(SESSION_START_USAGE));
    return;
  }

  const budgetMs = deps.budgetMs ?? SESSION_START_PULL_BUDGET_MS;
  const pull = deps.pull ?? sessionStartPull;
  const otherBundles = deps.otherBundles ?? ((root: string | null, signal?: AbortSignal) => otherCatalogBundles(root, signal ? { signal } : {}));
  // The catalog block lists the OTHER bundles, with their homes and freshness.
  const workspaceDeps = (currentRoot: Promise<string | null>) => ({
    loadWorkspaces: async (signal?: AbortSignal) => otherBundles(await currentRoot, signal),
    workspaceBudgetMs: SESSION_START_WORKSPACES_BUDGET_MS,
  });

  // A hosted checkout has no Git board: pull it from the host instead, then render home with a
  // settled board outcome (so home starts no pull of its own) and the hosted block after it.
  let hosted: CheckoutBinding | null = null;
  try {
    hosted = await (deps.hostedCheckout ?? ((d) => hostedCheckoutAt(d)))(values.dir);
  } catch {
    hosted = null;
  }
  if (hosted) {
    let block: Record<string, unknown>;
    try {
      block = await (deps.hostedPull ?? ((binding, budget) => hostedSessionStartPull(binding, budget)))(hosted, budgetMs);
    } catch {
      block = { folder: hosted.path, pull: "failed" };
    }
    const captured: string[] = [];
    const homeArgv: string[] = [];
    if (values.dir !== undefined) homeArgv.push("--dir", values.dir);
    if (values.json) homeArgv.push("--json");
    if (values["no-update-check"]) homeArgv.push("--no-update-check");
    await (deps.renderHome ?? home)(homeArgv, {
      stdout: (text) => void captured.push(text),
      boardPull: { offline: false },
      ...workspaceDeps(Promise.resolve(hosted.path)),
    });
    const rendered = captured.join("");
    if (values.json) {
      let view: unknown;
      try {
        view = JSON.parse(rendered);
      } catch {
        view = undefined;
      }
      stdout(view && typeof view === "object" && !Array.isArray(view) ? `${JSON.stringify({ ...view, hosted_checkout: block })}\n` : rendered);
    } else {
      stdout(`${rendered}${rendered.endsWith("\n") || rendered === "" ? "" : "\n"}${render({ hosted_checkout: block }, "default")}`);
    }
    return;
  }

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
  // the conventional bundle directory, the in-tree/window shape) → home's normal DISCOVERY walk,
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
    ...workspaceDeps(sessionBundleRoot(projectDir, boardPath)),
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
