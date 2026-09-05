import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withIsolatedUserEnv } from "./support/user-env.js";
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
import { SYNC_LOCAL_ONLY_MESSAGE, sync } from "../src/commands/sync.js";
import { resolveBundleKey } from "@superbee/board-git";
import { canonicalUserStateDir } from "../src/user-state.js";
import {
  boardHead,
  git,
  gitTry,
  initPlainBundleDir,
  isMidRebase,
  makeCommittedFolderTopology,
  makeGreenfieldTopology,
  makeTwoCloneTopology,
  wedgeMidRebase,
} from "../../board-git/test/git-harness.js";

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
  return withIsolatedUserEnv(home, run);
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
    const privateTarget = path.join(canonicalUserStateDir(homeDir), "opaque");
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

test("owner proof records a board-origin rebase as recovery-pending without changing it", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    await wedgeMidRebase(topo);
    assert.equal(isMidRebase(topo.b), true, "fixture is a real interrupted board rebase");
    const before = {
      head: git(topo.b.board, ["rev-parse", "HEAD"]),
      status: git(topo.b.board, ["status", "--porcelain"]),
      rebaseHead: await readFile(path.join(topo.b.board, ".git"), "utf8"),
    };

    const route = await inDir(topo.a.root, () => resolveLocalBundleRoute(undefined));
    assert.equal(route.kind, "bound-board");
    if (route.kind !== "bound-board") assert.fail("fixture must classify as bound board");
    assert.equal(route.readiness, "recovery-pending");
    assert.deepEqual(boardAttributionForRoute(route), { kind: "none" });
    assert.equal(isMidRebase(topo.b), true, "route proof never aborts the rebase");
    assert.deepEqual(
      {
        head: git(topo.b.board, ["rev-parse", "HEAD"]),
        status: git(topo.b.board, ["status", "--porcelain"]),
        rebaseHead: await readFile(path.join(topo.b.board, ".git"), "utf8"),
      },
      before,
      "read-only proof leaves the worktree state untouched",
    );
  } finally {
    await topo.cleanup();
  }
});

test("a recovery-pending board route skips autopull, SessionStart, and Home board state", async () => {
  const topo = await makeTwoCloneTopology();
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-pending-home-"));
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    await wedgeMidRebase(topo);
    const route = await inDir(topo.a.root, () => resolveLocalBundleRoute(undefined));
    assert.equal(route.kind, "bound-board");
    if (route.kind !== "bound-board") assert.fail("fixture must classify as bound board");
    assert.equal(route.readiness, "recovery-pending");
    const key = route.owner.stateKey;
    const before = await withHome(homeDir, async () => ({
      head: git(topo.b.board, ["rev-parse", "HEAD"]),
      refs: git(topo.b.root, ["show-ref"]),
      status: git(topo.b.board, ["status", "--porcelain"]),
      marker: await readMarker(key),
      cache: await readCache(key),
      state: await readSyncState(key),
    }));

    await withHome(homeDir, async () => {
      assert.equal(await maybeAutoPull(undefined, { route, env: {} }), "no-board");
      assert.equal(await inDir(topo.a.root, () => sessionStartPull(undefined)), undefined);
      let homeAutoPull = false;
      let homeBoardStatus = false;
      await inDir(topo.a.root, () => home([], {
        stdout: () => {},
        autoPull: async () => {
          homeAutoPull = true;
          return "no-board";
        },
        loadBoardStatus: async () => {
          homeBoardStatus = true;
          return null;
        },
        loadWorkspaces: async () => [],
      }));
      assert.equal(homeAutoPull, false, "Home skips autopull for a pending route");
      assert.equal(homeBoardStatus, false, "Home skips board status for a pending route");
    });

    const after = await withHome(homeDir, async () => ({
      head: git(topo.b.board, ["rev-parse", "HEAD"]),
      refs: git(topo.b.root, ["show-ref"]),
      status: git(topo.b.board, ["status", "--porcelain"]),
      marker: await readMarker(key),
      cache: await readCache(key),
      state: await readSyncState(key),
    }));
    assert.deepEqual(after, before, "read paths leave the pending board and private state untouched");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a non-board-origin rebase remains rejected and unchanged by owner proof", async () => {
  const topo = await makeTwoCloneTopology();
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    const doc = path.join(topo.b.board, "tasks", "seed-one.md");
    const original = await readFile(doc, "utf8");
    git(topo.b.board, ["checkout", "-b", "not-board-rebase"]);
    await writeFile(doc, `${original}\nlocal branch change\n`);
    git(topo.b.board, ["add", "--", "tasks/seed-one.md"]);
    git(topo.b.board, ["commit", "-m", "local non-board change"]);
    git(topo.b.board, ["checkout", "board"]);
    await writeFile(doc, `${original}\nboard branch change\n`);
    git(topo.b.board, ["add", "--", "tasks/seed-one.md"]);
    git(topo.b.board, ["commit", "-m", "board branch change"]);
    git(topo.b.board, ["checkout", "not-board-rebase"]);
    assert.notEqual(gitTry(topo.b.board, ["rebase", "board"]).status, 0, "fixture rebase must stop on a conflict");
    assert.equal(isMidRebase(topo.b), true);
    const before = {
      head: git(topo.b.board, ["rev-parse", "HEAD"]),
      status: git(topo.b.board, ["status", "--porcelain"]),
      rebaseHead: await readFile(path.join(topo.b.board, ".git"), "utf8"),
    };
    await assert.rejects(
      () => inDir(topo.a.root, () => resolveLocalBundleRoute(undefined)),
      /rebase not started from the board branch/,
    );
    assert.deepEqual(
      {
        head: git(topo.b.board, ["rev-parse", "HEAD"]),
        status: git(topo.b.board, ["status", "--porcelain"]),
        rebaseHead: await readFile(path.join(topo.b.board, ".git"), "utf8"),
      },
      before,
      "non-board rebase refusal never mutates the selected worktree",
    );
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

test("bound-board establish remains idempotent and explicit sync recovers a pending board", async () => {
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
      assert.equal(isMidRebase(topo.b), false, "explicit bound sync cancels the unfinished board rebase before continuing");
      assert.equal(git(topo.b.board, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "board");
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

test("Home closes summary, autopull, and board-status gates for a missing binding target", async () => {
  const topo = await makeTwoCloneTopology();
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-missing-home-"));
  try {
    const missing = path.join(topo.a.root, "missing-bound-bundle");
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: missing }));
    const publicKey = resolveBundleKey(topo.a.board);
    const before = await withHome(homeDir, async () => ({
      head: boardHead(topo.a),
      refs: git(topo.a.root, ["show-ref"]),
      docs: await readFile(path.join(topo.a.board, "tasks", "seed-one.md"), "utf8"),
      marker: await readMarker(publicKey),
      cache: await readCache(publicKey),
      state: await readSyncState(publicKey),
    }));
    let summaryCalled = false;
    let autopullCalled = false;
    let boardStatusCalled = false;
    let output = "";
    await withHome(homeDir, () => inDir(topo.a.root, () => home(["--json"], {
      stdout: (line) => (output += line),
      summarizeBundle: async () => {
        summaryCalled = true;
        return null;
      },
      autoPull: async () => {
        autopullCalled = true;
        return "no-board";
      },
      loadBoardStatus: async () => {
        boardStatusCalled = true;
        return null;
      },
      loadWorkspaces: async () => [],
    })));
    assert.equal(summaryCalled, false, "missing binding target closes summary before cwd discovery");
    assert.equal(autopullCalled, false, "missing binding target closes Home autopull");
    assert.equal(boardStatusCalled, false, "missing binding target closes Home board status");
    const rendered = JSON.parse(output) as { getting_started?: string };
    assert.match(rendered.getting_started ?? "", /project binding/);
    assert.match(rendered.getting_started ?? "", /missing-bound-bundle/);
    assert.match(rendered.getting_started ?? "", /init --recipe none/);
    const after = await withHome(homeDir, async () => ({
      head: boardHead(topo.a),
      refs: git(topo.a.root, ["show-ref"]),
      docs: await readFile(path.join(topo.a.board, "tasks", "seed-one.md"), "utf8"),
      marker: await readMarker(publicKey),
      cache: await readCache(publicKey),
      state: await readSyncState(publicKey),
    }));
    assert.deepEqual(after, before, "missing binding Home leaves the public board and state untouched");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a fresh clone whose binding names its own conventional board provisions from origin/board through bare sync", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-fresh-clone-home-"));
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: ".superbee" }));
    assert.equal(existsSync(topo.a.board), false, "fixture: the fresh clone has no local board yet");
    const originHead = git(topo.a.root, ["rev-parse", "origin/board"]).trim();

    // Before provisioning, the absent target's recovery points at sync — never at a replacement init.
    await assert.rejects(
      () => inDir(topo.a.root, () => list(["--json"], { stdout: () => {} })),
      (err: unknown) => {
        const cliErr = err as { code?: string; help?: string; message: string };
        assert.equal(cliErr.code, "NOT_FOUND");
        assert.match(cliErr.message, /from project binding/);
        assert.match(cliErr.help ?? "", /\bsync$/);
        assert.doesNotMatch(cliErr.help ?? "", /init --create-only/);
        return true;
      },
    );

    await withHome(homeDir, async () => {
      let out = "";
      await inDir(topo.a.root, () => sync(["--json"], { stdout: (line) => (out += line), hookInstalled: () => true }));
      const rec = JSON.parse(out) as { provisioned?: string; sync?: string };
      assert.match(rec.provisioned ?? "", /materialized from origin\/board/);
      assert.equal(rec.provisioned?.startsWith(topo.a.board), true, "provisioned exactly the bound path");
      assert.equal(rec.sync, "already up to date");
      assert.equal(git(topo.a.board, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "board");
      assert.equal(boardHead(topo.a), originHead);

      const route = await inDir(topo.a.root, () => resolveLocalBundleRoute(undefined));
      assert.equal(route.kind, "bound-board", "the provisioned target now routes through its proven owner");

      let again = "";
      await inDir(topo.a.root, () => sync(["--json"], { stdout: (line) => (again += line), hookInstalled: () => true }));
      assert.deepEqual(JSON.parse(again), { sync: "already up to date" });
    });
    assert.equal(existsSync(topo.b.board), false, "the sibling clone is never touched");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a local-only bundle at its own conventional bound path is routed to establishment, not 'nothing to sync'", async () => {
  const topo = await makeGreenfieldTopology();
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-greenfield-home-"));
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: ".superbee" }));

    // No board anywhere and no folder: the absent-target recovery still creates, never syncs.
    await assert.rejects(
      () => inDir(topo.a.root, () => list(["--json"], { stdout: () => {} })),
      (err: unknown) => {
        const cliErr = err as { code?: string; help?: string };
        assert.equal(cliErr.code, "NOT_FOUND");
        assert.match(cliErr.help ?? "", /init --create-only --dir/);
        return true;
      },
    );

    await initPlainBundleDir(topo.a);
    await withHome(homeDir, async () => {
      let out = "";
      await inDir(topo.a.root, () => sync(["--json"], { stdout: (line) => (out += line), hookInstalled: () => true }));
      const rec = JSON.parse(out) as { sync?: string; note?: string };
      assert.equal(rec.sync, SYNC_LOCAL_ONLY_MESSAGE);
      assert.match(rec.note ?? "", /--establish/);

      let established = "";
      await inDir(topo.a.root, () => sync(["--establish", "--json"], { stdout: (line) => (established += line), hookInstalled: () => true }));
      assert.match(established, /establish/);
      assert.equal(gitTry(topo.a.root, ["rev-parse", "--verify", "--quiet", "origin/board"]).status, 0, "origin received the board");
      assert.equal(git(topo.a.board, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "board");
    });
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a binding naming another project's conventional path never provisions the invoking checkout", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  const homeDir = await mkdtemp(path.join(tmpdir(), "superbee-bound-foreign-home-"));
  try {
    await writeFile(path.join(topo.a.root, ".superbee.json"), JSON.stringify({ bundle: topo.b.board }));
    await withHome(homeDir, async () => {
      await assert.rejects(
        () => inDir(topo.a.root, () => sync(["--json"], { stdout: () => {}, hookInstalled: () => true })),
        (err: unknown) => (err as { code?: string }).code === "NOT_FOUND",
      );
    });
    assert.equal(existsSync(topo.a.board), false, "the invoking checkout's board was not provisioned");
    assert.equal(existsSync(topo.b.board), false, "the foreign target was not provisioned either");
  } finally {
    await topo.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("architecture keeps validation read-only and recovery explicit-sync-only", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [bundle, owner, recovery, attribution, autopull, sessionStart, home, syncSource] = await Promise.all([
    readFile(path.join(root, "src", "bundle.ts"), "utf8"),
    readFile(path.join(root, "src", "bound-board-owner.ts"), "utf8"),
    readFile(path.join(root, "src", "bound-board-recovery.ts"), "utf8"),
    readFile(path.join(root, "src", "board-attribution.ts"), "utf8"),
    readFile(path.join(root, "src", "autopull.ts"), "utf8"),
    readFile(path.join(root, "src", "commands", "session-start.ts"), "utf8"),
    readFile(path.join(root, "src", "commands", "home.ts"), "utf8"),
    readFile(path.join(root, "src", "commands", "sync", "orchestrate.ts"), "utf8"),
  ]);
  assert.match(bundle, /validateBoundBoardOwner/);
  for (const source of [autopull, sessionStart, home, syncSource]) assert.doesNotMatch(source, /validateBoundBoardOwner/);
  assert.doesNotMatch(owner, /WeakMap/);
  assert.doesNotMatch(owner, /abortStaleRebase/);
  assert.match(recovery, /abortStaleRebase/);
  for (const source of [bundle, attribution, autopull, sessionStart, home]) {
    assert.doesNotMatch(source, /bound-board-recovery|recoverBoundBoardOwner/);
  }
  assert.match(syncSource, /recoverBoundBoardOwner/);
  assert.doesNotMatch(attribution, /import .*resolveBundleKey|process\.cwd\(/);
  assert.match(attribution, /stateKey/);
  assert.equal(existsSync(path.join(root, "src", "bound-board-owner.ts")), true);
});
