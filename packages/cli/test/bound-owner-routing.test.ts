import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONVENTION_TYPE, initBundle, writeDoc } from "@superbee/core";
import { maybeAutoPull } from "../src/autopull.js";
import { assertResolvedLocalRouteIdentity, boardAttributionForRoute, resolveLocalBundleRoute } from "../src/bundle.js";
import { boardPostPersistHook } from "../src/board-attribution.js";
import { readCache, readMarker, readSyncState } from "../src/cursor.js";
import { docRead } from "../src/commands/doc/read.js";
import { docWrite } from "../src/commands/doc/write.js";
import { init } from "../src/commands/init.js";
import { home } from "../src/commands/home.js";
import { list } from "../src/commands/list.js";
import { sessionStart, sessionStartPull } from "../src/commands/session-start.js";
import { sync } from "../src/commands/sync.js";
import { resolveBundleKey } from "@superbee/board-git";
import { boardHead, git, isMidRebase, makeCommittedFolderTopology, makeTwoCloneTopology, wedgeMidRebase } from "../../board-git/test/git-harness.js";

const BUILT_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/superbee.mjs");

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
    const nestedInner = path.join(temp, "nested-inner");
    const nestedOuter = path.join(temp, "nested-outer");
    await symlink(topo.a.board, direct, "dir");
    await symlink(topo.a.root, ancestor, "dir");
    await symlink(topo.a.board, nestedInner, "dir");
    await symlink(nestedInner, nestedOuter, "dir");

    for (const target of [direct, path.join(ancestor, ".superbee"), nestedOuter]) {
      await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: target }));
      await assert.rejects(
        () => inDir(topo.a.root, () => resolveLocalBundleRoute(undefined)),
        /symlinked target has a conventional board-worktree signature/,
      );
      await assert.rejects(() => inDir(topo.a.root, () => sync([], { stdout: () => {} })), /board-worktree signature/);
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

test("a descendant symlink that escapes to the public owner rejects before session-start Git or state", async () => {
  const topo = await makeTwoCloneTopology();
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-descendant-home-"));
  try {
    const escape = path.join(topo.a.root, "escape");
    const target = path.join(escape, path.basename(topo.a.root), ".superbee");
    await symlink(path.dirname(topo.a.root), escape, "dir");
    assert.equal(await realpath(target), topo.a.board, "the lexical descendant reaches the public board without the guard");
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: target }));

    await assert.rejects(
      () => inDir(topo.a.root, () => resolveLocalBundleRoute(undefined)),
      /symlinked target has a conventional board-worktree signature/,
    );

    const publicKey = resolveBundleKey(topo.a.board);
    const before = await withHome(homeDir, async () => ({
      head: boardHead(topo.a),
      marker: await readMarker(publicKey),
      cache: await readCache(publicKey),
      state: await readSyncState(publicKey),
    }));
    const recorderDir = path.join(homeDir, "git-recorder");
    const recorder = path.join(homeDir, "public-git-calls.log");
    await mkdir(recorderDir);
    await writeFile(
      path.join(recorderDir, "git"),
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PR65_GIT_RECORDER\"\nPATH=\"$PR65_GIT_ORIGINAL_PATH\"\nexport PATH\nexec git \"$@\"\n",
    );
    await chmod(path.join(recorderDir, "git"), 0o755);
    const priorPath = process.env.PATH;
    const priorRecorder = process.env.PR65_GIT_RECORDER;
    const priorGitPath = process.env.PR65_GIT_ORIGINAL_PATH;
    let pull;
    try {
      process.env.PATH = `${recorderDir}${path.delimiter}${priorPath ?? ""}`;
      process.env.PR65_GIT_RECORDER = recorder;
      process.env.PR65_GIT_ORIGINAL_PATH = priorPath ?? "";
      pull = await withHome(homeDir, () => inDir(topo.a.root, () => sessionStartPull(undefined)));
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      if (priorRecorder === undefined) delete process.env.PR65_GIT_RECORDER;
      else process.env.PR65_GIT_RECORDER = priorRecorder;
      if (priorGitPath === undefined) delete process.env.PR65_GIT_ORIGINAL_PATH;
      else process.env.PR65_GIT_ORIGINAL_PATH = priorGitPath;
    }
    assert.deepEqual(pull, { offline: true }, "the rejected binding is fail-soft rather than a public-board pull");
    assert.equal(existsSync(recorder), false, "session-start never invokes Git for the rejected binding");
    const after = await withHome(homeDir, async () => ({
      head: boardHead(topo.a),
      marker: await readMarker(publicKey),
      cache: await readCache(publicKey),
      state: await readSyncState(publicKey),
    }));
    assert.deepEqual(after, before, "session-start leaves the public board and its state recorder untouched");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("symlinked generic and committed conventional plain targets remain bound-local without Git or private state", async () => {
  const topo = await makeTwoCloneTopology();
  const committed = await makeCommittedFolderTopology();
  const temp = await mkdtemp(path.join(tmpdir(), "superbee-bound-symlink-local-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-symlink-local-home-"));
  try {
    const genericParent = path.join(temp, "generic-parent");
    const generic = path.join(genericParent, "ordinary-bundle");
    await mkdir(generic, { recursive: true });
    await initBundle(generic);
    await writeDoc({ root: generic }, { id: "notes/generic", frontmatter: { type: "Note", title: "Generic" }, body: "plain" });
    const genericAlias = path.join(temp, "generic-alias");
    const committedAlias = path.join(temp, "committed-alias");
    await symlink(genericParent, genericAlias, "dir");
    await symlink(committed.b.root, committedAlias, "dir");

    const rows = [
      { name: "generic", target: path.join(genericAlias, "ordinary-bundle"), readId: "notes/generic" },
      { name: "committed conventional", target: path.join(committedAlias, ".superbee"), readId: "notes/welcome" },
    ];
    const priorPath = process.env.PATH;
    try {
      process.env.PATH = path.join(temp, "no-git-on-path");
      await withHome(homeDir, async () => {
        for (const row of rows) {
          await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: row.target }));
          const route = await inDir(topo.a.root, () => resolveLocalBundleRoute(undefined));
          assert.equal(route.kind, "bound-local", row.name);
          assert.equal(route.bundle.root, await realpath(row.target), `${row.name}: engine receives the canonical plain root`);

          let listOut = "";
          await inDir(topo.a.root, () => list(["--json"], { stdout: (line) => (listOut += line) }));
          assert.match(listOut, new RegExp(row.readId));
          let readOut = "";
          await inDir(topo.a.root, () => docRead([row.readId, "--json"], { stdout: (line) => (readOut += line) }));
          assert.match(readOut, new RegExp(row.readId));
          let homeOut = "";
          await inDir(topo.a.root, () => home(["--json"], { stdout: (line) => (homeOut += line) }));
          assert.equal((JSON.parse(homeOut) as { bundle?: { root?: string } }).bundle?.root, await realpath(row.target));
          await inDir(topo.a.root, () => docWrite([
            `notes/${row.name.replaceAll(" ", "-")}-write`,
            "--type", "Note",
            "--body", "safe local write",
            "--json",
          ], { stdout: () => {} }));
        }
      });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
    assert.equal(existsSync(path.join(homeDir, ".superbee-state")), false, "safe local routes never create board private state");
  } finally {
    await topo.cleanup();
    await committed.cleanup();
    await rm(temp, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a bound-local route fails closed when its lexical symlink is swapped after classification", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "superbee-bound-symlink-swap-"));
  try {
    const project = path.join(temp, "project");
    const first = path.join(temp, "first");
    const second = path.join(temp, "second");
    const alias = path.join(temp, "alias");
    await mkdir(project);
    await mkdir(first);
    await mkdir(second);
    await initBundle(first);
    await initBundle(second);
    await symlink(first, alias, "dir");
    await writeFile(path.join(project, ".superbee.json"), JSON.stringify({ bundle: alias }));
    const route = await inDir(project, () => resolveLocalBundleRoute(undefined));
    assert.equal(route.kind, "bound-local");
    await rm(alias, { force: true });
    await symlink(second, alias, "dir");
    await assert.rejects(() => assertResolvedLocalRouteIdentity(route), /selected target changed after classification/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a binding symlink to private state rejects from its canonical target", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "superbee-bound-private-symlink-"));
  const homeDir = path.join(temp, "home");
  try {
    const project = path.join(temp, "project");
    const privateTarget = path.join(homeDir, ".superbee-state", "opaque");
    const alias = path.join(temp, "private-alias");
    await mkdir(project);
    await mkdir(privateTarget, { recursive: true });
    await symlink(privateTarget, alias, "dir");
    await writeFile(path.join(project, ".superbee.json"), JSON.stringify({ bundle: alias }));
    await withHome(homeDir, () => assert.rejects(
      () => inDir(project, () => resolveLocalBundleRoute(undefined)),
      /private user-state directory/,
    ));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Darwin accepts only the /var and /tmp lexical anchors strictly before a binding anchor", { skip: process.platform !== "darwin" }, async () => {
  const physicalTop = await mkdtemp("/private/tmp/superbee-bound-darwin-anchor-");
  try {
    const project = path.join(physicalTop, "project");
    const target = path.join(physicalTop, "plain-bundle");
    const lexicalTarget = path.join("/tmp", path.basename(physicalTop), "plain-bundle");
    await mkdir(project);
    await initBundle(target);
    await writeFile(path.join(project, ".superbee.json"), JSON.stringify({ bundle: lexicalTarget }));
    const route = await inDir(project, () => resolveLocalBundleRoute(undefined));
    assert.equal(route.kind, "bound-local");
    if (route.kind !== "bound-local") assert.fail("fixture must remain a local route");
    assert.equal(route.bundle.root, lexicalTarget, "a symlink strictly before the lexical anchor remains outside the binding route");
    assert.equal(route.identity.canonicalRoot, await realpath(target));
  } finally {
    await rm(physicalTop, { recursive: true, force: true });
  }
});

test("built CLI new and doc write remain successful without Git when unbound conventional attribution is unavailable", async () => {
  assert.equal(existsSync(BUILT_CLI), true, "npm run build must produce the CLI before this integration proof");
  const temp = await mkdtemp(path.join(tmpdir(), "superbee-bound-git-free-"));
  const homeDir = path.join(temp, "home");
  const project = path.join(temp, "project");
  const bundle = path.join(project, ".superbee");
  try {
    await mkdir(homeDir);
    await initBundle(bundle);
    await writeDoc({ root: bundle }, {
      id: "conventions/task",
      frontmatter: {
        type: CONVENTION_TYPE,
        governs: "Task",
        path: "tasks/",
        fields: { required: ["title"], optional: [] },
      },
      body: "",
    });
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: "",
      ASLITE_NO_UPDATE_CHECK: "1",
      SUPERBEE_NO_UPDATE_CHECK: "1",
      AGENTSTATE_LITE_NO_AUTOPULL: "1",
      SUPERBEE_NO_AUTOPULL: "1",
    };
    const created = spawnSync(process.execPath, [BUILT_CLI, "new", "Task", "git-free", "--title", "Git free", "--json"], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(created.status, 0, `new stdout=${created.stdout} stderr=${created.stderr}`);
    const wrote = spawnSync(process.execPath, [BUILT_CLI, "doc", "write", "notes/git-free", "--type", "Note", "--body", "safe", "--json"], {
      cwd: project,
      env,
      encoding: "utf8",
    });
    assert.equal(wrote.status, 0, `write stdout=${wrote.stdout} stderr=${wrote.stderr}`);
  } finally {
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
