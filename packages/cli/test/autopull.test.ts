// Tests for `autopull.ts` (tasks/sync-opportunistic-pull) — the opportunistic board-freshness
// trigger board-reading commands run, plus sync's one-time hook-install onboarding hint.
//
// Layers, mirroring the codebase's convention:
//   1. Trigger-matrix tests driving `maybeAutoPull` directly over git-harness topologies with the
//      injectable clock (the house pattern): fires only past the staleness threshold on a
//      PROVISIONED checkout; never provisions; ff-only (a diverged board is swallowed, never
//      rebased); the attempt-side throttle; the env opt-out knob.
//   2. Command-level wiring: every board-reading command (`list`, `doc read`, `status`, `home`,
//      `link show`) invokes the injectable trigger; mutations (`doc write`, `link add`) never do;
//      a real `list` on a stale provisioned board serves the teammate's pushed change (inline
//      freshness — THIS read is fresh, not the next one).
//   3. The added-latency budget against a REAL hanging remote (the U0 `hang://` helper pattern) —
//      bounded, and throttled so the SECOND read never pays it again inside the window.
//   4. The hook-install hint's once-ness (per-clone `hookHintedAt`) and its suppression when a
//      managed hook is installed.
//   5. DETECTION-COST pins (fix round HIGH 1) via a PATH git-shim that counts real spawns: the
//      non-triggering hot path is the tax every read pays, so its spawn budget is test-pinned —
//      0 spawns on non-board paths, exactly 1 (the key's `remote get-url`) on a provisioned board
//      with a fresh cache. Plus the session-start boardPull FENCE (fix round LOW 4): a
//      session-start whose pull step resolved to NO outcome still hands home a defined boardPull,
//      so home's own trigger can never run a network pull outside session-start's budget race.
//      (The spawned-subprocess default-wiring pin lives in doc-cli-integration.test.ts — the one
//      file that builds the real CLI.)
//
// NOTE the suite-wide knob: packages/cli's test script sets AGENTSTATE_LITE_NO_AUTOPULL=1 so the
// DEFAULT trigger is inert for every other suite (hermetic on machines whose own checkout has a
// provisioned, stale board). Tests here that want the real trigger inject `env: {}` explicitly.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";

import { initBundle, writeDoc } from "@superbee/core";
import {
  AUTO_PULL_STALE_MS,
  NO_AUTOPULL_ENV,
  SUPERBEE_NO_AUTOPULL_ENV,
  maybeAutoPull,
} from "../src/autopull.js";
import { readCache, readCursor, readSyncState } from "../src/cursor.js";
import { sync } from "../src/commands/sync.js";
import { hookInstallHintOnce } from "../src/sync-cli.js";
import { resolveBundleKey } from "@superbee/board-git";
import { hook, hookInstalled } from "../src/commands/hook.js";
import { home } from "../src/commands/home.js";
import { list } from "../src/commands/list.js";
import { status } from "../src/commands/status.js";
import { doc } from "../src/commands/doc.js";
import { link } from "../src/commands/link.js";
import { sessionStart } from "../src/commands/session-start.js";
import {
  boardHead,
  commitBoard,
  divergeSameDoc,
  git,
  isMidRebase,
  makeTwoCloneTopology,
  pushBoard,
  writeBoardDoc,
} from "../../board-git/test/git-harness.js";
import { testInvocation } from "./support/command-prefix.js";

// ── scaffolding (mirrors sync.test.ts / session-start.test.ts) ────────────────

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  return withIsolatedUserEnv(home, run);
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
  return mkdtemp(path.join(tmpdir(), "aslite-autopull-home-"));
}

function captureStdout(): { stdout: (s: string) => void; text: () => string } {
  const chunks: string[] = [];
  return { stdout: (s: string) => chunks.push(s), text: () => chunks.join("") };
}

/** A fixed epoch + offset clock (the injectable-clock house pattern). */
const T0 = Date.parse("2026-07-09T12:00:00.000Z");
const at = (offsetMs: number) => () => new Date(T0 + offsetMs);
const MIN = 60_000;

// ── 1. the trigger matrix ─────────────────────────────────────────────────────

test("staleness gate: first read pulls (no cache), a fresh cache is served as-is, past-threshold fires again", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    // No state yet for B's clone → infinitely stale → the trigger fires and records state.
    const first = await withHome(homeB, () =>
      maybeAutoPull(topo.b.board, { env: {}, now: at(0) }),
    );
    assert.equal(first, "pulled");
    const key = resolveBundleKey(topo.b.board);
    const cache = await withHome(homeB, () => readCache(key));
    assert.ok(cache, "a successful trigger pull writes the awareness cache (session-start's discipline)");
    assert.equal(cache!.updatedAt, new Date(T0).toISOString(), "cache stamped by the injected clock");

    // A pushes a change B does not have yet.
    await writeBoardDoc(topo.a, "tasks/from-a", {
      frontmatter: { type: "Task", title: "From A", actor: "mike" },
      body: "# From A\n",
    });
    commitBoard(topo.a, "board: A adds tasks/from-a");
    pushBoard(topo.a);
    const before = boardHead(topo.b);

    // Inside the window: silent no-op — the board is NOT updated (fresh cache wins).
    const fresh = await withHome(homeB, () =>
      maybeAutoPull(topo.b.board, { env: {}, now: at(4 * MIN) }),
    );
    assert.equal(fresh, "fresh");
    assert.equal(boardHead(topo.b), before, "no network op inside the staleness window");

    // Past the threshold: the trigger fires, ff-only pulls A's commit, and refreshes the cache.
    const pulled = await withHome(homeB, () =>
      maybeAutoPull(topo.b.board, { env: {}, now: at(6 * MIN) }),
    );
    assert.equal(pulled, "pulled");
    assert.notEqual(boardHead(topo.b), before, "A's pushed commit fast-forwarded in");
    const after = await withHome(homeB, () => readCache(key));
    assert.equal(after!.updatedAt, new Date(T0 + 6 * MIN).toISOString());
    assert.ok(
      after!.delta.some((r) => r.docId === "tasks/from-a" && r.actor === "mike"),
      "the awareness delta carries the incoming doc, attributed from frontmatter",
    );
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("threshold default: AUTO_PULL_STALE_MS is ~5 minutes (the adjudicated Homebrew-style window)", () => {
  assert.equal(AUTO_PULL_STALE_MS, 5 * 60_000);
});

test("binding-selected autopull uses the private board key, never the public checkout candidate", async () => {
  const topo = await makeTwoCloneTopology();
  const homeDir = await tempHome();
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    const outcome = await withHome(homeDir, () => withCwd(topo.a.root, () => maybeAutoPull(undefined, { env: {}, now: at(0) })));
    assert.equal(outcome, "pulled");
    assert.ok(await withHome(homeDir, () => readCache(resolveBundleKey(topo.b.board))), "private board cache was written");
    assert.equal(await withHome(homeDir, () => readCache(resolveBundleKey(topo.a.board))), null, "public board cache was untouched");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("detection-gated: an UNPROVISIONED checkout never fires and is NEVER provisioned by a read", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const homeB = await tempHome();
  try {
    const outcome = await withHome(homeB, () =>
      maybeAutoPull(topo.b.root, { env: {}, now: at(0) }),
    );
    assert.equal(outcome, "no-board");
    assert.ok(!existsSync(topo.b.board), "a read must not materialize the board (that is sync/session-start's job)");
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("non-board bundle: a plain local bundle outside any board repo never fires", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-autopull-plain-"));
  const homeDir = await tempHome();
  try {
    await initBundle(dir);
    const outcome = await withHome(homeDir, () => maybeAutoPull(dir, { env: {}, now: at(0) }));
    assert.equal(outcome, "no-board");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("bundle scope: a read of an UNRELATED bundle inside a board-sharing repo does not spend network on the board", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    // A second, unrelated bundle committed inside clone B's project tree.
    const other = path.join(topo.b.root, "docs-bundle");
    await initBundle(other);
    const outcome = await withHome(homeB, () => maybeAutoPull(other, { env: {}, now: at(0) }));
    assert.equal(outcome, "different-bundle");
    assert.equal(await withHome(homeB, () => readCache(resolveBundleKey(topo.b.board))), null);
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("ff-only: a DIVERGED board is swallowed — no rebase, no mid-state, HEAD untouched, no cache/cursor write", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    const d = await divergeSameDoc(topo); // B: local commit; origin: A's conflicting commit (fetched)
    const outcome = await withHome(homeB, () =>
      maybeAutoPull(topo.b.board, { env: {}, now: at(0) }),
    );
    assert.equal(outcome, "skipped", "the diverged pull is swallowed per ffPull's matrix");
    assert.equal(boardHead(topo.b), d.bHead, "never rebased, never moved");
    assert.ok(!isMidRebase(topo.b), "no rebase state left behind");
    const key = resolveBundleKey(topo.b.board);
    const state = await withHome(homeB, () => readSyncState(key));
    assert.equal(state.cache, null, "no cache write on a swallowed pull (cursor advances only on success)");
    assert.equal(state.cursor, null);
    assert.ok(state.autoPullAttemptAt, "…but the ATTEMPT is recorded, so the window backs off");

    // A second read inside the window is throttled — the un-ff-able board is not re-fetched per read.
    const again = await withHome(homeB, () =>
      maybeAutoPull(topo.b.board, { env: {}, now: at(MIN) }),
    );
    assert.equal(again, "throttled");
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("opt-out knob: Superbee and legacy no-autopull env vars disable the trigger entirely", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    await writeBoardDoc(topo.a, "tasks/late", { frontmatter: { type: "Task", title: "Late" }, body: "# Late\n" });
    commitBoard(topo.a, "board: A adds tasks/late");
    pushBoard(topo.a);
    const before = boardHead(topo.b);
    for (const [key, value] of [
      [NO_AUTOPULL_ENV, "1"],
      [SUPERBEE_NO_AUTOPULL_ENV, "1"],
      [SUPERBEE_NO_AUTOPULL_ENV, "0"],
    ] as const) {
      const outcome = await withHome(homeB, () =>
        maybeAutoPull(topo.b.board, { env: { [key]: value }, now: at(0) }),
      );
      assert.equal(outcome, "disabled", `${key}=${value}`);
      assert.equal(boardHead(topo.b), before, "nothing pulled");
      assert.deepEqual(
        await withHome(homeB, () => readSyncState(resolveBundleKey(topo.b.board))),
        { cursor: null, cache: null, marker: null, selfActors: null, autoPullAttemptAt: null, hookHintedAt: null },
        "disabled = zero state writes",
      );
    }
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

// ── 2. command-level wiring ───────────────────────────────────────────────────

test("inline freshness e2e: a stale B's `list` serves A's pushed doc in the SAME read; a fresh re-read is byte-identical and silent", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  try {
    await writeBoardDoc(topo.a, "tasks/inline-fresh", {
      frontmatter: { type: "Task", title: "Inline fresh", actor: "mike" },
      body: "# Inline fresh\n",
    });
    commitBoard(topo.a, "board: A adds tasks/inline-fresh");
    pushBoard(topo.a);

    // B has never pulled (no state → stale). The read itself triggers the pull, then serves it.
    const cap1 = captureStdout();
    await withHome(homeB, () =>
      list(["--dir", topo.b.board], {
        stdout: cap1.stdout,
        autoPull: (d) => maybeAutoPull(d, { env: {} }),
      }),
    );
    assert.match(cap1.text(), /tasks\/inline-fresh/, "THIS read is fresh — not the next one (inline adjudication)");
    assert.ok(!/pull|sync|board/i.test(cap1.text().split("docs")[0] ?? ""), "silent: no pull chatter above the rows");

    // Cache now fresh → the trigger no-ops and the output is byte-identical.
    const cap2 = captureStdout();
    await withHome(homeB, () =>
      list(["--dir", topo.b.board], {
        stdout: cap2.stdout,
        autoPull: (d) => maybeAutoPull(d, { env: {} }),
      }),
    );
    assert.equal(cap2.text(), cap1.text(), "behavior unchanged when the cache is fresh");
  } finally {
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

test("wiring: list / status / doc read / link show invoke the trigger; doc write / link add never do", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-autopull-wiring-"));
  try {
    await initBundle(dir);
    await writeDoc({ root: dir }, { id: "notes/a", frontmatter: { type: "Note", title: "A" }, body: "# A\n" });
    const calls: string[] = [];
    const spy = (name: string) => async (d?: string) => {
      calls.push(`${name}:${d}`);
      return "no-board" as const;
    };
    const sink = () => {};

    await list(["--dir", dir], { stdout: sink, autoPull: spy("list") });
    await status(["--dir", dir], { stdout: sink, autoPull: spy("status") });
    await doc(["read", "notes/a", "--dir", dir], { stdout: sink, autoPull: spy("doc-read") });
    await link(["show", "notes/a", "--dir", dir], { stdout: sink, autoPull: spy("link-show") });
    assert.deepEqual(calls, [
      `list:${dir}`,
      `status:${dir}`,
      `doc-read:${dir}`,
      `link-show:${dir}`,
    ]);

    // Mutations are NOT reads: the trigger must never fire for them.
    calls.length = 0;
    await doc(["write", "notes/b", "--type", "Note", "--body", "# B\n", "--dir", dir], {
      stdout: sink,
      autoPull: spy("doc-write"),
    });
    await link(["add", "notes/a", "notes/b", "--dir", dir], { stdout: sink, autoPull: spy("link-add") });
    assert.deepEqual(calls, [], "doc write / link add never trigger the pull");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("home wiring: plain local home triggers; a session-start render (boardPull present) and --remote never do", async () => {
  const calls: string[] = [];
  const spy = async (d?: string) => {
    calls.push(`home:${d}`);
    return "no-board" as const;
  };
  const inert = {
    stdout: () => {},
    summarizeBundle: async () => null,
    loadBoardStatus: async () => null,
    hookNeedsUpdate: () => false,
  };

  await home([], { ...inert, autoPull: spy });
  assert.equal(calls.length, 1, "a plain local home render triggers the pull once");

  calls.length = 0;
  await home([], { ...inert, autoPull: spy, boardPull: { offline: false, refreshed: true } });
  assert.equal(calls.length, 0, "session-start already pulled in-process — home must not double-pull");

  await home(["--remote", "http://127.0.0.1:9/x"], { ...inert, autoPull: spy });
  assert.equal(calls.length, 0, "a --remote-scoped home stays fully offline (the board is a local concept)");
});

// ── 3. the latency budget against a REAL hanging remote (U0 hang:// pattern) ──

test("budget: a hanging remote is killed inside the budget, and the throttle spares the NEXT read entirely", async () => {
  const topo = await makeTwoCloneTopology();
  const homeB = await tempHome();
  const helperDir = await mkdtemp(path.join(tmpdir(), "aslite-autopull-hang-"));
  const prevPath = process.env.PATH;
  try {
    const helper = path.join(helperDir, "git-remote-hang");
    await writeFile(helper, "#!/bin/sh\nsleep 60\n");
    chmodSync(helper, 0o755);
    process.env.PATH = `${helperDir}${path.delimiter}${prevPath ?? ""}`;
    git(topo.b.root, ["remote", "set-url", "origin", "hang://black.hole/repo"]);

    const budgetMs = 1_000;
    const t0 = Date.now();
    const outcome = await withHome(homeB, () =>
      maybeAutoPull(topo.b.board, { env: {}, budgetMs }),
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5_000, `the read's added latency is bounded by the budget (took ${elapsed}ms)`);
    // The fetch died against the budget; the local ff-merge against the last-known origin/board
    // still ran, so the swallow reason is the fetch's — either way NOT a successful refresh.
    assert.equal(outcome, "skipped");
    assert.equal(await withHome(homeB, () => readCache(resolveBundleKey(topo.b.board))), null);
    assert.equal(await withHome(homeB, () => readCursor(resolveBundleKey(topo.b.board))), null);

    // The attempt throttle: the NEXT read pays (near) nothing while the window lasts.
    const t1 = Date.now();
    const second = await withHome(homeB, () => maybeAutoPull(topo.b.board, { env: {}, budgetMs }));
    assert.equal(second, "throttled");
    assert.ok(Date.now() - t1 < 1_000, "no second network wait inside the window");
  } finally {
    process.env.PATH = prevPath;
    await rm(helperDir, { recursive: true, force: true });
    await topo.cleanup();
    await rm(homeB, { recursive: true, force: true });
  }
});

// ── 4. the hook-install onboarding hint (once, honest, non-nagging) ───────────

test("hook hint: fires on the FIRST successful sync receipt only, and never when a hook is installed", async () => {
  const topo = await makeTwoCloneTopology();
  const homeA = await tempHome();
  try {
    const run = async (installed: boolean) => {
      const cap = captureStdout();
      await withHome(homeA, () =>
        sync(["--dir", topo.a.root], { stdout: cap.stdout, hookInstalled: () => installed }),
      );
      return cap.text();
    };

    const first = await run(false);
    assert.match(first, /sync: already up to date/);
    assert.match(first, /hint: no SessionStart hook is installed — run `.* hook install` once/);

    const second = await run(false);
    assert.match(second, /sync: already up to date/);
    assert.ok(!second.includes("hook install"), "once per clone — never nagging");

    // A different clone (its own key) with a hook already installed: suppressed before ever shown.
    const capB = captureStdout();
    await withHome(homeA, () =>
      sync(["--dir", topo.b.root], { stdout: capB.stdout, hookInstalled: () => true }),
    );
    assert.ok(!capB.text().includes("hook install"), "an installed hook suppresses the hint entirely");
  } finally {
    await topo.cleanup();
    await rm(homeA, { recursive: true, force: true });
  }
});

test("hookInstallHintOnce: state failure suppresses the hint, never the receipt path (best-effort)", async () => {
  const homeA = await tempHome();
  try {
    // A throwing probe must yield undefined, not a throw.
    const hint = await withHome(homeA, () =>
      hookInstallHintOnce("some\nkey", testInvocation("aslite"), () => {
        throw new Error("probe boom");
      }),
    );
    assert.equal(hint, undefined);
  } finally {
    await rm(homeA, { recursive: true, force: true });
  }
});

test("hookInstalled: false on empty bases; true after `hook install` writes the managed hook", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aslite-hook-installed-"));
  try {
    assert.equal(hookInstalled([base]), false);
    await hook(["install"], { base, commandBase: "aslite", stdout: () => {} });
    assert.equal(hookInstalled([base]), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 5. detection-cost pins (fix round HIGH 1) + the session-start boardPull fence ──

/**
 * A PATH shim that intercepts every `git` spawn, logs its argv, and execs the REAL git — so a
 * test can pin the trigger's spawn budget (a count of PROCESSES, the thing that actually costs
 * milliseconds) without faking git's behavior. Install AFTER building any harness topology (the
 * harness's own git calls would otherwise pollute the log).
 */
async function installGitSpawnShim(): Promise<{
  spawns: () => Promise<string[]>;
  reset: () => Promise<void>;
  restore: () => Promise<void>;
}> {
  const realGit = process.platform === "win32"
    ? execFileSync("where.exe", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim()
    : execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shimDir = await mkdtemp(path.join(tmpdir(), "aslite-git-spawn-shim-"));
  const logPath = path.join(shimDir, "spawns.log");
  const shim = path.join(shimDir, process.platform === "win32" ? "git.cmd" : "git");
  if (process.platform === "win32") {
    await writeFile(shim, `@echo off\r\necho %*>>"${logPath}"\r\n"${realGit}" %*\r\n`);
  } else {
    await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const prevPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${prevPath ?? ""}`;
  return {
    spawns: async () => {
      try {
        return (await readFile(logPath, "utf8")).split("\n").filter((l) => l.trim().length > 0);
      } catch {
        return [];
      }
    },
    reset: () => writeFile(logPath, ""),
    restore: async () => {
      process.env.PATH = prevPath;
      await rm(shimDir, { recursive: true, force: true });
    },
  };
}

test("detection cost: 0 spawns on non-board paths; exactly ONE (remote get-url) on a provisioned board with a fresh cache", {
  skip: process.platform === "win32"
    ? "Node's shell-free executable lookup bypasses a PATH git.cmd shim; behavior is covered by the native board-channel suite"
    : undefined,
}, async () => {
  const topoProvisioned = await makeTwoCloneTopology();
  const topoBare = await makeTwoCloneTopology({ provision: false });
  const plain = await mkdtemp(path.join(tmpdir(), "aslite-autopull-cost-"));
  const homeDir = await tempHome();
  try {
    await initBundle(plain);
    // Seed a fresh cache on the provisioned clone BEFORE the shim starts counting.
    assert.equal(
      await withHome(homeDir, () => maybeAutoPull(topoProvisioned.b.board, { env: {}, now: at(0) })),
      "pulled",
    );

    const shim = await installGitSpawnShim();
    try {
      assert.equal(await withHome(homeDir, () => maybeAutoPull(plain, { env: {} })), "no-board");
      assert.equal((await shim.spawns()).length, 0, "a plain bundle outside any repo must spawn NOTHING");

      assert.equal(await withHome(homeDir, () => maybeAutoPull(topoBare.a.root, { env: {} })), "no-board");
      assert.equal((await shim.spawns()).length, 0, "an unprovisioned checkout must spawn NOTHING");

      assert.equal(
        await withHome(homeDir, () => maybeAutoPull(topoProvisioned.b.board, { env: {}, now: at(MIN) })),
        "fresh",
      );
      const lines = await shim.spawns();
      assert.equal(
        lines.length,
        1,
        `a fresh cache must prove itself with ONE spawn (got ${lines.length}: ${lines.join(" | ")})`,
      );
      assert.match(lines[0]!, /remote get-url/, "…and that one spawn is the state key's remote component");
    } finally {
      await shim.restore();
    }
  } finally {
    await topoProvisioned.cleanup();
    await topoBare.cleanup();
    await rm(plain, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("session-start fence: a pull step with NO outcome (no repo/no board/provision threw) still hands home a defined boardPull — zero fetches outside the budget race", async () => {
  const topo = await makeTwoCloneTopology(); // a REAL provisioned, never-pulled (stale) board
  const homeDir = await tempHome();
  const prevKnob = process.env[NO_AUTOPULL_ENV];
  // The FENCE, not the suite-wide knob, must be what prevents the pull — remove the knob.
  delete process.env[NO_AUTOPULL_ENV];
  const shim = await installGitSpawnShim();
  try {
    const cap = captureStdout();
    // An injected pull resolving `undefined` is the whole no-outcome class, provision-THREW included.
    await withHome(homeDir, () =>
      sessionStart(["--dir", topo.b.root], { stdout: cap.stdout, pull: async () => undefined }),
    );
    assert.match(cap.text(), /\.superbee/, "the render still appeared");
    const fetches = (await shim.spawns()).filter((l) => /(^|\s)fetch(\s|$)/.test(l));
    assert.deepEqual(
      fetches,
      [],
      "home under session-start must NEVER fetch — session-start's budget race is the only network bound",
    );
  } finally {
    await shim.restore();
    if (prevKnob === undefined) delete process.env[NO_AUTOPULL_ENV];
    else process.env[NO_AUTOPULL_ENV] = prevKnob;
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});
