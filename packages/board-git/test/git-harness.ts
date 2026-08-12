/**
 * `git-harness.ts` — the hermetic git test harness every downstream sync unit consumes (plan
 * [plans/sync-verb-implementation] §U0). It builds scratch repo topologies (a bare origin + two
 * clones, each with a `board` branch checked out as a linked worktree at `.agentstate-lite/`, so
 * the branch root IS the bundle root) and plants every fixture the sync suites need: dirty and
 * staged user code, new/modified/deleted board docs, divergent histories (same-doc and
 * different-doc), a dangling cursor SHA (an object rewritten out of history), a worktree wedged
 * mid-rebase, and a held `index.lock` (the concurrent-sync / GIT_BUSY fixture, adjudication B).
 *
 * NOT a test file (no `.test.ts` suffix → never run by the `./test/*.test.ts` glob) — a typed,
 * minimal LIBRARY. `git-harness.test.ts` is its self-test.
 *
 * The harness's OWN git invocations obey the plan's "global porcelain invariants": every call is
 * `git -C <dir> …` with a SCRUBBED environment — GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE unset
 * (inherited values override `-C`), GIT_TERMINAL_PROMPT=0, system/global config neutralized
 * (GIT_CONFIG_SYSTEM/GLOBAL=/dev/null) so the host's `~/.gitconfig` can never leak identity, hooks,
 * or signing into a fixture. Identity comes from harness env defaults, overridable per commit so a
 * fixture can plant a commit whose git author differs from a doc's frontmatter actor. Everything
 * lives under `os.tmpdir()`, realpath'd; nothing ever touches the real repo.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, unlink, realpath, readFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, readDoc, type Frontmatter } from "@superbee/core";

/** The branch that carries ONLY the bundle; its root maps to the bundle root. */
export const BOARD_BRANCH = "board";
/** The conventional folder the board worktree is checked out at (branch root = this dir). */
export const BUNDLE_DIR = ".agentstate-lite";

// ── porcelain-invariant git runner ──────────────────────────────────────────

/** Env keys whose INHERITED values would override `-C` — scrubbed on every call (invariant). */
const SCRUBBED_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

/** Baseline hermetic env applied to every git invocation (per-call overrides win). */
const GIT_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  // Neutralize host config so ~/.gitconfig can't leak identity/hooks/signing into a fixture.
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // No prompts, no interactive auth — matches the U1 spawn wrapper's invariants.
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
  // Default identity; a fixture that needs a distinct git author overrides these per commit.
  GIT_AUTHOR_NAME: "Harness Bot",
  GIT_AUTHOR_EMAIL: "harness@example.invalid",
  GIT_COMMITTER_NAME: "Harness Bot",
  GIT_COMMITTER_EMAIL: "harness@example.invalid",
};

/** The result of a git invocation that may legitimately exit nonzero. */
export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function gitEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of SCRUBBED_GIT_VARS) delete env[v];
  return { ...env, ...GIT_ENV_DEFAULTS, ...(overrides ?? {}) };
}

/**
 * Run `git -C <cwd> <args…>` with the scrubbed hermetic env, TOLERATING a nonzero exit
 * (returns the captured status/stdout/stderr). Use for ops expected to fail (a conflicting rebase,
 * a locked index). {@link git} is the throw-on-failure wrapper for the common case.
 */
export function gitTry(cwd: string, args: string[], overrides?: Record<string, string>): GitResult {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    env: gitEnv(overrides),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run a git op that MUST succeed; throws with the captured stderr on any nonzero exit. */
export function git(cwd: string, args: string[], overrides?: Record<string, string>): string {
  const r = gitTry(cwd, args, overrides);
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} (in ${cwd}) failed [${r.status}]: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout;
}

// ── identity-less environment (tasks/sync-fallback-identity's fresh-container shape) ──────────

/** Env vars git itself consults for identity — stripped from the child process for the duration. */
const NO_IDENTITY_ENV_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"] as const;

let forcedNoIdentitySystemConfig: string | undefined;

/**
 * A `GIT_CONFIG_SYSTEM` file forcing `user.useConfigOnly=true` — git's own switch to disable its
 * OS-account guess (`<username>@<hostname>`), which EMPIRICALLY still resolves an identity on a
 * dev machine even with every config/env source scrubbed (a real account exists there), unlike a
 * genuinely account-less fresh-container UID. This reproduces the identical "Please tell me who
 * you are" failure class deterministically, on any machine. Lazily created once per process.
 */
function noIdentitySystemConfigPath(): string {
  if (!forcedNoIdentitySystemConfig) {
    const dir = mkdtempSync(path.join(tmpdir(), "aslite-no-identity-"));
    const file = path.join(dir, "force-no-identity.gitconfig");
    writeFileSync(file, "[user]\n\tuseConfigOnly = true\n");
    forcedNoIdentitySystemConfig = file;
  }
  return forcedNoIdentitySystemConfig;
}

/**
 * Run `fn` with git's identity resolution genuinely unable to succeed ANYWHERE it looks (env,
 * local/global/system config, the OS-account guess) — the fresh-container / identity-less-CI-runner
 * shape `identityFlags` (porcelain.ts) guards against. Mutates `process.env` for the duration
 * (every code-under-test git spawn inherits it via `porcelain.ts`'s own `gitEnv`), restoring the
 * exact prior values afterward. A fixture repo built BEFORE entering this must carry NO local
 * `user.name`/`user.email` of its own (this harness's setup calls never write any).
 */
export async function withNoGitIdentity<T>(fn: () => Promise<T> | T): Promise<T> {
  const keys = [...NO_IDENTITY_ENV_VARS, "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"] as const;
  const saved = new Map<string, string | undefined>(keys.map((k) => [k, process.env[k]]));
  for (const k of NO_IDENTITY_ENV_VARS) delete process.env[k];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = noIdentitySystemConfigPath();
  // An ambient GIT_CONFIG_NOSYSTEM=1 makes git skip the system config file entirely — silently
  // defeating the forced useConfigOnly above and letting the OS-account guess back in on a dev
  // machine (empirically reproduced). Neutralized so no host env shape re-enables an identity.
  delete process.env.GIT_CONFIG_NOSYSTEM;
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── topology ─────────────────────────────────────────────────────────────────

/** One clone: its main worktree (`root`) and the board worktree (`board`, present once provisioned). */
export interface BoardRepo {
  readonly name: string;
  /** The clone's working directory — `main` is checked out here (user code lives here). */
  readonly root: string;
  /** `<root>/.agentstate-lite` — the linked board worktree (exists only after {@link provisionBoard}). */
  readonly board: string;
}

export interface TwoCloneTopology {
  /** The realpath'd scratch root under `os.tmpdir()` holding origin + both clones. */
  readonly dir: string;
  /** The bare origin repository. */
  readonly origin: string;
  readonly a: BoardRepo;
  readonly b: BoardRepo;
  /** Remove the entire scratch tree — leaves nothing behind. */
  cleanup(): Promise<void>;
}

export interface TopologyOptions {
  /** Provision each clone's board worktree (default true). Pass false to exercise U1's self-heal. */
  provision?: boolean;
}

/**
 * Bare-origin init with background maintenance OFF (receive.autogc / maintenance.auto / gc.auto):
 * receive-pack otherwise leaves a DETACHED `git maintenance run --auto --quiet --detach` running
 * in origin after every push — a concurrent modifier of the very repo the next fixture step
 * clones. Paired with the clones' `--no-local`: a local-path clone file-walks the source's
 * objects and is documented to race with concurrent modification (git-clone(1): "similar to
 * running cp -r <src> <dst> while modifying <src>") — observed in CI as
 * `fatal: failed to copy file to '…/objects/…': No such file or directory` mid-topology.
 */
function initBareOrigin(dir: string): void {
  git(dir, ["init", "--bare", "origin.git"]);
  const origin = path.join(dir, "origin.git");
  git(origin, ["config", "receive.autogc", "false"]);
  git(origin, ["config", "maintenance.auto", "false"]);
  git(origin, ["config", "gc.auto", "0"]);
}

/** The frontmatter of the docs seeded onto the board branch — targets for modify/delete fixtures. */
const SEED_DOCS: ReadonlyArray<{ id: string; frontmatter: Frontmatter; body: string }> = [
  { id: "tasks/seed-one", frontmatter: { type: "Task", title: "Seed one", actor: "mike" }, body: "# Seed one\n\nseed body\n" },
  { id: "tasks/seed-two", frontmatter: { type: "Task", title: "Seed two", actor: "brian" }, body: "# Seed two\n\nseed body\n" },
  { id: "notes/welcome", frontmatter: { type: "Note", title: "Welcome", actor: "mike" }, body: "# Welcome\n\nhello\n" },
];

/**
 * Build a bare origin + two clones (A, B). Each clone has `main` (with user code) checked out at its
 * root and — when provisioned — the `board` branch checked out as a linked worktree at
 * `.agentstate-lite/`, whose root carries the seeded OKF bundle (`index.md` + {@link SEED_DOCS}).
 */
export async function makeTwoCloneTopology(options: TopologyOptions = {}): Promise<TwoCloneTopology> {
  const provision = options.provision ?? true;
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "aslite-git-harness-")));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");

  // 1. Seed clone: main with user code.
  git(dir, ["init", "-b", "main", "seed"]);
  await writeFile(path.join(seed, "README.md"), "# demo project\n");
  await mkdir(path.join(seed, "src"), { recursive: true });
  await writeFile(path.join(seed, "src", "app.js"), "export const x = 1;\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial project"]);

  // 2. Orphan `board` branch: bundle-only, rooted at the branch root.
  git(seed, ["checkout", "--orphan", BOARD_BRANCH]);
  git(seed, ["rm", "-rf", "."]); // clear the inherited (main) tree from index + working dir
  await initBundle(seed); // writes the reserved root index.md (okf_version)
  for (const d of SEED_DOCS) {
    await writeDoc({ root: seed }, { id: d.id, frontmatter: d.frontmatter, body: d.body });
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "board: seed bundle"]);
  git(seed, ["checkout", "main"]); // restore the user-code working tree

  // 3. Bare origin; publish both branches; default HEAD → main (a clone checks out main).
  initBareOrigin(dir);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "origin", "main", BOARD_BRANCH]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  // 4. Two clones.
  git(dir, ["clone", "--no-local", origin, "A"]);
  git(dir, ["clone", "--no-local", origin, "B"]);
  const a: BoardRepo = { name: "A", root: path.join(dir, "A"), board: path.join(dir, "A", BUNDLE_DIR) };
  const b: BoardRepo = { name: "B", root: path.join(dir, "B"), board: path.join(dir, "B", BUNDLE_DIR) };
  if (provision) {
    provisionBoard(a);
    provisionBoard(b);
  }

  return {
    dir,
    origin,
    a,
    b,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Committed-folder topology (the `sync --establish` hard case): a bare origin + two clones of a
 * project whose bundle is a PLAIN COMMITTED FOLDER on `main` — NO `board` branch exists anywhere.
 * `BoardRepo.board` names `<root>/.agentstate-lite`, which here is just a committed directory,
 * not a checkout of its own. Seeds the same user code and {@link SEED_DOCS} as
 * {@link makeTwoCloneTopology} so post-establishment assertions can check the docs survived.
 */
export async function makeCommittedFolderTopology(): Promise<TwoCloneTopology> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "aslite-git-harness-")));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");

  git(dir, ["init", "-b", "main", "seed"]);
  await writeFile(path.join(seed, "README.md"), "# demo project\n");
  await mkdir(path.join(seed, "src"), { recursive: true });
  await writeFile(path.join(seed, "src", "app.js"), "export const x = 1;\n");
  const bundleRoot = path.join(seed, BUNDLE_DIR);
  await mkdir(bundleRoot, { recursive: true });
  await initBundle(bundleRoot);
  for (const d of SEED_DOCS) {
    await writeDoc({ root: bundleRoot }, { id: d.id, frontmatter: d.frontmatter, body: d.body });
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial project with the board committed on main"]);

  initBareOrigin(dir);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "origin", "main"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(dir, ["clone", "--no-local", origin, "A"]);
  git(dir, ["clone", "--no-local", origin, "B"]);
  const a: BoardRepo = { name: "A", root: path.join(dir, "A"), board: path.join(dir, "A", BUNDLE_DIR) };
  const b: BoardRepo = { name: "B", root: path.join(dir, "B"), board: path.join(dir, "B", BUNDLE_DIR) };
  return { dir, origin, a, b, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Greenfield-establish topology (plans/sync-greenfield-establish): a bare origin + two clones of a
 * project whose bundle DOESN'T EXIST YET anywhere — no `board` branch, local or on origin, and no
 * `.agentstate-lite/` folder in either clone (`initPlainBundleDir` plants one after cloning, for
 * whichever clone a test wants to establish from). Same seeded user code as
 * {@link makeTwoCloneTopology} so `--establish`'s "touches nothing but the board" claim is checkable
 * against real tracked files.
 */
export async function makeGreenfieldTopology(): Promise<TwoCloneTopology> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "aslite-git-harness-")));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");

  git(dir, ["init", "-b", "main", "seed"]);
  await writeFile(path.join(seed, "README.md"), "# demo project\n");
  await mkdir(path.join(seed, "src"), { recursive: true });
  await writeFile(path.join(seed, "src", "app.js"), "export const x = 1;\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial project"]);

  initBareOrigin(dir);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "origin", "main"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(dir, ["clone", "--no-local", origin, "A"]);
  git(dir, ["clone", "--no-local", origin, "B"]);
  const a: BoardRepo = { name: "A", root: path.join(dir, "A"), board: path.join(dir, "A", BUNDLE_DIR) };
  const b: BoardRepo = { name: "B", root: path.join(dir, "B"), board: path.join(dir, "B", BUNDLE_DIR) };
  return { dir, origin, a, b, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Plant a PLAIN, uncommitted `.agentstate-lite/` folder (`init`'s own output — just the reserved
 * root `index.md`, no docs) in a clone with no board branch anywhere yet — the establish
 * precondition ladder's expected starting shape. Callers add docs afterward via
 * {@link writeBoardDoc} (it only touches the filesystem, so it works before the folder is a
 * worktree too).
 */
export async function initPlainBundleDir(repo: BoardRepo): Promise<void> {
  await mkdir(repo.board, { recursive: true });
  await initBundle(repo.board);
}

/**
 * Provision the board worktree for a clone: fetch, then check out `origin/board` as a linked
 * worktree at `.agentstate-lite/`. `--no-track` faithfully reproduces the migration machine's
 * empirical NO-tracking-config state (why the invariants use explicit `origin/board`, never `@{u}`).
 */
export function provisionBoard(repo: BoardRepo): void {
  git(repo.root, ["fetch", "origin"]);
  git(repo.root, ["worktree", "add", "--no-track", "-b", BOARD_BRANCH, repo.board, `origin/${BOARD_BRANCH}`]);
}

/** Tear down a clone's board worktree + local branch (leaving `origin/board` intact). */
export function deprovisionBoard(repo: BoardRepo): void {
  git(repo.root, ["worktree", "remove", "--force", repo.board]);
  git(repo.root, ["branch", "-D", BOARD_BRANCH]);
}

// ── board-content fixtures (operate in the board worktree) ────────────────────

function docPath(id: string): string {
  return `${id}.md`;
}

/** Write a NEW (or overwrite an existing) board doc via the engine — leaves it UNCOMMITTED. */
export async function writeBoardDoc(
  repo: BoardRepo,
  id: string,
  doc: { frontmatter: Frontmatter; body: string },
): Promise<void> {
  await writeDoc({ root: repo.board }, { id, frontmatter: doc.frontmatter, body: doc.body });
}

/** Modify an EXISTING board doc (read → merge body/frontmatter → rewrite). Leaves it UNCOMMITTED. */
export async function modifyBoardDoc(
  repo: BoardRepo,
  id: string,
  change: { frontmatter?: Partial<Frontmatter>; body?: string },
): Promise<void> {
  const current = await readDoc({ root: repo.board }, id);
  const frontmatter: Frontmatter = { ...current.frontmatter, ...(change.frontmatter ?? {}) };
  await writeDoc({ root: repo.board }, { id, frontmatter, body: change.body ?? current.body });
}

/** Delete a board doc from the working tree (UNSTAGED deletion — the real add+delete story). */
export async function deleteBoardDoc(repo: BoardRepo, id: string): Promise<void> {
  await unlink(path.join(repo.board, docPath(id)));
}

/** Read a raw file under the board worktree (for assertions). */
export async function readBoardFile(repo: BoardRepo, relPath: string): Promise<string> {
  return readFile(path.join(repo.board, relPath), "utf8");
}

/** Stage everything in the board worktree and commit; returns the new board HEAD sha. */
export function commitBoard(
  repo: BoardRepo,
  message: string,
  opts?: { author?: { name: string; email: string } },
): string {
  git(repo.board, ["add", "-A"]);
  const overrides = opts?.author
    ? {
        GIT_AUTHOR_NAME: opts.author.name,
        GIT_AUTHOR_EMAIL: opts.author.email,
        GIT_COMMITTER_NAME: opts.author.name,
        GIT_COMMITTER_EMAIL: opts.author.email,
      }
    : undefined;
  git(repo.board, ["commit", "-m", message], overrides);
  return boardHead(repo);
}

/** The board worktree's HEAD sha. */
export function boardHead(repo: BoardRepo): string {
  return git(repo.board, ["rev-parse", "HEAD"]).trim();
}

/** Push the local board branch to origin with an EXPLICIT refspec (no tracking config assumed). */
export function pushBoard(repo: BoardRepo): void {
  git(repo.board, ["push", "origin", `${BOARD_BRANCH}:${BOARD_BRANCH}`]);
}

/** Fetch origin into the clone (updates `origin/board`). */
export function fetchBoard(repo: BoardRepo): void {
  git(repo.board, ["fetch", "origin"]);
}

/** The origin's `board` sha (the shared upstream tip). */
export function originBoardHead(topo: TwoCloneTopology): string {
  return git(topo.origin, ["rev-parse", `refs/heads/${BOARD_BRANCH}`]).trim();
}

// ── user-code fixtures (operate on the MAIN worktree — must survive every sync) ─

/** Dirty a tracked non-bundle file in the main worktree (UNSTAGED). Returns its repo-relative path. */
export async function plantDirtyUserCode(repo: BoardRepo): Promise<string> {
  await writeFile(path.join(repo.root, "src", "app.js"), "export const x = 2; // locally dirtied\n");
  return "src/app.js";
}

/** Stage a NEW user-code file in the main worktree (git add, no commit). Returns its repo-relative path. */
export async function plantStagedUserCode(repo: BoardRepo): Promise<string> {
  await writeFile(path.join(repo.root, "src", "staged.js"), "export const staged = true;\n");
  git(repo.root, ["add", "src/staged.js"]);
  return "src/staged.js";
}

// ── divergent-history fixtures ────────────────────────────────────────────────

/** Describes a planted divergence between the two clones over the board branch. */
export interface Divergence {
  /** The doc(s) each side touched. */
  readonly docId: string;
  readonly docPath: string;
  /** Clone A's pushed board HEAD (now `origin/board`). */
  readonly aHead: string;
  /** Clone B's local, unpushed board HEAD. */
  readonly bHead: string;
}

/**
 * Plant a SAME-DOC divergence: A edits `docId`, commits, and PUSHES (advancing origin/board); B
 * edits the SAME doc differently and commits LOCALLY (not pushed), then fetches. B's board is now a
 * divergent history that CONFLICTS on `rebase origin/board`. The rebase itself is left to the
 * code-under-test (see {@link wedgeMidRebase} to actually start + wedge it).
 */
export async function divergeSameDoc(topo: TwoCloneTopology, docId = "tasks/seed-one"): Promise<Divergence> {
  await modifyBoardDoc(topo.a, docId, { body: `# ${docId}\n\nchanged by A\n` });
  const aHead = commitBoard(topo.a, `board: A edits ${docId}`, { author: { name: "alice", email: "alice@example.invalid" } });
  pushBoard(topo.a);

  await modifyBoardDoc(topo.b, docId, { body: `# ${docId}\n\nchanged by B\n` });
  const bHead = commitBoard(topo.b, `board: B edits ${docId}`, { author: { name: "bob", email: "bob@example.invalid" } });
  fetchBoard(topo.b);

  return { docId, docPath: docPath(docId), aHead, bHead };
}

/**
 * Plant a DIFFERENT-DOC divergence: A edits `aDocId` + pushes; B edits a DIFFERENT `bDocId` locally
 * then fetches. B's `rebase origin/board` replays cleanly (no conflict).
 */
export async function divergeDifferentDoc(
  topo: TwoCloneTopology,
  aDocId = "tasks/seed-one",
  bDocId = "tasks/seed-two",
): Promise<Divergence> {
  await modifyBoardDoc(topo.a, aDocId, { body: `# ${aDocId}\n\nchanged by A\n` });
  commitBoard(topo.a, `board: A edits ${aDocId}`, { author: { name: "alice", email: "alice@example.invalid" } });
  pushBoard(topo.a);

  await modifyBoardDoc(topo.b, bDocId, { body: `# ${bDocId}\n\nchanged by B\n` });
  const bHead = commitBoard(topo.b, `board: B edits ${bDocId}`, { author: { name: "bob", email: "bob@example.invalid" } });
  fetchBoard(topo.b);

  return { docId: bDocId, docPath: docPath(bDocId), aHead: originBoardHead(topo), bHead };
}

// ── dangling cursor SHA ───────────────────────────────────────────────────────

/**
 * Return a board commit sha that is subsequently REWRITTEN OUT of history and pruned from the object
 * store — so `git cat-file -e <sha>^{commit}` fails (the "history rewritten under a stored cursor"
 * case the cursor module's re-anchor guard must handle). Call on a clone whose board is at parity
 * with origin (a fresh provisioned clone): the ephemeral commit is unreachable after the reset, so
 * `gc --prune=now` collects it.
 */
export async function danglingCursorSha(repo: BoardRepo): Promise<string> {
  await writeBoardDoc(repo, "tasks/ephemeral", { frontmatter: { type: "Task", title: "Ephemeral" }, body: "# Ephemeral\n" });
  const sha = commitBoard(repo, "board: ephemeral (rewritten out)");
  git(repo.board, ["reset", "--hard", "HEAD~1"]); // drop it; the working-tree file goes with it
  git(repo.board, ["reflog", "expire", "--expire=now", "--all"]);
  git(repo.board, ["gc", "--prune=now"]);
  return sha;
}

// ── stale mid-rebase fixture ──────────────────────────────────────────────────

/** Resolve a worktree git-path (e.g. `rebase-merge`, `index.lock`) to an absolute path. */
export function worktreeGitPath(repo: BoardRepo, relative: string): string {
  const raw = git(repo.board, ["rev-parse", "--git-path", relative]).trim();
  return path.resolve(repo.board, raw);
}

/** True when the board worktree is wedged mid-rebase (`rebase-merge` present). */
export function isMidRebase(repo: BoardRepo): boolean {
  return existsSync(worktreeGitPath(repo, "rebase-merge"));
}

/**
 * Plant a SAME-DOC divergence and then ACTUALLY start `rebase origin/board` in clone B, leaving its
 * board worktree WEDGED mid-rebase (`rebase-merge` present) — the crash/kill-mid-run state sync
 * entry must self-heal (adjudication C). Returns the underlying divergence.
 */
export async function wedgeMidRebase(topo: TwoCloneTopology, docId = "tasks/seed-one"): Promise<Divergence> {
  const d = await divergeSameDoc(topo, docId);
  const r = gitTry(topo.b.board, ["rebase", `origin/${BOARD_BRANCH}`]);
  if (r.status === 0) {
    throw new Error("wedgeMidRebase: expected a conflicting rebase to wedge the worktree, but it completed cleanly");
  }
  if (!isMidRebase(topo.b)) {
    throw new Error(`wedgeMidRebase: rebase exited ${r.status} but left no rebase-merge state`);
  }
  return d;
}

// ── concurrent-sync / held index.lock fixture (adjudication B) ────────────────

export interface HeldLock {
  /** The absolute path of the held `index.lock`. */
  readonly lockPath: string;
  /** Release the lock (idempotent). */
  release(): void;
}

/**
 * Hold the board worktree's `index.lock`, reproducing the concurrent-sync / GIT_BUSY state a second
 * git process would create: while held, any index-touching git op (`add`, `commit`, `rebase`) fails
 * with "Unable to create '…/index.lock': File exists". Created with O_EXCL so a double-hold throws.
 */
export function holdIndexLock(repo: BoardRepo): HeldLock {
  const lockPath = worktreeGitPath(repo, "index.lock");
  writeFileSync(lockPath, "", { flag: "wx" });
  let released = false;
  return {
    lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        rmSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

// ── non-empty, unprovisioned bundle dir (worktree-add refusal fixture) ────────

/**
 * Plant a NON-EMPTY, non-worktree `.agentstate-lite/` in an UNPROVISIONED clone — the "resolved or
 * refused, never a blind worktree add" case for U1's self-heal. Call on a clone built with
 * `{ provision: false }`.
 */
export async function plantNonEmptyBundleDir(repo: BoardRepo): Promise<void> {
  await mkdir(repo.board, { recursive: true });
  await writeFile(path.join(repo.board, "stray.md"), "# not a worktree — a pre-existing dir\n");
}
