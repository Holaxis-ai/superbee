import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeTwoCloneTopology, git } from "../../board-git/test/git-harness.js";
import { resolveLocalBundleTarget } from "../src/bundle.js";
import { CliError } from "../src/errors.js";
import { cliInvocation } from "../src/invocation.js";
import { catalogLabelCandidates } from "../src/catalog.js";
import { setupProjectChoice } from "../src/no-bundle-guidance.js";
import { buildBoardBlock, defaultLoadBoardStatus } from "../src/commands/home.js";
import { testInvocation } from "./support/command-prefix.js";

const INV = testInvocation("superbee");

async function discoveryHelp(startDir: string): Promise<string> {
  try {
    await resolveLocalBundleTarget(undefined, startDir);
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "NOT_FOUND");
    return String(error.help);
  }
  assert.fail("expected no bundle");
}

test("project choice never offers the home folder, an ancestor of it, or a root", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "sb-no-bundle-")));
  try {
    const home = path.join(dir, "home", "me");
    const project = path.join(home, "projects", "app");
    await mkdir(project, { recursive: true });
    for (const unsafe of [home, path.dirname(home), path.parse(dir).root]) {
      const hint = setupProjectChoice(unsafe, INV, home);
      assert.match(hint, /your home folder/);
      assert.ok(hint.includes(`${INV} setup --project <dir>`), hint);
      assert.ok(hint.includes(`${INV} setup --no-project`), hint);
      assert.ok(!hint.includes(`--project ${unsafe}`), hint);
    }
    const hint = setupProjectChoice(project, INV, home);
    assert.ok(hint.includes(`${INV} setup --project ${project}\` for this folder`), hint);
    assert.ok(hint.includes(`${INV} setup --no-project`), hint);
    assert.doesNotMatch(hint, /[\u2013\u2014]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovery error: an ordinary folder gets setup's project choice, never init", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "sb-no-bundle-")));
  try {
    const help = await discoveryHelp(dir);
    assert.equal(help, setupProjectChoice(dir, cliInvocation()));
    assert.doesNotMatch(help, / init /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovery error: a fresh clone of a project with a shared board gives the board's next step", async () => {
  const topo = await makeTwoCloneTopology({ provision: false });
  try {
    const before = git(topo.a.root, ["status", "--porcelain"]);
    const help = await discoveryHelp(topo.a.root);
    const expected = buildBoardBlock(await defaultLoadBoardStatus(topo.a.root), undefined, cliInvocation(), topo.a.root).firstContact;
    assert.ok(expected);
    assert.equal(help, expected);
    assert.match(help, /sync/);
    assert.doesNotMatch(help, / init /);
    assert.equal(git(topo.a.root, ["status", "--porcelain"]), before, "guidance never provisions");
  } finally {
    await topo.cleanup();
  }
});

test("catalog label candidates come from a folder name", () => {
  assert.deepEqual(catalogLabelCandidates("My Project!").slice(0, 2), ["my-project", "my-project-2"]);
  assert.deepEqual(catalogLabelCandidates(".superbee").slice(0, 1), ["superbee"]);
  assert.deepEqual(catalogLabelCandidates("!!!"), []);
});
