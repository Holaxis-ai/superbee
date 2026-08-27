// Tests for `session-start` (sync-verb plan §U4) — the ONE SessionStart hook command: a
// time-boxed best-effort board pull, then the home render IN-PROCESS.
//
// Two layers, mirroring the codebase's convention:
//   1. Pure-function unit tests for the moment-(e) string builders (research/sync-verb-ux-review
//      (e); machine-honest per the cursor-honesty adjudication) and `buildBoardBlock`'s folding —
//      the exact strings are PINNED here.
//   2. Integration tests over `git-harness.ts` topologies, driving `sessionStart()` /
//      `sessionStartPull()` / `home()` with real git, real `~/.superbee-state/sync` state (HOME
//      swapped to a temp dir), and — for the time-box test — a REAL hanging remote (a `hang://`
//      remote helper that sleeps; spawnSync's timeout kill is the enforcement under test,
//      empirically verified to unblock even while the helper grandchild still holds the pipes).
//
// The home offline-guarantee suite (home.test.ts) is deliberately UNTOUCHED — this file only adds
// coverage for the new board surface.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { chmodSync, existsSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOARD_OFFLINE_NOTE,
  BOARD_UP_TO_DATE,
  actorPhrase,
  boardFirstContactLine,
  buildBoardBlock,
  docLine,
  defaultLoadBoardStatus,
  home,
  hookUpdateNote,
  sinceLine,
  uncommittedLine,
  unpushedLine,
  type BoardStatus,
} from "../src/commands/home.js";
import {
  SESSION_START_PULL_BUDGET_MS,
  sessionStart,
  sessionStartPull,
} from "../src/commands/session-start.js";
import { sync } from "../src/commands/sync.js";
import { resolveBundleKey } from "@superbee/board-git";
import {
  HOOK_TIMEOUT_SECONDS,
  buildOpenCodePluginSource,
  computeHookUninstall,
  computeSessionStartHookInstall,
  globalHookTargets,
  hook,
  hookInstalled,
  hookNeedsUpdate,
  isManagedHookCommand,
  readHookStatus,
  readSettingsForInstall,
  sessionStartHookCommand,
} from "../src/commands/hook.js";
import { CliError } from "../src/errors.js";
import {
  isSafeUnquotedHookToken,
  renderGeneratedHookToken,
  tokenizeGeneratedHookCommand,
} from "../src/hook-compatibility.js";
import {
  LEXICAL_ENVELOPE_FOREIGN_COMMANDS,
  MISMATCHED_NPM_NODE_COMMAND,
  NONCANONICAL_MANAGED_PATH_CASES,
  SHELL_FOREIGN_COMMANDS,
  localDevExecutable,
  stableNodePair,
} from "./hook-shell-fixtures.js";
import { readCache, readCursor, readMarker, readSelfActors, type AwarenessCache } from "../src/cursor.js";
import { initBundle, writeDoc } from "@superbee/core";
import { addCatalogEntry } from "../src/catalog.js";
import {
  commitBoard,
  git,
  makeTwoCloneTopology,
  modifyBoardDoc,
  pushBoard,
  writeBoardDoc,
  type BoardRepo,
} from "../../board-git/test/git-harness.js";

// ── scaffolding (mirrors sync.test.ts) ───────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(here, "..");
const cliBin = path.join(cliPackageRoot, "dist", "superbee.mjs");

/**
 * Deterministic CLI resolution for spawned hook commands. The installed hook no longer inherits
 * this PATH lookup: it binds absolute Node + CLI paths after the process establishes authority.
 */
let preferredBinDirPromise: Promise<string> | undefined;
function preferredBinDir(): Promise<string> {
  preferredBinDirPromise ??= (async () => {
    if (!existsSync(cliBin)) execFileSync("npm", ["run", "build"], { cwd: cliPackageRoot, stdio: "inherit" });
    const dir = await mkdtemp(path.join(tmpdir(), "superbee-preferred-bin-"));
    if (process.platform === "win32") {
      await writeFile(path.join(dir, "superbee.cmd"), `@echo off\r\n"${process.execPath}" "${cliBin}" %*\r\n`);
    } else {
      await symlink(cliBin, path.join(dir, "superbee"));
    }
    return dir;
  })();
  return preferredBinDirPromise;
}
test.after(async () => {
  if (preferredBinDirPromise) await rm(await preferredBinDirPromise, { recursive: true, force: true });
});

/** Spawn the built CLI with the managed bare bin available for its emitted-command identity. */
async function runCliHook(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const binDir = await preferredBinDir();
  const baseEnv = opts.env ?? process.env;
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd: opts.cwd,
    env: { ...baseEnv, PATH: `${binDir}${path.delimiter}${baseEnv.PATH ?? ""}` },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function assertPathIndependentLocalLaunch(command: string): string[] {
  const tokens = tokenizeGeneratedHookCommand(command);
  assert.ok(tokens, `expected generated hook command: ${command}`);
  assert.equal(tokens.length, 3);
  assert.equal(path.basename(tokens[0]!).toLowerCase(), process.platform === "win32" ? "node.exe" : "node");
  assert.equal(realpathSync(tokens[1]!), realpathSync(cliBin));
  assert.equal(tokens[2], "session-start");
  assert.equal(path.isAbsolute(tokens[0]!), true);
  assert.equal(path.isAbsolute(tokens[1]!), true);
  return tokens;
}

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevLocalAppData = process.env.LOCALAPPDATA;
  const prevAppData = process.env.APPDATA;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  try {
    return await run();
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocalAppData;
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
  }
}

async function withCwd<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "aslite-session-start-home-"));
}

function capture(): { out: () => string; stdout: (s: string) => void } {
  let buf = "";
  return { out: () => buf, stdout: (s: string) => void (buf += s) };
}

/** Run `sessionStart` in-process under a swapped HOME, capturing the render. */
async function runSessionStart(
  home: string,
  argv: string[],
  deps: Parameters<typeof sessionStart>[1] = {},
): Promise<string> {
  const cap = capture();
  await withHome(home, () => sessionStart(argv, { stdout: cap.stdout, ...deps }));
  return cap.out();
}

/** Run plain `home` in-process under a swapped HOME, capturing the render. */
async function runHome(homeDir: string, argv: string[]): Promise<string> {
  const cap = capture();
  // Neutralize the hook-freshness probe: it reads the REAL user home/cwd scopes by design, and
  // these tests assert board strings, not hook state.
  await withHome(homeDir, () => home(argv, { stdout: cap.stdout, hookNeedsUpdate: () => false }));
  return cap.out();
}

test("bare binding session-start and home retain the private owner state, not the public checkout", async () => {
  const topo = await makeTwoCloneTopology();
  const homeDir = await tempHome();
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    const result = await withHome(homeDir, () => withCwd(topo.a.root, () => sessionStartPull(undefined)));
    assert.equal(result?.boardPath, topo.b.board);
    assert.ok(await withHome(homeDir, () => readMarker(resolveBundleKey(topo.b.board))), "private board marker was refreshed");
    assert.equal(await withHome(homeDir, () => readMarker(resolveBundleKey(topo.a.board))), null, "public board marker was untouched");
    const rendered = await withHome(homeDir, () => withCwd(topo.a.root, () => runHome(homeDir, ["--json"])));
    const renderedRoot = (JSON.parse(rendered) as { bundle?: { root?: string } }).bundle?.root;
    assert.ok(renderedRoot, "bare home rendered a bundle root");
    const [renderedStat, expectedStat] = await Promise.all([stat(renderedRoot!), stat(topo.b.board)]);
    assert.equal(renderedStat.dev, expectedStat.dev, "bare home rendered the private bundle device");
    assert.equal(renderedStat.ino, expectedStat.ino, "bare home rendered the private bundle identity");
    assert.ok(await withHome(homeDir, () => readCache(resolveBundleKey(topo.b.board))), "bare home refreshed the private board cache");
    assert.equal(await withHome(homeDir, () => readCache(resolveBundleKey(topo.a.board))), null, "bare home never wrote public board state");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("bare home with an invalid board-shaped binding fails soft without public board effects", async () => {
  const topo = await makeTwoCloneTopology();
  const homeDir = await tempHome();
  try {
    const invalidParent = path.join(topo.a.root, "broken");
    const invalid = path.join(invalidParent, ".superbee");
    await mkdir(invalidParent, { recursive: true });
    // This is the adversarial shape: resolving the binding lands on the PUBLIC board. The
    // owner validator must reject its lexical symlink before bare home can turn it into an
    // explicit-dir board probe/state key.
    await symlink(topo.a.board, invalid, "dir");
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: invalid }));
    const publicHead = git(topo.a.board, ["rev-parse", "HEAD"]);

    const rendered = await withHome(homeDir, () => withCwd(topo.a.root, () => runHome(homeDir, [])));
    assert.match(rendered, /bundle/);
    assert.equal(git(topo.a.board, ["rev-parse", "HEAD"]), publicHead, "invalid binding did not select public Git");
    assert.equal(await withHome(homeDir, () => readCache(resolveBundleKey(topo.a.board))), null, "invalid binding wrote no public state");
    assert.equal(await withHome(homeDir, () => readMarker(resolveBundleKey(topo.a.board))), null, "invalid binding refreshed no public marker");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

async function runSync(home: string, argv: string[]): Promise<string> {
  const cap = capture();
  await withHome(home, () => sync(argv, { stdout: cap.stdout }));
  return cap.out();
}

function row(actor: string, verb = "updated", kind = "Task", title = "Seed one") {
  return { docId: "tasks/seed-one", verb, kind, title, actor };
}

function cacheOf(delta: ReturnType<typeof row>[], counts?: Partial<AwarenessCache>): AwarenessCache {
  return {
    updatedAt: "2026-07-08T00:00:00.000Z",
    delta,
    unpushedCount: 0,
    uncommittedCount: 0,
    ...counts,
  };
}

function provisionedStatus(
  cache: AwarenessCache | null,
  extra?: Partial<Extract<BoardStatus, { state: "provisioned" }>>,
): BoardStatus {
  return { state: "provisioned", cache, selfActors: [], unpushed: null, uncommitted: null, ...extra };
}

const INV = "superbee";

// ── 1. pinned moment-(e) strings (pure) ───────────────────────────────────────

test("budget constants: pull budget ≤ 7s, under the 10s hook timeout (plan §U4)", () => {
  assert.ok(SESSION_START_PULL_BUDGET_MS <= 7_000);
  assert.ok(SESSION_START_PULL_BUDGET_MS < HOOK_TIMEOUT_SECONDS * 1000);
});

test("moment (e) strings: since-line, per-doc human line, backstop lines — exact pins", () => {
  assert.equal(sinceLine([row("mike"), row("mike"), row("mike")]), "3 board changes from mike");
  assert.equal(sinceLine([row("mike")]), "1 board change from mike");
  assert.equal(docLine(row("mike", "updated", "Task", "Seed one")), 'mike · updated Task "Seed one"');
  assert.equal(docLine(row("sara", "added", "Note", "Welcome")), 'sara · added Note "Welcome"');
  assert.equal(docLine(row("jo", "deleted", "unknown", "old-doc")), 'jo · deleted "old-doc"');
  assert.equal(unpushedLine(2), "2 local board commits not yet pushed — run sync when online");
  assert.equal(unpushedLine(1), "1 local board commit not yet pushed — run sync when online");
  assert.equal(uncommittedLine(3), "3 uncommitted board changes — run sync to share them");
  assert.equal(uncommittedLine(1), "1 uncommitted board change — run sync to share it");
  assert.equal(BOARD_OFFLINE_NOTE, "board sync offline — showing last known state");
});

test("actor phrase is built from the ACTUAL actors — never assumes one teammate", () => {
  assert.equal(actorPhrase([row("mike")]), "mike");
  assert.equal(actorPhrase([row("mike"), row("sara")]), "mike and sara");
  assert.equal(actorPhrase([row("mike"), row("sara"), row("jo"), row("mike")]), "mike, sara and jo");
  assert.equal(
    sinceLine([row("mike"), row("sara")]),
    "2 board changes from mike and sara",
  );
});

test("buildBoardBlock: clean provisioned board → the pinned 'up to date' string", () => {
  const { block, firstContact } = buildBoardBlock(provisionedStatus(cacheOf([])), undefined, INV);
  assert.equal(block, BOARD_UP_TO_DATE);
  assert.equal(firstContact, undefined);
});

test("buildBoardBlock: offline pull → pinned note + last-known delta labeled as_of", () => {
  const status = provisionedStatus(cacheOf([row("mike")]));
  const { block } = buildBoardBlock(status, { offline: true }, INV);
  assert.ok(block && typeof block === "object");
  const rec = block as Record<string, unknown>;
  assert.equal(rec.note, BOARD_OFFLINE_NOTE);
  assert.equal(rec.since_this_machine_last_synced, "1 board change from mike");
  assert.equal(rec.as_of, "2026-07-08T00:00:00.000Z");
});

test("buildBoardBlock: ONLY a cache-refreshing pull skips as_of; a local-state swallow keeps it", () => {
  const status = provisionedStatus(cacheOf([row("mike")]));
  // A SUCCESSFUL pull (refreshed: the cache was just rewritten) — no freshness label needed.
  const fresh = buildBoardBlock(status, { offline: false, refreshed: true }, INV);
  assert.equal((fresh.block as Record<string, unknown>).as_of, undefined);
  assert.equal((fresh.block as Record<string, unknown>).note, undefined);
  // A local-state-swallowed pull (diverged/dirty): offline:false but the cache was NOT refreshed
  // — the as_of label must attach (review round: `!pull || pull.offline` let this read as fresh).
  const swallowed = buildBoardBlock(status, { offline: false }, INV);
  assert.equal((swallowed.block as Record<string, unknown>).as_of, "2026-07-08T00:00:00.000Z");
});

test("buildBoardBlock: self-authored rows are filtered from the human count", () => {
  const status = provisionedStatus(cacheOf([row("brian"), row("mike"), row("brian")]), {
    selfActors: ["brian"],
  });
  const { block } = buildBoardBlock(status, { offline: false }, INV);
  const rec = block as Record<string, unknown>;
  assert.equal(rec.since_this_machine_last_synced, "1 board change from mike");
  assert.deepEqual(rec.changes, ['mike · updated Task "Seed one"']);
  // ALL rows self-authored + zero counts ⇒ clean.
  const allSelf = buildBoardBlock(
    provisionedStatus(cacheOf([row("brian")]), { selfActors: ["brian"] }),
    { offline: false },
    INV,
  );
  assert.equal(allSelf.block, BOARD_UP_TO_DATE);
});

test("buildBoardBlock: backstop both counts — live counts preferred, cache counts the fallback", () => {
  const live = buildBoardBlock(
    provisionedStatus(cacheOf([], { unpushedCount: 9, uncommittedCount: 9 }), {
      unpushed: 2,
      uncommitted: 1,
    }),
    undefined,
    INV,
  );
  const rec = live.block as Record<string, unknown>;
  assert.equal(rec.unpushed, "2 local board commits not yet pushed — run sync when online");
  assert.equal(rec.uncommitted, "1 uncommitted board change — run sync to share it");
  const cached = buildBoardBlock(
    provisionedStatus(cacheOf([], { unpushedCount: 3, uncommittedCount: 0 })),
    undefined,
    INV,
  );
  assert.equal(
    (cached.block as Record<string, unknown>).unpushed,
    "3 local board commits not yet pushed — run sync when online",
  );
});

test("buildBoardBlock: cache note (re-anchor) and pull notes surface; changes list is capped", () => {
  const rows = Array.from({ length: 15 }, (_, i) => row("mike", "updated", "Task", `Doc ${i}`));
  const status = provisionedStatus(cacheOf(rows, { note: "delta unavailable (history rewritten or repositioned)" }));
  const { block } = buildBoardBlock(status, { offline: true, notes: ["extra"] }, INV);
  const rec = block as Record<string, unknown>;
  assert.equal(rec.since_this_machine_last_synced, "15 board changes from mike");
  assert.equal((rec.changes as string[]).length, 10);
  assert.equal(rec.note, `${BOARD_OFFLINE_NOTE}; extra; delta unavailable (history rewritten or repositioned)`);
});

test("buildBoardBlock: unprovisioned → probe-gated first-contact line (run sync, NEVER init)", () => {
  const { block, firstContact } = buildBoardBlock({ state: "unprovisioned" }, undefined, INV);
  assert.equal(block, undefined);
  assert.equal(firstContact, boardFirstContactLine(INV));
  assert.equal(firstContact, "not yet provisioned — run `superbee sync` to set it up");
  assert.ok(!firstContact!.includes("init"));
});

test("buildBoardBlock: no board status → no block, even when a pull outcome exists", () => {
  assert.deepEqual(buildBoardBlock(null, { offline: true }, INV), {});
});

test("buildBoardBlock: the both-worlds window renders the shared factory's line verbatim (F5 — one-hop truth)", () => {
  const { block, firstContact } = buildBoardBlock({ state: "window", line: "the window truth" }, undefined, INV);
  assert.equal(block, undefined);
  assert.equal(firstContact, "the window truth", "the line rides the init-hint-suppressing slot");
});

// ── 2. integration: two-clone e2e over the harness ───────────────────────────

test("two-clone e2e: A pushes, B's session-start renders A's changes attributed (moment (e))", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    // A (teammate "mike") modifies a seed doc and adds a new one; pushes to origin/board.
    await modifyBoardDoc(topo.a, "tasks/seed-one", { body: "# Seed one\n\nrevised\n" });
    await writeBoardDoc(topo.a, "tasks/fresh", {
      frontmatter: { type: "Task", title: "Fresh work", actor: "mike" },
      body: "# Fresh work\n\nnew\n",
    });
    commitBoard(topo.a, "board: mike — 2 docs");
    pushBoard(topo.a);

    // B's session start: pull-then-render, one command, in-process.
    const out = await runSessionStart(homeB, ["--dir", topo.b.root]);

    assert.match(out, /since_this_machine_last_synced: 2 board changes from mike/);
    // TOON escapes the inner quotes inside array items — assert on the stable substrings.
    assert.ok(out.includes("mike · updated Task") && out.includes("Seed one"), out);
    assert.ok(out.includes("mike · added Task") && out.includes("Fresh work"), out);
    // The render is the full home view (identity header + bundle dashboard) — not a bare receipt.
    assert.match(out, /\.superbee/);
    assert.match(out, /bundle:/);

    // Cursor advanced to B's post-pull HEAD (successful pull).
    const key = await withHome(homeB, async () => resolveBundleKey(topo.b.board));
    const cursor = await withHome(homeB, () => readCursor(key));
    assert.ok(cursor, "expected a cursor after a successful pull");
    assert.equal(cursor!.token, git(topo.b.board, ["rev-parse", "HEAD"]).trim());

    // Marker refreshed by the pull step.
    assert.ok(await withHome(homeB, () => readMarker(key)));

    // A second session with nothing new: clean → the pinned 'board: up to date'.
    const again = await runSessionStart(homeB, ["--dir", topo.b.root]);
    assert.match(again, /board: up to date/);
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("self-authored filtering e2e: my own synced docs never inflate my since-line", async () => {
  const topo = await makeTwoCloneTopology();
  const homeA = await tempHome();
  try {
    // A writes a doc attributed to brian and syncs it (sync records brian as a SELF actor).
    await writeBoardDoc(topo.a, "tasks/mine", {
      frontmatter: { type: "Task", title: "My own work", actor: "brian" },
      body: "# Mine\n",
    });
    await runSync(homeA, ["--dir", topo.a.root]);
    const key = await withHome(homeA, async () => resolveBundleKey(topo.a.board));
    assert.deepEqual(await withHome(homeA, () => readSelfActors(key)), ["brian"]);

    // The sync's own cache delta contains brian's row — but the render filters it: clean board.
    const out = await runSessionStart(homeA, ["--dir", topo.a.root]);
    assert.match(out, /board: up to date/);
    assert.ok(!out.includes("board change from brian"), "self-authored row must not render");
  } finally {
    await topo.cleanup();
    await rm(homeA, { recursive: true, force: true });
  }
});

test("backstop both counts e2e: unpushed commits AND uncommitted changes render after a pull", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    // Two local board commits not pushed…
    await writeBoardDoc(topo.b, "tasks/local-one", {
      frontmatter: { type: "Task", title: "Local one", actor: "brian" },
      body: "x\n",
    });
    commitBoard(topo.b, "board: brian — 1 doc");
    await writeBoardDoc(topo.b, "tasks/local-two", {
      frontmatter: { type: "Task", title: "Local two", actor: "brian" },
      body: "x\n",
    });
    commitBoard(topo.b, "board: brian — 1 doc");
    // …plus one uncommitted change sitting in the worktree.
    await writeBoardDoc(topo.b, "tasks/uncommitted", {
      frontmatter: { type: "Task", title: "Uncommitted", actor: "brian" },
      body: "x\n",
    });

    const out = await runSessionStart(homeB, ["--dir", topo.b.root]);
    assert.match(out, /unpushed: 2 local board commits not yet pushed — run sync when online/);
    assert.match(out, /uncommitted: 1 uncommitted board change — run sync to share it/);
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("provisioning receipt: a fresh clone's session-start provisions LOUDLY and renders the bundle", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const homeB = await tempHome();
  try {
    const out = await runSessionStart(homeB, ["--dir", topo.b.root]);
    // Rider-2 announcement (the run that materialized the whole board must not read as a no-op).
    assert.match(out, /provisioned: .* — materialized from origin\/board/);
    // The freshly provisioned board's docs are the render's bundle dashboard (doc count).
    assert.match(out, /docs: 3/);
    // Marker + cursor exist (pull step completed).
    const key = await withHome(homeB, async () => resolveBundleKey(topo.b.board));
    assert.ok(await withHome(homeB, () => readMarker(key)));
    assert.ok(await withHome(homeB, () => readCursor(key)));
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

// ── 3. first-contact matrix (probe-gated, never marker-only) ─────────────────

test("first-contact: fresh clone + origin/board exists → 'run sync' hint, NEVER 'run init'", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const homeB = await tempHome();
  try {
    // Plain home (no pull at all): the fs+local-git probe alone must steer to sync. A brand-new
    // clone has NO marker (per-clone keying) — this is exactly the probe-gated case.
    const out = await runHome(homeB, ["--dir", topo.b.root]);
    assert.match(out, /board: not yet provisioned — run `.* sync` to set it up/);
    assert.ok(!out.includes("getting_started"), "the init hint must be suppressed");
    assert.ok(!/run `[^`]*init`/.test(out), "no init hint may appear");
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("first-contact: no board anywhere → today's behavior (init hint), no board block", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-noboard-"));
  const homeDir = await tempHome();
  try {
    git(dir, ["init", "-b", "main", "."]);
    await writeFile(path.join(dir, "README.md"), "# plain repo\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const out = await runHome(homeDir, ["--dir", path.join(dir, "missing")]);
    assert.ok(out.includes("getting_started"));
    assert.ok(out.includes("no OKF bundle found"));
    assert.ok(!out.includes("board:"), "no board block for a boardless repo");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ── 4. fail-soft matrix + time box ────────────────────────────────────────────

test("offline pull: unreachable origin → pinned offline note, cursor NOT advanced, render still appears", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    // First, a successful session start to plant a cursor + cache.
    await runSessionStart(homeB, ["--dir", topo.b.root]);
    const key = await withHome(homeB, async () => resolveBundleKey(topo.b.board));
    const cursorBefore = await withHome(homeB, () => readCursor(key));
    assert.ok(cursorBefore);

    // Teammate pushes; then B goes offline (origin URL points at nothing).
    await modifyBoardDoc(topo.a, "notes/welcome", { body: "# Welcome\n\nchanged\n" });
    commitBoard(topo.a, "board: mike — 1 doc");
    pushBoard(topo.a);
    git(topo.b.root, ["remote", "set-url", "origin", path.join(topo.dir, "gone.git")]);

    const out = await runSessionStart(homeB, ["--dir", topo.b.root]);
    assert.match(out, /board sync offline — showing last known state/);
    const cursorAfter = await withHome(homeB, () => readCursor(key));
    assert.equal(cursorAfter!.token, cursorBefore!.token, "cursor must not advance on a failed pull");
    // The marker is still refreshed by every pull step (the board demonstrably exists locally).
    assert.ok(await withHome(homeB, () => readMarker(key)));
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("time-box fall-through: a REAL hanging remote is killed inside the budget and home still renders", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  const helperDir = await mkdtemp(path.join(tmpdir(), "aslite-hang-helper-"));
  const prevPath = process.env.PATH;
  try {
    // A remote helper that hangs: `git fetch` over hang:// blocks until killed. The pull step's
    // per-op spawnSync timeout (sliced from the remaining budget) is the enforcement under test.
    const helper = path.join(helperDir, "git-remote-hang");
    await writeFile(helper, "#!/bin/sh\nsleep 60\n");
    chmodSync(helper, 0o755);
    process.env.PATH = `${helperDir}${path.delimiter}${prevPath ?? ""}`;
    git(topo.b.root, ["remote", "set-url", "origin", "hang://black.hole/repo"]);

    const budgetMs = 1_500;
    const t0 = Date.now();
    const out = await runSessionStart(homeB, ["--dir", topo.b.root], { budgetMs });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 5_000, `render must appear within the budget (took ${elapsed}ms)`);
    assert.match(out, /board sync offline — showing last known state/);
    assert.match(out, /\.superbee/); // the full home render fell through
  } finally {
    process.env.PATH = prevPath;
    await rm(helperDir, { recursive: true, force: true });
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("zero-at-the-fetch-boundary: a budget that decays to 0 AFTER the guard never reaches spawnSync (PR#24 MEDIUM)", async () => {
  // The exact reported mechanism: the ffPull call site is guarded, but local ops run between the
  // guard and the `remaining()` evaluation of the fetch slice — a scripted clock passes every
  // guard (calls 1-4 stay at t0) and then jumps past the deadline, so the slice handed to the
  // fetch is EXACTLY 0. Node's spawnSync treats timeout:0 as NO timeout, so without the
  // runGitBytes floor this would hang on the hang:// helper for 60s, unpreemptable by any race.
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  const helperDir = await mkdtemp(path.join(tmpdir(), "aslite-zero-boundary-"));
  const prevPath = process.env.PATH;
  try {
    const helper = path.join(helperDir, "git-remote-hang");
    await writeFile(helper, "#!/bin/sh\nsleep 60\n");
    chmodSync(helper, 0o755);
    process.env.PATH = `${helperDir}${path.delimiter}${prevPath ?? ""}`;
    git(topo.b.root, ["remote", "set-url", "origin", "hang://black.hole/repo"]);

    const budgetMs = 5_000;
    const t0real = Date.now();
    let calls = 0;
    // Calls 1-4: deadline mint, entry guard, provision slice, post-provision guard — all at t0.
    // Call 5+ (the ffPull slice and after): past the deadline → remaining() clamps to exactly 0.
    const scriptedNow = () => {
      calls += 1;
      return calls <= 4 ? t0real : t0real + budgetMs + 1_000;
    };
    const outcome = await withHome(homeB, () =>
      sessionStartPull(topo.b.root, budgetMs, scriptedNow),
    );
    const elapsed = Date.now() - t0real;

    assert.ok(elapsed < 5_000, `the 0 slice must classify immediately, never spawn (took ${elapsed}ms)`);
    assert.ok(outcome, "a provisioned board yields an outcome");
    assert.equal(outcome!.offline, true, "a zero-slice fetch is an offline outcome");
    assert.ok(outcome!.boardPath, "decay must have hit the FETCH boundary, past the entry guard");
    assert.equal(outcome!.refreshed, undefined, "no cache refresh on a floored pull");
    // Marker refreshed (board confirmed), cursor NOT advanced (no successful pull).
    const key = await withHome(homeB, async () => resolveBundleKey(topo.b.board));
    assert.ok(await withHome(homeB, () => readMarker(key)));
    assert.equal(await withHome(homeB, () => readCursor(key)), null);
  } finally {
    process.env.PATH = prevPath;
    await rm(helperDir, { recursive: true, force: true });
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("zero budget at entry: the guard takes the offline path before ANY network op; render still appears", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  const helperDir = await mkdtemp(path.join(tmpdir(), "aslite-zero-entry-"));
  const prevPath = process.env.PATH;
  try {
    const helper = path.join(helperDir, "git-remote-hang");
    await writeFile(helper, "#!/bin/sh\nsleep 60\n");
    chmodSync(helper, 0o755);
    process.env.PATH = `${helperDir}${path.delimiter}${prevPath ?? ""}`;
    git(topo.b.root, ["remote", "set-url", "origin", "hang://black.hole/repo"]);

    const t0 = Date.now();
    const out = await runSessionStart(homeB, ["--dir", topo.b.root], { budgetMs: 0 });
    assert.ok(Date.now() - t0 < 5_000, "zero budget must never wait on the network");
    assert.match(out, /board sync offline — showing last known state/);
    assert.match(out, /\.superbee/);
  } finally {
    process.env.PATH = prevPath;
    await rm(helperDir, { recursive: true, force: true });
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("fall-through belt: an injected pull that NEVER resolves still renders home at the budget", async () => {
  const homeDir = await tempHome();
  try {
    const t0 = Date.now();
    const out = await runSessionStart(homeDir, [], {
      budgetMs: 200,
      pull: () => new Promise(() => {}),
    });
    assert.ok(Date.now() - t0 < 3_000);
    assert.match(out, /\.superbee/);
    assert.match(out, /commands:/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("session-start inherits non-empty workspace orientation from home", async () => {
  const homeDir = await realpath(await tempHome());
  const bundleDir = path.join(homeDir, "personal-bundle");
  try {
    await initBundle(bundleDir);
    await addCatalogEntry("personal", bundleDir, { home: homeDir });

    const out = await runSessionStart(homeDir, ["--json"], {
      budgetMs: 50,
      pull: async () => undefined,
    });
    const view = JSON.parse(out) as Record<string, any>;
    assert.equal(view.workspaces.count, 1);
    assert.equal(view.workspaces.shown, 1);
    assert.deepEqual(view.workspaces.entries, [{ label: "personal" }]);
    assert.match(view.workspaces.help, /catalog resolve <label-or-id> --field path$/);
    assert.doesNotMatch(JSON.stringify(view.workspaces), /(?:locator|personal-bundle|bnd_)/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("fail-soft: a THROWING injected pull still renders (offline outcome), exit path clean", async () => {
  const homeDir = await tempHome();
  try {
    const out = await runSessionStart(homeDir, [], {
      pull: () => Promise.reject(new Error("boom")),
    });
    assert.match(out, /\.superbee/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("local-state swallow (diverged) → honest 'run sync' note, not the offline note; stale cache labeled as_of", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    // A successful session start first, so a cache exists to be honestly labeled stale later.
    await runSessionStart(homeB, ["--dir", topo.b.root]);

    // B commits locally; A pushes a different commit — origin and B diverge.
    await writeBoardDoc(topo.b, "tasks/b-local", {
      frontmatter: { type: "Task", title: "B local", actor: "brian" },
      body: "x\n",
    });
    commitBoard(topo.b, "board: brian — 1 doc");
    await modifyBoardDoc(topo.a, "notes/welcome", { body: "# Welcome\n\nmoved\n" });
    commitBoard(topo.a, "board: mike — 1 doc");
    pushBoard(topo.a);

    const out = await runSessionStart(homeB, ["--dir", topo.b.root]);
    assert.match(out, /board pull skipped \(diverged\) — run `.* sync` to reconcile/);
    assert.ok(!out.includes(BOARD_OFFLINE_NOTE), "a divergence is not an offline state");
    // The swallowed pull did NOT refresh the cache — the render must carry the freshness label
    // (review round: offline:false must not read as "just pulled").
    assert.match(out, /as_of: /);
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("sync's pull step also refreshes the marker (U4 inherited item 5: a synced repo presents it)", async () => {
  const topo = await makeTwoCloneTopology();
  const homeA = await tempHome();
  try {
    await runSync(homeA, ["--dir", topo.a.root]);
    const key = await withHome(homeA, async () => resolveBundleKey(topo.a.board));
    assert.ok(await withHome(homeA, () => readMarker(key)), "sync must refresh the board marker");
  } finally {
    await topo.cleanup();
    await rm(homeA, { recursive: true, force: true });
  }
});

test("defaultLoadBoardStatus: provisioned board reports live counts + cache; boardless dir → null", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    await writeBoardDoc(topo.b, "tasks/pending", {
      frontmatter: { type: "Task", title: "Pending", actor: "brian" },
      body: "x\n",
    });
    const status = await withHome(homeB, () => defaultLoadBoardStatus(topo.b.root));
    assert.ok(status && status.state === "provisioned");
    assert.equal(status.uncommitted, 1);
    assert.equal(status.unpushed, 0);
    assert.equal(await defaultLoadBoardStatus(tmpdir()), null);
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("home and session-start preserve a dual conventional-bundle conflict instead of suggesting init", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const homeDir = await tempHome();
  try {
    await initBundle(path.join(topo.a.root, ".superbee"));
    await initBundle(path.join(topo.a.root, ".agentstate-lite"));

    const status = await defaultLoadBoardStatus(topo.a.root);
    assert.equal(status?.state, "conflict");
    assert.match(status?.state === "conflict" ? status.line : "", /refusing to choose/);

    const rendered = JSON.parse(await runSessionStart(homeDir, ["--dir", topo.a.root, "--json"])) as Record<string, unknown>;
    assert.match(String(rendered.board), /refusing to choose/);
    assert.equal(rendered.getting_started, undefined);
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ── 5. hook wiring (install/status/uninstall + the re-install prompt) ─────────

test("hook install wires `session-start` into all three runtimes; status/uninstall agree", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-base-"));
  try {
    // The CLI itself is found through PATH, but the WRITTEN command is fully absolute.
    const install = await runCliHook(["hook", "install", "--json"], { cwd: base });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const installReceipt = JSON.parse(install.stdout).hook;
    assert.equal(installReceipt.changed, true);
    assert.equal(installReceipt.restart_required, true);
    assert.deepEqual(installReceipt.affected_hosts, ["claude_code", "codex", "opencode"]);
    assert.match(install.stdout, /session-start/);

    const claude = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(path.join(base, ".claude", "settings.json"), "utf8")),
    );
    const entry = claude.hooks.SessionStart[0].hooks[0];
    const launchTokens = assertPathIndependentLocalLaunch(entry.command);
    assert.equal(entry.timeout, HOOK_TIMEOUT_SECONDS);

    const codex = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(path.join(base, ".codex", "hooks.json"), "utf8")),
    );
    assert.equal(codex.hooks.SessionStart[0].hooks[0].command, entry.command);

    const plugin = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(base, ".config", "opencode", "plugins", "axi-superbee.js"), "utf8"),
    );
    assert.ok(plugin.includes("axi-sdk-js managed opencode plugin: superbee"));
    assert.ok(plugin.includes(`const command = ${JSON.stringify(launchTokens[0])}`));
    assert.ok(plugin.includes(`const commandArgs = ${JSON.stringify(launchTokens.slice(1))}`));

    const minimalPathRun = spawnSync(
      process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      process.platform === "win32" ? ["/d", "/s", "/c", entry.command] : ["-c", entry.command],
      {
      cwd: base,
      env: {
        HOME: base,
        USERPROFILE: base,
        LOCALAPPDATA: path.join(base, "AppData", "Local"),
        APPDATA: path.join(base, "AppData", "Roaming"),
        PATH: process.platform === "win32" ? process.env.SystemRoot ?? "C:\\Windows" : "/usr/bin:/bin",
        AGENTSTATE_LITE_NO_AUTOPULL: "1",
      },
      encoding: "utf8",
      },
    );
    assert.equal(minimalPathRun.status, 0, minimalPathRun.stdout + minimalPathRun.stderr);

    // A freshly installed hook needs no update…
    assert.equal(hookNeedsUpdate([base]), false);

    const capStatus = capture();
    await hook(["status"], { base, stdout: capStatus.stdout });
    assert.match(capStatus.out(), /installed: true/);
    assert.match(capStatus.out(), /session-start/);

    const capUn = capture();
    await hook(["uninstall"], { base, stdout: capUn.stdout });
    assert.match(capUn.out(), /installed: false/);
    assert.equal(hookNeedsUpdate([base]), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("user hook operations honor relocated config homes and global remains an alias", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aslite-hook-relocated-"));
  const homeDir = path.join(root, "home");
  const claudeHome = path.join(root, "claude-config");
  const codexHome = path.join(root, "codex-home");
  const xdgHome = path.join(root, "xdg-config");
  const cwd = path.join(root, "project");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    OPENCODE_CONFIG_DIR: "",
    XDG_CONFIG_HOME: xdgHome,
  };
  const location = { cwd, home: homeDir, env };
  try {
    await mkdir(homeDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    // Spawned as the bare preferred bin (checkout-path-independent recognition of the written
    // command); the child's HOME is redirected so user-scope fallbacks resolve inside the fixture.
    const install = await runCliHook(["hook", "install", "--scope", "user"], {
      cwd,
      env: { ...env, HOME: homeDir, USERPROFILE: homeDir },
    });
    assert.equal(install.status, 0, install.stdout + install.stderr);

    const claude = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    assertPathIndependentLocalLaunch(claude.hooks.SessionStart[0].hooks[0].command);
    const codex = JSON.parse(await readFile(path.join(codexHome, "hooks.json"), "utf8"));
    assert.equal(codex.hooks.SessionStart[0].hooks[0].command, claude.hooks.SessionStart[0].hooks[0].command);
    assert.match(await readFile(path.join(codexHome, "config.toml"), "utf8"), /hooks = true/);
    assert.match(
      await readFile(path.join(xdgHome, "opencode", "plugins", "axi-superbee.js"), "utf8"),
      /axi-sdk-js managed opencode plugin: superbee/,
    );
    assert.equal(hookInstalled(undefined, location), true);
    assert.equal(hookNeedsUpdate(undefined, location), false);

    const status = capture();
    await hook(["status", "--scope", "global"], { ...location, stdout: status.stdout });
    assert.match(status.out(), /installed: true/);
    assert.match(status.out(), /scope: user/);
    assert.match(status.out(), new RegExp(codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await assert.rejects(() => readFile(path.join(homeDir, ".claude", "settings.json")));
    await assert.rejects(() => readFile(path.join(homeDir, ".codex", "hooks.json")));
    await assert.rejects(() =>
      readFile(path.join(homeDir, ".config", "opencode", "plugins", "axi-superbee.js")),
    );

    await hook(["uninstall", "--scope", "user"], { ...location, stdout: () => {} });
    assert.equal(hookInstalled(undefined, location), false);
    await assert.rejects(() =>
      readFile(path.join(xdgHome, "opencode", "plugins", "axi-superbee.js")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode's explicit config directory takes precedence over its XDG config root", () => {
  const targets = globalHookTargets("/home/test", {
    XDG_CONFIG_HOME: "/xdg",
    OPENCODE_CONFIG_DIR: "/profiles/review",
  });
  assert.equal(targets.opencodePlugin, path.join("/profiles/review", "plugins", "axi-superbee.js"));
});

test("hook re-install prompt: a pre-session-start managed hook is detected and surfaced in home", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-old-"));
  const homeDir = await tempHome();
  try {
    // Seed the OLD hook shape (the pre-U4 home-only command — bare bin, no subcommand).
    await mkdir(path.join(base, ".claude"), { recursive: true });
    await writeFile(
      path.join(base, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { matcher: "", hooks: [{ type: "command", command: "agentstate-lite", timeout: 10 }] },
            ],
          },
        },
        null,
        2,
      ),
    );
    assert.equal(hookNeedsUpdate([base]), true);

    // home surfaces the self-clearing re-install prompt when the probe reports outdated.
    const cap = capture();
    await withHome(homeDir, () => home([], { stdout: cap.stdout, hookNeedsUpdate: () => true }));
    assert.match(cap.out(), /hook_update: .*predates `session-start` — re-run `.* hook install`/);
    assert.equal(hookUpdateNote(INV).includes("hook install"), true);

    // Re-running install rewrites the command — the prompt clears. Spawned as the bare preferred
    // bin so the rewritten command is recognizably managed at any checkout path.
    const install = await runCliHook(["hook", "install"], { cwd: base });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const rewritten = JSON.parse(await readFile(path.join(base, ".claude", "settings.json"), "utf8"));
    assertPathIndependentLocalLaunch(rewritten.hooks.SessionStart[0].hooks[0].command);
    assert.equal(hookNeedsUpdate([base]), false);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("sessionStartHookCommand: bare base passes through; a spaced path is quoted; plugin spawns argv", () => {
  assert.equal(sessionStartHookCommand("aslite"), "aslite session-start");
  const spaced = "/Users/f b/packages/cli/dist/superbee.mjs";
  assert.equal(sessionStartHookCommand(spaced), `${renderGeneratedHookToken(spaced)} session-start`);
  const src = buildOpenCodePluginSource("/opt/bin/agentstate-lite");
  assert.ok(src.includes('const command = "/opt/bin/agentstate-lite"'));
  assert.ok(src.includes('const commandArgs = ["session-start"]'));
});

test("writer/recognizer agreement: every reachable hookCommand() base composes a command recognition claims", async () => {
  // One table over the composer (writer) and isManagedHookCommand (recognizer) — the invariant
  // the review addendum named: no channel may write a hook our own recognition would not claim.
  const reachableBases = [
    "superbee", //                                                     bare preferred bin on PATH
    "aslite", //                                                       bare legacy alias on PATH
    "agentstate-lite", //                                              bare legacy bin on PATH
    "/usr/local/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs", // npm-dist absolute path (scoped install root)
    "/Users/f b/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs", //    absolute path WITH spaces (quoted form)
  ];
  for (const base of reachableBases) {
    const composed = sessionStartHookCommand(base);
    assert.equal(isManagedHookCommand(composed), true, `writer/recognizer drift for base: ${base}`);
  }

  // Negative — the GUARD, not just the predicate: a token-free exotic base is refused by the
  // owning composer, and install over it refuses BEFORE writing anything anywhere.
  const exotic = "/tmp/x/bin/mytool.mjs";
  assert.throws(() => sessionStartHookCommand(exotic), /refusing to install an orphan hook/);

  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-orphan-guard-"));
  try {
    const cap = capture();
    await assert.rejects(
      () => hook(["install"], { base, commandBase: exotic, stdout: cap.stdout }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "RUNTIME");
        assert.equal(err.exitCode, 1);
        assert.match(err.message, /would not be recognized as managed — refusing to install an orphan hook/);
        return true;
      },
    );
    assert.equal(cap.out(), "", "no success receipt for a refused install");
    assert.deepEqual(await readdir(base), [], "nothing was written to ANY target");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 5b. managed-hook recognition across BOTH command forms (aslite coordinate) ─
//
// The npm coordinate rename made `aslite` the preferred bin, so a written hook command can be
// `aslite session-start` — which the legacy `agentstate-lite` substring marker does NOT match.
// These tests pin the two-form recognition rule and the upgrade path: install REWRITES a legacy
// hook (no duplicate), reinstall over a correct new-form hook is a no-op, uninstall/status see
// either form, and a foreign SessionStart hook is never touched.

test("isManagedHookCommand: exact historical/generated tokens, never marker substrings", () => {
  // Canonical generated form.
  assert.equal(isManagedHookCommand("superbee session-start"), true);
  assert.equal(isManagedHookCommand("superbee"), true);
  // Legacy generated forms.
  assert.equal(isManagedHookCommand("agentstate-lite session-start"), true);
  assert.equal(isManagedHookCommand("/opt/homebrew/bin/agentstate-lite session-start"), false);
  assert.equal(isManagedHookCommand("npx -y agentstate-lite session-start"), true);
  assert.equal(isManagedHookCommand('"/Users/f b/dist/agentstate-lite.mjs" session-start'), false);
  assert.equal(isManagedHookCommand("echo agentstate-lite"), false);
  assert.equal(isManagedHookCommand("agentstate-lite backup"), false);
  // New form — bare historical commands remain owned but migration-required. Absolute commands
  // are owned only at executable layouts the installer has actually emitted.
  assert.equal(isManagedHookCommand("aslite session-start"), true);
  assert.equal(isManagedHookCommand("aslite"), true);
  assert.equal(isManagedHookCommand("/usr/local/bin/aslite session-start"), false);
  assert.equal(isManagedHookCommand('"/Users/f b/bin/aslite" session-start'), false);
  assert.equal(
    isManagedHookCommand("/usr/local/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start"),
    true,
  );
  // Documented asymmetry: the new-form npx spelling is NOT recognized (first token `npx`) —
  // the installer never emits an npx form, so only hand-authored hooks can hit this.
  assert.equal(isManagedHookCommand("npx -y aslite session-start"), false);
  assert.equal(isManagedHookCommand("npx -y @holaxis/aslite session-start"), false);
  // Never a false positive on a foreign command merely containing the letters.
  assert.equal(isManagedHookCommand("easlite session-start"), false);
  assert.equal(isManagedHookCommand("aslite2 session-start"), false);
  assert.equal(isManagedHookCommand("/x/easlite session-start"), false);
  assert.equal(isManagedHookCommand("some-tool --aslite"), false);
  assert.equal(isManagedHookCommand("echo aslite-is-not-first"), false);
  assert.equal(isManagedHookCommand("echo hello"), false);
});

const FOREIGN_HOOK = { type: "command", command: "some-other-tool session-start", timeout: 30 };

test("computeSessionStartHookInstall: a LEGACY hook is rewritten IN PLACE — no duplicate appended", () => {
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ ...FOREIGN_HOOK }] },
        { matcher: "", hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }] },
      ],
    },
  };
  const [updated, changed] = computeSessionStartHookInstall(settings, { command: "aslite session-start" });
  assert.equal(changed, true);
  const groups = updated.hooks!.SessionStart!;
  assert.equal(groups.length, 2, "no new group appended");
  assert.deepEqual(groups[0]!.hooks, [FOREIGN_HOOK], "foreign hook untouched");
  assert.deepEqual(groups[1]!.hooks, [
    { type: "command", command: "aslite session-start", timeout: HOOK_TIMEOUT_SECONDS },
  ]);
});

test("computeSessionStartHookInstall: reinstall over a correct NEW-form hook is a no-op", () => {
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "aslite session-start", timeout: HOOK_TIMEOUT_SECONDS }] },
      ],
    },
  };
  const [updated, changed] = computeSessionStartHookInstall(settings, { command: "aslite session-start" });
  assert.equal(changed, false);
  assert.equal(updated, settings, "the unchanged input object is returned");
});

test("computeSessionStartHookInstall: a legacy+new duplicate pair collapses to ONE managed hook", () => {
  // The state an SDK-marker install would have left: a legacy hook plus an appended aslite one.
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }] },
        { matcher: "", hooks: [{ ...FOREIGN_HOOK }, { type: "command", command: "aslite session-start", timeout: 10 }] },
      ],
    },
  };
  const [updated, changed] = computeSessionStartHookInstall(settings, { command: "aslite session-start" });
  assert.equal(changed, true);
  const groups = updated.hooks!.SessionStart!;
  const managed = groups.flatMap((g) => g.hooks ?? []).filter((h) => isManagedHookCommand(h.command ?? ""));
  assert.equal(managed.length, 1, "exactly one managed hook survives");
  assert.equal(groups[0]!.hooks![0]!.command, "aslite session-start", "first managed hook rewritten in place");
  assert.deepEqual(groups[1]!.hooks, [FOREIGN_HOOK], "foreign hook survives the duplicate sweep");
});

test("uninstall + status recognize historical and generated managed forms; a foreign hook is never touched", () => {
  for (const command of [
    "agentstate-lite session-start",
    "aslite session-start",
    "/usr/local/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start",
  ]) {
    const settings = {
      hooks: {
        SessionStart: [
          { matcher: "", hooks: [{ ...FOREIGN_HOOK }] },
          { matcher: "", hooks: [{ type: "command", command, timeout: 10 }] },
        ],
      },
    };
    assert.deepEqual(readHookStatus(settings), { installed: true, command }, `status must see: ${command}`);
    const [updated, changed] = computeHookUninstall(settings);
    assert.equal(changed, true, `uninstall must remove: ${command}`);
    assert.deepEqual(updated.hooks!.SessionStart, [{ matcher: "", hooks: [FOREIGN_HOOK] }]);
    assert.equal(readHookStatus(updated).installed, false);
  }
  // A settings file with ONLY a foreign hook: uninstall is a no-op, status reports not installed.
  const foreignOnly = { hooks: { SessionStart: [{ matcher: "", hooks: [{ ...FOREIGN_HOOK }] }] } };
  const [after, changed] = computeHookUninstall(foreignOnly);
  assert.equal(changed, false);
  assert.equal(after, foreignOnly);
  assert.equal(readHookStatus(foreignOnly).installed, false);
});

test("writer and recognizer round-trip the complete printable alphabet and representative Node pairs", () => {
  for (let code = 0x20; code <= 0x7e; code += 1) {
    const character = String.fromCharCode(code);
    const executable = localDevExecutable(character);
    const command = sessionStartHookCommand(executable, ["session-start"], "linux");
    assert.equal(command, `${renderGeneratedHookToken(executable, "linux")} session-start`, JSON.stringify(character));
    assert.deepEqual(tokenizeGeneratedHookCommand(command, "linux"), [executable, "session-start"], JSON.stringify(character));
    assert.equal(isManagedHookCommand(command, "linux"), true, JSON.stringify(character));
    assert.equal(command.startsWith("'"), !isSafeUnquotedHookToken(executable), JSON.stringify(character));
  }
  for (const character of ["{a,b}", "${HOME}", "*", "café", "a b", "a'b", String.raw`a\b`]) {
    const [runtime, executable] = stableNodePair(character);
    const command = sessionStartHookCommand(runtime, [executable, "session-start"], "linux");
    assert.deepEqual(tokenizeGeneratedHookCommand(command, "linux"), [runtime, executable, "session-start"], character);
    assert.equal(isManagedHookCommand(command, "linux"), true, character);
  }
});

test("built uninstall preserves noncanonical lexical envelopes byte-for-byte for Claude and Codex", { skip: process.platform === "win32" ? "POSIX lexical-envelope matrix has a dedicated Windows grammar suite" : undefined }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-lexical-foreign-"));
  const settings = JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: LEXICAL_ENVELOPE_FOREIGN_COMMANDS.map(({ command }) => ({
              type: "command",
              command,
              timeout: 10,
            })),
          },
        ],
      },
    },
    null,
    2,
  ) + "\n";
  const targets = [
    path.join(base, ".claude", "settings.json"),
    path.join(base, ".codex", "hooks.json"),
  ];
  try {
    for (const target of targets) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, settings);
    }

    const result = await runCliHook(["hook", "uninstall", "--json"], { cwd: base });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).hook.changed, false);
    for (const target of targets) {
      assert.equal(await readFile(target, "utf8"), settings, `${target} must remain byte-identical`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("built uninstall recognizes every canonical lexical envelope", { skip: process.platform === "win32" ? "POSIX lexical-envelope matrix has a dedicated Windows grammar suite" : undefined }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-lexical-owned-"));
  const canonicalCommands = [
    "aslite session-start",
    "'/tmp/a b/packages/cli/dist/superbee.mjs' session-start",
    String.raw`'/tmp/a'\''b/packages/cli/dist/superbee.mjs' session-start`,
    '"/tmp/a b/packages/cli/dist/superbee.mjs" session-start',
    String.raw`'/opt/a'\''b/bin/node' '/opt/a'\''b/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs' session-start`,
  ];
  const settings = JSON.stringify(
    {
      hooks: {
        SessionStart: canonicalCommands.map((command) => ({
          matcher: "",
          hooks: [{ type: "command", command, timeout: 10 }],
        })),
      },
    },
    null,
    2,
  ) + "\n";
  const targets = [
    path.join(base, ".claude", "settings.json"),
    path.join(base, ".codex", "hooks.json"),
  ];
  try {
    for (const target of targets) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, settings);
    }

    const result = await runCliHook(["hook", "uninstall", "--json"], { cwd: base });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).hook.changed, true);
    for (const target of targets) {
      const after = JSON.parse(await readFile(target, "utf8"));
      assert.deepEqual(after, { hooks: { SessionStart: [] } }, `${target} must remove every canonical form`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("built uninstall preserves the complete shell-expansion taxonomy byte-for-byte", { skip: process.platform === "win32" ? "POSIX shell-expansion matrix has a dedicated Windows grammar suite" : undefined }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-shell-foreign-"));
  const settings = JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: SHELL_FOREIGN_COMMANDS.map(({ command }) => ({ type: "command", command, timeout: 10 })),
          },
        ],
      },
    },
    null,
    2,
  ) + "\n";
  const targets = [
    path.join(base, ".claude", "settings.json"),
    path.join(base, ".codex", "hooks.json"),
  ];
  try {
    for (const target of targets) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, settings);
    }

    const result = await runCliHook(["hook", "uninstall", "--json"], { cwd: base });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).hook.changed, false);
    for (const target of targets) {
      assert.equal(await readFile(target, "utf8"), settings, `${target} must remain byte-identical`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("built install and uninstall preserve mismatched npm Node/package pairs across all hosts", { skip: process.platform === "win32" ? "POSIX npm-path matrix has a dedicated Windows grammar suite" : undefined }, async () => {
  const control = await mkdtemp(path.join(tmpdir(), "aslite-hook-semantic-control-"));
  const installBase = await mkdtemp(path.join(tmpdir(), "aslite-hook-semantic-install-"));
  const uninstallBase = await mkdtemp(path.join(tmpdir(), "aslite-hook-semantic-uninstall-"));
  const mismatchedPlugin = buildOpenCodePluginSource("/opt/runtime-a/bin/node", [
    "/opt/npm-b/lib/node_modules/superbee/dist/superbee.mjs",
    "session-start",
  ]);
  const jsonTargets = (base: string): string[] => [
    path.join(base, ".claude", "settings.json"),
    path.join(base, ".codex", "hooks.json"),
  ];
  const pluginTarget = (base: string): string =>
    path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  try {
    const controlInstall = await runCliHook(["hook", "install", "--json"], { cwd: control });
    assert.equal(controlInstall.status, 0, controlInstall.stdout + controlInstall.stderr);
    const controlSettings = JSON.parse(await readFile(jsonTargets(control)[0]!, "utf8"));
    const currentCommand = controlSettings.hooks.SessionStart[0].hooks[0].command as string;

    const installSettings = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [{ type: "command", command: MISMATCHED_NPM_NODE_COMMAND, timeout: 10 }],
            },
            { matcher: "", hooks: [{ type: "command", command: currentCommand, timeout: 10 }] },
          ],
        },
      },
      null,
      2,
    ) + "\n";
    for (const target of jsonTargets(installBase)) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, installSettings);
    }
    await mkdir(path.dirname(pluginTarget(installBase)), { recursive: true });
    await writeFile(pluginTarget(installBase), mismatchedPlugin);
    await writeFile(path.join(installBase, ".codex", "config.toml"), "[features]\nhooks = true\n");

    const install = await runCliHook(["hook", "install", "--json"], { cwd: installBase });
    assert.equal(install.status, 1, install.stdout + install.stderr);
    for (const target of jsonTargets(installBase)) {
      assert.equal(await readFile(target, "utf8"), installSettings, `${target} must remain byte-identical`);
    }
    assert.equal(await readFile(pluginTarget(installBase), "utf8"), mismatchedPlugin);

    const uninstallSettings = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [{ type: "command", command: MISMATCHED_NPM_NODE_COMMAND, timeout: 10 }],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n";
    for (const target of jsonTargets(uninstallBase)) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, uninstallSettings);
    }
    await mkdir(path.dirname(pluginTarget(uninstallBase)), { recursive: true });
    await writeFile(pluginTarget(uninstallBase), mismatchedPlugin);

    const uninstall = await runCliHook(["hook", "uninstall", "--json"], { cwd: uninstallBase });
    assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
    const receipt = JSON.parse(uninstall.stdout);
    const canonicalUninstallBase = await realpath(uninstallBase);
    assert.equal(receipt.hook.changed, false);
    assert.deepEqual(receipt.hook.notes, [
      `preserved unmanaged OpenCode plugin: ${pluginTarget(canonicalUninstallBase)}`,
    ]);
    for (const target of jsonTargets(uninstallBase)) {
      assert.equal(await readFile(target, "utf8"), uninstallSettings, `${target} must remain byte-identical`);
    }
    assert.equal(await readFile(pluginTarget(uninstallBase), "utf8"), mismatchedPlugin);
  } finally {
    await rm(control, { recursive: true, force: true });
    await rm(installBase, { recursive: true, force: true });
    await rm(uninstallBase, { recursive: true, force: true });
  }
});

test("built lifecycle preserves noncanonical managed-path near-matches across all hosts", { skip: process.platform === "win32" ? "POSIX managed-path matrix has a dedicated Windows grammar suite" : undefined }, async () => {
  const control = await mkdtemp(path.join(tmpdir(), "aslite-hook-path-control-"));
  const installBase = await mkdtemp(path.join(tmpdir(), "aslite-hook-path-install-"));
  const uninstallBase = await mkdtemp(path.join(tmpdir(), "aslite-hook-path-uninstall-"));
  const jsonTargets = (base: string): string[] => [
    path.join(base, ".claude", "settings.json"),
    path.join(base, ".codex", "hooks.json"),
  ];
  const pluginTarget = (base: string): string =>
    path.join(base, ".config", "opencode", "plugins", "axi-superbee.js");
  const foreignEntries = NONCANONICAL_MANAGED_PATH_CASES.map(({ command }) => ({
    type: "command",
    command,
    timeout: 10,
  }));
  try {
    const controlInstall = await runCliHook(["hook", "install", "--json"], { cwd: control });
    assert.equal(controlInstall.status, 0, controlInstall.stdout + controlInstall.stderr);
    const controlSettings = JSON.parse(await readFile(jsonTargets(control)[0]!, "utf8"));
    const currentCommand = controlSettings.hooks.SessionStart[0].hooks[0].command as string;

    const installSettings = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { matcher: "", hooks: foreignEntries },
            { matcher: "", hooks: [{ type: "command", command: currentCommand, timeout: 10 }] },
          ],
        },
      },
      null,
      2,
    ) + "\n";
    for (const target of jsonTargets(installBase)) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, installSettings);
    }
    await writeFile(path.join(installBase, ".codex", "config.toml"), "[features]\nhooks = true\n");

    const install = await runCliHook(["hook", "install", "--json"], { cwd: installBase });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    for (const target of jsonTargets(installBase)) {
      assert.equal(await readFile(target, "utf8"), installSettings, `${target} must remain byte-identical`);
    }

    const uninstallSettings = JSON.stringify(
      { hooks: { SessionStart: [{ matcher: "", hooks: foreignEntries }] } },
      null,
      2,
    ) + "\n";
    for (const target of jsonTargets(uninstallBase)) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, uninstallSettings);
    }
    const uninstall = await runCliHook(["hook", "uninstall", "--json"], { cwd: uninstallBase });
    assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
    assert.equal(JSON.parse(uninstall.stdout).hook.changed, false);
    for (const target of jsonTargets(uninstallBase)) {
      assert.equal(await readFile(target, "utf8"), uninstallSettings, `${target} must remain byte-identical`);
    }

    for (const { family, program, args } of NONCANONICAL_MANAGED_PATH_CASES) {
      const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-path-opencode-"));
      const plugin = pluginTarget(base);
      const source = buildOpenCodePluginSource(program, args);
      try {
        await mkdir(path.dirname(plugin), { recursive: true });
        await writeFile(plugin, source);
        const status = await runCliHook(["hook", "status", "--json"], { cwd: base });
        assert.equal(status.status, 0, status.stdout + status.stderr);
        assert.equal(JSON.parse(status.stdout).hook.hosts.opencode.state, "unmanaged", family);

        const remove = await runCliHook(["hook", "uninstall", "--json"], { cwd: base });
        assert.equal(remove.status, 0, remove.stdout + remove.stderr);
        assert.equal(JSON.parse(remove.stdout).hook.changed, false, family);
        assert.equal(await readFile(plugin, "utf8"), source, `${family}: OpenCode bytes changed`);

        const reinstall = await runCliHook(["hook", "install", "--json"], { cwd: base });
        assert.equal(reinstall.status, 1, family);
        assert.equal(await readFile(plugin, "utf8"), source, `${family}: OpenCode install overwrote bytes`);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(control, { recursive: true, force: true });
    await rm(installBase, { recursive: true, force: true });
    await rm(uninstallBase, { recursive: true, force: true });
  }
});

test("hookNeedsUpdate: PATH-bound and pre-session-start hooks are flagged; a stable Node pair is current", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-newform-"));
  const write = async (command: string) => {
    await mkdir(path.join(base, ".claude"), { recursive: true });
    await writeFile(
      path.join(base, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }] } }),
    );
  };
  try {
    await write("aslite session-start");
    assert.equal(hookNeedsUpdate([base]), true);
    await write("aslite"); // pre-session-start shape under the new bin name
    assert.equal(hookNeedsUpdate([base]), true);
    await write(process.platform === "win32"
      ? "C:/opt/aslite/bin/node.exe C:/opt/aslite/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start"
      : "/opt/aslite/bin/node /opt/aslite/lib/node_modules/@holaxis/aslite/dist/agentstate-lite.mjs session-start");
    assert.equal(hookNeedsUpdate([base]), true);
    await write(process.platform === "win32"
      ? "C:/opt/superbee/bin/node.exe C:/opt/superbee/lib/node_modules/superbee/dist/superbee.mjs session-start"
      : "/opt/superbee/bin/node /opt/superbee/lib/node_modules/superbee/dist/superbee.mjs session-start");
    assert.equal(hookNeedsUpdate([base]), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook install over a seeded legacy hook converges on disk: rewrite, idempotent reinstall, clean uninstall", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-upgrade-"));
  const settingsPath = path.join(base, ".claude", "settings.json");
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { matcher: "", hooks: [{ ...FOREIGN_HOOK }] },
              { matcher: "", hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }] },
            ],
          },
        },
        null,
        2,
      ),
    );

    // Spawned as the bare preferred bin: the written command is EXACTLY `aslite session-start`,
    // so this proof holds at any checkout path (the in-process variant wrote an absolute source
    // path whose managed-recognition depended on the checkout path's substring — review finding).
    const install = await runCliHook(["hook", "install"], { cwd: base });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const afterInstall = JSON.parse(await readFile(settingsPath, "utf8"));
    const managed = (afterInstall.hooks.SessionStart as { hooks?: { command?: string }[] }[])
      .flatMap((g) => g.hooks ?? [])
      .filter((h) => isManagedHookCommand(h.command ?? ""));
    assert.equal(managed.length, 1, "the legacy hook was rewritten, not duplicated");
    assertPathIndependentLocalLaunch(managed[0]!.command);
    assert.deepEqual(afterInstall.hooks.SessionStart[0].hooks, [FOREIGN_HOOK], "foreign hook untouched");

    const bytesAfterInstall = await readFile(settingsPath, "utf8");
    const reinstall = await runCliHook(["hook", "install", "--json"], { cwd: base });
    assert.equal(reinstall.status, 0, reinstall.stdout + reinstall.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), bytesAfterInstall, "reinstall is a no-op on disk");
    const reinstallReceipt = JSON.parse(reinstall.stdout).hook;
    assert.equal(reinstallReceipt.changed, false);
    assert.equal(reinstallReceipt.restart_required, false);
    assert.deepEqual(reinstallReceipt.affected_hosts, []);

    const staleClaude = JSON.parse(bytesAfterInstall);
    staleClaude.hooks.SessionStart = staleClaude.hooks.SessionStart
      .map((group: { hooks?: { command?: string }[] }) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((entry) => !isManagedHookCommand(entry.command ?? "")),
      }))
      .filter((group: { hooks: unknown[] }) => group.hooks.length > 0);
    await writeFile(settingsPath, `${JSON.stringify(staleClaude, null, 2)}\n`);
    const claudeOnly = await runCliHook(["hook", "install", "--json"], { cwd: base });
    assert.equal(claudeOnly.status, 0, claudeOnly.stdout + claudeOnly.stderr);
    assert.deepEqual(JSON.parse(claudeOnly.stdout).hook.affected_hosts, ["claude_code"]);

    const uninstall = await runCliHook(["hook", "uninstall"], { cwd: base });
    assert.equal(uninstall.status, 0, uninstall.stdout + uninstall.stderr);
    const afterUninstall = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(afterUninstall.hooks.SessionStart, [{ matcher: "", hooks: [FOREIGN_HOOK] }]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 5c. destructive-write discipline: fail-loud on malformed settings + atomic writes ─
//
// QA found the old install path silently clobbered settings it could not parse (readSettings
// swallowed the parse error into `{}`, then a fresh hooks-only file was written over the user's
// permissions/theme), and truncate-then-write let a concurrent reader observe a torn file and
// trigger that same loss. These tests pin the fixed contract: install REFUSES a malformed file
// (structured RUNTIME failure, byte-untouched), other targets still proceed, read-only paths and
// uninstall never touch a malformed file, and managed writes go through temp + rename.

test("hook install over invalid-JSON settings: structured RUNTIME error naming the file, bytes untouched, other targets still written", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-badjson-"));
  const settingsPath = path.join(base, ".claude", "settings.json");
  const poisoned = '{ "permissions": { "allow": ["Bash"] }, not json';
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, poisoned);

    await assert.rejects(
      () => hook(["install"], { base, commandBase: "aslite", stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "RUNTIME");
        assert.equal(err.exitCode, 1);
        const refused = (err.details as { refused?: string[] })?.refused ?? [];
        assert.equal(refused.length, 1);
        assert.match(refused[0]!, /settings\.json/);
        assert.match(refused[0]!, /unparseable JSON/);
        assert.match(refused[0]!, /nothing was written/);
        return true;
      },
    );

    assert.equal(await readFile(settingsPath, "utf8"), poisoned, "the malformed file is byte-untouched");
    // Other targets still proceeded despite the refusal.
    const codex = JSON.parse(await readFile(path.join(base, ".codex", "hooks.json"), "utf8"));
    assert.ok(codex.hooks.SessionStart[0].hooks[0].command.endsWith(" session-start"));
    await readFile(path.join(base, ".config", "opencode", "plugins", "axi-superbee.js"), "utf8");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook install over a present-but-non-array SessionStart: refused, file untouched", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-nonarray-"));
  const settingsPath = path.join(base, ".claude", "settings.json");
  const authored = JSON.stringify({ theme: "dark", hooks: { SessionStart: { matcher: "" } } }, null, 2);
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, authored);

    await assert.rejects(
      () => hook(["install"], { base, commandBase: "aslite", stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "RUNTIME");
        const refused = (err.details as { refused?: string[] })?.refused ?? [];
        assert.equal(refused.length, 1);
        assert.match(refused[0]!, /`hooks\.SessionStart` exists but is not an array/);
        return true;
      },
    );
    assert.equal(await readFile(settingsPath, "utf8"), authored, "the user-authored value survives");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("readSettingsForInstall: shape table — absent ok, round-trippable ok, every malformed shape refused with a reason", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-hook-readshape-"));
  const file = path.join(dir, "settings.json");
  const table: Array<{ content: string | undefined; ok: boolean; reason?: RegExp }> = [
    { content: undefined, ok: true },
    { content: "{}", ok: true },
    { content: '{"hooks":{"SessionStart":[]}}', ok: true },
    { content: "not json", ok: false, reason: /unparseable JSON/ },
    { content: '"just a string"', ok: false, reason: /not a JSON object/ },
    { content: "[1,2]", ok: false, reason: /not a JSON object/ },
    { content: '{"hooks": 3}', ok: false, reason: /`hooks` is not a JSON object/ },
    { content: '{"hooks":{"SessionStart":{}}}', ok: false, reason: /`hooks\.SessionStart` exists but is not an array/ },
    { content: '{"hooks":{"session_start":"x"}}', ok: false, reason: /`hooks\.session_start` exists but is not an array/ },
  ];
  try {
    for (const row of table) {
      if (row.content === undefined) await rm(file, { force: true });
      else await writeFile(file, row.content);
      const result = readSettingsForInstall(file);
      assert.equal(result.ok, row.ok, `content ${JSON.stringify(row.content)}`);
      if (!result.ok) assert.match(result.reason, row.reason!, `content ${JSON.stringify(row.content)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook status + uninstall on invalid-JSON settings: no crash, no touch (pinned lenient read-only behavior)", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-lenient-"));
  const settingsPath = path.join(base, ".claude", "settings.json");
  const poisoned = "{ definitely broken";
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, poisoned);

    const capStatus = capture();
    await hook(["status"], { base, stdout: capStatus.stdout });
    assert.match(capStatus.out(), /installed: false/);
    assert.equal(await readFile(settingsPath, "utf8"), poisoned);

    const capUn = capture();
    await hook(["uninstall"], { base, stdout: capUn.stdout });
    assert.match(capUn.out(), /changed: false/);
    assert.equal(await readFile(settingsPath, "utf8"), poisoned, "uninstall never rewrites a malformed file");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook install preserves a 0600 settings.json mode while rewriting a legacy hook", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-mode-"));
  const settingsPath = path.join(base, ".claude", "settings.json");
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }] }] } },
        null,
        2,
      ),
    );
    await chmod(settingsPath, 0o600);
    await hook(["install"], { base, commandBase: "aslite", stdout: () => {} });
    const rewritten = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(rewritten.hooks.SessionStart[0].hooks[0].command.endsWith(" session-start"));
    if (process.platform !== "win32") {
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600, "install must not widen a private settings file");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("readSettingsForInstall: an unreadable file is refused as 'unreadable', not 'unparseable JSON'", async (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.skip("POSIX permission-bit refusal requires a non-root POSIX environment");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-hook-unreadable-"));
  const file = path.join(dir, "settings.json");
  try {
    await writeFile(file, "{}");
    await chmod(file, 0o000);
    const result = readSettingsForInstall(file);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /unreadable/);
      assert.doesNotMatch(result.reason, /unparseable JSON/);
    }
  } finally {
    await chmod(file, 0o600).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 5d. symlinked settings (stow/dotfile management) + malformed-member hardening ─

test("hook install writes THROUGH a symlinked settings.json: the link survives, its target updates atomically, mode preserved", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-symlink-"));
  const dotfiles = path.join(base, "dotfiles");
  const real = path.join(dotfiles, "claude-settings.json");
  const link = path.join(base, ".claude", "settings.json");
  try {
    await mkdir(dotfiles, { recursive: true });
    await writeFile(
      real,
      JSON.stringify(
        { theme: "dark", hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "agentstate-lite session-start", timeout: 10 }] }] } },
        null,
        2,
      ),
    );
    await chmod(real, 0o600);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(real, link);

    const install = await runCliHook(["hook", "install"], { cwd: base });
    assert.equal(install.status, 0, install.stdout + install.stderr);

    // The review's reproduction: before the fix the link became a regular file and the dotfile
    // target stayed stale. Now the link is STILL a link and the resolved target carries the update.
    assert.equal((await lstat(link)).isSymbolicLink(), true, "the symlink must survive the install");
    const updated = JSON.parse(await readFile(real, "utf8"));
    assertPathIndependentLocalLaunch(updated.hooks.SessionStart[0].hooks[0].command);
    assert.equal(updated.theme, "dark", "unrelated keys in the dotfile target survive");
    if (process.platform !== "win32") {
      assert.equal((await stat(real)).mode & 0o777, 0o600, "the target's mode is preserved");
    }
    assert.deepEqual(await readdir(dotfiles), ["claude-settings.json"], "no temp residue beside the target");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook install refuses a DANGLING symlinked settings.json: structured failure, link untouched, other targets proceed", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-dangling-"));
  const link = path.join(base, ".claude", "settings.json");
  const nowhere = path.join(base, "dotfiles", "missing.json");
  try {
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(nowhere, link);

    await assert.rejects(
      () => hook(["install"], { base, commandBase: "aslite", stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "RUNTIME");
        const refused = (err.details as { refused?: string[] })?.refused ?? [];
        assert.equal(refused.length, 1);
        assert.match(refused[0]!, /dangling symlink/);
        assert.match(refused[0]!, /settings\.json/);
        return true;
      },
    );
    assert.equal((await lstat(link)).isSymbolicLink(), true, "the dangling link is untouched");
    assert.equal(existsSync(nowhere), false, "nothing was manufactured at the link's target");
    // The other JSON target still proceeded.
    JSON.parse(await readFile(path.join(base, ".codex", "hooks.json"), "utf8"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("hook install refuses a SessionStart [null] member: exit-1 class, file untouched, NO success receipt", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-nullmember-"));
  const settingsPath = path.join(base, ".claude", "settings.json");
  const poisoned = '{"hooks":{"SessionStart":[null]}}';
  try {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, poisoned);

    const cap = capture();
    await assert.rejects(
      () => hook(["install"], { base, commandBase: "aslite", stdout: cap.stdout }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "RUNTIME");
        assert.equal(err.exitCode, 1);
        const refused = (err.details as { refused?: string[] })?.refused ?? [];
        assert.equal(refused.length, 1);
        assert.match(refused[0]!, /`hooks\.SessionStart\[0\]` is not an object/);
        return true;
      },
    );
    // Receipt truthfulness: `installed: true` must never be emitted for a refused target.
    assert.equal(cap.out(), "", "no success receipt for a failed install");
    assert.equal(await readFile(settingsPath, "utf8"), poisoned, "the file is byte-untouched");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("status + uninstall tolerate malformed SessionStart members: skip without throwing, honest report, never touch", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-tolerant-"));
  const settingsPath = path.join(base, ".claude", "settings.json");
  const managedGroup = { matcher: "", hooks: [{ type: "command", command: "aslite session-start", timeout: 10 }] };
  try {
    // A malformed member BESIDE a real managed hook: status must still see the managed hook.
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ hooks: { SessionStart: [null, managedGroup] } }));
    const capStatus = capture();
    await hook(["status"], { base, stdout: capStatus.stdout });
    assert.match(capStatus.out(), /installed: true/);

    // Uninstall removes the managed hook and preserves the malformed member verbatim.
    await hook(["uninstall"], { base, stdout: () => {} });
    const afterUninstall = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(afterUninstall.hooks.SessionStart, [null]);

    // A file with ONLY a malformed member: status honest-false, uninstall a byte-no-op.
    const onlyNull = '{"hooks":{"SessionStart":[null]}}';
    await writeFile(settingsPath, onlyNull);
    const capStatus2 = capture();
    await hook(["status"], { base, stdout: capStatus2.stdout });
    assert.match(capStatus2.out(), /installed: false/);
    const capUn = capture();
    await hook(["uninstall"], { base, stdout: capUn.stdout });
    assert.match(capUn.out(), /changed: false/);
    assert.equal(await readFile(settingsPath, "utf8"), onlyNull);

    // Pure-layer totality: the walkers never throw on a malformed member.
    assert.deepEqual(readHookStatus({ hooks: { SessionStart: [null] } } as never), { installed: false });
    const [, unChanged] = computeHookUninstall({ hooks: { SessionStart: [null] } } as never);
    assert.equal(unChanged, false);
    const [installed] = computeSessionStartHookInstall({ hooks: { SessionStart: [null] } } as never, {
      command: "aslite session-start",
    });
    assert.deepEqual(installed.hooks!.SessionStart![0], null, "a malformed member passes through untouched");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 6. no-repo / boardless session-start stays serene ─────────────────────────

test("session-start --dir on a BOARDLESS project with a committed bundle: dashboard, never 'run init'", async () => {
  // THIS repo's own pre-migration shape: a plain `.agentstate-lite/` bundle committed on main,
  // no `board` branch anywhere. The --dir bridge must fall back to home's DISCOVERY walk from
  // the project dir — treating the project dir as a literal bundle root dangled a wrong `init`
  // hint next to a real bundle (review round, fix 3).
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-committed-bundle-"));
  const homeDir = await tempHome();
  try {
    git(dir, ["init", "-b", "main", "."]);
    const bundleDir = path.join(dir, ".agentstate-lite");
    await initBundle(bundleDir);
    await writeDoc(
      { root: bundleDir },
      { id: "tasks/one", frontmatter: { type: "Task", title: "One" }, body: "x\n" },
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "main: committed bundle, no board branch"]);

    const out = await runSessionStart(homeDir, ["--dir", dir]);
    assert.match(out, /docs: 1/);
    assert.ok(!out.includes("getting_started"), "no init hint next to a real committed bundle");
    assert.ok(!/run `[^`]*init`/.test(out), "no init hint may appear");
    assert.ok(!out.includes("board sync offline"), "boardless is not an offline state");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("session-start outside any git repo: no board block, plain home render, resolves cleanly", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-norepo-"));
  const homeDir = await tempHome();
  try {
    const outcome = await withHome(homeDir, () => sessionStartPull(dir));
    assert.equal(outcome, undefined);
    const out = await runSessionStart(homeDir, ["--dir", dir]);
    assert.ok(out.includes("getting_started"));
    assert.ok(out.includes("no OKF bundle found"));
    assert.ok(!out.includes("board sync offline"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});
