import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle } from "@superbee/core";
import { maybeAutoPull } from "../src/autopull.js";
import { boardAttributionForRoute, resolveLocalBundleRoute } from "../src/bundle.js";
import { boardPostPersistHook } from "../src/board-attribution.js";
import { readSyncState } from "../src/cursor.js";
import { init } from "../src/commands/init.js";
import { home } from "../src/commands/home.js";
import { sessionStart } from "../src/commands/session-start.js";
import { sync } from "../src/commands/sync.js";
import { boardHead, git, isMidRebase, makeCommittedFolderTopology, makeTwoCloneTopology, wedgeMidRebase } from "../../board-git/test/git-harness.js";

async function inDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(before);
  }
}

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

test("bound-owner route table classifies real Git and ordinary binding topologies without basename authority", async () => {
  const topo = await makeTwoCloneTopology();
  const committed = await makeCommittedFolderTopology();
  const temp = await mkdtemp(path.join(tmpdir(), "superbee-bound-route-"));
  try {
    const external = path.join(temp, ".superbee");
    await mkdir(external);
    await initBundle(external);

    const rows: Array<{ name: string; target: string; kind: "bound-local" | "bound-board" }> = [
      { name: "plain external conventional", target: external, kind: "bound-local" },
      { name: "committed in-tree conventional", target: committed.b.board, kind: "bound-local" },
      { name: "linked private board", target: topo.b.board, kind: "bound-board" },
    ];
    for (const row of rows) {
      await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: row.target }));
      const route = await inDir(topo.a.root, () => resolveLocalBundleRoute(undefined));
      assert.equal(route.kind, row.kind, row.name);
      assert.equal(route.target.root, row.target, `${row.name}: selected target stays lexical`);
      if (route.kind === "bound-board") {
        assert.equal(route.owner.bundleRoot, topo.b.board);
        assert.equal(route.owner.ownerRoot, topo.b.root);
        assert.equal(boardAttributionForRoute(route).kind, "board");
      } else {
        assert.deepEqual(boardAttributionForRoute(route), { kind: "none" });
      }
    }
  } finally {
    await topo.cleanup();
    await committed.cleanup();
    await rm(temp, { recursive: true, force: true });
  }
});

test("lexical binding symlinks reject before a public board can be routed", async () => {
  const topo = await makeTwoCloneTopology();
  const temp = await mkdtemp(path.join(tmpdir(), "superbee-bound-symlink-"));
  try {
    const publicHead = boardHead(topo.a);
    const direct = path.join(temp, "direct-board");
    const ancestor = path.join(temp, "ancestor");
    await symlink(topo.a.board, direct, "dir");
    await symlink(topo.a.root, ancestor, "dir");

    for (const target of [direct, path.join(ancestor, ".superbee")]) {
      await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: target }));
      await assert.rejects(
        () => inDir(topo.a.root, () => resolveLocalBundleRoute(undefined)),
        /lexical path component .* must not be a symlink/,
      );
      await assert.rejects(() => inDir(topo.a.root, () => sync([], { stdout: () => {} })), /must not be a symlink/);
      let homeAutoPull = false;
      let homeBoardStatus = false;
      await inDir(topo.a.root, () => home([], {
        stdout: () => {},
        autoPull: async () => {
          homeAutoPull = true;
          return "no-board" as const;
        },
        loadBoardStatus: async () => {
          homeBoardStatus = true;
          return null;
        },
        loadWorkspaces: async () => [],
      }));
      assert.equal(homeAutoPull, false, "a rejected binding cannot reach Home's autopull probe");
      assert.equal(homeBoardStatus, false, "a rejected binding cannot reach Home's board state probe");
      assert.equal(boardHead(topo.a), publicHead, "rejected binding never reaches public board Git");
    }
  } finally {
    await topo.cleanup();
    await rm(temp, { recursive: true, force: true });
  }
});

test("a proven owner heals a board-origin stale rebase before freezing its capability", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    await wedgeMidRebase(topo);
    assert.equal(isMidRebase(topo.b), true, "fixture is a real interrupted board rebase");

    const route = await inDir(topo.a.root, () => resolveLocalBundleRoute(undefined));
    assert.equal(route.kind, "bound-board");
    assert.equal(isMidRebase(topo.b), false, "recovery ran before the final branch proof");
    assert.equal(git(topo.b.board, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "board");
  } finally {
    await topo.cleanup();
  }
});

test("plain bindings keep sync, pull/view, autopull, home, session-start, and init away from the invoking board", async () => {
  const topo = await makeTwoCloneTopology();
  const temp = await mkdtemp(path.join(tmpdir(), "superbee-bound-plain-routes-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-plain-home-"));
  try {
    const external = path.join(temp, ".superbee");
    await mkdir(external);
    await initBundle(external);
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: external }));
    const publicHead = boardHead(topo.a);

    await withHome(homeDir, async () => {
      assert.equal(await inDir(topo.a.root, () => maybeAutoPull(undefined, { env: {} })), "no-board");

      let syncOut = "";
      await inDir(topo.a.root, () => sync([], { stdout: (line) => (syncOut += line) }));
      assert.match(syncOut, /nothing to sync/);

      let pullOut = "";
      await inDir(topo.a.root, () => sync(["--pull-only"], { stdout: (line) => (pullOut += line) }));
      assert.match(pullOut, /nothing to sync/);
      await assert.rejects(
        () => inDir(topo.a.root, () => sync(["--show-incoming", "tasks/seed-one"], { stdout: () => {} })),
        (err: unknown) => (err as { code?: string }).code === "NO_UPSTREAM",
      );

      let homeOut = "";
      await inDir(topo.a.root, () => home(["--json"], { stdout: (line) => (homeOut += line) }));
      assert.equal((JSON.parse(homeOut) as { bundle?: { root?: string } }).bundle?.root, external);

      let sessionOut = "";
      await inDir(topo.a.root, () => sessionStart(["--json", "--no-update-check"], { stdout: (line) => (sessionOut += line) }));
      assert.equal((JSON.parse(sessionOut) as { bundle?: { root?: string } }).bundle?.root, external);

      const newTarget = path.join(temp, "new-workspace");
      await mkdir(newTarget);
      await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: newTarget }));
      await inDir(topo.a.root, () => init(["--recipe", "none"], { stdout: () => {} }));
      assert.equal(existsSync(path.join(newTarget, "index.md")), true, "bare init writes the bound target");
      assert.equal(existsSync(path.join(topo.a.root, "index.md")), false, "bare init never writes the invoking checkout");
    });
    assert.equal(boardHead(topo.a), publicHead, "plain routes never touch the invoking board");
  } finally {
    await topo.cleanup();
    await rm(temp, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("bound-board establish remains idempotent and stale recovery reaches sync's ordinary convergence", async () => {
  const topo = await makeTwoCloneTopology();
  const home = await mkdtemp(path.join(tmpdir(), "superbee-bound-establish-home-"));
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    const publicHead = boardHead(topo.a);
    await withHome(home, async () => {
      let out = "";
      await inDir(topo.a.root, () => sync(["--establish", "--json"], { stdout: (line) => (out += line) }));
      assert.equal((JSON.parse(out) as { establish?: string }).establish, "already established");
      assert.equal(boardHead(topo.a), publicHead, "bound establish never touches the public board");

      await wedgeMidRebase(topo);
      const publicHeadAfterFixture = boardHead(topo.a);
      await assert.rejects(
        () => inDir(topo.a.root, () => sync([], { stdout: () => {} })),
        (err: unknown) => (err as { code?: string }).code === "CONFLICT",
      );
      assert.equal(isMidRebase(topo.b), false, "bound sync recovers then reaches the convergence outcome");
      assert.equal(boardHead(topo.a), publicHeadAfterFixture, "bound recovery never uses the invoking public board");
    });
  } finally {
    await topo.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

test("post-persist attribution accepts only an explicit precomputed state key", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "superbee-bound-attribution-"));
  try {
    await withHome(home, async () => {
      const hook = boardPostPersistHook({ kind: "board", stateKey: "private-owner-key" }, "private-actor");
      assert.ok(hook);
      await hook();
      assert.deepEqual((await readSyncState("private-owner-key")).selfActors, ["private-actor"]);
      assert.equal(boardPostPersistHook({ kind: "none" }, "private-actor"), undefined);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("architecture keeps validator and post-persist authority transport single-owner", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [bundle, owner, attribution, autopull, sessionStart, home, syncSource] = await Promise.all([
    readFile(path.join(root, "src", "bundle.ts"), "utf8"),
    readFile(path.join(root, "src", "bound-board-owner.ts"), "utf8"),
    readFile(path.join(root, "src", "board-attribution.ts"), "utf8"),
    readFile(path.join(root, "src", "autopull.ts"), "utf8"),
    readFile(path.join(root, "src", "commands", "session-start.ts"), "utf8"),
    readFile(path.join(root, "src", "commands", "home.ts"), "utf8"),
    readFile(path.join(root, "src", "commands", "sync", "orchestrate.ts"), "utf8"),
  ]);
  assert.match(bundle, /validateBoundBoardOwner/);
  for (const source of [autopull, sessionStart, home, syncSource]) assert.doesNotMatch(source, /validateBoundBoardOwner/);
  assert.doesNotMatch(owner, /WeakMap/);
  assert.doesNotMatch(attribution, /import .*resolveBundleKey|process\.cwd\(/);
  assert.match(attribution, /stateKey/);
  assert.equal(existsSync(path.join(root, "src", "bound-board-owner.ts")), true);
});
