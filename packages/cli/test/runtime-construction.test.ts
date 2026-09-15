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
    predecessorLayouts:[],ownedSkillPackages:["fixture-cli"],updatesEnabled:false,
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
