// `superbee sync` — the entry flow, composed of explicit phases:
// heal → detect → provision → commit → pull → push → receipt (`--pull-only` skips commit + push).
//
// COMMAND LAYER ONLY: this module composes `@superbee/board-git`'s exported vocabulary
// plus the CLI's store wiring (`cursor.ts`), never re-implementing git plumbing or the
// state-store schema. It keeps COMMAND UX: arg parsing, envelopes, help text, and the git tier's
// CLI command boundary (BoardGitError → CliError, see `sync()`).
//
// TWO CALLERS, ONE `ffPull` PRIMITIVE, DIFFERENT TOLERANCE: `ffPull` is deliberately
// fail-soft for the SessionStart caller. `--pull-only` is an interactive verb that must report a
// REAL structured outcome, so `ffSwallowToError` translates every swallowed reason into the
// capped CliError taxonomy instead of silently no-op'ing.
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BOARD_BRANCH,
  BOARD_REMOTE,
  BUNDLE_DIR,
  bundleDirNameForProject,
  committedBundleAtHead,
  changesSince,
  countUncommitted,
  currentHead,
  detectBoardChannel,
  fetchRebaseResolving,
  ffPull,
  hasLocalOnlyBundle,
  healStaleRebaseBeforeProvisioning,
  inTreeFetchAndRecord,
  isBoardGitError,
  originDocsBetween,
  provisionBoardWorktree,
  push,
  repoTopLevel,
  resolveBundleKey,
  resolveOriginRef,
  retargetBoardInterior,
  runGit,
  stageAndCommit,
  unpushedCount,
  type CommitResult,
  type DocChange,
  type FetchRebaseResolvingOutcome,
  type ProvisionOutcome,
  type SyncCursor,
} from "@superbee/board-git";
import { REANCHOR_NOTE, defaultSyncStore } from "../../cursor.js";
import { hookInstallHintOnce, type SyncCliDeps } from "../../sync-cli.js";
import { ESTABLISH_ALREADY, establishBoard } from "./establish.js";
import {
  buildConvergeError,
  buildPushFailurePartial,
  buildSyncReceipt,
  cap,
  pushFailureMessage,
  throwPostCommitFailure,
  toCliError,
  toIncomingRows,
  withProvisionAnnouncement,
  withUpstreamHelp,
  writeAwarenessCache,
} from "./converge.js";
import { showIncoming } from "./show-incoming.js";
import { ffSwallowToError, syncOutcomeError, syncOutcomeLine } from "../../sync-outcomes.js";
import { CliError, asHandled, cliErrorFromBoardGit } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, resolveMode, type OutputMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import {
  assertBundleOutsidePrivateState,
  assertSearchDirOutsidePrivateState,
} from "../../private-state-bundle-boundary.js";
import { resolveLocalBundleTarget, resolveProjectBinding } from "../../bundle.js";
import { validateBoundBoardOwner, type BoundBoardOwner } from "../../bound-board-owner.js";

export const SYNC_USAGE = `superbee sync — share the board branch with a remote (git tier)

Usage:
  superbee sync [--pull-only] [--dir <path>] [--limit <n>] [--json]
  superbee sync --establish [--yes] [--dir <path>] [--json]
  superbee sync --show-incoming <id> [--out <file>] [--dir <path>] [--json]

Shares this repo's board (\`.superbee\`, or an existing legacy \`.agentstate-lite\`, kept on its own \`board\` branch) with your
teammates: ordinary sync commits pending local doc changes, pulls theirs, and pushes yours without
touching code files. The one-time \`--establish\` transition also appends the board path to the
root working-tree \`.gitignore\` and reports that edit. \`--pull-only\` skips commit + push and
only fast-forwards from origin
(never rebases) — the mode a read-only session uses to pick up incoming changes without
publishing local ones.

\`init\` creates a LOCAL bundle; sharing it is a separate, explicit act. \`sync --establish\` turns
this project's local \`.superbee/\` (or legacy \`.agentstate-lite/\`) into the shared board: it snapshots and publishes the
bundle, then checks out the new \`board\` branch at the same path — never automatic, never inferred
from a bare \`sync\` (which never publishes a bundle nobody has chosen to share). Once established
(here or by a teammate), plain \`sync\` is everyone's setup AND ongoing verb: on a project that
already shares a board, it provisions the local checkout, then commits, pulls, and pushes ordinary
board changes.
\`--establish\` on an already-established project is a safe no-op that notes \`already established\`
and proceeds as an ordinary sync.

On a repo that has never had the board checkout materialized locally (a fresh clone, or the first
\`superbee\` invocation after one), sync provisions \`.superbee\` itself from \`origin/board\` —
never silently: the receipt carries a \`provisioned: <path>\` line. If the checkout already exists
but its pointers went stale (e.g. it was moved or remounted at a different path), sync self-heals
it via \`git worktree repair\` and reports \`repaired: <path>\` the same way — a repair is a git
mutation too, and both lines appear even on an otherwise-empty run.

Three definitive empty states (exit 0): an ordinary directory with no git repo — or a repo with
neither a board branch nor a bundle — prints 'sync: nothing to sync' (a run directory inside
Superbee's private user-state root is a CONFLICT, never an empty state); a repo whose bundle is
known to have no board branch anywhere is a LOCAL-ONLY board; a clean shared board prints 'sync: already up to date'. If origin
cannot be checked and no board ref is available, sync reports the shared-board state as unknown
and recommends retrying when origin is reachable.
Otherwise the receipt reports { committed, pushed, pulled, actor, incoming } — \`incoming\` is the
enriched delta of docs that arrived this run (capped; --limit controls the row cap, default 20).

When a doc changed on BOTH sides, sync CONVERGES: your teammate's version is kept on the board,
YOUR version is saved to an export file named in the receipt, and the sync completes (the
board is never left mid-state; non-conflicted local changes still land). The run exits 5 with
one row per conflicted doc and the reconcile chain: \`sync --show-incoming <id>\` to view the kept
incoming version, \`doc update <id> --body-file <export-file>\` to write your merged version on
top, then \`sync\` again to share it.

\`sync --show-incoming <id>\` prints the board's incoming (upstream) version of one doc — the
state of \`origin/board\` as of the last fetch (it never fetches). Full doc-read semantics: large
bodies truncate and point at \`--out <file>\` (raw bytes to disk); \`--out -\` streams the raw
bytes to stdout with the receipt (or any error envelope) on stderr. A doc absent upstream renders
as an expected state, not an error.

If the push fails after a local commit already landed (offline, revoked/expired credentials, or a
locked repository), the receipt still reports what committed/pulled successfully — your work is
saved locally either way, and re-running sync retries the push.

A board can also ride IN-TREE: \`.superbee/\` or legacy \`.agentstate-lite/\` committed WITH the code on the current
branch, with no dedicated \`board\` branch anywhere. That is a supported, read-side mode — sync
recognizes it and behaves accordingly: \`sync --pull-only\` fetches the branch's own tracking
upstream and reports incoming board doc changes (your normal \`git pull\` delivers them);
\`session-start\`/\`home\` show the same upstream awareness; \`--show-incoming <id>\` reads the
upstream version. Sharing YOUR board changes rides your normal commit/push — a full \`sync\`
refuses (it would have to publish the code branch itself) and \`sync --establish\` remains the
explicit conversion to a dedicated \`board\` branch. If the branch has no upstream (or a detached
HEAD), in-tree awareness honestly reports that there is no comparison basis rather than guessing.

Board-READING commands (\`list\`, \`doc read\`, \`status\`, \`home\`, \`link show\`) also keep a
provisioned board fresh opportunistically: when the board's awareness state is older than ~5
minutes, the read first runs the same fast-forward-only pull \`--pull-only\` uses (time-boxed to
~2s; never a rebase, never provisioning, silent on any failure) and then serves fresh state — so
the board checkout's HEAD can advance after a plain \`list\`. Reads never auto-push; sharing YOUR
changes is always this verb. Set SUPERBEE_NO_AUTOPULL to any non-empty value to disable the
auto-pull (note: "0" disables it too — the variable's PRESENCE is the switch) for CI or scripted
runs that must never touch the network. Legacy AGENTSTATE_LITE_NO_AUTOPULL remains supported.

\`--establish\` also handles the project whose \`.superbee/\` or legacy \`.agentstate-lite/\` folder is ALREADY COMMITTED
on the current branch: it creates the \`board\` branch carrying the folder's CURRENT files (files
only — the folder's history stays where it is), pushes it to origin with tracking, and prepares
ONE local commit on a new \`board-cleanup\` branch that removes the folder from the current branch
and gitignores it — you push that branch and open the PR yourself; nothing on the current branch
is pushed or changed. Until that PR merges the old committed folder is a frozen snapshot: sync no
longer updates it, so treat it as read-only. Without \`--yes\`, the committed case prints a
preview (a dry run, including the rollout note to send teammates) and changes nothing. It refuses
while the selected bundle folder has uncommitted changes, when the current branch is behind origin on
commits touching the folder (pull first — a teammate's board commit must never be stranded on
the frozen copy), when origin is unreachable (the freshness check and the push both need it),
and when any \`board/...\` branch exists locally or on the remote (git cannot create a \`board\`
branch alongside them). It reports 'already established' (exit 0) once a board branch exists on
origin — with state-aware guidance, including re-creating the folder-removal commit when an
interrupted run left it missing. Coordinate first: every board writer syncs (at minimum commits)
their board work before anyone establishes.

Two edge states are ACCEPTED rather than auto-resolved. (1) On a case-insensitive filesystem, a
committed folder whose name differs from \`.superbee\` only by case (a state this CLI never
creates) can misroute establishment — rename it to the exact lowercase spelling first. (2) Deleting
the remote \`board\` branch in the middle of the both-worlds window (a deliberate, destructive,
out-of-band act) leaves the prepared cleanup PR pointing at a board that no longer exists — do not
merge that PR; re-run \`sync --establish\` to publish the board again first.

Options:
  --pull-only          Only fast-forward from origin (never rebase); skip commit + push
  --establish          Explicitly publish this project's bundle as its shared board (a folder
                       already committed on the branch is handled too — preview first)
  --yes                Execute the committed-folder establishment (without it, that case prints
                       a preview and changes nothing; the uncommitted case never needs it)
  --show-incoming <id> Print the upstream (origin/board) version of one doc, as of the last fetch
  --out <file>         With --show-incoming: write the raw bytes to <file> ('-' = raw to stdout)
  --dir <path>         Directory to run sync from (default: the cwd) — must be inside a git repo
  --limit <n>          Cap the incoming-delta row list to <n> rows (default: 20; 0 = unlimited)
  --json               Emit compact JSON instead of TOON
  -h, --help           Show this help
`;

/** AXI list-cap default: 20 rows unless `--limit` overrides it (0 = unlimited). */
const DEFAULT_LIMIT = 20;

/** The bundle exists locally and origin was successfully checked for a shared board. */
export const SYNC_LOCAL_ONLY_MESSAGE =
  "local-only board — no shared board branch exists, so there is nothing to pull or push";

export function syncLocalOnlyNote(inv: string): string {
  return (
    "a supported mode: every local command works, and your board changes stay on this machine " +
    `(sync committed nothing). To share the board with teammates, run \`${inv} sync --establish\` ` +
    "— it publishes the board as a 'board' branch on the repo's 'origin' remote (add one first " +
    "if the repo has none); teammates then just run sync."
  );
}

export const SYNC_REMOTE_STATE_UNKNOWN_MESSAGE =
  "shared board state unknown — origin could not be checked, so sync cannot tell whether a remote board exists";

export function syncRemoteStateUnknownNote(inv: string, hasLocalBundle: boolean): string {
  const local = hasLocalBundle
    ? "your local bundle remains usable and sync committed nothing. "
    : "sync changed nothing. ";
  return local + `Retry \`${inv} sync\` when origin is available; a shared board may already exist.`;
}

// ── the in-tree board (read-side mode) ─────────────────────────────────────────

/** The in-tree board's one-line identity, naming the actual recognized conventional directory. */
export function syncInTreeBoardLine(bundleDir: string): string {
  return `in-tree — board docs ride the current code branch (${bundleDir}/ is committed with the code)`;
}
export const SYNC_IN_TREE_BOARD_LINE = syncInTreeBoardLine(BUNDLE_DIR);

/** The explicit "no comparison basis" state (upstream decision table: report nothing, honestly). */
export const SYNC_IN_TREE_NO_BASIS = "no-comparison-basis";

/**
 * "N incoming board changes not yet in this checkout — run 'git pull' to get them" — the receipt's
 * own rendering of the same template home's `inTreePullHintLine` uses, kept as ONE row
 * (`line.home.in-tree.pull-hint`) and looked up from both sites.
 */
export function inTreePullHint(behind: number): string {
  return syncOutcomeLine("line.home.in-tree.pull-hint", { n: behind });
}

/** The in-tree `--pull-only` up-to-date state (nothing upstream this checkout lacks). */
export const SYNC_IN_TREE_CURRENT = "checkout is current with upstream";

// ── the phase inputs/results ──────────────────────────────────────────────────

/** The per-run inputs every phase shares, assembled once by {@link syncCommand}. */
interface SyncRun {
  dir: string; inv: string; mode: OutputMode; limit: number; pullOnly: boolean;
  stdout: (s: string) => void; deps: Partial<SyncCliDeps>;
  owner?: BoundBoardOwner;
}

/** The arg-parse phase's dispatch decision. */
type SyncDispatch =
  | { kind: "help" }
  | { kind: "show-incoming"; id: string; values: { out?: string; dir?: string; json?: boolean }; owner?: BoundBoardOwner }
  | { kind: "run"; options: Pick<SyncRun, "dir" | "mode" | "limit" | "pullOnly" | "owner">; establish: boolean; yes: boolean };

/** The provision phase's result: the board checkout this run operates on. */
interface SyncBoard { boardPath: string; key: string; outcome: ProvisionOutcome }

/** Pre-pull baselines: the stored cursor and the refs captured BEFORE this run's commit/fetch. */
interface SyncBaseline { storedCursor: SyncCursor | null; startHead: string; preFetchOriginRef: string | null }

/** The pull's two feeds: the receipt's origin-only delta and the cache's cursor-based delta. */
interface SyncDelta { originDelta: DocChange[]; changes: DocChange[]; reanchorNote?: string }

/**
 * The in-tree sync flow: full sync REFUSES with truthful guidance (structured, `details.state:
 * "in-tree"` — consumers discriminate on the state, never the code alone); `--pull-only` degrades
 * to FETCH-AND-REPORT — the same `inTreeFetchAndRecord` step session-start budgets, here with the
 * interactive posture (a failed fetch throws its classified error instead of degrading silently).
 * Delivery is always the user's own `git pull`; the working tree is never touched on any path.
 */
async function syncInTree(run: SyncRun): Promise<void> {
  const top = repoTopLevel(run.dir);
  if (!top) throw new CliError("RUNTIME", "not inside a git repository");
  const bundleDir = committedBundleAtHead(top)?.bundleDir ?? bundleDirNameForProject(top);
  const boardPath = path.join(top, bundleDir);
  assertBundleOutsidePrivateState(boardPath);

  if (!run.pullOnly) {
    const hasOrigin = runGit(top, ["remote", "get-url", BOARD_REMOTE]).status === 0;
    throw syncOutcomeError("in-tree.sync-refusal", { inv: run.inv, boardPath, hasOrigin });
  }

  const key = resolveBundleKey(boardPath);
  // A confirmed board exists for this repo — same marker contract as the branch-mode pull steps.
  await defaultSyncStore.refreshMarker(key);

  const result = await inTreeFetchAndRecord(defaultSyncStore, top, key, bundleDir);
  if (result.state === "fetch-failed") throw result.failure; // classified; maps at the boundary

  const rec: Record<string, unknown> = { board: syncInTreeBoardLine(bundleDir) };
  if (result.state === "no-upstream") {
    rec.state = SYNC_IN_TREE_NO_BASIS;
    rec.note = syncOutcomeLine("line.in-tree.no-basis", { reason: result.reason });
  } else if (result.state === "unusable-upstream") {
    rec.state = SYNC_IN_TREE_NO_BASIS;
    rec.note = syncOutcomeLine("line.in-tree.no-basis", { reason: "unusable-upstream", ref: result.ref });
  } else {
    rec.upstream = result.upstreamRef;
    rec.incoming = cap(toIncomingRows(result.changes), run.limit);
    const notes: string[] = [];
    if (result.reanchored) notes.push(REANCHOR_NOTE);
    notes.push(result.behind > 0 ? inTreePullHint(result.behind) : SYNC_IN_TREE_CURRENT);
    rec.note = notes.join("; ");
  }
  const hookHint = await hookInstallHintOnce(key, run.inv, run.deps.hookInstalled);
  if (hookHint) rec.hint = hookHint;
  run.stdout(render(rec, run.mode));
}

/**
 * The sync command entry — and the git tier's CLI COMMAND BOUNDARY: any typed `BoardGitError`
 * that reaches this edge maps through THE one `cliErrorFromBoardGit` layer, so callers (the bin
 * wrapper, tests) always observe `CliError` with the exact envelope/exit the tier produced.
 */
export async function sync(argv: string[], deps: Partial<SyncCliDeps> = {}): Promise<void> {
  try {
    await syncCommand(argv, deps);
  } catch (err) {
    throw isBoardGitError(err) ? cliErrorFromBoardGit(err) : err;
  }
}

/** The arg-parse phase: flag validation (usage refusals in their pinned order) and dispatch. */
async function parseSyncInvocation(argv: string[], inv: string): Promise<SyncDispatch> {
  const { values } = parseLeafOrUsage(
    () =>
      parseArgs({
        args: argv,
        options: {
          "pull-only": { type: "boolean" },
          establish: { type: "boolean" },
          "show-incoming": { type: "string" },
          migrate: { type: "boolean" },
          yes: { type: "boolean" },
          out: { type: "string" },
          dir: { type: "string" },
          limit: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.sync,
  );
  if (values.help) return { kind: "help" };

  // `--migrate` is a RETIRED spelling: `--establish` subsumed the committed-folder case. The flag
  // stays recognized so old muscle memory gets a pointer instead of a generic unknown-option error.
  if (values.migrate) {
    throw new CliError(
      "USAGE",
      "--migrate was retired — 'sync --establish' now handles a committed .superbee/ or legacy .agentstate-lite/ folder " +
        "too (preview first; --yes executes)",
      { help: `${inv} sync --establish` },
    );
  }
  if (values.yes && !values.establish) {
    throw new CliError("USAGE", "--yes only applies to sync --establish (it confirms the committed-folder case)", {
      help: `${inv} sync --establish --yes`,
    });
  }

  // `--show-incoming <id>` is the conflict VIEWER — a pure read of the last-fetched origin/board
  // state, dispatched before any of the sync flow (it never provisions, commits, pulls or pushes).
  if (values["show-incoming"] !== undefined) {
    const id = values["show-incoming"].trim();
    if (!id) {
      throw new CliError("USAGE", "--show-incoming was given an empty value — pass a doc id (or a reserved path like log.md)", {
        help: `${inv} sync --show-incoming <id>`,
      });
    }
    if (values["pull-only"]) {
      throw new CliError("USAGE", "--show-incoming and --pull-only cannot be combined — the viewer never pulls");
    }
    if (values.establish) {
      throw new CliError("USAGE", "--show-incoming and --establish cannot be combined");
    }
    let owner: BoundBoardOwner | undefined;
    if (values.dir === undefined && await resolveProjectBinding(process.cwd())) {
      owner = await validateBoundBoardOwner(await resolveLocalBundleTarget(undefined));
    }
    return { kind: "show-incoming", id, values, ...(owner ? { owner } : {}) };
  }
  if (values.out !== undefined) {
    throw new CliError("USAGE", "--out only applies to sync --show-incoming <id>", {
      help: `${inv} sync --show-incoming <id> --out <file>`,
    });
  }
  if (values.establish && values["pull-only"]) {
    throw new CliError(
      "USAGE",
      "--establish and --pull-only cannot be combined — establishing always publishes",
    );
  }

  let limit = DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    const raw = values.limit.trim();
    if (!/^\d+$/.test(raw)) {
      throw new CliError("USAGE", "--limit must be a non-negative integer (0 = unlimited)");
    }
    limit = Number(raw);
  }

  // Sync never resolves a bundle through resolveLocalBundleTarget, so its run directory answers to
  // the relation HERE — before retargeting, provisioning, or any git probe. Without it a guarded
  // root exits 0 with `nothing to sync`, reporting absence where the honest answer is the conflict.
  // Ordered after argv validation so a USAGE error still wins.
  assertSearchDirOutsidePrivateState(path.resolve(values.dir ?? process.cwd()));

  // A bare project binding is an exact board-owner selection, not a hint for the cwd routing
  // below. Validate it before retarget/heal/channel/provision can spawn Git in the public
  // checkout, then carry only the frozen capability through all remaining phases.
  let owner: BoundBoardOwner | undefined;
  if (values.dir === undefined && await resolveProjectBinding(process.cwd())) {
    owner = await validateBoundBoardOwner(await resolveLocalBundleTarget(undefined));
  }

  // Standing inside the board worktree retargets to the enclosing project so provisioning's
  // idempotent path resolves the REAL board (see retargetBoardInterior).
  const dir = owner?.ownerRoot ?? retargetBoardInterior(values.dir ?? process.cwd());
  return {
    kind: "run",
    options: { dir, pullOnly: Boolean(values["pull-only"]), limit, mode: resolveMode(values), ...(owner ? { owner } : {}) },
    establish: Boolean(values.establish),
    yes: Boolean(values.yes),
  };
}

/** The provision phase: owns known-remote-absence vs failed-remote-check; empty states render here (null). */
function provisionPhase(run: SyncRun): SyncBoard | null {
  if (run.owner) {
    // The binding proof already established the exact private board worktree. Provisioning is a
    // public-cwd discovery/healing mechanism and is categorically unavailable to a bound run.
    return { boardPath: run.owner.bundleRoot, key: run.owner.stateKey, outcome: { kind: "already", boardPath: run.owner.bundleRoot } };
  }
  const emptyState = (rec: Record<string, unknown>): null => {
    run.stdout(render(rec, run.mode));
    return null;
  };
  const outcome = provisionBoardWorktree(run.dir, { allowLocalBranch: false, ensureIgnore: true });
  if (outcome.kind === "local_board") {
    throw outcome.remoteExists
      ? syncOutcomeError("sync.local-board.remote-exists", { inv: run.inv })
      : syncOutcomeError("sync.local-board.unpublished", { inv: run.inv });
  }
  if (outcome.kind === "no_repo") {
    return emptyState({ sync: "nothing to sync" });
  }
  if (outcome.kind === "no_board") {
    const hasLocalBundle = hasLocalOnlyBundle(run.dir);
    if (outcome.remoteState === "unknown") {
      return emptyState({
        sync: SYNC_REMOTE_STATE_UNKNOWN_MESSAGE,
        note: syncRemoteStateUnknownNote(run.inv, hasLocalBundle),
      });
    }
    if (hasLocalBundle) {
      return emptyState({ sync: SYNC_LOCAL_ONLY_MESSAGE, note: syncLocalOnlyNote(run.inv) });
    }
    return emptyState({ sync: "nothing to sync" });
  }
  const boardPath = outcome.boardPath;

  // THE HEAL-ORDERING EDGE: the entry heal ran BEFORE this worktree was known to be sound — its
  // worktree-root guard correctly SKIPPED a worktree with stale pointers. The repair just
  // performed fixes those pointers, so a rebase left wedged INSIDE this worktree would otherwise
  // go unhealed for the rest of this run. Re-run the SAME entry heal now that the worktree is
  // structurally sound (best-effort, matching the entry heal's own posture — see its doc comment).
  if (outcome.kind === "repaired") {
    healStaleRebaseBeforeProvisioning(run.dir);
  }

  return { boardPath, key: resolveBundleKey(boardPath), outcome };
}

/**
 * The baseline phase. The BOARD-PENDING MARKER is refreshed FIRST: provisioning just CONFIRMED a
 * board exists for this repo — exactly the marker's meaning — so one write covers every path out
 * of this run. Then the diff baselines: origin/board's OWN ref as this run understood it BEFORE
 * its own fetch — captured before the commit and pull phases, so it can never include anything local.
 */
async function baselinePhase(board: SyncBoard): Promise<SyncBaseline> {
  await defaultSyncStore.refreshMarker(board.key);
  const storedCursor = await defaultSyncStore.readCursor(board.key);
  const startHead = currentHead(board.boardPath);
  const preFetchOriginRef = resolveOriginRef(board.boardPath);
  return { storedCursor, startHead, preFetchOriginRef };
}

/** The commit phase (skipped for `--pull-only`): stage-and-commit, recording self actors. */
async function commitPhase(board: SyncBoard, pullOnly: boolean): Promise<CommitResult> {
  let commitResult: CommitResult = { committed: false, docs: [] };
  if (!pullOnly) {
    commitResult = stageAndCommit(board.boardPath);
    if (commitResult.committed && commitResult.docs.length > 0) {
      // The actors THIS clone just committed are recorded per-clone, so the
      // home render can filter self-authored rows out of the human "since" count.
      await defaultSyncStore.recordSelfActors(board.key, commitResult.docs.map((d) => d.actor));
    }
  }
  return commitResult;
}

/**
 * The pull phase. Full sync rebases with the CONVERGING conflict mechanic (keep upstream, export
 * local, COMPLETE the rebase — never left mid-state); `--pull-only` ff-only-merges (NEVER
 * rebases, see the module header). A conflicted run is a CONFLICT(5) terminal even though the
 * rebase COMPLETED: the push is deliberately SKIPPED — the documented reconcile chain's next
 * `sync` commits the merged version and pushes everything in one pass. Any post-commit failure
 * composes the "work is saved" framing and the honest cache write via
 * {@link throwPostCommitFailure}.
 */
async function pullPhase(run: SyncRun, board: SyncBoard, commitResult: CommitResult): Promise<void> {
  const { boardPath, key, outcome } = board;
  if (run.pullOnly) {
    const ff = ffPull(boardPath);
    if (ff.swallowed) {
      throw withProvisionAnnouncement(ffSwallowToError(ff.swallowed, run.inv, boardPath), outcome);
    }
    return;
  }
  // Every failure composes in one order: withProvisionAnnouncement, then throwPostCommitFailure.
  const fail = (err: CliError): Promise<never> =>
    throwPostCommitFailure(withProvisionAnnouncement(err, outcome), commitResult.committed, key, boardPath);
  let rebaseOutcome: FetchRebaseResolvingOutcome;
  try {
    rebaseOutcome = fetchRebaseResolving(boardPath, defaultSyncStore.exportsDir(key));
  } catch (rawErr) {
    throw await fail(withUpstreamHelp(toCliError(rawErr, "rebase"), run.inv));
  }
  if (rebaseOutcome.status === "resolved") {
    throw await fail(buildConvergeError(boardPath, rebaseOutcome.conflicts, run.inv, run.limit));
  }
  if (rebaseOutcome.status === "no_upstream") {
    // First publication is ALWAYS explicit. A local branch name or an index.md file is evidence
    // of neither user consent nor transaction provenance; inferring either here can publish an
    // unrelated private branch. `--establish` owns snapshot, publish, and recovery.
    throw await fail(syncOutcomeError("sync.full.no-upstream", { inv: run.inv }));
  }
}

/**
 * The delta phase, after a successful pull. The RECEIPT's pulled/incoming is ONLY what
 * origin/board itself gained this run (see `originDocsBetween`'s header for why a HEAD-anchored
 * diff can't express this); the CACHE's enriched "since I last read" delta is deliberately
 * SEPARATE and self-inclusive — the human-facing render filters self-authored rows.
 * Prefer the STORED cursor; an absent or foreign-tier cursor falls back to the board's OWN
 * pre-sync HEAD, so a teammate's very first sync still reports everything that just arrived. A
 * stored cursor whose object no longer exists (history rewritten under it) re-anchors: the honest
 * note, an empty delta (unknowable across a rewrite), the cursor advanced to now — never fatal.
 */
async function deltaPhase(board: SyncBoard, baseline: SyncBaseline): Promise<SyncDelta> {
  const { boardPath, key } = board;
  const postFetchOriginRef = resolveOriginRef(boardPath);
  const originDelta = originDocsBetween(boardPath, baseline.preFetchOriginRef, postFetchOriginRef);

  const { storedCursor } = baseline;
  const cursorToken =
    storedCursor && storedCursor.tier === "git" && typeof storedCursor.token === "string"
      ? storedCursor.token
      : undefined;
  const postPullHead = currentHead(boardPath);
  const delta = changesSince(boardPath, cursorToken ?? baseline.startHead);
  if (delta.ok) {
    await defaultSyncStore.writeCursor(key, { tier: "git", token: postPullHead });
    return { originDelta, changes: delta.changes };
  }
  await defaultSyncStore.recordReanchor(
    key,
    { tier: "git", token: postPullHead },
    { unpushedCount: unpushedCount(boardPath) ?? 0, uncommittedCount: countUncommitted(boardPath) },
  );
  return { originDelta, changes: [], reanchorNote: REANCHOR_NOTE };
}

/**
 * The push phase (skipped for `--pull-only`). A push failure AFTER a successful commit+pull gets
 * a PARTIAL envelope LEADING with the safety message, then throws `asHandled` so the bin wrapper
 * sets the exit code without a second (conflicting) error envelope.
 */
async function pushPhase(run: SyncRun, board: SyncBoard, commitResult: CommitResult, delta: SyncDelta): Promise<number> {
  if (run.pullOnly) return 0;
  const ahead = unpushedCount(board.boardPath) ?? 0;
  try {
    push(board.boardPath);
    return ahead;
  } catch (err) {
    const classified = toCliError(err, "push");
    const warning = pushFailureMessage(classified);
    const partial = buildPushFailurePartial(
      board.outcome, warning, commitResult.docs, delta.originDelta, run.limit, delta.reanchorNote,
    );
    run.stdout(render(partial, run.mode));
    await writeAwarenessCache(board.key, board.boardPath, delta.changes, delta.reanchorNote);
    throw asHandled(new CliError(classified.code, warning, { details: classified.details }));
  }
}

/**
 * The receipt phase: the awareness cache is refreshed with FINAL (post-push-attempt) backstop
 * counts, so a successful push is reflected — deliberately still the cursor-based `changes` (see
 * {@link deltaPhase}), NOT `originDelta`. The onboarding last-mile hint rides BOTH success
 * surfaces — a founder's very first sync is often an empty one right after provisioning.
 */
async function receiptPhase(
  run: SyncRun, board: SyncBoard, commitResult: CommitResult, delta: SyncDelta,
  pushedCount: number, establishAlreadyNote: string | undefined,
): Promise<void> {
  await writeAwarenessCache(board.key, board.boardPath, delta.changes, delta.reanchorNote);
  const hookHint = await hookInstallHintOnce(board.key, run.inv, run.deps.hookInstalled);
  const receipt = buildSyncReceipt({
    outcome: board.outcome, commitDocs: commitResult.docs, pushedCount,
    originDelta: delta.originDelta, limit: run.limit,
    establishAlreadyNote, reanchorNote: delta.reanchorNote, hookHint,
  });
  run.stdout(render(receipt, run.mode));
}

async function syncCommand(argv: string[], deps: Partial<SyncCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const inv = cliInvocation();

  const dispatch = await parseSyncInvocation(argv, inv);
  if (dispatch.kind === "help") {
    stdout(SYNC_USAGE);
    return;
  }
  if (dispatch.kind === "show-incoming") {
    await showIncoming(dispatch.id, dispatch.values, deps, dispatch.owner);
    return;
  }
  const run: SyncRun = { ...dispatch.options, inv, stdout, deps };

  // Refuse the private-state identity before provisioning, fetching, committing, or publishing.
  // Later phase-local checks retain the invariant across any path re-resolution.
  const initialTop = repoTopLevel(run.dir);
  if (initialTop) {
    const initialBundleDir = committedBundleAtHead(initialTop)?.bundleDir ?? bundleDirNameForProject(initialTop);
    assertBundleOutsidePrivateState(path.join(initialTop, initialBundleDir));
  }

  // `--establish` dispatches before ordinary provisioning; an already-shared board falls through
  // to the ordinary sync flow with an idempotence note.
  let establishAlreadyNote: string | undefined;
  if (dispatch.establish && !run.owner) {
    const establishOutcome = await establishBoard(run.dir, inv, run.mode, stdout, deps, { yes: dispatch.yes });
    if (!establishOutcome.already) return;
    establishAlreadyNote = ESTABLISH_ALREADY;
  }

  // The entry self-heal: a stale mid-rebase state found at ENTRY (a crashed/killed prior run) is
  // aborted BEFORE provisioning is even checked, let alone the commit phase (see
  // {@link healStaleRebaseBeforeProvisioning} for why this must run BEFORE provisioning).
  if (!run.owner) healStaleRebaseBeforeProvisioning(run.dir);

  // CHANNEL DETECTION — the act-time probe at sync's own resolution point, computed fresh on
  // every run (never cached across a network boundary). Routing is deliberately narrow: ONLY a
  // positively detected `in-tree` channel leaves the branch-mode flow; `branch`, `local-only`,
  // AND the fail-closed `indeterminate` outcome all fall through to the provisioning state
  // machine unchanged — detection composes with that machine, never re-routes its guidance. The
  // tracked-folder refusal arms throw typed here and map at this command's boundary.
  if (!run.owner) {
    const detection = detectBoardChannel(run.dir);
    if (detection.kind === "channel" && detection.channel.mode === "in-tree") {
      await syncInTree(run);
      return;
    }
  }

  const board = provisionPhase(run);
  if (board === null) return;
  assertBundleOutsidePrivateState(board.boardPath);

  const baseline = await baselinePhase(board);
  const commitResult = await commitPhase(board, run.pullOnly);
  await pullPhase(run, board, commitResult);
  const delta = await deltaPhase(board, baseline);
  const pushedCount = await pushPhase(run, board, commitResult, delta);
  await receiptPhase(run, board, commitResult, delta, pushedCount, establishAlreadyNote);
}
