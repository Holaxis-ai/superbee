import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { makeTwoCloneTopology, git } from "../../board-git/test/git-harness.js";
import { inspectSetupBoard } from "../src/commands/setup.js";
import { buildSetupPlan, type SetupPlanInput } from "../src/setup-plan.js";
import { buildBoardBlock, buildHomeView, defaultLoadBoardStatus, home } from "../src/commands/home.js";
import { sessionStart, sessionStartPull } from "../src/commands/session-start.js";
import { testInvocation } from "./support/command-prefix.js";

const INV = testInvocation("superbee");
const READY: SetupPlanInput = {
  host: "claude-code", scope: "project",
  distribution: { allowed: true, state: "durable_global", reason: "fixture", persistent: true },
  state: { state: "ready", reason: "fixture", records: 0 },
  skill: { canonical: { state: "installed" }, legacy: { state: "absent" } },
  hook: { installed: true, compatibility: { state: "current", reason: "fixture" } },
  mcp: { state: "owned_current", reason: "fixture" },
  workspace: { bundle: "absent", catalog: "empty", selected_registered: false },
};

test("discovery guidance agreement: known, cached offline, unknown, greenfield, unrelated catalog", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    const greenfield = path.join(topo.dir, "greenfield");
    await mkdir(greenfield);
    git(greenfield, ["init", "-b", "main"]);
    const before = git(topo.a.root, ["status", "--porcelain"]);
    for (const row of [
      { name: "known shared board", dir: topo.a.root, expected: "shared", catalog: "empty" },
      { name: "unrelated catalog cannot hide this project's board", dir: topo.a.root, expected: "shared", catalog: "ready" },
      { name: "greenfield", dir: greenfield, expected: "greenfield", catalog: "empty" },
      { name: "unrelated catalog stays explicitly selectable", dir: greenfield, expected: "catalog", catalog: "ready" },
    ] as const) {
      const board = await inspectSetupBoard(row.dir);
      const plan = buildSetupPlan({ ...READY, workspace: { ...READY.workspace, board, catalog: row.catalog } });
      assert.equal(plan.workspace.current_project_bundle, "absent", row.name);
      assert.equal(plan.workspace.catalog_selects_current_project, false, row.name);
      if (row.expected === "shared") {
        assert.deepEqual(plan.next?.command, ["superbee", "sync", "--pull-only"], row.name);
        assert.equal(plan.next?.mutates, true);
        assert.equal(plan.next?.approval.required, true);
        assert.equal(existsSync(path.join(row.dir, ".superbee")), false, "inspection never provisions");
        const block = buildBoardBlock(await defaultLoadBoardStatus(row.dir), undefined, INV);
        assert.match(block.firstContact!, /sync/);
      } else if (row.expected === "greenfield") {
        assert.equal(plan.next?.command?.[1], "init");
      } else {
        assert.equal(plan.next, undefined);
        assert.equal(plan.capabilities.find((c) => c.id === "bundle")?.state, "not_applicable");
      }
    }
    assert.equal(git(topo.a.root, ["status", "--porcelain"]), before);

    git(topo.b.root, ["remote", "set-url", "origin", path.join(topo.dir, "missing.git")]);
    const cached = await inspectSetupBoard(topo.b.root);
    assert.equal(cached.kind, "channel");
    assert.deepEqual(buildSetupPlan({ ...READY, workspace: { ...READY.workspace, board: cached } }).next?.command,
      ["superbee", "sync", "--pull-only"]);
    assert.match(buildBoardBlock(await defaultLoadBoardStatus(topo.b.root), { offline: true }, INV).firstContact!, /sync/);

    git(topo.b.root, ["update-ref", "-d", "refs/remotes/origin/board"]);
    const unknown = await inspectSetupBoard(topo.b.root);
    assert.equal(unknown.kind, "indeterminate");
    for (const catalog of ["empty", "ready"] as const) {
      const plan = buildSetupPlan({ ...READY, workspace: { ...READY.workspace, board: unknown, catalog } });
      assert.equal(plan.status, "blocked");
      assert.equal(plan.next?.mutates, false);
      assert.equal(plan.next?.action, "inspect");
      assert.deepEqual(plan.next?.command, ["superbee", "setup", "--host", "claude-code", "--scope", "project"]);
    }
    const outcome = await sessionStartPull(topo.b.root, 1000);
    assert.ok(outcome?.discoveryUnknown);
    assert.match(outcome.discoveryUnknown, /session-start --dir/);
    const status = await defaultLoadBoardStatus(topo.b.root);
    assert.deepEqual(status, { state: "unverified" });
    let rendered = false;
    await sessionStart(["--dir", topo.b.root, "--json"], {
      pull: async () => outcome,
      renderHome: async (_argv, deps) => {
        const block = buildBoardBlock(status, deps?.boardPull, INV);
        const view = buildHomeView({ binPath: () => "/fixture/superbee", invocation: () => INV }, null,
          undefined, undefined, undefined, block);
        assert.equal(view.getting_started, undefined);
        assert.match(String(view.board), /could not be checked/);
        rendered = true;
      },
    });
    assert.equal(rendered, true, "unknown discovery remains fail-soft and renders orientation");
    assert.equal(existsSync(topo.b.board), false, "unknown discovery creates no bundle");
  } finally {
    await topo.cleanup();
  }
});

test("standalone home preserves unverified origin without network and greenfield remains distinct", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    git(topo.a.root, ["update-ref", "-d", "refs/remotes/origin/board"]);
    git(topo.a.root, ["remote", "set-url", "origin", path.join(topo.dir, "missing.git")]);
    const greenfield = path.join(topo.dir, "greenfield");
    await mkdir(greenfield);
    git(greenfield, ["init", "-b", "main"]);
    for (const row of [
      { dir: topo.a.root, unverified: true },
      { dir: greenfield, unverified: false },
      { dir: topo.dir, unverified: false },
    ]) {
      let output = "";
      await home(["--dir", row.dir, "--json"], {
        stdout: (s) => { output += s; }, invocation: () => INV,
        summarizeBundle: async () => null,
        loadBoardStatus: defaultLoadBoardStatus,
        autoPull: async () => undefined, loadWorkspaces: async () => [],
        hookNeedsUpdate: () => false, skillRefreshScopes: () => [],
      });
      const view = JSON.parse(output);
      if (row.unverified) {
        assert.match(view.board, /existence is unverified/);
        assert.match(view.board, /session-start --dir/);
        assert.equal(view.getting_started, undefined);
      } else {
        assert.equal(view.board, undefined);
        assert.match(view.getting_started, /init --create-only/);
      }
    }
    // A successful check of a reachable empty origin permits greenfield guidance even though
    // the network-free home probe itself cannot establish remote absence.
    const emptyOrigin = path.join(topo.dir, "empty.git");
    git(topo.dir, ["init", "--bare", emptyOrigin]);
    git(greenfield, ["remote", "add", "origin", emptyOrigin]);
    const checked = await sessionStartPull(greenfield);
    assert.equal(checked?.discoveryAbsent, true);
    assert.deepEqual(buildBoardBlock(await defaultLoadBoardStatus(greenfield), checked, INV), {});
  } finally {
    await topo.cleanup();
  }
});

test("setup repairs a known tracked bundle missing from the working tree instead of proposing init", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    git(topo.a.root, ["remote", "remove", "origin"]);
    await mkdir(topo.a.board);
    await writeFile(path.join(topo.a.board, "index.md"), '---\nokf_version: "0.1"\n---\n');
    git(topo.a.root, ["add", "-f", ".superbee/index.md"]);
    git(topo.a.root, ["commit", "-m", "Track fixture bundle"]);
    await rm(topo.a.board, { recursive: true });
    const board = await inspectSetupBoard(topo.a.root);
    assert.deepEqual(board, { kind: "channel", channel: { mode: "in-tree" } });
    for (const catalog of ["empty", "ready"] as const) {
      const plan = buildSetupPlan({ ...READY, workspace: { ...READY.workspace, board, catalog } });
      assert.equal(plan.status, "blocked");
      assert.equal(plan.next?.action, "inspect");
      assert.equal(plan.next?.mutates, false);
      assert.match(plan.next!.description, /restore the missing tracked checkout/);
      assert.equal(plan.next?.command?.[1], "setup");
    }
    assert.equal(existsSync(topo.a.board), false);
  } finally {
    await topo.cleanup();
  }
});

test("setup discovery honors own conventional binding and never borrows a missing external target", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    const binding = path.join(topo.a.root, ".superbee.json");
    await writeFile(binding, JSON.stringify({ bundle: ".superbee" }));
    assert.deepEqual(await inspectSetupBoard(topo.a.root), {
      kind: "channel", channel: { mode: "branch", branch: "board", remote: "origin" },
    });
    await writeFile(binding, JSON.stringify({ bundle: "../missing-external" }));
    await assert.rejects(inspectSetupBoard(topo.a.root), /binding is unresolved/);
    assert.equal(existsSync(topo.a.board), false);
  } finally {
    await topo.cleanup();
  }
});
