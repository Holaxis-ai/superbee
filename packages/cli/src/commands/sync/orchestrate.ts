import { renderUsage } from "../../output.js";
import { detectBoardChannel } from "../../board-runtime.js";
import { provisionBoardWorktree } from "../../board-runtime.js";
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
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BOARD_BRANCH,
  BOARD_REMOTE,
  boardBranchOf,
  BUNDLE_DIR,
  bundleDirNameForProject,
  committedBundleAtHead,
  changesSince,
  countUncommitted,
  currentHead,
  fetchRebaseResolving,
  ffPull,
  hasLocalOnlyBundle,
  healStaleRebaseBeforeProvisioning,
  inTreeFetchAndRecord,
  fetchOrigin,
  isBoardGitError,
  originDocsBetween,
  push,
  repoTopLevel,
  resolveBundleKey,
  resolveOriginRef,
  retargetBoardInterior,
  runGit,
  malformedCommittedDocuments,
  malformedOutgoingDocuments,
  stageAndCommit,
  unpushedCount,
  type CommitResult,
  type HeldDocument,
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
import { SYNC_GATE_CONFIG, declaredSyncGate, runSyncGate } from "./gate.js";
import { ffSwallowToError, syncOutcomeError, syncOutcomeLine, withSharingDetails } from "../../sync-outcomes.js";
import { CliError, asHandled, cliErrorFromBoardGit, toExit } from "../../errors.js";
import { parseLeafOrUsage } from "../../args.js";
import { CLI_LEAVES } from "../../command-spec.js";
import { render, renderErrorEnvelope, resolveMode, type OutputMode } from "../../output.js";
import { cliInvocation } from "../../invocation.js";
import {
  assertBundleOutsidePrivateState,
  assertSearchDirOutsidePrivateState,
} from "../../private-state-bundle-boundary.js";
import {
  boundBoardWorktreeError,
  emptyDirectory,
  ownConventionalBoardRoot,
  resolveLocalBundleRoute,
  resolveProjectBinding,
  type ResolvedLocalRoute,
} from "../../bundle.js";
import type { BoundBoardOwner } from "../../bound-board-owner.js";
import { recoverBoundBoardOwner } from "../../bound-board-recovery.js";
import { commandToken, type CommandPrefix } from "../../command-text.js";
import { syncEnvelope, withSyncEnvelope } from "../../sync-outcomes.js";
import { MOVED_MARKER_FILE, movedBoardRefusal, readMovedMarker } from "../../hosted/moved-marker.js";

export const SYNC_USAGE = `superbee sync — share the board branch with a remote (git tier)

Usage:
  superbee sync [--pull-only] [--dir <path>] [--limit <n>] [--json]
  superbee sync --establish [--yes] [--dir <path>] [--json]
  superbee sync --show-incoming <id> [--out <file> | --body-out <file>] [--dir <path>] [--json]
  superbee sync --inspect --doc <id> [--out <file>] [--dir <path>] [--json]
  superbee sync --resolve keep|take|revise --doc <id> [--dir <path>] [--json]

Before first publication, check whether the intended remote repository exists, then whether
origin/board exists. Superbee does not create the remote repository. If the repository is
confirmed absent, create it outside Superbee if authorized or ask an authorized owner/teammate;
if it exists and origin/board is confirmed absent, --establish needs explicit consent,
repository-specific push capability, and branch-create policy clearance. If origin/board exists,
plain sync joins it. If either remote fact is unknown, diagnose URL, network, identity,
visibility, and repository Read access; do not establish.

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
The same verb also works when an automation or chat agent clones the shared \`board\` branch as
the repository root: a tracked OKF root index plus the exact attached \`board\` branch identifies
that standalone checkout, so sync operates there directly and never creates a nested bundle.
A repository can carry more than one board: a NAMED board lives on its own \`board-<name>\` branch
(lowercase letters, digits and hyphens) whose root commits \`.superbee-board.json\` containing
\`{"schema": 1, "branch": "board-<name>"}\`. A standalone clone of that branch, tracking
\`origin/board-<name>\`, syncs exactly as above against \`origin/board-<name>\` and never touches
\`origin/board\`; the conventional \`.superbee\` worktree always uses \`board\`.
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

A hosted checkout's conflict verbs work on a saved conflict too, over the same flow (sync still
keeps the teammate's version first): \`--inspect --doc <id>\` shows your saved version and the
teammate's (\`--out <file>\` writes theirs whole); \`--resolve take\` restores theirs (undoing any
later edit) and discards your saved copy; \`--resolve keep\` writes your saved body over theirs with \`doc update\` (frontmatter
that differs is listed, not carried); \`--resolve revise\` records the document as it is now, so
edit it to the result you want first. Each removes the saved copy; none commits or pushes: the
next \`sync\` shares keep and revise.

\`sync --show-incoming <id>\` prints the board's incoming (upstream) version of one doc — the
state of \`origin/board\` as of the last fetch (it never fetches). Full doc-read semantics: large
parsed bodies truncate and point at \`--body-out <file>\` (body-only Markdown, directly safe for
\`doc update --body-file\`); \`--out <file>\` remains the exact whole-blob channel for documents
and arbitrary paths. A \`-\` destination streams only payload bytes to stdout with the receipt (or
any error envelope) on stderr. A doc absent upstream renders as an expected state, not an error.

If the push fails after a local commit already landed (offline, revoked/expired credentials, or a
locked repository), the receipt still reports what committed/pulled successfully — your work is
saved locally either way, and re-running sync retries the push. A push that loses a race to
another writer (non-fast-forward, including the remote's "incorrect old value" refusal) is not a
permission problem: sync re-fetches, rebases with the same converging mechanic, re-runs the gate,
and pushes again, up to 5 attempts in all, then exits 1 with \`details.reason: non-fast-forward\`.

A clone can declare a SYNC GATE: a command sync runs on the converged tree after rebasing onto
the remote board and before every push that sends commits (\`git config superbee.syncGate
'<command>'\`, any Git config scope; an empty value declares none; \`superbee.syncGateTimeoutSeconds\`
overrides the 600s timeout). It runs through the shell from the board root with
SUPERBEE_BOARD_BRANCH, SUPERBEE_BOARD_UPSTREAM_REF, SUPERBEE_BOARD_UPSTREAM_SHA (the remote tip
rebased onto), SUPERBEE_BOARD_HEAD_SHA (what would be pushed) and SUPERBEE_SYNC_ATTEMPT set. A
non-zero exit, a timeout, or any edit to the board holds the push: the work stays committed
locally and sync exits 5 with code GATE_FAILED and the gate's last output lines. Exactly the
judged commit is pushed. The command comes from Git configuration, never from board files, so
board content cannot choose the command; keep the gate's code outside the board too (a script
inside the board runs whatever a teammate last pushed). A gate must leave the board as it found
it: an untracked, non-ignored file it writes counts as an edit. The opt-in turn-end sync runs
the gate as well, inside the agent host's hook time limit, so keep a gate fast there.
\`--pull-only\` never runs it, and neither does \`--establish\`'s first publication of a board.

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
  --body-out <file>    With --show-incoming: write only a parsed doc body ('-' = body to stdout)
  --inspect --doc <id> Show a saved conflict: your saved version and the teammate's
                       (--inspect <id> is an alias; --out <file> writes theirs whole)
  --resolve keep|take|revise --doc <id>
                       Settle a saved conflict: keep writes yours with doc update, take keeps
                       theirs, revise keeps the document as you edited it; sync then pushes it
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

export function syncLocalOnlyNote(inv: CommandPrefix): string {
  return (
    "a supported mode: every local command works, and your board changes stay on this machine " +
    `(sync committed nothing). The existing remote repository is visible and has no board branch, ` +
    "so repository creation permission is irrelevant. With explicit publication consent, " +
    `repository-specific push capability, and branch-create policy clearance, run \`${inv} sync --establish\`; ` +
    "the push is the decisive write test. Teammates then use sync to join."
  );
}

export const SYNC_REMOTE_STATE_UNKNOWN_MESSAGE =
  "shared board state unknown — origin could not be checked, so sync cannot tell whether a remote board exists";

export function syncRemoteStateUnknownNote(inv: CommandPrefix, hasLocalBundle: boolean): string {
  const local = hasLocalBundle
    ? "your local bundle remains usable and sync committed nothing. "
    : "sync changed nothing. ";
  return local +
    "The repository and board remain unknown: verify the exact origin URL, network, active " +
    `HTTPS/SSH identity, visibility, and repository Read access, then retry \`${inv} sync\`. ` +
    "A shared board may already exist; do not establish while its state is unknown.";
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
  dir: string; inv: CommandPrefix; mode: OutputMode; limit: number; pullOnly: boolean;
  stdout: (s: string) => void; deps: Partial<SyncCliDeps>;
  owner?: BoundBoardOwner;
  route?: ResolvedLocalRoute;
}

/** The arg-parse phase's dispatch decision. */
type SyncDispatch =
  | { kind: "help" }
  | { kind: "show-incoming"; id: string; values: { out?: string; "body-out"?: string; dir?: string; json?: boolean }; route?: ResolvedLocalRoute }
  | { kind: "run"; options: Pick<SyncRun, "dir" | "mode" | "limit" | "pullOnly" | "owner" | "route">; establish: boolean; yes: boolean };

/** The provision phase's result: the board checkout this run operates on. */
interface SyncBoard { boardPath: string; key: string; outcome: ProvisionOutcome }

/**
 * Refuse a board that carries the moved-to-hosted marker (`publish --to hosted` wrote it). With
 * `fetch` (the entry check, before anything is committed), origin is fetched first, and a board
 * moved back passes: origin holds the commit that added the marker but no longer the marker (it
 * was reverted), so this run's pull brings that in. Offline, the marker here stands. A marker whose
 * commit origin never received is refused with the push that finishes the move.
 */
function refuseMovedBoard(boardPath: string, fetch = false): void {
  const marker = readMovedMarker(boardPath);
  if (marker === null) return;
  const fetched = fetch ? fetchOrigin(boardPath) : true;
  const where = markerOnOrigin(boardPath);
  if (fetch && fetched && where === "moved_back") return;
  throw movedBoardRefusal(boardPath, marker, { commits: unpushedCount(boardPath) ?? 0, uncommitted: countUncommitted(boardPath) }, where === "unpushed" ? { markerUnpushed: boardPath } : {});
}

/**
 * Where origin's board (as last fetched) stands on this folder's marker: `moved_back` when origin
 * holds the commit that added it but not the marker, `unpushed` when origin lacks that commit, and
 * `on_origin` or `unknown` otherwise (no origin, or a marker no commit here added).
 */
function markerOnOrigin(boardPath: string): "on_origin" | "moved_back" | "unpushed" | "unknown" {
  const origin = resolveOriginRef(boardPath);
  if (origin === null) return "unknown";
  const added = runGit(boardPath, ["log", "-1", "--format=%H", "--diff-filter=A", "HEAD", "--", MOVED_MARKER_FILE]);
  const commit = added.status === 0 ? added.stdout.trim() : "";
  if (commit === "") return "unknown";
  if (runGit(boardPath, ["merge-base", "--is-ancestor", commit, origin]).status !== 0) return "unpushed";
  return runGit(boardPath, ["cat-file", "-e", `${origin}:${MOVED_MARKER_FILE}`]).status === 0 ? "on_origin" : "moved_back";
}

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
  // An in-tree bundle rides the code branch: this reports what is incoming, and moves nothing.
  run.stdout(render(withSyncEnvelope(rec, syncEnvelope("git")), run.mode));
}

/**
 * The sync command entry — and the git tier's CLI COMMAND BOUNDARY: any typed `BoardGitError`
 * that reaches this edge maps through THE one `cliErrorFromBoardGit` layer, so callers (the bin
 * wrapper, tests) always observe `CliError` with the exact envelope/exit the tier produced.
 */
export async function sync(argv: string[], deps: Partial<SyncCliDeps> = {}): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await syncCommand(argv, deps);
    } catch (err) {
      throw isBoardGitError(err) ? cliErrorFromBoardGit(err) : err;
    }
  };
  if (!requestsShowIncomingStdoutByteChannel(argv)) {
    await run();
    return;
  }

  // Reserve stdout from RAW argv, before parsing, bundle resolution, or Git. Otherwise an early
  // usage failure can put an error envelope where the caller expects only document/body bytes.
  // Deeper show-incoming errors already carry `handled`; honoring it here prevents double emission.
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  try {
    await run();
  } catch (err) {
    const { envelope, handled } = toExit(err);
    if (!handled) stderr(renderErrorEnvelope(envelope));
    throw handled ? err : asHandled(err);
  }
}

/** True when raw sync argv reserves stdout for show-incoming bytes (split and --flag=- forms). */
function requestsShowIncomingStdoutByteChannel(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--out" || arg === "--body-out") && argv[i + 1]?.trim() === "-") return true;
    if (arg?.startsWith("--out=") && arg.slice("--out=".length).trim() === "-") return true;
    if (arg?.startsWith("--body-out=") && arg.slice("--body-out=".length).trim() === "-") return true;
  }
  return false;
}

/**
 * `--inspect` names its document with `--doc <id>`, like `--resolve`; `--inspect <id>` is kept
 * as an alias. A bare `--inspect` (last, or followed by another flag) is read as an empty value,
 * which the hosted parse replaces with `--doc`.
 */
function bareInspect(argv: string[]): string[] {
  return argv.map((token, index) => (token === "--inspect" && (index + 1 === argv.length || argv[index + 1]!.startsWith("-")) ? "--inspect=" : token));
}

/**
 * The one parse of `sync` argv, for both kinds of target: a Git board (below) and a hosted
 * checkout (`../../hosted/sync.ts`, which owns `--inspect`, `--resolve` and `--doc`).
 */
export function parseSyncArgs(argv: string[]) {
  return parseLeafOrUsage(
    () =>
      parseArgs({
        args: bareInspect(argv),
        options: {
          "pull-only": { type: "boolean" },
          establish: { type: "boolean" },
          "show-incoming": { type: "string" },
          migrate: { type: "boolean" },
          yes: { type: "boolean" },
          out: { type: "string" },
          "body-out": { type: "string" },
          dir: { type: "string" },
          limit: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
          inspect: { type: "string" },
          resolve: { type: "string" },
          doc: { type: "string" },
          "accept-deletes": { type: "string" },
          "restore-deletes": { type: "boolean" },
          "take-host-deletions": { type: "string" },
        },
        allowPositionals: true,
      }),
    CLI_LEAVES.sync,
  );
}

/** The arg-parse phase: flag validation (usage refusals in their pinned order) and dispatch. */
async function parseSyncInvocation(argv: string[], inv: CommandPrefix): Promise<SyncDispatch> {
  const { values } = parseSyncArgs(argv);
  if (values.help) return { kind: "help" };
  if (values.inspect !== undefined || values.resolve !== undefined || values.doc !== undefined || values["accept-deletes"] !== undefined || values["restore-deletes"] !== undefined || values["take-host-deletions"] !== undefined) {
    // `superbee sync` routes the conflict verbs (both homes) and the hosted-only verbs before the
    // Git sync runs; only a caller that invokes the Git sync directly reaches this.
    throw new CliError("USAGE", `--inspect, --resolve and --doc are handled by '${inv} sync' (the one conflict grammar for Git boards and hosted checkouts); --accept-deletes, --restore-deletes and --take-host-deletions apply to a hosted checkout only`, {
      help: `${inv} sync --inspect --doc <id>`,
    });
  }

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
    const outValue = values.out;
    const bodyOutValue = values["body-out"];
    const outPresent = outValue !== undefined;
    const bodyOutPresent = bodyOutValue !== undefined;
    if (outPresent && bodyOutPresent) {
      throw new CliError(
        "USAGE",
        "--out and --body-out cannot be combined — each reserves one output channel",
        { help: `${inv} sync --show-incoming ${commandToken(id)} --body-out (<path> | -)` },
      );
    }
    if (outValue !== undefined && outValue.trim() === "") {
      throw new CliError(
        "USAGE",
        "--out was given an empty value — pass a file path or '-' for stdout.",
        { help: `${inv} sync --show-incoming ${commandToken(id)} --out (<path> | -)` },
      );
    }
    if (bodyOutValue !== undefined && bodyOutValue.trim() === "") {
      throw new CliError(
        "USAGE",
        "--body-out was given an empty value — pass a file path or '-' for stdout.",
        { help: `${inv} sync --show-incoming ${commandToken(id)} --body-out (<path> | -)` },
      );
    }
    let route: ResolvedLocalRoute | undefined;
    if (values.dir === undefined && await resolveProjectBinding(process.cwd())) {
      route = await resolveLocalBundleRoute(undefined);
    }
    return { kind: "show-incoming", id, values, ...(route ? { route } : {}) };
  }
  if (values.out !== undefined) {
    throw new CliError("USAGE", "--out only applies to sync --show-incoming <id>", {
      help: `${inv} sync --show-incoming <id> --out <file>`,
    });
  }
  if (values["body-out"] !== undefined) {
    throw new CliError("USAGE", "--body-out only applies to sync --show-incoming <id>", {
      help: `${inv} sync --show-incoming <id> --body-out <file>`,
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

  // The run directory answers to the relation HERE — before retargeting, provisioning, or any Git
  // probe. The binding route below is the sole exception: it resolves once, proves an owner if any,
  // and then carries only that frozen capability. Without this guard a private root exits 0 with
  // `nothing to sync`, reporting absence where the honest answer is the conflict.
  // Ordered after argv validation so a USAGE error still wins.
  assertSearchDirOutsidePrivateState(path.resolve(values.dir ?? process.cwd()));

  // A bare project binding is an exact board-owner selection, not a hint for the cwd routing
  // below. Validate it before retarget/heal/channel/provision can spawn Git in the public
  // checkout, then carry only the frozen capability through all remaining phases.
  //
  // The one binding shape that is NOT frozen away from provisioning: a target that is its own
  // repository's conventional board path. That names exactly the board the ordinary flow owns for
  // this checkout, so an absent target (a fresh clone of a shared board) provisions and a
  // local-only bundle establishes from the repository top. A target that already IS the linked
  // board worktree still routes through its proven owner.
  let route: ResolvedLocalRoute | undefined;
  let ownBoardRoot: string | undefined;
  if (values.dir === undefined) {
    const binding = await resolveProjectBinding(process.cwd());
    if (binding) {
      ownBoardRoot = (await ownConventionalBoardRoot(binding)) ?? undefined;
      // A linked worktree cannot provision the repository's one board checkout a second time, and
      // a board registered to a missing worktree must be pruned first; give the resolver's recovery
      // instead of a provisioning attempt that can only fail.
      if (ownBoardRoot !== undefined) {
        const blocked = await boundBoardWorktreeError(binding);
        if (blocked) throw blocked;
      }
      // An absent or empty own board path is exactly what provisioning fills; the resolver refuses
      // to open it (its recovery is this very sync), so only an occupied path routes through it.
      if (ownBoardRoot === undefined || (existsSync(binding.target) && !(await emptyDirectory(binding.target)))) {
        route = await resolveLocalBundleRoute(undefined);
      }
      if (ownBoardRoot !== undefined && route?.kind === "bound-local") route = undefined;
    }
  }
  const boundOwner = route?.kind === "bound-board" ? route.owner : undefined;
  const owner = route?.kind === "bound-board" && route.readiness === "ready" ? route.owner : undefined;

  // Standing inside the board worktree retargets to the enclosing project so provisioning's
  // idempotent path resolves the REAL board (see retargetBoardInterior).
  const dir = boundOwner?.ownerRoot
    ?? ownBoardRoot
    ?? (route?.kind === "bound-local" ? route.target.root : retargetBoardInterior(values.dir ?? process.cwd()));
  return {
    kind: "run",
    options: {
      dir, pullOnly: Boolean(values["pull-only"]), limit, mode: resolveMode(values),
      ...(owner ? { owner } : {}), ...(route ? { route } : {}),
    },
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
    run.stdout(render(withSyncEnvelope(rec, syncEnvelope("local")), run.mode));
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
async function baselinePhase(board: SyncBoard, entryOriginRef?: string | null): Promise<SyncBaseline> {
  await defaultSyncStore.refreshMarker(board.key);
  const storedCursor = await defaultSyncStore.readCursor(board.key);
  const startHead = currentHead(board.boardPath);
  const preFetchOriginRef = board.outcome.kind === "already" && board.outcome.originBaseline
    ? board.outcome.originBaseline
    : entryOriginRef !== undefined
      ? entryOriginRef
      : resolveOriginRef(board.boardPath);
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
  const { boardPath, outcome } = board;
  if (run.pullOnly) {
    const ff = ffPull(boardPath);
    if (ff.swallowed) {
      throw withProvisionAnnouncement(ffSwallowToError(ff.swallowed, run.inv, boardPath), outcome);
    }
    return;
  }
  await convergingRebase(run, board, commitResult.committed);
}

/**
 * Fetch and rebase onto the remote board with the converging conflict mechanic — the full sync's
 * pull, and the re-pull after a lost push race. A conflict is the CONFLICT(5) terminal; nothing
 * is pushed after it.
 */
async function convergingRebase(run: SyncRun, board: SyncBoard, committedThisRun: boolean): Promise<void> {
  const { boardPath, key, outcome } = board;
  // Every failure composes in one order: withProvisionAnnouncement, then throwPostCommitFailure.
  const fail = (err: CliError): Promise<never> =>
    throwPostCommitFailure(withProvisionAnnouncement(err, outcome), committedThisRun, key, boardPath);
  let rebaseOutcome: FetchRebaseResolvingOutcome;
  try {
    rebaseOutcome = fetchRebaseResolving(boardPath, defaultSyncStore.exportsDir(key));
  } catch (rawErr) {
    throw await fail(withUpstreamHelp(toCliError(rawErr, "rebase"), run.inv));
  }
  if (rebaseOutcome.status === "resolved") {
    throw await fail(await buildConvergeError(boardPath, rebaseOutcome.conflicts, run.inv, run.limit));
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

/** Push attempts per sync: the first, plus re-fetch/rebase/re-gate retries after lost races. */
export const SYNC_PUSH_ATTEMPTS = 5;

/** A short randomized pause before a retry, so two writers that lost to each other desynchronize. */
function raceBackoffMs(attempt: number): number {
  return Math.floor(250 * attempt + Math.random() * 750 * attempt);
}

/**
 * The push phase (skipped for `--pull-only`). Before each push that sends commits, the clone's
 * declared sync gate (Git config `superbee.syncGate`) judges the converged tree; a failing gate
 * holds the push with the work committed locally (GATE_FAILED, exit 5). A push that loses a race
 * to another writer (non-fast-forward) re-fetches, rebases with the converging mechanic, re-runs
 * the gate, and pushes again, up to {@link SYNC_PUSH_ATTEMPTS} attempts. A push failure AFTER a
 * successful commit+pull gets a PARTIAL envelope LEADING with the safety message, then throws
 * `asHandled` so the bin wrapper sets the exit code without a second (conflicting) error envelope.
 */
async function pushPhase(
  run: SyncRun, board: SyncBoard, commitResult: CommitResult, delta: SyncDelta, baseline: SyncBaseline,
): Promise<{ commits: number; documents: number; delta: SyncDelta; gate?: Record<string, unknown> }> {
  if (run.pullOnly) return { commits: 0, documents: 0, delta };
  const gate = declaredSyncGate(board.boardPath);
  // Resolved once: the gate judges for this branch, every attempt pushes to it, and a retry
  // refuses if anything moved the checkout off it.
  const branch = boardBranchOf(board.boardPath);
  let gateDetails: Record<string, unknown> | undefined;
  for (let attempt = 1; ; attempt += 1) {
    // One head per attempt: the gate judges it, the counts describe it, and exactly it is pushed.
    const head = currentHead(board.boardPath);
    const counted = unpushedCount(board.boardPath);
    const ahead = counted ?? 0;
    // The documents the push sends: every one the unpushed commits change, this run's or earlier.
    const outgoing = ahead > 0 ? new Set(originDocsBetween(board.boardPath, resolveOriginRef(board.boardPath), head).map((change) => change.docId)).size : 0;
    // An unknown count is gated too: the gate is skipped only when nothing is known to be sent.
    if (gate && (counted === null || ahead > 0)) {
      const judged = await runSyncGate(board.boardPath, branch, gate, attempt);
      if (!judged.passed) await failGate(run, board, commitResult, delta, judged.reason ?? "failed", judged.details);
      gateDetails = judged.details;
    }
    try {
      push(board.boardPath, head, branch);
      return { commits: ahead, documents: outgoing, delta, ...(gateDetails ? { gate: gateDetails } : {}) };
    } catch (err) {
      const classified = withSharingDetails(toCliError(err, "push"), { operation: "update-board" });
      const raced = classified.code === "TRANSIENT" && classified.details?.reason === "non-fast-forward";
      if (raced && attempt < SYNC_PUSH_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, raceBackoffMs(attempt)));
        if (boardBranchOf(board.boardPath) !== branch) {
          throw new CliError("CONFLICT", `the board checkout left '${branch}' during sync; nothing more was pushed`, {
            details: { state: "board-branch-moved", branch },
            help: `check out '${branch}' in ${board.boardPath}, then ${run.inv} sync`,
          });
        }
        await convergingRebase(run, board, commitResult.committed);
        refuseMovedBoard(board.boardPath);
        delta = await deltaPhase(board, baseline);
        // The re-pull merged new upstream work into this clone's commits; hold a document that
        // merge made malformed exactly as the first pull would have.
        holdMalformedCommitted(run, board, delta);
        continue;
      }
      const details = raced ? { ...classified.details, attempts: attempt } : classified.details;
      const exhausted = raced
        ? new CliError(
          classified.code,
          `another writer pushed to the board each time sync tried (${attempt} attempts, each re-fetched ` +
            `and rebased${gate ? " and re-gated" : ""}) — re-run sync to try again`,
          { details },
        )
        : classified;
      const warning = pushFailureMessage(exhausted);
      const partial = buildPushFailurePartial(
        board.outcome, warning, commitResult.docs, delta.originDelta, run.limit, delta.reanchorNote,
        details,
      );
      run.stdout(render(withSyncEnvelope(partial, syncEnvelope("git", { received: delta.originDelta.length })), run.mode));
      await writeAwarenessCache(board.key, board.boardPath, delta.changes, delta.reanchorNote);
      throw asHandled(new CliError(exhausted.code, warning, { details }));
    }
  }
}

/**
 * A malformed document in an unpushed commit (made by hand, by an older client whose push failed,
 * or by a rebase merging two edits of one frontmatter) is held: nothing is pushed.
 */
function holdMalformedCommitted(run: SyncRun, board: SyncBoard, delta: SyncDelta): void {
  const originRef = resolveOriginRef(board.boardPath);
  if (originRef === null) return;
  const held = malformedCommittedDocuments(board.boardPath, originRef, "HEAD");
  if (held.length > 0) reportHeld(run, board, delta, held, "committed locally");
}

/** A failing gate: print the partial receipt (nothing pushed) and exit GATE_FAILED (5). */
async function failGate(
  run: SyncRun, board: SyncBoard, commitResult: CommitResult, delta: SyncDelta,
  reason: string, details: Record<string, unknown>,
): Promise<never> {
  const warning =
    `committed to the board locally — your work is saved. The sync gate ${reason} on the rebased ` +
    "board, so nothing was pushed; fix what it reports, then re-run sync";
  const help = `run the gate yourself from ${board.boardPath} (git config --get ${SYNC_GATE_CONFIG}), fix what it reports, then ${run.inv} sync`;
  const partial = buildPushFailurePartial(
    board.outcome, warning, commitResult.docs, delta.originDelta, run.limit, delta.reanchorNote, { gate: details },
  );
  // The error is reported through this receipt (exit 5), so it carries the code and next step too.
  partial.code = "GATE_FAILED";
  partial.help = help;
  const envelope = syncEnvelope("git", { received: delta.originDelta.length, next: [`${run.inv} sync`] });
  run.stdout(render(withSyncEnvelope(partial, envelope), run.mode));
  await writeAwarenessCache(board.key, board.boardPath, delta.changes, delta.reanchorNote);
  throw new CliError("GATE_FAILED", `the sync gate ${reason}; nothing was pushed`, {
    help,
    details: { gate: details },
    handled: true,
  });
}

/**
 * The receipt phase: the awareness cache is refreshed with FINAL (post-push-attempt) backstop
 * counts, so a successful push is reflected — deliberately still the cursor-based `changes` (see
 * {@link deltaPhase}), NOT `originDelta`. The onboarding last-mile hint rides BOTH success
 * surfaces — a founder's very first sync is often an empty one right after provisioning.
 */
async function receiptPhase(
  run: SyncRun, board: SyncBoard, commitResult: CommitResult, delta: SyncDelta,
  pushed: { commits: number; documents: number; gate?: Record<string, unknown> }, establishAlreadyNote: string | undefined,
): Promise<void> {
  await writeAwarenessCache(board.key, board.boardPath, delta.changes, delta.reanchorNote);
  const hookHint = await hookInstallHintOnce(board.key, run.inv, run.deps.hookInstalled);
  const receipt = buildSyncReceipt({
    outcome: board.outcome, commitDocs: commitResult.docs, pushedCount: pushed.commits,
    originDelta: delta.originDelta, limit: run.limit,
    establishAlreadyNote, reanchorNote: delta.reanchorNote, hookHint,
  });
  if (pushed.gate) receipt.gate = `passed: ${String(pushed.gate.command)} (attempt ${String(pushed.gate.attempt)})`;
  run.stdout(render(withSyncEnvelope(receipt, syncEnvelope("git", { sent: pushed.documents, received: delta.originDelta.length })), run.mode));
}

/**
 * A sync with an outgoing document whose frontmatter does not parse. Publishing it would break
 * every reader of the shared board, so nothing outgoing moves: no commit, no push, no file set
 * aside. Incoming changes still arrive when the board fast-forwards (Git itself refuses a
 * fast-forward that would overwrite a local edit). The receipt names each held document with the
 * fix, and the run exits 5 so the turn-end hook hands it back to the writer.
 */
async function heldRun(run: SyncRun, board: SyncBoard, baseline: SyncBaseline, held: readonly HeldDocument[]): Promise<void> {
  const pulled = ffPull(board.boardPath);
  const delta = await deltaPhase(board, baseline);
  await writeAwarenessCache(board.key, board.boardPath, delta.changes, delta.reanchorNote);
  reportHeld(run, board, delta, held, "in the worktree", pulled.swallowed);
}

/** Print the held receipt (nothing pushed) and exit 5 so the turn-end hook hands it back. */
function reportHeld(
  run: SyncRun, board: SyncBoard, delta: SyncDelta, held: readonly HeldDocument[],
  where: "in the worktree" | "committed locally", notPulled?: string,
): never {
  const receipt = buildSyncReceipt({
    outcome: board.outcome, commitDocs: [], pushedCount: 0,
    originDelta: delta.originDelta, limit: run.limit, reanchorNote: delta.reanchorNote,
  });
  receipt.sync = where === "in the worktree"
    ? "held: nothing was committed or pushed"
    : "held: local commits carry these documents, so nothing was pushed";
  if (notPulled) receipt.pull = `not pulled (${notPulled}); the next sync after the fix pulls`;
  receipt.held_documents = held.map((doc) => ({ id: doc.id, path: doc.relPath, reason: doc.reason, detail: doc.detail }));
  const fix = `fix the lines between the --- markers of ${held.map((doc) => doc.relPath).join(", ")} ` +
    `(quote any value that contains ': '), check with ${run.inv} status, then run ${run.inv} sync`;
  receipt.held_help =
    `not published: the YAML frontmatter of these documents does not parse, and publishing it would ` +
    `break every reader of the board, so this sync sent nothing. Your files are untouched; ${fix}` +
    (where === "committed locally" ? " (the fix is committed on top and both go out together)" : "");
  const envelope = syncEnvelope("git", { received: delta.originDelta.length, held: held.length, next: [`${run.inv} sync`] });
  run.stdout(render(withSyncEnvelope(receipt, envelope), run.mode));
  throw new CliError(
    "CONFLICT",
    `${held.length} document(s) have invalid frontmatter (${held.map((doc) => doc.id).join(", ")}); nothing was published`,
    { help: fix, details: { held: held.map((doc) => doc.id) }, handled: true },
  );
}

async function syncCommand(argv: string[], deps: Partial<SyncCliDeps> = {}): Promise<void> {
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const inv = cliInvocation();

  const dispatch = await parseSyncInvocation(argv, inv);
  if (dispatch.kind === "help") {
    stdout(renderUsage(SYNC_USAGE));
    return;
  }
  if (dispatch.kind === "show-incoming") {
    await showIncoming(dispatch.id, dispatch.values, deps, dispatch.route);
    return;
  }
  const run: SyncRun = { ...dispatch.options, inv, stdout, deps };

  // A plain binding is a normal selected bundle, never a board owner.  Keep sync's supported
  // local-only/no-op result without probing an enclosing private or invoking checkout.
  if (run.route?.kind === "bound-local") {
    stdout(render(withSyncEnvelope({ sync: "nothing to sync" }, syncEnvelope("local")), run.mode));
    return;
  }

  if (run.route?.kind === "bound-board" && run.route.readiness === "recovery-pending") {
    const recoveredOwner = await recoverBoundBoardOwner(run.route.target, run.route.owner);
    run.owner = recoveredOwner;
    run.route = { ...run.route, readiness: "ready", owner: recoveredOwner };
  }

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
  if (dispatch.establish) {
    const establishOutcome = await establishBoard(run.owner?.ownerRoot ?? run.dir, inv, run.mode, stdout, deps, { yes: dispatch.yes });
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
  // A board moved to hosted (its marker already here) takes nothing from this run. A pull-only run
  // never pushes, so it still pulls: that is how a board moved back (its marker reverted) returns.
  // Origin as it stood before the entry check's fetch, so the receipt's incoming counts what that
  // fetch brought (a moved-back board's revert, say).
  const entryOriginRef = resolveOriginRef(board.boardPath);
  if (!run.pullOnly) refuseMovedBoard(board.boardPath, true);

  const baseline = await baselinePhase(board, entryOriginRef);
  if (!run.pullOnly) {
    const held = malformedOutgoingDocuments(board.boardPath);
    if (held.length > 0) {
      await heldRun(run, board, baseline, held);
      return;
    }
  }
  const commitResult = await commitPhase(board, run.pullOnly);
  if (commitResult.held) {
    await heldRun(run, board, baseline, commitResult.held);
    return;
  }
  await pullPhase(run, board, commitResult);
  // The marker can arrive with this pull: then nothing is pushed, and this run's commit stays local.
  if (!run.pullOnly) refuseMovedBoard(board.boardPath);
  const delta = await deltaPhase(board, baseline);
  if (!run.pullOnly) holdMalformedCommitted(run, board, delta);
  const pushed = await pushPhase(run, board, commitResult, delta, baseline);
  await receiptPhase(run, board, commitResult, pushed.delta, pushed, establishAlreadyNote);
}
