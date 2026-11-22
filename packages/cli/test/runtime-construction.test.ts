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
  import { appendFile, readFile } from "node:fs/promises";
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
    await appendFile(join(reader, id + ".md"), "\\nA line in the reader checkout.\\n".repeat(1500));
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
        assert.ok(listing.help.some(line => line.endsWith(" doc read <id> --dir ' standalone reader' --json")));
        stdout = "";
        await read(relativeBoard, "--offset", "0");
        const firstPage = JSON.parse(stdout);
        const offset = firstPage.range.next_offset;
        assert.ok(offset > 0);
        const suffix = " doc read " + id + " --offset " + offset + " --expected-version " + firstPage.head_version +
          " --dir ' standalone reader' --json";
        assert.ok(firstPage.help[0].endsWith(suffix), firstPage.help[0]);
        stdout = "";
        await read(relativeBoard, "--offset", String(offset), "--expected-version", firstPage.head_version);
        const nextPage = JSON.parse(stdout);
        assert.equal(nextPage.range.offset, offset);
        assert.match(nextPage.body, /A line in the reader checkout/);
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
      const previewRead = " doc read " + id + " --offset " + result.next_offset + " --expected-version " + result.head_version +
        " --dir ' standalone reader' --json";
      assert.ok(result.help.some(line => line.endsWith(previewRead)));
      stdout = "";
      await read(reader, "--offset", "0", "--expected-version", result.head_version);
      assert.match(JSON.parse(stdout).body, /A line in the reader checkout/);
    });
  } finally {
    await topo.cleanup();
  }
`));

test("scoped doc update validates its board and version before reading input, then uses the ordinary CAS", () => isolated(`
  import { mkdir, readFile, realpath, rename } from "node:fs/promises";
  import { join } from "node:path";
  import { doc } from ${JSON.stringify(url("commands/doc"))};
  import { runWithRuntime, snapshotRuntimeOptions } from ${JSON.stringify(url("runtime-context"))};
  import { makeTwoCloneTopology, git } from
    ${JSON.stringify(new URL("../../board-git/test/git-harness.ts", import.meta.url).href)};

  const topo = await makeTwoCloneTopology();
  try {
    const board = join(topo.dir, "standalone writer");
    git(topo.dir, ["clone", "--branch", "board", topo.origin, board]);
    const supplied = topo.dir + "/./standalone writer";
    const verified = await realpath(board);
    const id = "tasks/seed-one";
    const file = join(board, id + ".md");
    const before = await readFile(file, "utf8");
    const tip = git(board, ["rev-parse", "HEAD"]);
    const config = options();
    config.existingGitBoard = { usage: "Select an existing Git board." };
    await runWithRuntime(snapshotRuntimeOptions(config), async () => {
      let stdout = "";
      const deps = {
        stdout: value => { stdout += value; },
        readStdin: async () => { assert.fail("this command must not read stdin"); },
      };
      const update = (...args) => doc(["update", id, "--json", ...args], deps);
      const read = async () => {
        stdout = "";
        await doc(["read", id, "--dir", board, "--json"], deps);
        const result = JSON.parse(stdout);
        stdout = "";
        return result;
      };
      const { head_version: originalVersion, body } = await read();
      const suppliedRead = " doc read " + id + " --dir '" + supplied + "' --json";
      const verifiedRead = " doc read " + id + " --dir '" + verified + "' --json";
      await assert.rejects(update("--dir", supplied), error => {
        assert.match(error.message, /requires --expected-version/);
        assert.ok(error.help.endsWith(suppliedRead), error.help);
        return true;
      });
      await assert.rejects(update("--dir", " "), { message: /requires --expected-version/, help: / doc update --help$/ });
      await assert.rejects(update("--dir", supplied, "--expected-version", " "), error => {
        assert.match(error.message, /given an empty value.*head_version/);
        assert.doesNotMatch(error.message, /omit/);
        assert.ok(error.help.endsWith(suppliedRead), error.help);
        return true;
      });
      await assert.rejects(
        update("--dir", board, "--expected-version", originalVersion, "--actor", " "),
        { message: /--actor was given an empty value/, help: / doc update --help$/ },
      );
      await assert.rejects(
        update("--dir", board, "--expected-version", originalVersion, "--nonesuch", "value"),
        { message: /kind/, help: / doc update --help$/ },
      );
      await assert.rejects(update("--expected-version", originalVersion), /root of an existing standalone/);
      for (const invalid of [topo.a.root, topo.a.board, join(board, "tasks")]) {
        await assert.rejects(update("--dir", invalid, "--expected-version", originalVersion), /root of an existing standalone/);
      }
      assert.equal(await readFile(file, "utf8"), before);

      await update("--dir", supplied, "--expected-version", originalVersion, "--title", "Guarded update", "--actor", "openai/codex");
      const receipt = JSON.parse(stdout);
      const winner = await readFile(file, "utf8");
      assert.equal(receipt.doc, "updated");
      assert.equal(receipt.changed, true);
      assert.ok(receipt.help[0].endsWith(verifiedRead), receipt.help[0]);
      assert.notEqual(receipt.version, originalVersion);
      assert.match(winner, /openai\\/codex/);
      const latest = await read();
      assert.equal(latest.head_version, receipt.version);
      assert.equal(latest.body, body);
      await assert.rejects(
        update("--dir", supplied, "--expected-version", originalVersion, "--body-file", join(topo.dir, "absent body")),
        error => {
          assert.equal(error.code, "STALE_HEAD");
          assert.equal(error.exitCode, 5);
          assert.deepEqual(error.details, { expected: originalVersion, actual: receipt.version });
          assert.ok(error.help.endsWith(verifiedRead), error.help);
          return true;
        },
      );
      assert.equal(await readFile(file, "utf8"), winner);
      assert.equal(git(board, ["rev-parse", "HEAD"]), tip);

      await update("--dir", board, "--expected-version", receipt.version, "--body", body + "\\n[Missing](/tasks/missing.md)\\n");
      const linked = JSON.parse(stdout);
      const linkedBytes = await readFile(file, "utf8");
      const warning = linked.warnings.find(warning => warning.code === "LINK_TARGET_ABSENT");
      assert.match(warning.message, /forward declaration/);
      assert.doesNotMatch(warning.message, /doc write/);
      await assert.rejects(
        update("--dir", board, "--expected-version", linked.version, "--body", body),
        { message: /would silently drop/, help: / doc update --help$/ },
      );

      const movedBoard = join(topo.dir, "moved standalone writer");
      await assert.rejects(
        doc(["update", id, "--dir", board, "--expected-version", linked.version], {
          readStdin: async () => {
            await rename(board, movedBoard);
            await mkdir(board);
            return body;
          },
        }),
        { code: "CONFLICT", message: /selected target identity changed after classification/ },
      );
      assert.equal(await readFile(join(movedBoard, id + ".md"), "utf8"), linkedBytes);
      await assert.rejects(readFile(file), { code: "ENOENT" });
    });
  } finally {
    await topo.cleanup();
  }
`));

test("eligible standalone updates record only the winning actor in each declared board-state directory", () => isolated(`
  import { mkdir, readFile } from "node:fs/promises";
  import { dirname, join } from "node:path";
  import { resolveBundleKey } from "@superbee/board-git";
  import { doc } from ${JSON.stringify(url("commands/doc"))};
  import { defaultSyncStore, readSyncState } from ${JSON.stringify(url("cursor"))};
  import { runWithRuntime, snapshotRuntimeOptions } from ${JSON.stringify(url("runtime-context"))};
  import { makeTwoCloneTopology, git } from
    ${JSON.stringify(new URL("../../board-git/test/git-harness.ts", import.meta.url).href)};

  const topo = await makeTwoCloneTopology();
  try {
    const parent = join(topo.dir, "standalone");
    await mkdir(parent);
    const board = join(parent, ".superbee");
    git(topo.dir, ["clone", "--branch", "board", topo.origin, board]);
    const id = "tasks/seed-one";
    const key = resolveBundleKey(board);
    const session = (name) => snapshotRuntimeOptions({
      ...options(), existingGitBoard: { usage: "Select an existing Git board." },
      boardStateDir: join(topo.dir, name),
    });
    const first = session("board state A");
    const second = session("board state B");
    const call = (session, subcommand, ...argv) => runWithRuntime(session, async () => {
      let stdout = "";
      await doc([subcommand, id, "--dir", board, "--json", ...argv], {
        stdout: value => { stdout += value; },
      });
      return JSON.parse(stdout);
    });
    const actors = (session) => runWithRuntime(session, async () => (await readSyncState(key)).selfActors ?? []);

    const [one, two] = await Promise.all([call(first, "read"), call(second, "read")]);
    assert.equal(one.head_version, two.head_version);
    const write = (session, version, actor, title) =>
      call(session, "update", "--expected-version", version, "--actor", actor, "--title", title);
    const winner = await write(first, one.head_version, "human:one", "First update");
    assert.equal(winner.changed, true);
    await assert.rejects(write(second, two.head_version, "human:two", "Second update"), { code: "STALE_HEAD" });
    assert.deepEqual(await actors(first), ["human:one"]);
    assert.deepEqual(await actors(second), []);

    const next = await write(second, winner.version, "human:two", "Second update");
    assert.equal(next.changed, true);
    assert.deepEqual(await actors(first), ["human:one"]);
    assert.deepEqual(await actors(second), ["human:two"]);
    for (const [session, location, actor] of [[first, "board state A", "human:one"], [second, "board state B", "human:two"]]) {
      const cursorPath = runWithRuntime(session, () => defaultSyncStore.statePath(key));
      assert.equal(dirname(cursorPath), join(topo.dir, location));
      const cursor = JSON.parse(await readFile(cursorPath, "utf8"));
      assert.deepEqual(cursor.selfActors, [actor]);
    }
  } finally {
    await topo.cleanup();
  }
`));
