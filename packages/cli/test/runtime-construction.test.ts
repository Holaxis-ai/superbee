import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const url = (name: string) => new URL(`../src/${name}.ts`, import.meta.url).href;
const prelude = `
  import assert from "node:assert/strict";
  import { createCliRuntime, createPosixCliRuntime } from ${JSON.stringify(url("runtime"))};
  import { registerExecutableEntry, currentExecutableRealPath } from ${JSON.stringify(url("invocation"))};
  import { configureSourceIdentity, staticBuildIdentity } from ${JSON.stringify(url("build-identity"))};
  import { currentDistribution } from ${JSON.stringify(url("runtime-context"))};
  import { createPosixHostCommands, createPosixPrivateStateHost } from ${JSON.stringify(url("posix-host"))};
  const entry = ${JSON.stringify(fileURLToPath(import.meta.url))};
  const otherEntry = ${JSON.stringify(fileURLToPath(new URL("../src/runtime.ts", import.meta.url)))};
  const descriptor = {
    identity: {schema:"superbee.build-identity.v1", package:{name:"fixture-cli",version:"1.2.3"},
      source:{commit:null,dirty:null},artifact:{channel:"local-dev"},compatibility_contracts:{skill:1,hook:1,mcp:1}},
    executablePath:entry,assetRoot:"/tmp/fixture",
    install:{packageName:"fixture-cli",entryRelativePath:"dist/fixture.mjs",bins:["fixture"]},
    ownedSkillPackages:["fixture-cli"],updatesEnabled:false,
  };
  const options = () => ({distribution:descriptor,host:createPosixHostCommands(),privateState:createPosixPrivateStateHost(),
    filesystemHost:{runtimeLockParent:()=>"/tmp",runtimeOwnerKey:()=>"fixture",enforcePrivateMode:true,
      isTransientOpenError:()=>false,isReplacementConflict:()=>false,isDirectoryContentionError:()=>false},
    boardHost:{sameResolvedPath:(a,b)=>a===b,moveAsideHelp:()=>""}});
`;
function isolated(body: string): void {
  const child = spawnSync(process.execPath, [
    "--import", fileURLToPath(new URL("./ts-loader.mjs", import.meta.url)),
    "--input-type=module", "-e", prelude + body,
  ], { encoding: "utf8" });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
}

test("conflicting executable construction leaves existing authority intact and permits recovery", () => isolated(`
  registerExecutableEntry(entry);
  const before = staticBuildIdentity();
  assert.throws(()=>createPosixCliRuntime({...descriptor,executablePath:otherEntry}), /already registered/);
  assert.equal(currentDistribution(), undefined);
  assert.equal(currentExecutableRealPath(), entry);
  assert.equal(staticBuildIdentity(), before);
  createPosixCliRuntime(descriptor);
  const bound = currentDistribution();
  assert.deepEqual(bound, descriptor);
  assert.ok(Object.isFrozen(bound.install.bins));
  assert.throws(()=>registerExecutableEntry(otherEntry), /already registered/);
  assert.throws(()=>createPosixCliRuntime({...descriptor,assetRoot:"/different"}), /conflicting configuration/);
  assert.equal(currentDistribution(), bound);
  assert.equal(currentExecutableRealPath(), entry);
  createPosixCliRuntime(descriptor);
`));

test("policy and descriptor getter failures publish no identity and allow subsequent configuration", () => isolated(`
  const broken = options();
  Object.defineProperty(broken.host, "comparisonKey", {get(){throw new Error("policy getter failed");}});
  assert.throws(()=>createCliRuntime(broken), /policy getter failed/);
  assert.equal(currentDistribution(), undefined);
  assert.equal(currentExecutableRealPath(), undefined);
  const brokenDescriptor = {...descriptor, get assetRoot(){throw new Error("descriptor getter failed");}};
  assert.throws(()=>createPosixCliRuntime(brokenDescriptor), /descriptor getter failed/);
  // This would fail if rejected construction had resolved the lazy source identity cache.
  configureSourceIdentity({name:"fixture-cli",version:"1.2.3"});
  const before = staticBuildIdentity();
  assert.throws(()=>createCliRuntime(broken), /policy getter failed/);
  assert.equal(staticBuildIdentity(), before);
  createCliRuntime(options());
  const bound = currentDistribution();
  const identity = staticBuildIdentity();
  assert.throws(()=>createCliRuntime(broken), /policy getter failed/);
  assert.equal(currentDistribution(), bound);
  assert.equal(staticBuildIdentity(), identity);
  assert.equal(currentExecutableRealPath(), entry);
  createCliRuntime(options());
`));

test("unresolved registration is inert and unresolved runtime construction cannot claim executable authority", () => isolated(`
  const missing = entry + ".missing";
  registerExecutableEntry(missing);
  assert.equal(currentExecutableRealPath(), undefined);
  assert.throws(()=>createPosixCliRuntime({...descriptor,executablePath:missing}), /could not be resolved/);
  assert.equal(currentDistribution(), undefined);
  assert.equal(currentExecutableRealPath(), undefined);
  configureSourceIdentity({name:"fixture-cli",version:"1.2.3"});
  createPosixCliRuntime(descriptor);
  const bound = currentDistribution();
  registerExecutableEntry(missing);
  assert.equal(currentExecutableRealPath(), entry);
  assert.equal(currentDistribution(), bound);
`));

test("established source identity rejects inconsistent distribution without registering its executable", () => isolated(`
  configureSourceIdentity({name:"fixture-cli",version:"1.2.3"});
  const before = staticBuildIdentity();
  assert.throws(()=>createPosixCliRuntime({...descriptor,identity:{...descriptor.identity,
    package:{name:"fixture-cli",version:"2.0.0"}}}), /established build identity/);
  assert.equal(currentDistribution(), undefined);
  assert.equal(currentExecutableRealPath(), undefined);
  assert.equal(staticBuildIdentity(), before);
  createPosixCliRuntime(descriptor);
  assert.equal(currentExecutableRealPath(), entry);
`));

test("sync respects composed board scope and process-group capability", () => isolated(`
  import { mkdtemp, rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { runWithRuntime, snapshotRuntimeOptions } from ${JSON.stringify(url("runtime-context"))};
  import { runHostedSyncGate } from ${JSON.stringify(url("commands/sync/gate"))};
  import { hookInstallHintOnce } from ${JSON.stringify(url("sync-cli"))};

  const config = options();
  config.distribution = { ...descriptor, syncExistingGitBoardsOnly: true };
  config.host = { ...config.host, supportsSyncGateProcessGroups: false };
  const folder = await mkdtemp(join(tmpdir(), "superbee-process-group-"));
  try {
    await runWithRuntime(snapshotRuntimeOptions(config), async () => {
      const gate = await runHostedSyncGate(
        { folder, origin: "https://example.invalid", bundleId: "fixture" },
        { command: "exit 0", timeoutSeconds: 1 },
      );
      assert.equal(gate.passed, false);
      assert.match(gate.reason, /POSIX process groups/);
      let checkedHook = false;
      assert.equal(await hookInstallHintOnce("fixture", "fixture", () => {
        checkedHook = true;
        return true;
      }), undefined);
      assert.equal(checkedHook, false);
    });
    const runtime = createCliRuntime(config);
    await runtime.run(["sync", "--establish"]);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
`));

test("scoped list and doc read stay at the explicit standalone checkout and never request freshness", () => isolated(`
  import { readFile } from "node:fs/promises";
  import { join } from "node:path";
  import { list } from ${JSON.stringify(url("commands/list"))};
  import { docRead } from ${JSON.stringify(url("commands/doc/read"))};
  import { runWithRuntime, snapshotRuntimeOptions } from ${JSON.stringify(url("runtime-context"))};
  import { makeTwoCloneTopology, git } from
    ${JSON.stringify(new URL("../../board-git/test/git-harness.ts", import.meta.url).href)};

  const topo = await makeTwoCloneTopology();
  try {
    const relativeBoard = " standalone reader";
    const reader = join(topo.dir, relativeBoard);
    git(topo.dir, ["clone", "--branch", "board", topo.origin, reader]);
    const id = "tasks/seed-one";
    const config = options();
    config.existingGitBoard = { usage: "Select an existing Git board." };
    await runWithRuntime(snapshotRuntimeOptions(config), async () => {
      let stdout = "";
      const deps = {
        stdout: value => { stdout += value; },
        autoPull: async () => { throw new Error("scoped read must not autopull"); },
      };
      const read = (dir, ...args) => docRead([id, "--dir", dir, "--json", ...args], deps);
      const scan = dir => list(["--dir", dir, "--json", "--prefix", "tasks/"], deps);
      const target = join(topo.dir, "prohibited-output");
      for (const channel of [["--out", target], ["--body-out", "-"], ["--rendered-out", target], ["--field", "title"]]) {
        await assert.rejects(read(reader, ...channel), { code: "USAGE" });
      }
      for (const invalid of [topo.a.root, topo.a.board, join(reader, "tasks"), ""]) {
        await assert.rejects(read(invalid), /root of an existing standalone/);
        await assert.rejects(scan(invalid), /root of an existing standalone/);
      }
      await assert.rejects(list(["--json"], deps), { code: "USAGE" });
      await assert.rejects(docRead([id, "--json"], deps), { code: "USAGE" });
      await assert.rejects(docRead([id, "--dir", reader], deps), { code: "USAGE" });
      await assert.rejects(readFile(target), { code: "ENOENT" });
      assert.equal(stdout, "");
      await list(["--help"], deps);
      assert.match(stdout, /sync --pull-only --dir <standalone-board>/);
      stdout = "";
      await list(["--help", "--dir", relativeBoard], deps);
      assert.match(stdout, /sync --pull-only --dir ' standalone reader'/);
      stdout = "";
      for (const [bad, remedy] of [
        [["--field", "malformed"], "--field progress_status=done"],
        [["--field", "progress_status="], "--field progress_status=done"],
        [["--field", "progress_status=todo,,done"], "--field progress_status=todo,in_progress"],
        [["--limit=-1"], "--limit 100"],
      ]) {
        await assert.rejects(list([...bad, "--dir", relativeBoard], deps), (error) => {
          assert.equal(error.code, "USAGE");
          assert.ok(error.help.endsWith(" list " + remedy + " --dir ' standalone reader'"), error.help);
          return true;
        });
        await assert.rejects(list(bad, deps), (error) => {
          assert.equal(error.code, "USAGE");
          assert.ok(error.help.endsWith(" list --help"), error.help);
          return true;
        });
      }
      const cwd = process.cwd();
      process.chdir(topo.dir);
      try {
        await scan(relativeBoard);
        const listing = JSON.parse(stdout);
        assert.ok(listing.docs.some(row => row.id === id));
        assert.ok(listing.help.some(line => line.endsWith(" --dir ' standalone reader' --json")));
        stdout = "";
        await read(relativeBoard);
        await assert.rejects(read(relativeBoard, "--offset", "999999"), (error) => {
          assert.equal(error.code, "USAGE");
          assert.ok(error.help.endsWith(" doc read tasks/seed-one --offset 0 --dir ' standalone reader' --json"), error.help);
          return true;
        });
      } finally {
        process.chdir(cwd);
      }
      const result = JSON.parse(stdout);
      assert.equal(result.id, id);
      stdout = "";
      await read(reader, "--offset", "0", "--expected-version", result.head_version);
      assert.equal(JSON.parse(stdout).body, result.body);
    });
  } finally {
    await topo.cleanup();
  }
`));
