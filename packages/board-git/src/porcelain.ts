/**
 * `porcelain.ts` — the board's git porcelain layer.
 *
 * ONE spawn wrapper ({@link runGit}) enforces the global porcelain invariants on every
 * invocation; the exported ops (provision, stage-and-commit, fetch-rebase, push, ff-pull,
 * unpushed-count, stale-rebase detect/abort) are the ONLY vocabulary the CLI's sync command
 * and SessionStart pull speak (the ref-to-ref doc diff family rides them from `diff.ts`).
 * `@superbee/core` never learns git exists — this package CONSUMES core (its
 * one frontmatter parser, its one path/reserved-file vocabulary) and is consumed by the CLI.
 *
 * Invariants (every call):
 *   - `git -C <dir>` with GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE SCRUBBED from the environment
 *     because inherited values override `-C`.
 *   - GIT_TERMINAL_PROMPT=0 and GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10' — the
 *     no-hang class is killed at the wrapper, not per call site.
 *   - GIT_EDITOR/GIT_SEQUENCE_EDITOR=true on rebase ops (nothing interactive can open).
 *   - A per-op timeout (network ops get a longer budget); a fired timeout classifies TRANSIENT.
 *   - EXPLICIT refs everywhere — `origin/board`, NEVER `@{u}` (a shared board branch can arrive
 *     with no tracking config at all — empirically observed in the field).
 *   - Worktree internals via `git rev-parse --git-path` (`.git` is a FILE in a linked worktree).
 *   - Rename detection OFF (`--no-renames`): a doc's identity IS its path; add+delete is the true
 *     story. Explicit (not merely `-M` omitted) so a host `diff.renames=true` config cannot leak in.
 *   - Git text conversion OFF (`-c core.autocrlf=false -c core.eol=lf`): portable bundle bytes
 *     are never rewritten by a host's global Windows checkout policy.
 *   - Path quoting OFF (`-c core.quotepath=off`): non-ASCII paths come back as raw UTF-8, never
 *     C-quoted — parsed paths must round-trip back into git as pathspecs (see `runGit`'s header).
 *   - No raw git on stdout: every failure routes through `classifyGitError` (errors.ts)
 *     into the typed `BoardGitError` taxonomy; the CLI command boundary maps it to exit codes.
 *
 * IDENTITY FALLBACK: every commit-CREATING call (`stageAndCommit`, `snapshotBundleCommit`,
 * `flow.ts`'s `createBoardRootCommit`/`createRemovalCommit`, and every non-`--abort` rebase
 * invocation in `fetchRebase`/`fetchRebaseResolving` — a replay needs committer identity too)
 * prepends {@link identityFlags}'s per-invocation `-c user.*` args. `[]` on a machine with a
 * resolvable identity — byte-identical to before this existed; the synthetic identity only when
 * git itself could not construct one anywhere (fresh container / identity-less CI runner).
 *
 * CONFLICT BOUNDARY: {@link fetchRebase} DETECTS a same-doc conflict — collects the conflicted ids
 * via `diff --name-only --diff-filter=U` — and `git rebase --abort`s cleanly (ZERO data movement;
 * kept for any consumer that must never move data). The converging mechanic is
 * {@link fetchRebaseResolving}: keep the upstream version, export the local version, and complete
 * the rebase.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  conceptIdFromPath,
  isReservedFile,
  mutationActorFromFrontmatter,
  parseMarkdown,
} from "@superbee/core";
import { BoardGitError, classifyGitError, isBoardGitError, type GitFailure } from "./errors.js";

/** The dedicated branch that carries ONLY the bundle (its root IS the bundle root). */
export const BOARD_BRANCH = "board";
/** The one remote the board syncs against. */
export const BOARD_REMOTE = "origin";
/** The EXPLICIT remote-tracking ref every pull/rebase/count uses — never `@{u}`. */
export const BOARD_REF = `${BOARD_REMOTE}/${BOARD_BRANCH}`;
/** The canonical folder used for every newly-created project bundle and board worktree. */
export const BUNDLE_DIR = ".superbee";
/**
 * The pre-rename conventional folder: recognized and operated in place. A new checkout at this
 * spelling is permitted only to complete an interrupted establish whose verified
 * `.agentstate-lite.establish-backup/` selected the recovery path.
 */
export const LEGACY_BUNDLE_DIR = ".agentstate-lite";
/** The complete recognition set. Creation sites must use {@link BUNDLE_DIR}, not this collection. */
export const BUNDLE_DIRS = [BUNDLE_DIR, LEGACY_BUNDLE_DIR] as const;
export type BundleDirName = (typeof BUNDLE_DIRS)[number];

interface RecognizedBundlePath {
  name: BundleDirName;
  sourcePath: string;
  realPath: string;
  symlink: boolean;
}

/** A real directory with the reserved root index; files, empty dirs, and dangling links do not count. */
function recognizedBundlePath(name: BundleDirName, sourcePath: string): RecognizedBundlePath | null {
  try {
    const link = lstatSync(sourcePath);
    if (!statSync(sourcePath).isDirectory() || !statSync(path.join(sourcePath, "index.md")).isFile()) return null;
    return { name, sourcePath, realPath: realpathSync(sourcePath), symlink: link.isSymbolicLink() };
  } catch {
    return null;
  }
}

/** The existing valid project bundle (or recovery backup), falling back to the canonical creation target. */
export function bundleDirNameForProject(top: string): BundleDirName {
  const matches = BUNDLE_DIRS.flatMap((name) => {
    const direct = path.join(top, name);
    return [recognizedBundlePath(name, direct), recognizedBundlePath(name, `${direct}.establish-backup`)]
      .filter((match): match is RecognizedBundlePath => match !== null);
  });
  const byName = new Map<BundleDirName, RecognizedBundlePath[]>();
  for (const match of matches) byName.set(match.name, [...(byName.get(match.name) ?? []), match]);
  if (byName.size > 1) {
    const canonical = byName.get(BUNDLE_DIR) ?? [];
    const legacy = byName.get(LEGACY_BUNDLE_DIR) ?? [];
    const sharedPhysical = canonical.find((candidate) =>
      legacy.some((other) => other.realPath === candidate.realPath),
    )?.realPath;
    if (sharedPhysical) {
      const aliases = matches.filter((match) => match.realPath === sharedPhysical);
      return [...aliases].sort((a, b) => Number(a.symlink) - Number(b.symlink))[0]!.name;
    }
    const sources = [...byName.values()].map((group) => group[0]!.sourcePath);
    const shown = sources.map((source) => `'${path.relative(top, source)}/'`).join(" and ");
    throw new BoardGitError(
      "CONFLICT",
      `${shown} contain project bundles at ${top} — refusing to choose between two project bundles`,
      {
        details: {
          path: top,
          phase: "filesystem-bundle-selection",
          state: "bundle-directory-conflict",
          directories: sources.map((source) => path.relative(top, source)),
        },
        help: "choose the project bundle to keep, then move the other directory outside the repository before retrying",
      },
    );
  }
  return [...byName.keys()][0] ?? BUNDLE_DIR;
}

/**
 * Worktree-portability config forced on every worktree-creating or repairing invocation: git >=
 * 2.48's `worktree.useRelativePaths` writes both the linked worktree's
 * `.git` file and the main repo's `worktrees/<name>/gitdir` registration as paths RELATIVE to each
 * other, instead of the pre-2.48 default of absolute paths on both sides. Since the board worktree
 * always lives INSIDE the repo it belongs to (`<repoTop>/.superbee`), a relative pointer is
 * mount-portable by construction — a sandbox/devcontainer/CI checkout remounted at a different
 * absolute path stays self-consistent. NO version probing: an unknown `-c` config key is silently
 * ignored by git older than 2.48, so this is safe to pass unconditionally on every version.
 */
const RELATIVE_WORKTREE_CONFIG = ["-c", "worktree.useRelativePaths=true"];

// ── the ONE spawn wrapper ─────────────────────────────────────────────────────

/** Env keys whose INHERITED values override `-C` — scrubbed on every invocation (invariant). */
const SCRUBBED_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

/** Default per-op timeout for local plumbing/porcelain. */
const LOCAL_TIMEOUT_MS = 30_000;
/** Budget for ops that touch the network (fetch/push/probe) — bounded, but tolerant of a slow remote. */
export const NETWORK_TIMEOUT_MS = 60_000;

export interface GitRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Per-op timeout; defaults to {@link LOCAL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Piped to the child's stdin (the `commit -F -` message channel — no shell interpolation). */
  input?: string;
  /** True for rebase ops: forces GIT_EDITOR/GIT_SEQUENCE_EDITOR=true so nothing interactive opens. */
  rebase?: boolean;
  /**
   * ssh ConnectTimeout override, in seconds (default 10). SessionStart passes 5 so a black-holed
   * ssh host is abandoned inside the pull budget
   * rather than eating it whole. The spawnSync `timeoutMs` kill is the HARD enforcement either
   * way (https remotes never consult ssh); this only makes the ssh case fail faster and cleaner.
   */
  connectTimeoutSeconds?: number;
  /** Explicit temporary index used by snapshot plumbing; ambient GIT_INDEX_FILE stays scrubbed. */
  indexFile?: string;
  /** Explicit repository directory for a work tree rooted somewhere other than `dir`. */
  gitDir?: string;
  /** Explicit work-tree root paired with {@link gitDir}. */
  workTree?: string;
}

/** The hermetic environment for one invocation: ambient env, scrubbed, with the invariants forced. */
function gitEnv(rebase: boolean, connectTimeoutSeconds = 10, indexFile?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of SCRUBBED_GIT_VARS) delete env[v];
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  // Locale-pin git prose so classifyGitError's fallback matchers survive non-English hosts.
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_SSH_COMMAND = `ssh -o BatchMode=yes -o ConnectTimeout=${connectTimeoutSeconds}`;
  if (rebase) {
    env.GIT_EDITOR = "true";
    env.GIT_SEQUENCE_EDITOR = "true";
  }
  return env;
}

/**
 * Run `git -C <dir> <args…>` under the porcelain invariants, TOLERATING a nonzero exit (the caller
 * inspects `status`). A spawn-level failure (no git binary, fired timeout) can never be a
 * legitimate outcome, so it THROWS the classified `BoardGitError` (GIT_MISSING / TRANSIENT) directly.
 *
 * `-c core.quotepath=off` is a wrapper invariant: with git's default
 * `core.quotepath=true`, any non-ASCII path (e.g. `tasks/café.md`) comes back C-QUOTED in
 * diff/status output (`"tasks/caf\303\251.md"`, surrounding quotes included) — and every
 * downstream parse that feeds the parsed string back into git as a path/pathspec (`show :3:<p>`,
 * `checkout -- <p>`, `rm -- <p>`, `show <rev>:<p>`) then MISSES the real file. Off = raw UTF-8
 * bytes out, exactly what the filesystem and pathspecs expect — killing the class for EVERY
 * path-parsing consumer at the one chokepoint, like LC_ALL=C does for prose. Every
 * `--name-status` invocation additionally passes `-z` (see {@link nameStatusRows}) so a TAB,
 * newline, or other control byte inside a path is immune too, matching the conflict list's
 * `--name-only -z` (see `fetchRebaseResolving`).
 */
export function runGit(dir: string, args: string[], opts: RunOptions = {}): GitRunResult {
  const r = runGitBytes(dir, args, opts);
  return { status: r.status, stdout: r.stdout.toString("utf8"), stderr: r.stderr };
}

/** {@link runGitBytes}'s result: stdout as the EXACT BYTES; stderr decoded (it is git prose). */
export interface GitRunBytesResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * The one spawn site: every git invocation — text or binary —
 * flows through here, so the wrapper invariants (scrubbed env, locale pin, quotepath off, no-hang
 * timeouts, non-interactive editors) hold for both. `stdout` is returned as a Buffer of the EXACT
 * bytes git produced; {@link runGit} is the utf8-decoding projection every text parser rides.
 * Call THIS directly when the payload is a raw blob that must round-trip byte-identically (the
 * `:3:` conflict export, `show-incoming --out`'s byte channel) — routing a blob through a UTF-8
 * string silently rewrites invalid sequences to U+FFFD.
 */
export function runGitBytes(dir: string, args: string[], opts: RunOptions = {}): GitRunBytesResult {
  // Time-box floor: Node's spawnSync treats
  // `timeout: 0` as NO timeout at all (a zero waits for the child indefinitely), and a
  // synchronous spawn cannot be preempted by any timer — so a caller whose sliced budget
  // decayed to 0 between its own guard and this spawn would HANG the exact path the budget
  // exists to bound. A non-positive timeout therefore classifies as an IMMEDIATE fired timeout
  // (TRANSIENT) without ever spawning: one chokepoint closing the class for every caller,
  // present and future, however their guard-to-spawn gaps decay.
  if (opts.timeoutMs !== undefined && opts.timeoutMs <= 0) {
    throw classifyGitError({ args, status: null, stdout: "", stderr: "", timedOut: true });
  }
  const repositoryArgs = [
    ...(opts.gitDir ? [`--git-dir=${opts.gitDir}`] : []),
    ...(opts.workTree ? [`--work-tree=${opts.workTree}`] : []),
  ];
  const r = spawnSync("git", [
    "-C",
    dir,
    "-c",
    "core.quotepath=off",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    ...repositoryArgs,
    ...args,
  ], {
    env: gitEnv(opts.rebase ?? false, opts.connectTimeoutSeconds, opts.indexFile),
    timeout: opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
    input: opts.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = r.stdout ?? Buffer.alloc(0);
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString("utf8");
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    throw classifyGitError({
      args,
      status: r.status ?? null,
      stdout: stdout.toString("utf8"),
      stderr,
      timedOut: code === "ETIMEDOUT",
      spawnErrorCode: code ?? "SPAWN",
    });
  }
  // A killed child (e.g. timeout without an error object on some platforms) has status null.
  if (r.status === null) {
    throw classifyGitError({ args, status: null, stdout: stdout.toString("utf8"), stderr, timedOut: true });
  }
  return { status: r.status, stdout, stderr };
}

/** A {@link GitFailure} from a tolerated-but-failed invocation, for classification. */
function failureOf(args: string[], r: GitRunResult): GitFailure {
  return { args, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run a git op that MUST succeed; a nonzero exit throws the classified `BoardGitError`. */
export function mustGit(dir: string, args: string[], opts: RunOptions = {}): string {
  const r = runGit(dir, args, opts);
  if (r.status !== 0) throw classifyGitError(failureOf(args, r));
  return r.stdout;
}

// ── identity fallback (fresh-container / identity-less-CI-runner safety net) ──

/** The literal fallback identity when no actor is already flowing into the commit path. */
const IDENTITY_FALLBACK_ACTOR = "superbee";

/** Lowercase; any run of non `[a-z0-9.-]` collapses to one `-`; trimmed of leading/trailing `-`. */
function slugifyActor(actor: string): string {
  const slug = actor
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : IDENTITY_FALLBACK_ACTOR;
}

/**
 * True when git can construct BOTH commit identities in `dir` from everything IT ITSELF respects
 * (env `GIT_AUTHOR_*`/`GIT_COMMITTER_*`/`EMAIL`, local/global/system config, the OS-account
 * guess) — probed via `git var GIT_AUTHOR_IDENT` AND `git var GIT_COMMITTER_IDENT`, the exact
 * constructions git performs before a real commit. Both probes are required: author alone
 * false-negatives the real CI shape where only `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` are exported
 * — the author ident resolves, yet the commit still dies "Committer identity unknown"
 * (empirically verified). A nonzero exit on either is git's own verdict that it would refuse the
 * commit — never string-matched, never re-derived.
 */
function hasResolvableIdentity(dir: string): boolean {
  return (
    runGit(dir, ["var", "GIT_AUTHOR_IDENT"]).status === 0 &&
    runGit(dir, ["var", "GIT_COMMITTER_IDENT"]).status === 0
  );
}

/**
 * The per-invocation `-c user.name=… -c user.email=…` fallback for a commit-creating git call —
 * NEVER a config write, on disk or otherwise. `[]` when `dir` already has a resolvable identity
 * (every user with real git config gets byte-identical argv to before this existed); the four
 * `-c` args ONLY when resolution genuinely fails, so a fresh container or an identity-less CI
 * runner can still commit. `user.name` is `actor` — the resolved actor string already flowing
 * into the commit path — falling back to the literal {@link IDENTITY_FALLBACK_ACTOR} when `actor`
 * is absent or blank; `user.email` is `<slug of that name>@superbee.invalid` (RFC 2606).
 * The ONE primitive every sync-family commit-creating call site consumes — see porcelain.ts's
 * module header for the site map.
 */
export function identityFlags(dir: string, actor?: string): string[] {
  if (hasResolvableIdentity(dir)) return [];
  const name = actor && actor.trim().length > 0 ? actor.trim() : IDENTITY_FALLBACK_ACTOR;
  return ["-c", `user.name=${name}`, "-c", `user.email=${slugifyActor(name)}@superbee.invalid`];
}

// ── repo/worktree discovery ───────────────────────────────────────────────────

export type RepoTopLevelProbe =
  | { kind: "repo"; top: string }
  | { kind: "not_repo" }
  | { kind: "unavailable"; reason: string };

function hasEnclosingGitMarker(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Evidence-preserving repository discovery for callers that must distinguish a plain folder from
 * broken Git plumbing. A marker plus a failed probe is indeterminate, never "not a repo".
 */
export function probeRepoTopLevel(dir: string): RepoTopLevelProbe {
  if (!existsSync(dir)) {
    return hasEnclosingGitMarker(dir)
      ? { kind: "unavailable", reason: "git repository discovery path does not exist" }
      : { kind: "not_repo" };
  }
  const r = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) {
    if (!hasEnclosingGitMarker(dir)) return { kind: "not_repo" };
    const detail = r.stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, 240);
    return {
      kind: "unavailable",
      reason: detail ? `git repository discovery failed: ${detail}` : `git repository discovery failed (exit ${r.status})`,
    };
  }
  const top = r.stdout.trim();
  return top.length > 0
    ? { kind: "repo", top }
    : { kind: "unavailable", reason: "git repository discovery returned an empty top level" };
}

/**
 * The enclosing repository's top-level working directory, or null when discovery cannot produce
 * one. This legacy fail-soft projection is intentionally preserved; truth-sensitive consumers use
 * {@link probeRepoTopLevel}.
 */
export function repoTopLevel(dir: string): string | null {
  const result = probeRepoTopLevel(dir);
  return result.kind === "repo" ? result.top : null;
}

/** Resolve a worktree-internal git path (e.g. `rebase-merge`, `index.lock`) to an absolute path. */
function worktreeGitPath(boardPath: string, relative: string): string {
  const raw = mustGit(boardPath, ["rev-parse", "--git-path", relative]).trim();
  return path.resolve(boardPath, raw);
}

/** realpath when the path exists; the path unchanged otherwise (for stable comparisons). */
function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Compare physical paths without treating Windows case/drive-letter aliases as different roots. */
function samePhysicalPath(a: string, b: string): boolean {
  const left = path.resolve(realOrSame(a));
  const right = path.resolve(realOrSame(b));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The repo/worktree's git common-dir, realpathed for ownership comparisons. */
function gitCommonDir(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--git-common-dir"]);
  if (r.status !== 0) return null;
  const raw = r.stdout.trim();
  if (raw.length === 0) return null;
  return realOrSame(path.isAbsolute(raw) ? raw : path.resolve(dir, raw));
}

/** True when both paths are worktrees of the same git repository/common-dir. */
function sameGitCommonDir(a: string, b: string): boolean {
  const aCommon = gitCommonDir(a);
  const bCommon = gitCommonDir(b);
  return aCommon !== null && bCommon !== null && samePhysicalPath(aCommon, bCommon);
}

/**
 * True when `boardPath`'s OWN git plumbing resolves back to itself — the structural signature of
 * a healthy linked worktree, independent of what's currently checked out there. Deliberately
 * WEAKER than {@link isProvisioned}: a worktree wedged mid-rebase has a DETACHED HEAD (rebase
 * checks out commits directly), so it is never "on the `board` branch" until healed — but its
 * pointer files can still be perfectly healthy (or freshly repaired). This is the repair
 * self-heal's OWN success signal (worktree-portability): `git worktree repair`'s job is only to
 * fix the POINTERS, not to un-wedge a rebase, so checking for `isProvisioned`'s stronger
 * "on-branch" condition would misreport a genuinely successful repair as a failure whenever the
 * worktree was ALSO wedged (the heal-ordering edge — the caller re-runs the entry heal for that).
 * Exported for channel detection's rule 1 (`channel.ts`), which keys on this same weak signature.
 */
export function worktreeRootResolves(boardPath: string): boolean {
  const boardTop = repoTopLevel(boardPath);
  return boardTop !== null && samePhysicalPath(boardTop, boardPath);
}

/**
 * Stronger than {@link worktreeRootResolves}: the path must be a worktree root AND belong to the
 * same git common-dir as the project that wants to adopt it. This rejects a foreign repo's board
 * worktree parked at this project's conventional path. Exported for channel detection's rule 1.
 */
export function worktreeRootResolvesForOwner(boardPath: string, ownerTop: string): boolean {
  return worktreeRootResolves(boardPath) && sameGitCommonDir(boardPath, ownerTop);
}

/**
 * True when a wedged rebase in `boardPath` was invoked FROM the `board` branch — read from git's
 * OWN `rebase-merge/head-name` (or `rebase-apply/head-name`, the non-interactive backend) file,
 * which git writes with the ORIGINAL ref (e.g. `refs/heads/board`) specifically so
 * `--continue`/`--abort` know where to return to, even though HEAD itself is detached for the
 * rebase's duration (empirically verified live). This is a STRUCTURAL signal from git's own
 * bookkeeping, never inferred or guessed — the discriminator {@link repairedWorktreeIsBoard} needs
 * to accept a wedged-mid-rebase worktree (detached HEAD, never literally "on branch board") WITHOUT
 * also accepting an unrelated worktree that merely happens to be mid-rebase on some OTHER branch.
 */
export function rebaseWasFromBoardBranch(boardPath: string): boolean {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const headNamePath = path.join(worktreeGitPath(boardPath, state), "head-name");
    if (!existsSync(headNamePath)) continue;
    try {
      if (readFileSync(headNamePath, "utf8").trim() === `refs/heads/${BOARD_BRANCH}`) return true;
    } catch {
      /* an unreadable head-name proves nothing either way — keep checking the other backend */
    }
  }
  return false;
}

/**
 * The repair self-heal's ACTUAL success signal (worktree-portability): {@link worktreeRootResolves}
 * alone is NOT enough — `git worktree repair` is safe to run (and exits 0) on a worktree whose
 * pointers were never even stale, so a genuinely healthy but WRONG-branch worktree (someone's own
 * unrelated `git worktree add .superbee some-other-branch`), or one merely left on a plain
 * detached HEAD for an unrelated reason (no rebase in progress at all), would otherwise be
 * misreported as a successful "repaired" board checkout — and every downstream sync step
 * (`stageAndCommit`, `fetchRebaseResolving`, `push`) would then operate against content that was
 * never the shared board. This is genuinely on
 * `board` when EITHER the branch is attached and literally `board`, OR HEAD is detached BECAUSE
 * of a wedged rebase that was itself started FROM `board` ({@link rebaseWasFromBoardBranch}) — any
 * other detached state (or any other named branch) is NOT accepted, and falls through to refusal.
 */
function repairedWorktreeIsBoard(boardPath: string, ownerTop: string): boolean {
  if (!worktreeRootResolvesForOwner(boardPath, ownerTop)) return false;
  const branch = runGit(boardPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status === 0 && branch.stdout.trim() === BOARD_BRANCH) return true;
  return detectStaleRebase(boardPath) && rebaseWasFromBoardBranch(boardPath);
}

/**
 * True when the conventional board worktree is genuinely provisioned for the repo containing
 * `dir`: the selected conventional directory exists, is ITSELF a worktree root (not a plain directory
 * falling through to the parent repo), and has the `board` branch checked out.
 */
export function isProvisioned(dir: string): boolean {
  const top = repoTopLevel(dir);
  if (!top) return false;
  const boardPath = path.join(top, bundleDirNameForProject(top));
  if (!existsSync(boardPath) || !worktreeRootResolvesForOwner(boardPath, top)) return false;
  const branch = runGit(boardPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch.status === 0 && branch.stdout.trim() === BOARD_BRANCH;
}

// ── provisioning (self-heal) ──────────────────────────────────────────────────

export type ProvisionOutcome =
  /**
   * The worktree was created (fresh or self-healed clone). `source` names WHERE it materialized
   * FROM — `remote` (the classic clone/join path: checked out from `refs/remotes/origin/board`) or
   * `local` (the `hasLocal` arm: an ALREADY-EXISTING local `board` branch, such as a legacy or
   * manually prepared checkout) — so an announcement never claims "materialized from
   * origin/board" for a branch that never touched origin.
   */
  | { kind: "provisioned"; boardPath: string; source: "local" | "remote"; gitignore?: GitignoreUpdate }
  /**
   * A pre-existing worktree carrying stale pointers after a sandbox or mount move —
   * `.git` file / `worktrees/<name>/gitdir` still name the OLD absolute path) was structurally
   * repaired via `git worktree repair`. Distinct from `already`: a repair IS a git mutation
   * (rewrites the pointer files) and must be ANNOUNCEABLE, never folded into the silent-no-op
   * "already" case (decisions/board-branch-sync rider 2).
   */
  | { kind: "repaired"; boardPath: string; gitignore?: GitignoreUpdate }
  /** Already provisioned (or the board branch is already checked out) — idempotent success. */
  | { kind: "already"; boardPath: string; gitignore?: GitignoreUpdate }
  /** `dir` is not inside a git repository at all — the caller emits `sync: nothing to sync`. */
  | { kind: "no_repo" }
  /** No local or fetched board ref exists; `remoteState` records whether origin was checked. */
  | { kind: "no_board"; remoteState: "absent" | "unknown" }
  /** An unprovisioned local `board` branch exists, but this caller refuses to adopt it by name. */
  | { kind: "local_board"; boardPath: string; remoteExists: boolean };

/**
 * True when `<dir>/.git` exists as a FILE (never a directory) — the structural signature of git's
 * own checkout machinery: a linked worktree OR a submodule (both point their `.git` at a real
 * gitdir elsewhere via this same file shape; a full repository's `.git` is a directory). This is
 * the ONLY gate that makes {@link repairWorktree} reachable: the never-touch guarantee
 * requires that a repair attempt can NEVER fire against a plain foreign directory, only against
 * something that already looks like git's own machinery — {@link repairedWorktreeIsBoard} is what
 * then tells a genuine `board` worktree apart from a submodule or an unrelated worktree that merely
 * shares this same signature. Exported for channel detection's rule 1.
 */
export function hasWorktreeSignature(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  if (!existsSync(gitPath)) return false;
  try {
    return statSync(gitPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Attempt `git worktree repair` on a worktree with a stale/mismatched `.git` file. After the
 * enclosing repo is moved or remounted, this
 * rewrites BOTH the linked worktree's `.git` file and the main repo's `worktrees/<name>/gitdir`
 * registration to agree again — and, with {@link RELATIVE_WORKTREE_CONFIG}, to RELATIVE paths, so
 * a capable git converts an inherited absolute setup while repairing it). Run from the repo TOP
 * (not the board path itself — the board path's own git plumbing is exactly what's broken).
 * Structural signal only (porcelain lesson): the caller re-checks `isProvisioned` itself, never
 * trusts this function's exit code alone as proof of a healthy result, and never inspects stderr
 * prose (`repair:` diagnostic lines are expected chatter on the SUCCESS path here, not failure).
 */
function repairWorktree(top: string, boardPath: string): boolean {
  const r = runGit(top, [...RELATIVE_WORKTREE_CONFIG, "worktree", "repair", boardPath]);
  return r.status === 0;
}

/** Single-quote shell escaping for remediation commands printed in error help. */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** Single-quote escaping inside a PowerShell script literal. */
function powershellQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function moveAsideHelp(boardPath: string, note: string): string {
  if (process.platform === "win32") {
    return (
      `powershell.exe -NoProfile -NonInteractive -Command "` +
      `$ErrorActionPreference='Stop'; Move-Item -LiteralPath ${powershellQuote(boardPath)} ` +
      `-Destination ${powershellQuote(`${boardPath}.bak`)}"`
    );
  }
  return `mv ${shellQuote(boardPath)} ${shellQuote(`${boardPath}.bak`)}  # ${note}`;
}

/**
 * True when the repository is shallow (truncated history). Ancestor-containment checks are
 * unreliable there (a missing parent chain reads as "not an ancestor"), so both the local-branch
 * fast-forward adopt and the stale-marker auto-clear treat shallow as "cannot verify" and keep
 * their refusal/no-op. Fail-closed: an unreadable answer counts as shallow.
 */
export function isShallowRepository(top: string): boolean {
  const r = runGit(top, ["rev-parse", "--is-shallow-repository"]);
  return r.status !== 0 || r.stdout.trim() !== "false";
}

/**
 * The ONE unambiguous local-branch adoption for establish/window journeys: a leftover local
 * `board` branch — e.g. the committed-case establisher's own root commit after the cleanup PR
 * merged — that is a STRICT ANCESTOR of a LIVE-fetched `origin/board` is fast-forwarded to it and
 * adopted. Refusal-preserving by construction: EVERY guard failure returns false and the caller
 * keeps the `local_board` refusal verbatim (diverged, ahead, unrelated, checked out anywhere,
 * mid-rebase, shallow, dead fetch — the caller gates on the live fetch). Guards, in order:
 *   1. not a shallow repository ({@link isShallowRepository} — the ancestor check is unreliable);
 *   2. the branch is not checked out in ANY worktree, the main checkout included — adoption must
 *      never touch a checkout the user is standing on (`worktree list --porcelain`, the same
 *      version-proof structural read the add-failure fallback uses);
 *   3. no existing worktree is wedged mid-rebase FROM the branch (a rebase detaches HEAD, hiding
 *      the branch from the worktree list — read git's own rebase bookkeeping instead);
 *   4. the local tip is an ancestor of the fetched `origin/board` (strict — equality is the
 *      pre-existing `localMatchesRemote` adopt);
 *   5. the ref moves via compare-and-swap (`update-ref <new> <old>`) — a concurrent mover fails
 *      the swap and the refusal stands; nothing is ever forced.
 */
function tryFastForwardAdoptLocalBoard(top: string, localSha: string, remoteSha: string): boolean {
  if (localSha.length === 0 || remoteSha.length === 0) return false;
  if (isShallowRepository(top)) return false;
  const list = runGit(top, ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) return false;
  const lines = list.stdout.split("\n");
  if (lines.includes(`branch refs/heads/${BOARD_BRANCH}`)) return false;
  for (const wt of lines.filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length))) {
    if (!existsSync(wt)) continue; // a stale registration whose directory is gone hosts no rebase
    try {
      if (detectStaleRebase(wt) && rebaseWasFromBoardBranch(wt)) return false;
    } catch {
      return false; // unreadable worktree state proves nothing — keep the refusal
    }
  }
  if (runGit(top, ["merge-base", "--is-ancestor", localSha, remoteSha]).status !== 0) return false;
  return runGit(top, ["update-ref", `refs/heads/${BOARD_BRANCH}`, remoteSha, localSha]).status === 0;
}

/**
 * The tracked-folder REMNANT probe for establish/window journeys: the folder-removal (cleanup)
 * commit has already LANDED on this branch's remote counterpart AND this clone has already pulled
 * it, yet some board paths are STILL tracked at HEAD — a clone's own board commit, merged over the
 * removal, re-added them. In that state the window's "run 'git pull'" advice is a DEAD END (pull
 * has nothing left to deliver) and the dual-board framing is wrong (the paths are stragglers, not
 * a competing board): the only exit is untracking the remnant paths. Returns the tracked paths, or
 * null when this is NOT the remnant state (the genuine window keeps its pull-first guidance).
 */
export function trackedBoardRemnantPaths(
  top: string, bundleDir: BundleDirName = bundleDirNameForProject(top),
): string[] | null {
  const branch = currentBranch(top);
  if (branch === "HEAD" || branch === BOARD_BRANCH) return null;
  const remoteRef = `refs/remotes/${BOARD_REMOTE}/${branch}`;
  if (runGit(top, ["rev-parse", "--verify", "--quiet", remoteRef]).status !== 0) return null;
  // The removal must have LANDED on the remote tip…
  if (runGit(top, ["cat-file", "-e", `${remoteRef}:${bundleDir}`]).status === 0) return null;
  // …and this clone must have ALREADY PULLED it (otherwise pull-first is exactly right).
  if (runGit(top, ["merge-base", "--is-ancestor", remoteRef, "HEAD"]).status !== 0) return null;
  const ls = runGit(top, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", bundleDir]);
  if (ls.status !== 0) return null;
  const paths = ls.stdout.split("\0").filter((p) => p.length > 0);
  return paths.length > 0 ? paths : null;
}

/**
 * What a tracked-folder-facing-a-shared-board state should tell the user — the ONE string source
 * for the sync/provisioning refusal ({@link preShareWindowError}), channel detection
 * (`channel.ts`), and home's offline board line. Home renders this truth directly instead of a
 * "run sync" that sync then refuses. `state` is the structured discriminator the thrown
 * refusal carries in `details.state`.
 */
export interface BoardWindowGuidance {
  state: "pre-share-window" | "window-remnant";
  message: string;
  help: string;
  /** Remnant arm only: the still-tracked folder paths (full list — display capping is the consumer's). */
  trackedRemnants?: string[];
  originConfigured: boolean;
}

/** Build {@link BoardWindowGuidance} for the tracked-folder states (see {@link preShareWindowError}). */
export function boardWindowGuidance(
  top: string, originConfigured = true, bundleDir: BundleDirName = bundleDirNameForProject(top),
): BoardWindowGuidance {
  if (!originConfigured) {
    return {
      state: "pre-share-window",
      originConfigured,
      message:
        `a previously fetched '${BOARD_REF}' ref shows this project's board was shared, but no ` +
        `'${BOARD_REMOTE}' remote is configured here any more — '${bundleDir}' is still the old ` +
        `folder committed on this branch, and sync cannot pull the shared board without the remote`,
      help: `git remote add ${BOARD_REMOTE} <url>  # restore the remote, 'git pull' once the cleanup PR merges, then re-run sync`,
    };
  }
  const remnants = trackedBoardRemnantPaths(top, bundleDir);
  if (remnants !== null) {
    const plural = remnants.length !== 1;
    return {
      state: "window-remnant",
      originConfigured,
      trackedRemnants: remnants,
      message:
        `the '${BOARD_BRANCH}' branch exists on ${BOARD_REMOTE} and the folder-removal (cleanup) ` +
        `commit has already been pulled here, but ${remnants.length} ${plural ? "paths" : "path"} under ` +
        `'${bundleDir}/' ${plural ? "are" : "is"} still tracked on this branch — a board commit merged ` +
        `over the removal re-added ${plural ? "them" : "it"}, so 'git pull' has nothing left to fix: ` +
        `untrack ${plural ? "those paths" : "that path"}, then re-run sync`,
      help:
        `git rm -r --cached -- ${bundleDir} && git commit -m 'board: untrack leftover board paths', ` +
        `then mv ${bundleDir} ${bundleDir}.bak and re-run sync — it provisions the shared board; ` +
        `reconcile any docs from the backup afterwards with doc update`,
    };
  }
  return {
    state: "pre-share-window",
    originConfigured,
    message:
      `the '${BOARD_BRANCH}' branch exists on ${BOARD_REMOTE}, but '${bundleDir}' here is ` +
      `still the old folder committed on this branch — the folder-removal (cleanup) PR ` +
      `hasn't merged yet, or this clone hasn't pulled it: once it lands, run 'git pull', ` +
      `then run sync again`,
    help: "git pull  # after the cleanup PR merges, then re-run sync",
  };
}

/**
 * The pre-share-window refusal: the board branch already exists
 * on the remote, but THIS clone's checked-out branch still TRACKS the folder (the old committed
 * copy — the folder-removal PR hasn't merged, or this clone hasn't pulled it). A bare "move it
 * aside" is dangerous in exactly this state because it hand-builds the overlay hazard;
 * the only safe advice is pull-first. ONE factory so `provisionBoardWorktree` and channel
 * detection (`channel.ts`) stay verbatim-identical, mechanically.
 *
 * Two truth arms refine the default wording without changing the refusal semantics:
 *  - `originConfigured: false`: the only board-branch
 *    evidence is a PREVIOUSLY FETCHED `origin/board` ref while no `origin` remote is configured
 *    any more — the default wording would falsely claim the branch "exists on origin", and its
 *    bare `git pull` help cannot work with no remote to pull from;
 *  - the REMNANT arm ({@link trackedBoardRemnantPaths}): the removal already landed AND was
 *    pulled, so "run 'git pull'" is a dead end — the refusal names the still-tracked paths and
 *    the `git rm -r --cached` escape instead.
 */
export function preShareWindowError(top: string, boardPath: string, originConfigured = true): BoardGitError {
  const base = path.basename(boardPath);
  const bundleDir = BUNDLE_DIRS.includes(base as BundleDirName)
    ? base as BundleDirName
    : bundleDirNameForProject(top);
  const guidance = boardWindowGuidance(top, originConfigured, bundleDir);
  const details: Record<string, unknown> = { path: boardPath, state: guidance.state };
  if (!guidance.originConfigured) details.origin_configured = false;
  if (guidance.trackedRemnants) {
    const shown = guidance.trackedRemnants.slice(0, 20);
    details.tracked_remnants = { shown: shown.length, total: guidance.trackedRemnants.length, rows: shown };
  }
  return new BoardGitError("RUNTIME", guidance.message, { details, help: guidance.help });
}

/** How a non-empty, non-adoptable pre-existing conventional directory was classified. */
export type ExistingDirRefusalReason = "foreign" | "foreign_checkout" | "unrepairable" | "wrong_branch";

/**
 * The provisioning refusal for a pre-existing conventional directory that cannot be adopted, worded to
 * the case actually observed — never telling someone to move aside a worktree that repair simply
 * could not fix, or one that IS the board checkout, as if it were foreign junk. Every remedy stays
 * NON-DESTRUCTIVE (`mv`, never `rm`) — none of these reasons make the directory's CONTENT
 * worthless, only unsafe for sync to adopt automatically. ONE factory so the CLI's sync-outcome
 * table can enumerate the four arms against provisioning's own bytes.
 */
export function existingDirRefusal(reason: ExistingDirRefusalReason, boardPath: string, top: string): BoardGitError {
  const bundleDir = path.basename(boardPath);
  const messages: Record<ExistingDirRefusalReason, { message: string; help: string }> = {
    foreign: {
      message: `a non-empty '${bundleDir}' directory already exists at ${boardPath} but is not the shared board checkout — move it aside, then re-run sync`,
      help: moveAsideHelp(boardPath, "then re-run sync; reconcile any local-only docs afterwards"),
    },
    foreign_checkout: {
      message: `'${bundleDir}' at ${boardPath} is git checkout machinery, but it belongs to a different git repository than ${top} — move it aside, then re-run sync to provision this repo's board from origin/board`,
      help: moveAsideHelp(boardPath, "then re-run sync; the existing checkout is untouched, just relocated"),
    },
    unrepairable: {
      message: `'${bundleDir}' at ${boardPath} looks like the board checkout with stale pointers that 'git worktree repair' could not fix (its git-internal registration is likely gone) — move it aside, then re-run sync to re-provision fresh from origin/board`,
      help: moveAsideHelp(boardPath, "then re-run sync; recover any local-only, unpushed docs from the backup afterwards"),
    },
    wrong_branch: {
      message: `'${bundleDir}' at ${boardPath} is git checkout machinery (a linked worktree or nested repo), but it is not checked out to the '${BOARD_BRANCH}' branch (nor mid-rebase from it) — it is likely used for something else — move it aside, then re-run sync to re-provision the board fresh from origin/board`,
      help: moveAsideHelp(boardPath, "then re-run sync; the existing checkout is untouched, just relocated"),
    },
  };
  return new BoardGitError("RUNTIME", messages[reason].message, {
    details: { path: boardPath },
    help: messages[reason].help,
  });
}

/**
 * SELF-HEALING board-worktree provisioning:
 * `git fetch --prune origin` runs BEFORE `board` is referenced (best-effort: offline provisioning still
 * works from a previously fetched `origin/board`); worktree absent but a board ref exists → a
 * fresh `git worktree add`; a pre-existing NON-EMPTY selected bundle directory that is NOT the board
 * worktree is REFUSED with guidance (never a blind add — a pre-existing EMPTY directory is the one
 * resolvable case, removed so the add can proceed); "already checked out" from git = idempotent
 * success. The `--no-track` add reproduces the no-tracking-config state a shared board can arrive
 * in — which is exactly why every other op uses EXPLICIT `origin/board` refs.
 *
 * Worktree portability: a fresh `add` writes relative pointers
 * ({@link RELATIVE_WORKTREE_CONFIG}, git >= 2.48; silently ignored on older git — no version
 * probing). And a pre-existing NON-EMPTY directory that carries a worktree signature (a `.git`
 * FILE — {@link hasWorktreeSignature}) is NOT automatically foreign: it may be a genuine board
 * worktree whose pointers went stale because the enclosing repo was mounted at a different path
 * (a sandbox/devcontainer/CI checkout). Before refusing, attempt {@link repairWorktree} and
 * re-check {@link repairedWorktreeIsBoard} — only when that STILL fails does the refusal fire,
 * worded to name what was actually observed (never telling someone to move aside a worktree that
 * repair simply could not fix, or one that genuinely IS the board checkout, as if either were a
 * directory that was never git's business to begin with).
 */
export interface NetworkBudgetOptions {
  /** Budget for the op's `git fetch` (default {@link NETWORK_TIMEOUT_MS}); callers may slice it. */
  fetchTimeoutMs?: number;
  /** ssh ConnectTimeout override, in seconds — see {@link RunOptions.connectTimeoutSeconds}. */
  connectTimeoutSeconds?: number;
  /** False prevents a branch named `board` from being adopted without explicit user consent. */
  allowLocalBranch?: boolean;
  /** Ensure every recognized conventional bundle name is ignored in the code worktree. */
  ensureIgnore?: boolean;
}

export function provisionBoardWorktree(dir: string, budget: NetworkBudgetOptions = {}): ProvisionOutcome {
  const top = repoTopLevel(dir);
  if (!top) return { kind: "no_repo" };
  const bundleDir = bundleDirNameForProject(top);
  const boardPath = path.join(top, bundleDir);
  const withIgnoreCoverage = <T extends { boardPath: string }>(outcome: T): T & { gitignore?: GitignoreUpdate } => {
    if (!budget.ensureIgnore) return outcome;
    const gitignore = ensureBoardGitignoreWorkingTree(top);
    return gitignore.changed ? { ...outcome, gitignore } : outcome;
  };
  if (isProvisioned(top)) return withIgnoreCoverage({ kind: "already" as const, boardPath });

  // Probe the board ref explicitly: a clone's configured fetch refspec may exclude it.
  const hasOrigin = runGit(top, ["remote", "get-url", BOARD_REMOTE]).status === 0;
  const deadline = Date.now() + (budget.fetchTimeoutMs ?? NETWORK_TIMEOUT_MS);
  const networkOptions = (): RunOptions => ({
    timeoutMs: Math.max(0, deadline - Date.now()),
    connectTimeoutSeconds: budget.connectTimeoutSeconds,
  });
  const runNetwork = (args: string[]): GitRunResult | null => {
    try {
      return runGit(top, args, networkOptions());
    } catch (err) {
      if (isBoardGitError(err) && err.code === "TRANSIENT") return null;
      throw err;
    }
  };
  let remoteState: "absent" | "unknown" = "absent";
  let remoteBoardKnownAbsent = false;
  // True only when THIS run's fetch of origin/board succeeded — the fast-forward adopt below is
  // gated on a live view (a stale ref must never drive a ref move; dead fetch keeps the refusal).
  let liveFetch = false;
  if (hasOrigin) {
    const probe = runNetwork([
      "ls-remote",
      "--exit-code",
      BOARD_REMOTE,
      `refs/heads/${BOARD_BRANCH}`,
    ]);
    if (probe?.status === 0) {
      // Exact `board` cannot coexist remotely with `board/*`; any local children are stale.
      const children = runGit(top, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/remotes/${BOARD_REF}/`,
      ]);
      let namespaceReady = children.status === 0;
      for (const child of children.stdout.split("\n").filter(Boolean)) {
        if (runGit(top, ["update-ref", "-d", child]).status !== 0) namespaceReady = false;
      }
      if (namespaceReady) {
        const fetch = runNetwork([
          "fetch",
          "--prune",
          "--no-tags",
          BOARD_REMOTE,
          `+refs/heads/${BOARD_BRANCH}:refs/remotes/${BOARD_REF}`,
        ]);
        remoteState = fetch?.status === 0 ? "absent" : "unknown";
        liveFetch = fetch?.status === 0;
      } else {
        remoteState = "unknown";
      }
    } else if (probe?.status === 2) {
      remoteBoardKnownAbsent = true;
      runGit(top, ["update-ref", "-d", `refs/remotes/${BOARD_REF}`]);
    } else {
      remoteState = "unknown";
    }
  }

  const localBoard = runGit(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${BOARD_BRANCH}`]);
  const remoteBoard = runGit(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]);
  const hasLocal = localBoard.status === 0;
  const hasRemote = remoteBoard.status === 0 && !remoteBoardKnownAbsent;
  const localMatchesRemote =
    hasLocal &&
    hasRemote &&
    localBoard.stdout.trim().length > 0 &&
    localBoard.stdout.trim() === remoteBoard.stdout.trim();
  if (!hasLocal && !hasRemote) {
    return {
      kind: "no_board",
      remoteState,
    };
  }

  // The establisher's "git pull, then sync" receipt chain
  // must survive a teammate advancing origin/board in the window. A leftover local branch that is
  // a STRICT ANCESTOR of a LIVE-fetched origin/board fast-forwards and is adopted; every other
  // shape keeps the `local_board` refusal verbatim. Memoized: the two refusal sites below share
  // ONE ref-move attempt.
  let ffAdopted: boolean | undefined;
  const adoptLocalBoard = (): boolean => {
    if (ffAdopted === undefined) {
      ffAdopted =
        hasRemote &&
        liveFetch &&
        tryFastForwardAdoptLocalBoard(top, localBoard.stdout.trim(), remoteBoard.stdout.trim());
    }
    return ffAdopted;
  };

  if (existsSync(boardPath)) {
    if (readdirSync(boardPath).length > 0) {
      // The PRE-SHARE WINDOW (see {@link preShareWindowError} for the full hazard story): the
      // generic "move it aside" advice below must never fire while the checked-out branch still
      // TRACKS the folder and the board branch exists on the remote.
      if (
        hasRemote &&
        !hasWorktreeSignature(boardPath) &&
        runGit(top, ["cat-file", "-e", `HEAD:${bundleDir}`]).status === 0
      ) {
        throw preShareWindowError(top, boardPath, hasOrigin);
      }
      // Non-empty and (per isProvisioned above) not currently a genuine `board` checkout: it may
      // STILL be the real board worktree, just wedged with stale pointers — try the structural
      // self-heal FIRST, reachable ONLY because the worktree signature is present (never for a
      // plain foreign directory — the never-touch guarantee).
      const hadSignature = hasWorktreeSignature(boardPath);
      let reason: ExistingDirRefusalReason = "foreign";
      if (hadSignature) {
        if (worktreeRootResolves(boardPath) && !sameGitCommonDir(boardPath, top)) {
          reason = "foreign_checkout";
        } else {
          repairWorktree(top, boardPath);
        }
        // repairedWorktreeIsBoard, NOT a bare worktreeRootResolves/isProvisioned: repair's job is
        // fixing POINTERS, not un-wedging a rebase (a worktree ALSO wedged mid-rebase stays on a
        // DETACHED HEAD until healed — the heal-ordering edge, the caller re-runs the entry heal
        // once it sees `repaired`) — but a bare pointer-resolves check is NOT sufficient proof this
        // is genuinely the board checkout at all (`git worktree repair` is a
        // safe no-op on an ALREADY-healthy worktree regardless of which branch it's on, so a
        // sidecar worktree someone genuinely uses for something else, or one merely left on a
        // plain detached HEAD, would otherwise be silently misreported as "repaired").
        if (repairedWorktreeIsBoard(boardPath, top)) {
          return withIgnoreCoverage({ kind: "repaired" as const, boardPath });
        }
        if (reason !== "foreign_checkout") {
          if (worktreeRootResolves(boardPath) && !sameGitCommonDir(boardPath, top)) {
            reason = "foreign_checkout";
          } else {
            reason = worktreeRootResolves(boardPath) ? "wrong_branch" : "unrepairable";
          }
        }
      }
      // REFUSE, worded to the case actually observed (see {@link existingDirRefusal}).
      throw existingDirRefusal(reason, boardPath, top);
    }
    if (hasLocal && budget.allowLocalBranch === false && !localMatchesRemote && !adoptLocalBoard()) {
      return { kind: "local_board", boardPath, remoteExists: hasRemote };
    }
    // The one resolvable pre-existing state: an EMPTY directory. Remove it so worktree add can
    // create the path itself.
    rmdirSync(boardPath);
  }

  // A branch name alone is not provenance. Interactive sync and SessionStart adopt an
  // unprovisioned local branch only when its commit exactly equals the freshly-pruned remote ref,
  // OR when it is a strict ancestor of a LIVE-fetched origin/board (the establisher's own leftover
  // branch once the share window closes — fast-forwarded before adoption, {@link
  // tryFastForwardAdoptLocalBoard}); everything else refuses, so an unrelated/private branch is
  // never guessed at.
  if (hasLocal && budget.allowLocalBranch === false && !localMatchesRemote && !adoptLocalBoard()) {
    return { kind: "local_board", boardPath, remoteExists: hasRemote };
  }

  // Creation normally targets `.superbee`. The only legacy create site is load-bearing recovery:
  // an interrupted establish moved the valid legacy bundle to its deterministic backup before
  // worktree creation. Keep this assertion next to the mutation so broadening legacy selection
  // cannot silently turn ordinary fresh clones into new `.agentstate-lite` layouts.
  if (
    bundleDir === LEGACY_BUNDLE_DIR &&
    recognizedBundlePath(LEGACY_BUNDLE_DIR, `${boardPath}.establish-backup`) === null
  ) {
    throw new BoardGitError(
      "RUNTIME",
      `refusing to create '${LEGACY_BUNDLE_DIR}/' without a valid establish recovery backup`,
      { details: { path: boardPath, state: "legacy-create-without-recovery-backup" } },
    );
  }

  const r = hasLocal
    ? runGit(top, [...RELATIVE_WORKTREE_CONFIG, "worktree", "add", boardPath, BOARD_BRANCH])
    : runGit(top, [
        ...RELATIVE_WORKTREE_CONFIG,
        "worktree",
        "add",
        "--no-track",
        "-b",
        BOARD_BRANCH,
        boardPath,
        `refs/remotes/${BOARD_REF}`,
      ]);
  if (r.status !== 0) {
    // The branch is already checked out (somewhere): the checkout EXISTS — idempotent success.
    // STRUCTURAL check, not message-matching: git's refusal phrasing changed across versions
    // ("already checked out" ≤2.47, "already used by worktree" ≥2.48), and LC_ALL=C pins locale
    // but not version. `worktree list --porcelain` names the checked-out branch of every
    // worktree in a stable machine format — version-proof.
    const list = runGit(top, ["worktree", "list", "--porcelain"]);
    if (list.status === 0 && list.stdout.split("\n").includes(`branch refs/heads/${BOARD_BRANCH}`)) {
      return withIgnoreCoverage({ kind: "already" as const, boardPath });
    }
    throw classifyGitError(failureOf(["worktree", "add"], r));
  }
  // A fast-forward-adopted branch's tip IS the fetched origin/board, so `remote` is the truthful
  // provenance for its announcement; a branch adopted as-is (equal, or the explicit-establish
  // path) keeps `local`.
  return withIgnoreCoverage({
    kind: "provisioned" as const,
    boardPath,
    source: hasLocal && ffAdopted !== true ? "local" as const : "remote" as const,
  });
}

// ── stale-rebase self-heal primitives consumed at sync entry ───────────────────

/** True when the board worktree is wedged mid-rebase (a crash/kill left `rebase-merge` behind). */
export function detectStaleRebase(boardPath: string): boolean {
  return (
    existsSync(worktreeGitPath(boardPath, "rebase-merge")) ||
    existsSync(worktreeGitPath(boardPath, "rebase-apply"))
  );
}

/** Abort the wedged rebase, restoring the pre-rebase worktree. */
export function abortStaleRebase(boardPath: string): void {
  mustGit(boardPath, ["rebase", "--abort"], { rebase: true });
}

// ── doc-change vocabulary ─────────────────────────────────────────────────────

export type DocVerb = "added" | "updated" | "deleted";

/**
 * One board doc's change, ENRICHED from its own frontmatter. `actor` is read PER-DOC FROM
 * FRONTMATTER — never from a commit subject or git author, because commit metadata is a human
 * mirror rather than the attribution source.
 */
export interface DocChange {
  docId: string;
  actor: string;
  verb: DocVerb;
  kind: string;
  title: string;
}

const UNKNOWN = "unknown";

/** Non-empty trimmed string, else the `unknown` placeholder. */
function fmString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : UNKNOWN;
}

/** True when a repo-relative path is a concept document (a non-reserved `.md`). */
export function isConceptDocPath(relPath: string): boolean {
  return relPath.endsWith(".md") && !isReservedFile(relPath);
}

/**
 * Parse `--name-status -z --no-renames` output into `[statusLetter, path]` pairs. Every record is
 * exactly two NUL-terminated fields (status, then path) — `--no-renames` guarantees no third
 * (old-path) field ever appears. NUL framing is raw and unquoted BY DEFINITION (matching the
 * conflict list's `--name-only -z`), so a path carrying a TAB, newline, or any other byte a
 * human-format `\t`/`\n`-delimited parse would mis-split (or, once C-quoted, round-trip WRONG)
 * comes through correctly. Only the trailing empty field git emits after the final NUL is
 * dropped — an interior empty field is never assumed to be a filler and would misalign the
 * pairing instead of being silently skipped.
 */
export function nameStatusRows(out: string): Array<{ letter: string; relPath: string }> {
  const fields = out.split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  const rows: Array<{ letter: string; relPath: string }> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const letter = (fields[i] ?? "").trim().charAt(0);
    const relPath = fields[i + 1] ?? "";
    if (letter.length > 0 && relPath.length > 0) rows.push({ letter, relPath });
  }
  return rows;
}

/** Map a name-status letter to the doc verb (`T` type-change reads as an update). */
export function verbOf(letter: string): DocVerb | null {
  if (letter === "A") return "added";
  if (letter === "M" || letter === "T") return "updated";
  if (letter === "D") return "deleted";
  return null;
}

/**
 * Build the enriched {@link DocChange} for one changed doc by parsing the frontmatter of the doc's
 * content AT `rev` (a `<rev>:<path>` readable by `git show` — the stage for a pending commit, HEAD
 * for a landed change, the old tip for a deletion). Malformed frontmatter degrades to `unknown`
 * fields — a corrupt doc must never block a commit or the feed. `idPath` (default: `relPath`)
 * names the BUNDLE-relative path the doc id derives from — `git show` always reads the full
 * repo-relative `relPath`, so a prefix-scoped diff strips its prefix from the id only.
 */
export function enrichDocChange(
  boardPath: string,
  relPath: string,
  verb: DocVerb,
  rev: string,
  runOptions: RunOptions = {},
  idPath: string = relPath,
): DocChange {
  const docId = conceptIdFromPath(idPath);
  let actor = UNKNOWN;
  let kind = UNKNOWN;
  let title = docId;
  const shown = runGit(boardPath, ["show", `${rev}:${relPath}`], runOptions);
  if (shown.status === 0) {
    try {
      const { frontmatter } = parseMarkdown(shown.stdout, relPath);
      actor = mutationActorFromFrontmatter(frontmatter) ?? UNKNOWN;
      kind = fmString(frontmatter.type);
      const t = fmString(frontmatter.title);
      if (t !== UNKNOWN) title = t;
    } catch {
      // MalformedDocumentError: keep the unknown placeholders.
    }
  }
  return { docId, actor, verb, kind, title };
}

// ── stage + commit (the commit grammar) ───────────────────────────────────────

export interface CommitResult {
  committed: boolean;
  /** Present when committed. */
  sha?: string;
  /** The commit subject actually written (grammar below) — for envelopes/tests, never re-parsed. */
  subject?: string;
  /** The enriched per-doc changes that were committed (empty for a reserved-file-only commit). */
  docs: DocChange[];
}

/**
 * The change set's single named actor — the same rule {@link commitSubject} names an actor by:
 * exactly one distinct actor across every doc change. `undefined` for zero docs (nothing to name)
 * or more than one distinct actor (ambiguous) — {@link identityFlags}'s literal fallback covers
 * both, so the commit-identity fallback never invents a false single actor.
 */
function primaryActor(docs: DocChange[]): string | undefined {
  if (docs.length === 0) return undefined;
  const actors = [...new Set(docs.map((d) => d.actor))];
  return actors.length === 1 ? actors[0] : undefined;
}

/**
 * The commit-subject grammar (test-pinned): stable `board:` prefix; single-doc
 * `board: <actor> — <verb> <id>`; multi-doc single-actor `board: <actor> — N docs` (NEVER
 * "1 docs" — one doc always takes the single-doc form); multi-actor `board: N docs from M actors`
 * (the subject names an actor only when exactly one). A commit that touches ONLY reserved files
 * (index.md/log.md regeneration) gets the stable maintenance subject.
 */
function commitSubject(docs: DocChange[]): string {
  if (docs.length === 0) return "board: bundle maintenance";
  const first = docs[0]!;
  if (docs.length === 1) return `board: ${first.actor} — ${first.verb} ${first.docId}`;
  const single = primaryActor(docs);
  if (single) return `board: ${single} — ${docs.length} docs`;
  const actorCount = new Set(docs.map((d) => d.actor)).size;
  return `board: ${docs.length} docs from ${actorCount} actors`;
}

/**
 * Stage EVERYTHING in the board worktree (`add -A` — the worktree carries only the bundle, so
 * path-scoping is by construction) and commit it with the grammar subject plus a per-doc
 * verb-kind-id list in the BODY (the `git log board` activity feed — human mirror, NEVER parsed
 * back). Skips (idempotent no-op) when nothing is staged. The message travels via `-F -` on stdin
 * — no shell interpolation, no argv-length ceiling. `--no-verify` keeps user hook policy (and any
 * interactive hook) off the machine-managed board branch — hooks configured for the main worktree
 * are shared config in a linked worktree and could otherwise reject or hang the sync commit.
 */
export function stageAndCommit(boardPath: string): CommitResult {
  mustGit(boardPath, ["add", "-A"]);
  if (runGit(boardPath, ["diff", "--cached", "--quiet"]).status === 0) {
    return { committed: false, docs: [] };
  }

  const rows = nameStatusRows(mustGit(boardPath, ["diff", "--cached", "--name-status", "--no-renames", "-z"]));
  const docs: DocChange[] = [];
  for (const { letter, relPath } of rows) {
    if (!isConceptDocPath(relPath)) continue;
    const verb = verbOf(letter);
    if (!verb) continue;
    // A pending doc's frontmatter is read from the STAGE (`:0:` — the exact bytes being
    // committed); a deletion's from the outgoing HEAD version.
    docs.push(enrichDocChange(boardPath, relPath, verb, verb === "deleted" ? "HEAD" : ":0"));
  }

  const subject = commitSubject(docs);
  const bodyLines =
    docs.length > 0
      ? docs.map((d) => `${d.verb} ${d.kind} ${d.docId}`)
      : rows.map((r) => `${r.letter} ${r.relPath}`);
  const message = `${subject}\n\n${bodyLines.join("\n")}\n`;
  mustGit(
    boardPath,
    [...identityFlags(boardPath, primaryActor(docs)), "commit", "--no-verify", "-F", "-"],
    { input: message },
  );
  const sha = mustGit(boardPath, ["rev-parse", "HEAD"]).trim();
  return { committed: true, sha, subject, docs };
}

/** A root commit assembled from a plain bundle without touching the real index or worktree. */
export interface BundleSnapshotCommit extends CommitResult {
  committed: true;
  sha: string;
  tree: string;
}

/** Enumerate the exact filesystem entries Git must capture; never follow symlinked directories. */
function snapshotFilesystemFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.toLowerCase() === ".git") {
        throw new BoardGitError(
          "RUNTIME",
          `the bundle contains nested git control data at '${relPath}' — establish refuses because ` +
            `Git can silently omit or collapse files below that boundary`,
          { details: { nested_git_paths: [relPath] } },
        );
      }
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relPath);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relPath);
      else {
        throw new BoardGitError(
          "RUNTIME",
          `the bundle contains an unsupported filesystem entry at '${relPath}' — only files, ` +
            `directories, and symbolic links can be established safely`,
        );
      }
    }
  };
  visit(root, "");
  return files.sort();
}

/**
 * Assert that a bundle directory's raw file/symlink bytes equal a commit, bypassing Git's clean
 * and smudge views. This guards the destructive establishment boundary: attributes, EOL policy,
 * and configured filters must never make a successful conversion discard the user's source bytes.
 */
export function assertBundleBytesMatchCommit(top: string, bundlePath: string, commit: string): void {
  const listed = runGit(top, ["ls-tree", "-r", "-z", commit]);
  if (listed.status !== 0) throw classifyGitError(failureOf(["ls-tree", "-r", "-z", commit], listed));
  const mismatches: string[] = [];
  for (const row of listed.stdout.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    const relPath = row.slice(tab + 1);
    const absolute = path.resolve(bundlePath, relPath);
    if (!absolute.startsWith(`${path.resolve(bundlePath)}${path.sep}`)) {
      mismatches.push(relPath);
      continue;
    }
    if (type !== "blob" || !oid) {
      mismatches.push(relPath);
      continue;
    }
    const stored = runGitBytes(top, ["cat-file", "blob", oid]);
    if (stored.status !== 0) {
      throw classifyGitError({
        args: ["cat-file", "blob", oid],
        status: stored.status,
        stdout: stored.stdout.toString("utf8"),
        stderr: stored.stderr,
      });
    }
    try {
      const stat = lstatSync(absolute);
      const actual = mode === "120000" ? readlinkSync(absolute, { encoding: "buffer" }) : readFileSync(absolute);
      if ((mode === "120000" && !stat.isSymbolicLink()) || (mode !== "120000" && !stat.isFile())) {
        mismatches.push(relPath);
      } else if (!Buffer.from(actual).equals(stored.stdout)) {
        mismatches.push(relPath);
      }
    } catch {
      mismatches.push(relPath);
    }
  }
  if (mismatches.length > 0) {
    throw new BoardGitError(
      "RUNTIME",
      `bundle bytes differ from the Git snapshot at '${mismatches[0]}' — a Git attribute, ` +
        `clean/smudge filter, EOL rule, or concurrent writer may be rewriting content; no source backup was removed`,
      { details: { byte_mismatches: mismatches.slice(0, 20) } },
    );
  }
}

/**
 * Snapshot a PLAIN bundle directory as a root commit using an isolated temporary Git index.
 *
 * This is the safe half of greenfield establishment: the source directory is read-only, the code
 * worktree/index are untouched, and no `board` ref is created. The returned commit is initially
 * unreachable except by its SHA; the caller either publishes that exact commit or lets normal Git
 * object pruning collect it later. The commit message uses the same grammar as
 * {@link stageAndCommit}, including per-document actor enrichment from the temporary stage.
 */
export function snapshotBundleCommit(top: string, bundlePath: string): BundleSnapshotCommit {
  const gitDir = mustGit(top, ["rev-parse", "--absolute-git-dir"]).trim();
  const filesystemFiles = snapshotFilesystemFiles(bundlePath);
  const scratch = mkdtempSync(path.join(tmpdir(), "aslite-establish-index-"));
  const indexFile = path.join(scratch, "index");
  const snapshotOptions: RunOptions = { gitDir, workTree: bundlePath, indexFile };
  try {
    mustGit(bundlePath, ["read-tree", "--empty"], snapshotOptions);
    // A project commonly ignores its bundle directory, and users may also carry broad global or
    // info/exclude rules. Establish snapshots the explicit bundle source, so ignore policy must
    // not silently drop otherwise-valid bundle files from the first published commit.
    mustGit(
      bundlePath,
      [
        // The snapshot contract is the source's literal bytes. A Windows user's ambient
        // core.autocrlf setting is a checkout preference, not bundle policy, so neutralize it at
        // this one plumbing boundary. Explicit attributes and clean filters remain active and are
        // still caught by assertBundleBytesMatchCommit below.
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.sparseCheckout=false",
        "-c",
        "core.sparseCheckoutCone=false",
        "add",
        "-f",
        "-A",
        "--",
        ".",
      ],
      snapshotOptions,
    );
    const stagedRows = mustGit(bundlePath, ["ls-files", "--stage", "-z"], snapshotOptions)
      .split("\0")
      .filter(Boolean);
    const gitlinks = stagedRows
      .filter((row) => row.startsWith("160000 "))
      .map((row) => row.slice(row.indexOf("\t") + 1));
    if (gitlinks.length > 0) {
      throw new BoardGitError(
        "RUNTIME",
        `the bundle contains nested git checkout machinery at '${gitlinks[0]}' — establish ` +
          `refuses because Git would publish only a gitlink and omit that directory's files`,
        { details: { nested_git_paths: gitlinks } },
      );
    }
    const stagedFiles = stagedRows.map((row) => row.slice(row.indexOf("\t") + 1)).sort();
    if (
      stagedFiles.length !== filesystemFiles.length ||
      stagedFiles.some((file, index) => file !== filesystemFiles[index])
    ) {
      const staged = new Set(stagedFiles);
      const filesystem = new Set(filesystemFiles);
      throw new BoardGitError("RUNTIME", "Git did not capture every bundle file; nothing was published", {
        details: {
          omitted_paths: filesystemFiles.filter((file) => !staged.has(file)).slice(0, 20),
          unexpected_paths: stagedFiles.filter((file) => !filesystem.has(file)).slice(0, 20),
        },
      });
    }
    const tree = mustGit(bundlePath, ["write-tree"], snapshotOptions).trim();
    const emptyTree = mustGit(top, ["mktree"], { input: "" }).trim();
    const rows = nameStatusRows(
      mustGit(
        bundlePath,
        ["diff", "--cached", "--name-status", "--no-renames", "-z", emptyTree],
        snapshotOptions,
      ),
    );
    const docs: DocChange[] = [];
    for (const { letter, relPath } of rows) {
      if (!isConceptDocPath(relPath)) continue;
      const verb = verbOf(letter);
      if (!verb) continue;
      docs.push(enrichDocChange(bundlePath, relPath, verb, ":0", snapshotOptions));
    }
    const subject = commitSubject(docs);
    const bodyLines =
      docs.length > 0
        ? docs.map((d) => `${d.verb} ${d.kind} ${d.docId}`)
        : rows.map((r) => `${r.letter} ${r.relPath}`);
    const message = `${subject}\n\n${bodyLines.join("\n")}\n`;
    const sha = mustGit(top, [...identityFlags(top, primaryActor(docs)), "commit-tree", tree], {
      input: message,
    }).trim();
    assertBundleBytesMatchCommit(top, bundlePath, sha);
    return { committed: true, sha, tree, subject, docs };
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ── fetch + rebase (conflict = detect only) ───────────────────────────────────

export type FetchRebaseOutcome =
  | { status: "clean" }
  /**
   * A same-doc divergence was DETECTED: the conflicted ids were collected and the rebase was
   * ABORTED — the worktree is pristine, nothing moved. Conflicted concept docs report their doc
   * id; a conflicted reserved/non-doc path reports its repo-relative path verbatim.
   */
  | { status: "conflict"; conflictedDocIds: string[] };

/**
 * `git fetch --prune origin` then `git rebase origin/board` (explicit ref; editors forced non-interactive).
 * On conflict: collect `diff --name-only --diff-filter=U`, `rebase --abort`, and REPORT — zero
 * data movement. Any other rebase failure (it should not
 * happen on the sync path — full sync commits first, so the rebase starts clean) is classified
 * and thrown.
 */
export function fetchRebase(boardPath: string): FetchRebaseOutcome {
  mustGit(boardPath, ["fetch", "--prune", BOARD_REMOTE], { timeoutMs: NETWORK_TIMEOUT_MS });
  // Computed ONCE and reused for every rebase invocation below (never `--abort`, which commits
  // nothing): a replayed commit needs COMMITTER identity too, the same failure class as a plain
  // commit — see porcelain.ts's module header site map.
  const idFlags = identityFlags(boardPath);
  const r = runGit(boardPath, [...idFlags, "rebase", BOARD_REF], {
    rebase: true,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (r.status === 0) return { status: "clean" };
  if (detectStaleRebase(boardPath)) {
    const conflicted = mustGit(boardPath, ["diff", "--name-only", "--diff-filter=U"])
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((p) => (isConceptDocPath(p) ? conceptIdFromPath(p) : p));
    mustGit(boardPath, ["rebase", "--abort"], { rebase: true });
    return { status: "conflict", conflictedDocIds: conflicted };
  }
  throw classifyGitError(failureOf(["rebase", BOARD_REF], r));
}

// ── fetch + rebase, converging ────────────────────────────────────────────────

/** One conflicted file the converging rebase resolved (keep-upstream + export-local). */
export interface ResolvedConflict {
  /** The repo-relative path of the conflicted file. */
  relPath: string;
  /** The doc id for a concept doc; the repo-relative path VERBATIM for a reserved/non-doc file. */
  entry: string;
  /**
   * True when `entry` is a concept-doc id — the authoritative doc-vs-raw discriminator derived
   * from the path shape at resolution time. Consumers must branch on this,
   * never re-derive from the entry string (a dotted doc id like `notes/v1.2` is
   * indistinguishable from a raw path by string shape alone).
   */
  isDoc: boolean;
  /**
   * Absolute path of the exported local version — the full-fidelity artifact containing the
   * blob's exact bytes — or null when the local side had no content to save (the local
   * commit DELETED the file — no stage-3 blob exists).
   */
  exportPath: string | null;
  /**
   * Absolute path of the exported local version's body only: the artifact
   * the reconcile chain's `doc update <id> --body-file <file>` can consume LITERALLY —
   * `--body-file` treats its input as a body, so feeding it the full export would nest the YAML
   * frontmatter into the body. Written only for a concept doc whose local blob parses as OKF
   * markdown; null otherwise (raw/reserved files, local deletions, unparseable blobs).
   */
  bodyExportPath: string | null;
}

export type FetchRebaseResolvingOutcome =
  | { status: "clean" }
  /**
   * Same-doc conflicts were RESOLVED by the converging mechanic (upstream kept, local exported)
   * and the rebase COMPLETED — the worktree is never left mid-state; non-conflicted local commits
   * landed on top of `origin/board`. One entry per conflicted file (deduped across rebase stops:
   * a doc conflicting at several stops keeps its LAST export — the local FINAL content).
   */
  | { status: "resolved"; conflicts: ResolvedConflict[] }
  /**
   * The fetch SUCCEEDED (a live, current view of the remote), but `origin/board` still doesn't
   * resolve — there is nothing to rebase onto because nobody has published this local branch.
   * The command layer refuses ordinary sync and routes the user to explicit `sync --establish`.
   * Distinct from a dead/misconfigured remote, which throws from the fetch above.
   */
  | { status: "no_upstream" };

/**
 * Backstop against a converging loop that stops making progress (should be impossible: every
 * iteration either completes a replayed commit or `--skip`s one, and the todo list is finite).
 */
const MAX_REBASE_STOPS = 1000;

/**
 * `git fetch --prune origin` then `git rebase origin/board`, RESOLVING same-doc conflicts with the
 * converging mechanic ({@link fetchRebase} keeps its detect-only shape for consumers that must
 * never move data).
 *
 * WARNING — rebase INVERTS ours/theirs. Replaying local commits ONTO origin/board makes
 * HEAD/stage-2 ("ours") the UPSTREAM version and stage-3 ("theirs") YOUR local version. That
 * inversion is why every step below uses EXPLICIT refs (`origin/board`, `:3:`) and NEVER
 * `--ours`/`--theirs`.
 *
 * The test-pinned sequence for each conflicted `<path>`:
 *   1. `git show :3:<path> > <export-file>` — FIRST (`:3:` = theirs-in-rebase = the LOCAL
 *      version → this is "yours saved").
 *   2. `git checkout origin/board -- <path>` — keep the UPSTREAM (teammate's) version.
 *   3. `git add -- <path>`.
 * Then advance non-interactively: `GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true git rebase --continue`
 * (the `rebase: true` env invariant), LOOPING the whole block until the rebase state
 * (`rev-parse --git-path rebase-merge` / `rebase-apply`) is GONE — multiple local commits each
 * stop the rebase. Two states the verbatim sequence meets in practice are handled explicitly:
 *   - a replayed commit whose EVERY change was a conflicted path now kept at upstream becomes
 *     EMPTY; `rebase --continue` refuses it, so a stop with NO unmerged files advances with
 *     `git rebase --skip` (the commit's content lives on in the export file);
 *   - a side that has no blob for the path (local deleted it → no stage 3: nothing to export;
 *     upstream deleted it → keep-upstream means `git rm -- <path>`).
 * On ANY unexpected failure mid-loop the rebase is ABORTED before rethrowing — the worktree is
 * never left mid-state on any path.
 *
 * Export files land at `<exportDir>/<relPath>` with the blob's exact bytes and a
 * `<relPath minus .md>.body.md` body-only companion for parseable concept docs. The companion is
 * the `doc update --body-file` input. Created 0700/0600; the caller passes a
 * per-bundle dir OUTSIDE the worktree (see cursor.ts `syncExportsDir`).
 */
export function fetchRebaseResolving(boardPath: string, exportDir: string): FetchRebaseResolvingOutcome {
  mustGit(boardPath, ["fetch", "--prune", BOARD_REMOTE], { timeoutMs: NETWORK_TIMEOUT_MS });
  // The fetch above is a LIVE view of origin, but there is no `origin/board` to rebase onto —
  // checked structurally (not by parsing rebase's failure prose) so this never collides with the
  // conflict-detection loop below.
  if (runGit(boardPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]).status !== 0) {
    return { status: "no_upstream" };
  }
  // Computed ONCE and reused for every rebase invocation in this function (never `--abort`, which
  // commits nothing): a replayed commit needs COMMITTER identity too, the same failure class as a
  // plain commit — see porcelain.ts's module header site map.
  const idFlags = identityFlags(boardPath);
  const r = runGit(boardPath, [...idFlags, "rebase", BOARD_REF], { rebase: true, timeoutMs: NETWORK_TIMEOUT_MS });
  if (r.status === 0) return { status: "clean" };
  if (!detectStaleRebase(boardPath)) throw classifyGitError(failureOf(["rebase", BOARD_REF], r));

  // `-z` NUL framing: the conflict list is the one parse whose corruption
  // means a STUCK LOOP (a mis-parsed path fails `show :3:`/`checkout`/`rm` on every iteration),
  // so it must be robust even against names the tab/newline-split parsers can't express — NUL
  // output is raw and unquoted BY DEFINITION, independent of any quotepath setting.
  const listConflicted = (): string[] =>
    mustGit(boardPath, ["diff", "--name-only", "-z", "--diff-filter=U"])
      .split("\0")
      .filter((l) => l.length > 0);

  const byPath = new Map<string, ResolvedConflict>();
  try {
    let stops = 0;
    while (detectStaleRebase(boardPath)) {
      if (++stops > MAX_REBASE_STOPS) {
        throw new BoardGitError(
          "RUNTIME",
          `sync's converging rebase did not terminate after ${MAX_REBASE_STOPS} stops — aborting to leave the board unchanged`,
        );
      }
      const conflicted = listConflicted();
      if (conflicted.length === 0) {
        // No unmerged files at this stop: the replayed commit became EMPTY (every change it
        // carried was a conflicted path kept at upstream) — drop it. `--skip` may itself stop on
        // the NEXT commit's conflict (tolerated nonzero); the loop handles that stop normally.
        runGit(boardPath, [...idFlags, "rebase", "--skip"], { rebase: true });
        continue;
      }
      for (const relPath of conflicted) {
        // 1. EXPORT yours FIRST: `:3:` = theirs-in-rebase = the LOCAL version (the inversion).
        // Bytes, not a utf8 string: the export must round-trip the blob
        // byte-identically — a binary/invalid-UTF-8 blob routed through a string is corrupted
        // (invalid sequences become U+FFFD).
        const local = runGitBytes(boardPath, ["show", `:3:${relPath}`]);
        let exportPath: string | null = null;
        let bodyExportPath: string | null = null;
        const isDoc = isConceptDocPath(relPath);
        if (local.status === 0) {
          exportPath = path.join(exportDir, relPath);
          mkdirSync(path.dirname(exportPath), { recursive: true, mode: 0o700 });
          writeFileSync(exportPath, local.stdout, { mode: 0o600 });
          // The body-only companion is the literally executable
          // `doc update --body-file` input. Only for a concept doc whose blob parses as OKF
          // markdown and whose bytes round-trip utf8 cleanly. A doc that parses after a lossy
          // decode — an invalid byte became U+FFFD — would get a corrupted body
          // companion while the full export stays exact, and the emitted chain would apply the
          // corruption; skip the companion, and with it the runnable chain, instead). A parse
          // failure likewise just means no runnable chain — the full export remains either way.
          if (isDoc) {
            try {
              const decoded = local.stdout.toString("utf8");
              if (Buffer.from(decoded, "utf8").equals(local.stdout)) {
                const { body } = parseMarkdown(decoded, relPath);
                bodyExportPath = exportPath.replace(/\.md$/, ".body.md");
                writeFileSync(bodyExportPath, body, { mode: 0o600 });
              }
            } catch {
              bodyExportPath = null;
            }
          }
        }
        // 2+3. Keep the UPSTREAM (teammate's) version — explicit ref, never --ours/--theirs. An
        // upstream-side DELETION keeps upstream's state by removing the path instead.
        if (runGit(boardPath, ["cat-file", "-e", `refs/remotes/${BOARD_REF}:${relPath}`]).status === 0) {
          mustGit(boardPath, ["checkout", BOARD_REF, "--", relPath]);
          mustGit(boardPath, ["add", "--", relPath]);
        } else {
          mustGit(boardPath, ["rm", "-f", "--", relPath]);
        }
        byPath.set(relPath, {
          relPath,
          entry: isDoc ? conceptIdFromPath(relPath) : relPath,
          isDoc,
          exportPath,
          bodyExportPath,
        });
      }
      // Advance non-interactively. A nonzero exit that leaves the rebase state behind is a NEW
      // stop (the next commit's conflict, or an empty commit) — the loop resolves it; a nonzero
      // exit with NO rebase state left is a genuine failure.
      const cont = runGit(boardPath, [...idFlags, "rebase", "--continue"], { rebase: true });
      if (cont.status !== 0 && !detectStaleRebase(boardPath)) {
        throw classifyGitError(failureOf(["rebase", "--continue"], cont));
      }
    }
  } catch (err) {
    // NEVER leave the worktree mid-state: restore the pre-rebase board, then rethrow.
    try {
      mustGit(boardPath, ["rebase", "--abort"], { rebase: true });
    } catch {
      /* best-effort — the original error is the one that matters */
    }
    throw err;
  }
  return { status: "resolved", conflicts: [...byPath.values()] };
}

// ── push ──────────────────────────────────────────────────────────────────────

/** `git push origin board`. Failures classify (AUTH exit 4 vs network exit 1, best-effort). */
export function push(boardPath: string): void {
  mustGit(boardPath, ["push", BOARD_REMOTE, BOARD_BRANCH], { timeoutMs: NETWORK_TIMEOUT_MS });
}

/**
 * The committed-folder establishment publishes the freshly created `board` branch WITH TRACKING —
 * `git push -u origin board`, run from the repo TOP (during establishment the branch exists only
 * as a ref; it is not checked out anywhere). The `-u` is LOAD-BEARING: without it
 * the establishing machine's fresh `board` branch has no tracking config at all — sync itself
 * always uses EXPLICIT `origin/board` refs precisely because that state exists, but the humans'
 * own git (`status`, `branch -vv`) reads the tracking config, and this is the one moment the
 * config can be written for free.
 */
export function pushBoardUpstream(top: string): void {
  mustGit(top, ["push", "-u", BOARD_REMOTE, BOARD_BRANCH], { timeoutMs: NETWORK_TIMEOUT_MS });
}

/**
 * Publish an exact, already-built root commit as `origin/board` without first creating a local
 * `board` ref. This is the snapshot-first establishment write: a failed push leaves the source
 * folder, code worktree, code index, and branch namespace untouched.
 */
export function pushBoardCommit(top: string, commit: string): void {
  mustGit(top, ["push", BOARD_REMOTE, `${commit}:refs/heads/${BOARD_BRANCH}`], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
}

/** Set the provisioned local board branch's upstream without another network write. */
export function setBoardUpstream(boardPath: string): void {
  mustGit(boardPath, ["branch", "--set-upstream-to", BOARD_REF, BOARD_BRANCH]);
}

/**
 * `git fetch origin`, returning whether it succeeded (nonzero tolerated at THIS layer — the
 * caller decides what a dead fetch means). The committed-folder establish path refuses on false:
 * the act cannot complete offline anyway — the mandatory `push -u`
 * would fail — and tolerating a dead fetch is exactly what would let a stale clone establish while
 * a teammate's board commit sat unseen on origin (the behind-origin freshness guard needs a LIVE
 * origin to be worth anything). Renamed from `fetchOriginTolerated`: the old name described a
 * tolerance its one real consumer no longer extends.
 */
export function fetchOrigin(top: string): boolean {
  // `--prune` matters here: a stale
  // `refs/remotes/origin/board/<x>` tracking ref — left behind after the remote offender was
  // deleted — would block the push's own local `refs/remotes/origin/board` tracking-ref update.
  // Pruning against the live remote clears it before the namespace check even runs.
  return runGit(top, ["fetch", "--prune", BOARD_REMOTE], { timeoutMs: NETWORK_TIMEOUT_MS }).status === 0;
}

/** Fetch `origin` with pruning, preserving the classified auth/network failure for strict paths. */
export function fetchOriginRequired(top: string): void {
  mustGit(top, ["fetch", "--prune", BOARD_REMOTE], { timeoutMs: NETWORK_TIMEOUT_MS });
}

/**
 * Branch names under the `board/` namespace make
 * `refs/heads/board` UNCREATABLE — git refs form a directory tree, so `refs/heads/board/<x>`
 * (a directory) and `refs/heads/board` (a file) conflict, and the establishment's `push -u` is
 * rejected by the remote. This lists the REMOTE offenders (`ls-remote --heads origin board/*`)
 * as short branch names; a failure to ask the remote throws classified (the committed-folder
 * establish path treats the remote as mandatory — see {@link fetchOrigin}).
 */
export function remoteBoardNamespaceBranches(top: string): string[] {
  const r = runGit(top, ["ls-remote", "--heads", BOARD_REMOTE, `${BOARD_BRANCH}/*`], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (r.status !== 0) throw classifyGitError(failureOf(["ls-remote"], r));
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length));
}

/**
 * Branches under the `board/` namespace — locally OR on the remote — make `refs/heads/board`
 * UNCREATABLE (a ref directory/file conflict; empirically confirmed against this repo's own
 * origin, which once carried `board/sync-verb-tasks`). Both establish cases share this guard.
 */
export function boardNamespaceConflicts(top: string): string[] {
  const local = runGit(top, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BOARD_BRANCH}/`]);
  const localNames =
    local.status === 0
      ? local.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((n) => `${n} (local)`)
      : [];
  const remoteNames = remoteBoardNamespaceBranches(top).map((n) => `${n} (on ${BOARD_REMOTE})`);
  return [...localNames, ...remoteNames];
}

// ── gitignore entry (both establish cases share the ONE idempotent transform) ──

/** Every conventional bundle spelling that must stay out of the code branch's own index. */
export const GITIGNORE_ENTRIES = BUNDLE_DIRS.map((name) => `${name}/`);

/**
 * Return `content` with every recognized conventional bundle directory ignored. Existing exact
 * spellings (with or without leading/trailing slash) are respected independently; only missing
 * names are appended. Establish and ordinary provisioning share this idempotent transform.
 */
export function withIgnoreEntries(content: string): string {
  const lines = content.split("\n").map((line) => line.trim());
  const missing = BUNDLE_DIRS.filter((bundleDir) =>
    !lines.some((line) =>
      line === bundleDir || line === `${bundleDir}/` || line === `/${bundleDir}` || line === `/${bundleDir}/`
    ),
  );
  if (missing.length === 0) return content;
  let out = content;
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  if (out.length > 0) out += "\n";
  out += `# shared boards — managed on the '${BOARD_BRANCH}' branch by superbee sync\n`;
  out += `${missing.map((bundleDir) => `${bundleDir}/`).join("\n")}\n`;
  return out;
}

/**
 * Ensure all {@link GITIGNORE_ENTRIES} in
 * `<top>/.gitignore` in the WORKING TREE ONLY — never committed to the code branch (unlike the
 * committed case's version of this transform, which writes an object-database blob INTO the
 * prepared cleanup commit). Idempotent via {@link withIgnoreEntries}; a call that changes nothing reports
 * `changed: false`. Read/write failures are NOT swallowed — a caller that cannot write
 * `.gitignore` needs to know, since the receipt promises to announce it.
 */
export interface GitignoreUpdate { changed: boolean; path: string; entries: string[] }

export function ensureBoardGitignoreWorkingTree(top: string): GitignoreUpdate {
  const gitignorePath = path.join(top, ".gitignore");
  let content = "";
  try {
    content = readFileSync(gitignorePath, "utf8");
  } catch {
    /* absent .gitignore reads as empty */
  }
  const updated = withIgnoreEntries(content);
  if (updated === content) return { changed: false, path: gitignorePath, entries: [...GITIGNORE_ENTRIES] };
  writeFileSync(gitignorePath, updated);
  return { changed: true, path: gitignorePath, entries: [...GITIGNORE_ENTRIES] };
}

// ── ff-only pull (the fail-soft SessionStart path) ────────────────────────────

export interface FfPullResult {
  /** True when `origin/board` fast-forwarded the local board HEAD. */
  updated: boolean;
  /**
   * Present when a nonzero exit was SWALLOWED (the fail-soft matrix): `not-a-repo`,
   * `detached-head`, `no-upstream`, `diverged`, `dirty`, `auth`, `network`, `busy`, `git-missing`,
   * `conflict`, or `runtime`. A successful merge after a failed fetch still reports the fetch's
   * reason (best-effort freshness — the merge ran against the last-known `origin/board`).
   */
  swallowed?: string;
}

/** Map a classified BoardGitError code to the ff-pull swallow-reason vocabulary. */
function swallowReason(err: BoardGitError): string {
  switch (err.code) {
    case "GIT_MISSING":
      return "git-missing";
    case "NO_UPSTREAM":
      return "no-upstream";
    case "GIT_BUSY":
      return "busy";
    case "AUTH_REQUIRED":
      return "auth";
    case "TRANSIENT":
      return "network";
    case "CONFLICT":
      return "conflict";
    default:
      return "runtime";
  }
}

/**
 * `git fetch origin` → `git merge --ff-only origin/board`, SWALLOWING every nonzero exit — the
 * fail-soft matrix: not-a-repo, no-remote/no-upstream, detached HEAD, divergence, dirty
 * refusal, auth/network, a held lock, even a missing git binary. This is the SessionStart pull's
 * primitive: it must never throw and never block a render on repo state.
 */
export function ffPull(boardPath: string, budget: NetworkBudgetOptions = {}): FfPullResult {
  try {
    if (!repoTopLevel(boardPath)) return { updated: false, swallowed: "not-a-repo" };
    // Detached HEAD: an ff merge would move the detached HEAD, not the board branch — skip.
    if (runGit(boardPath, ["symbolic-ref", "-q", "HEAD"]).status !== 0) {
      return { updated: false, swallowed: "detached-head" };
    }
    const before = mustGit(boardPath, ["rev-parse", "HEAD"]).trim();

    let fetchReason: string | undefined;
    const fetched = runGit(boardPath, ["fetch", "--prune", BOARD_REMOTE], {
      timeoutMs: budget.fetchTimeoutMs ?? NETWORK_TIMEOUT_MS,
      connectTimeoutSeconds: budget.connectTimeoutSeconds,
    });
    if (fetched.status !== 0) {
      // Keep going: origin/board may exist from an earlier fetch; the merge is still meaningful.
      fetchReason = swallowReason(classifyGitError(failureOf(["fetch", "--prune"], fetched)));
    }

    const merged = runGit(boardPath, ["merge", "--ff-only", BOARD_REF]);
    if (merged.status !== 0) {
      const text = `${merged.stderr}\n${merged.stdout}`;
      if (/Not possible to fast-forward/i.test(text) || /have diverged/i.test(text)) {
        return { updated: false, swallowed: "diverged" };
      }
      if (/local changes .* would be overwritten|Please commit your changes or stash/i.test(text)) {
        return { updated: false, swallowed: "dirty" };
      }
      return { updated: false, swallowed: swallowReason(classifyGitError(failureOf(["merge"], merged))) };
    }

    const after = mustGit(boardPath, ["rev-parse", "HEAD"]).trim();
    const result: FfPullResult = { updated: after !== before };
    if (fetchReason !== undefined) result.swallowed = fetchReason;
    return result;
  } catch (err) {
    // Fail-soft to the last defense: even a spawn-level failure is swallowed here.
    if (isBoardGitError(err)) return { updated: false, swallowed: swallowReason(err) };
    return { updated: false, swallowed: "runtime" };
  }
}

// ── unpushed count ────────────────────────────────────────────────────────────

/**
 * Local board commits ahead of the explicit `origin/board` ref, or `null` when no such ref exists
 * (no remote / never fetched) — the caller distinguishes "0 unpushed" from "no upstream to count
 * against" (the awareness backstop needs both).
 */
export function unpushedCount(boardPath: string): number | null {
  if (runGit(boardPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${BOARD_REF}`]).status !== 0) {
    return null;
  }
  const out = mustGit(boardPath, ["rev-list", "--count", `${BOARD_REF}..HEAD`]).trim();
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : 0;
}

// ── small named ops the flow layer composes (promoted from commands/sync.ts, A0) ─

/** The board worktree's current HEAD sha; a failure throws classified. */
export function currentHead(boardPath: string): string {
  const r = runGit(boardPath, ["rev-parse", "HEAD"]);
  if (r.status !== 0) {
    throw classifyGitError({ args: ["rev-parse", "HEAD"], status: r.status, stdout: r.stdout, stderr: r.stderr });
  }
  return r.stdout.trim();
}

/** The repo's current branch short name, or the literal `"HEAD"` for a detached checkout (never throws). */
export function currentBranch(top: string): string {
  const r = runGit(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : "HEAD";
}

/** One `git status --porcelain` row: its two-letter status code and repo-relative path. */
export interface StatusRow {
  status: string;
  path: string;
}

/** Parse `git status --porcelain[ -- <prefix>]` into {@link StatusRow}s (`[]` on a failed status). */
export function statusRows(dir: string, prefix?: string): StatusRow[] {
  const r = runGit(dir, ["status", "--porcelain", ...(prefix ? ["--", prefix] : [])]);
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
}

/**
 * Count of lines in `git status --porcelain` — uncommitted (staged or not) changes in the
 * worktree. `prefix` (board-git PR C) scopes the count to one pathspec — the in-tree backstop's
 * variant, so a dirty CODE tree never inflates the board's uncommitted count; branch-mode callers
 * omit it (the board worktree carries only the bundle, so repo-wide IS bundle-wide there).
 */
export function countUncommitted(boardPath: string, prefix?: string): number {
  return statusRows(boardPath, prefix).length;
}

/**
 * Read a path's exact bytes at `ref`, or `null` when absent. Absence is checked STRUCTURALLY
 * (`cat-file -e`) before the read — never inferred from `show`'s failure prose, which drifts
 * across git versions — so a path that genuinely exists but fails to `show` is a real
 * (classified) error, not a swallowed absence.
 */
export function readDocBytesAtRef(dir: string, ref: string, relPath: string): Buffer | null {
  if (runGit(dir, ["cat-file", "-e", `${ref}:${relPath}`]).status !== 0) return null;
  const shown = runGitBytes(dir, ["show", `${ref}:${relPath}`]);
  if (shown.status !== 0) {
    throw classifyGitError({ args: ["show"], status: shown.status, stdout: "", stderr: shown.stderr });
  }
  return shown.stdout;
}
