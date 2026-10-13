import assert from "node:assert/strict";
import test from "node:test";
import { dependencyPreflight, lockedRegistryPackages } from "../src/preflight.mjs";

const entry = (name, version) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity: "sha512-fixture" });
test("workspace resolution, scoped transitive selection and named replacement are exact", () => {
  const manifests = [{ directory: "", manifest: { dependencies: { "@scope/local": "*", public: "^1" } } }, { directory: "packages/local", manifest: { name: "@scope/local", dependencies: { public: "^2" } } }];
  const lock = { packages: { "node_modules/@scope/local": { link: true, resolved: "packages/local" }, "node_modules/public": entry("public", "1.0.0"), "packages/local/node_modules/public": entry("public", "2.0.0"), "node_modules/@scope/nested": entry("@scope/nested", "3.0.0") } };
  const rows = lockedRegistryPackages(lock, manifests);
  assert.deepEqual(rows.map((row) => `${row.name}@${row.version}`), ["@scope/nested@3.0.0", "public@1.0.0", "public@2.0.0"]);
  const replaced = lockedRegistryPackages(lock, manifests, { replacements: [{ name: "public", version: "4.0.0", metadataOnly: true }] });
  assert.deepEqual(replaced.map((row) => `${row.name}@${row.version}`), ["@scope/nested@3.0.0", "public@4.0.0"]);
  delete lock.packages["node_modules/public"];
  assert.throws(() => lockedRegistryPackages(lock, manifests), /complete reviewed/);
});
test("metadata failures stay sanitized and bounded; no mutation or install API exists", async () => {
  const packages = Array.from({length:8}, (_,index) => ({ name:`fixture${index}`,version:"1.0.0",metadataOnly:true }));
  let active=0,max=0;
  const result = await dependencyPreflight({ packages, cwd:".", run: async (_,args) => { active++; max=Math.max(max,active); await new Promise(resolve=>setTimeout(resolve,5)); active--; return JSON.stringify({tarball:`https://registry.npmjs.org/${args[1].split('@')[0]}/-/fixture.tgz`}); } });
  assert.equal(result.packages,8); assert.equal(max,3);
  await assert.rejects(dependencyPreflight({packages,cwd:".",run:async()=>{throw new Error("secret token /private/path");}}), (error) => { assert.match(error.message,/Dependency metadata/);assert.doesNotMatch(error.message,/secret|\/private/);return true; });
  await assert.rejects(dependencyPreflight({packages:[{name:"--option",version:"1.0.0"}],cwd:".",run:async()=>assert.fail("must not run")}), /complete reviewed/);
});

test("incomplete/conflicting metadata is denied; version-only lock rows need explicit consent", () => {
  const manifest = [{directory:"",manifest:{dependencies:{fixture:"1.0.0"}}}];
  for (const row of [{version:"1.0.0"},{version:"1.0.0",resolved:"https://registry.npmjs.org/fixture/-/fixture.tgz"},{version:"1.0.0",integrity:"sha512-fixture"}]) {
    assert.throws(()=>lockedRegistryPackages({packages:{"node_modules/fixture":row}},manifest),/complete reviewed/);
  }
  const unbound=lockedRegistryPackages({packages:{"node_modules/fixture":{version:"1.0.0"}}},manifest,{allowMetadataOnly:["fixture"]});
  assert.equal(unbound[0].metadataOnly,true);
  const lock={packages:{"node_modules/fixture":entry("fixture","1.0.0"),"node_modules/@scope/nested":entry("@scope/nested","1.0.0"),"node_modules/other/node_modules/@scope/nested":{...entry("@scope/nested","1.0.0"),integrity:"different"}}};
  assert.throws(()=>lockedRegistryPackages(lock,manifest,{scopes:["@scope"]}),/complete reviewed/);
});

test("exact npm versions admit prerelease plus build and reject malformed identities", () => {
  const manifests=[{directory:"",manifest:{dependencies:{fixture:"*"}}}];
  for (const version of ["1.0.0","0.0.0-pre.1","1.0.0-pre.1+build.1","1.0.0+001"]) {
    assert.equal(lockedRegistryPackages({packages:{"node_modules/fixture":entry("fixture",version)}},manifests)[0].version,version);
  }
  for (const version of ["01.0.0","1.0.0-","1.0.0-pre.","1.0.0-01","1.0.0+","1.0.0+build..1","--option"]) {
    assert.throws(()=>lockedRegistryPackages({packages:{"node_modules/fixture":entry("fixture",version)}},manifests),/complete reviewed/);
  }
});
