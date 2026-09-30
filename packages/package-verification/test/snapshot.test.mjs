import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../src/harness.mjs";
import { exportSnapshot, SNAPSHOT_FILES, verifySnapshotIntegrity, verifySnapshotProvenance } from "../src/snapshot.mjs";

const exec = promisify(execFile), packageRoot = fileURLToPath(new URL("../", import.meta.url));
const git = async (root, ...args) => (await exec("git", ["-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid",...args])).stdout.trim();
test("snapshot export is exact, owned and refuses stale/dirty/symlink targets", async () => {
  const workspace = await createWorkspace();
  try {
    const source = path.join(workspace.root,"source"), target = path.join(workspace.root,"consumer","snapshot");
    await mkdir(path.join(source,"packages/package-verification"),{recursive:true});
    for (const file of SNAPSHOT_FILES) {
      const destination = path.join(source,"packages/package-verification",file);
      await mkdir(path.dirname(destination),{recursive:true}); await cp(path.join(packageRoot,file),destination);
    }
    await git(source,"init");await git(source,"remote","add","origin","https://github.com/Holaxis-ai/superbee.git");
    await git(source,"add",".");await git(source,"commit","-m","fixture source");
    const commit = await git(source,"rev-parse","HEAD");
    assert.equal((await exportSnapshot({source,target,commit})).status,"provenance-checked");
    assert.equal((await verifySnapshotIntegrity(target)).provenance.startsWith("not-checked"),true);
    const before = await readFile(path.join(target,"snapshot.json"));
    await assert.rejects(exportSnapshot({source,target,commit,expected:"0".repeat(40)}));
    assert.deepEqual(await readFile(path.join(target,"snapshot.json")),before);
    await exportSnapshot({source,target,commit,expected:commit});
    await writeFile(path.join(source,"dirty"),"untracked");
    await assert.rejects(exportSnapshot({source,target,commit,expected:commit}),/clean producer/);
    await rm(path.join(source,"dirty"));
    const link = path.join(workspace.root,"linked");await symlink(target,link);
    await assert.rejects(exportSnapshot({source,target:link,commit,expected:commit}),/symlink/);
    // A self-consistent digest record is not provenance: red against actual committed bytes.
    const changed = Buffer.from("independently edited fork\n");
    await writeFile(path.join(target,"README.md"),changed);
    const manifest = JSON.parse(before);manifest.files["README.md"]=`sha256:${createHash("sha256").update(changed).digest("hex")}`;
    await writeFile(path.join(target,"snapshot.json"),JSON.stringify(manifest));
    assert.equal((await verifySnapshotIntegrity(target)).status,"integrity-checked");
    await assert.rejects(verifySnapshotProvenance({source,target}),/exact producer/);
    await assert.rejects(exportSnapshot({source,target,commit,expected:commit}),/exact producer/);
    await writeFile(path.join(target,"unmanaged"),"must survive");
    await assert.rejects(exportSnapshot({source,target,commit,expected:commit}));
    assert.equal(await readFile(path.join(target,"unmanaged"),"utf8"),"must survive");
  } finally {await workspace.close();}
});
