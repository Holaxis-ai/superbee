import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { registerOperationPlugin, listOperationPlugins, removeOperationPlugin, selectLocalOperation } from "../src/operation-plugins.js";
import { listSourcePlugins, registeredRecipe } from "../src/source-plugins.js";
import { canonicalUserStateDir } from "../src/user-state.js";
import { pluginFixture, registerFixture } from "./source-plugin-fixture.js";
const reason = (r:string) => (e:any) => e.details?.reason === r;
async function fixture(body:(base:string,home:string,root:string,m:any)=>Promise<void>) {
 const base = await mkdtemp(join(tmpdir(),"operation-plugin-")),home=join(base,"home"),root=join(base,"adapter");
 await mkdir(home); await mkdir(root); await mkdir(join(root,"dist"));
 const m={name:"fixture-local",version:"1.0.0",superbeeLocalOperations:{contract:1,id:"fixture",core:SOURCE_PLUGIN_CORE_VERSION,helper:1,entry:"dist/entry.mjs",assets:["dist/helper.py"],operations:[{id:"local.fixture.compare.v1",capability:{name:"fixture_compare",implementationId:"fixture/1",description:"Compare synthetic inputs",inputSchema:{type:"object"},annotations:{readOnlyHint:false},maximumOutputBytes:1024}}]}};
 await writeFile(join(root,"package.json"),JSON.stringify(m)); await writeFile(join(root,"dist/entry.mjs"),"throw new Error('must never import');"); await writeFile(join(root,"dist/helper.py"),"# captured helper\n");
 try {await body(base,home,root,m);} finally {await rm(base,{recursive:true,force:true});}
}
async function accept(root:string,home:string){const p=await registerOperationPlugin(root,undefined,home);return registerOperationPlugin(root,p.digest as string,home);}
test("operation preview/list/selection never imports, snapshots are independent of source/recipe selection",()=>fixture(async(base,home,root)=>{
 const p=await registerOperationPlugin(root,undefined,home);assert.equal(p.accepted,false);
 await accept(root,home); const selected=(await selectLocalOperation("local.fixture.compare.v1",home))!;
 assert.equal(selected.capability.name,"fixture_compare");assert.ok(Object.isFrozen(selected.capability.inputSchema));assert.equal(selected.assets.length,3);
 const source=await pluginFixture(base);await registerFixture(source,home);const before=await listSourcePlugins(home);assert.equal((await registeredRecipe("github:work-items",home))?.ok,true);
 await writeFile(join(root,"dist/helper.py"),"# original changed\n");assert.equal((await selectLocalOperation(selected.id,home))!.digest,selected.digest);
 await accept(root,home);assert.notEqual((await selectLocalOperation(selected.id,home))!.generation,selected.generation);
 assert.match(await readFile(join(selected.rootPath,"dist/helper.py"),"utf8"),/captured/);
 await removeOperationPlugin("fixture",home);assert.equal(await selectLocalOperation(selected.id,home),undefined);assert.deepEqual(await listSourcePlugins(home),before);assert.equal((await registeredRecipe("github:work-items",home))?.ok,true);
}));
test("acceptance detects changed assets and preserves active generation",()=>fixture(async(_base,home,root)=>{
 await accept(root,home);const before=await listOperationPlugins(home),p=await registerOperationPlugin(root,undefined,home);
 await writeFile(join(root,"dist/helper.py"),"# changed\n");await assert.rejects(registerOperationPlugin(root,p.digest as string,home),reason("operation_changed"));assert.deepEqual(await listOperationPlugins(home),before);
 const selected=(await selectLocalOperation("local.fixture.compare.v1",home))!;await writeFile(join(selected.rootPath,"dist/helper.py"),"# tampered\n");await assert.rejects(selectLocalOperation(selected.id,home),reason("operation_changed"));
}));
test("finite declarations refuse traversal, duplicate descriptors, incompatible ABI and malformed schema",()=>fixture(async(_base,home,root,m)=>{
 for(const mutate of [(d:any)=>d.assets.push("../escape"),(d:any)=>d.operations.push(d.operations[0]),(d:any)=>d.operations[0].capability.inputSchema.type="string",(d:any)=>d.operations[0].capability.execute="invented",(d:any)=>d.core="999.0.0",(d:any)=>d.helper=2,(d:any)=>d.operations[0].capability.description="x".repeat(5000)]) {
  const next=structuredClone(m);mutate(next.superbeeLocalOperations);await writeFile(join(root,"package.json"),JSON.stringify(next));await assert.rejects(registerOperationPlugin(root,undefined,home));
 }
}));
test("symlinks, non-UTF8 assets, oversized assets and unsafe state refuse",()=>fixture(async(base,home,root)=>{
 await accept(root,home);const before=await listOperationPlugins(home),file=join(root,"dist/helper.py");await rm(file);await symlink(join(base,"outside"),file);await assert.rejects(registerOperationPlugin(root,undefined,home));await rm(file);
 await writeFile(file,Buffer.from([255]));await assert.rejects(registerOperationPlugin(root,undefined,home));await writeFile(file,"x".repeat(2*1024*1024+1));await assert.rejects(registerOperationPlugin(root,undefined,home));await writeFile(file,"# okay\n");
 await chmod(join(canonicalUserStateDir(home),"operation-plugins"),0o755);const p=await registerOperationPlugin(root,undefined,home);await assert.rejects(registerOperationPlugin(root,p.digest as string,home));await chmod(join(canonicalUserStateDir(home),"operation-plugins"),0o700);assert.deepEqual(await listOperationPlugins(home),before);
}));
test("foreign plugin cannot shadow a selected operation",()=>fixture(async(_base,home,root,m)=>{
 await accept(root,home);m.superbeeLocalOperations.id="second";await writeFile(join(root,"package.json"),JSON.stringify(m));const p=await registerOperationPlugin(root,undefined,home);await assert.rejects(registerOperationPlugin(root,p.digest as string,home),reason("operation_conflict"));
}));
test("captured incompatible ABI remains inspectable while invocation refuses and preserves state",()=>fixture(async(_base,home,root)=>{
 const { sourceDigest } = await import("../src/source-local/state.js");
 await accept(root,home);const selection=(await selectLocalOperation("local.fixture.compare.v1",home))!;
 const manifestPath=join(selection.rootPath,"package.json"),m=JSON.parse(await readFile(manifestPath,"utf8"));m.superbeeLocalOperations.core="future-core";await writeFile(manifestPath,JSON.stringify(m));
 const files=[];for(const file of [...selection.assets].sort((a,b)=>a.path.localeCompare(b.path)))files.push({path:file.path,bytes:await readFile(join(selection.rootPath,file.path),"utf8")});
 const pointer=join(canonicalUserStateDir(home),"operation-plugins.json"),rows=JSON.parse(await readFile(pointer,"utf8"));rows[0].digest=sourceDigest(files);await writeFile(pointer,JSON.stringify(rows));
 const before=await readFile(pointer,"utf8");assert.equal(((await listOperationPlugins(home)).plugins as any[])[0].core,"future-core");await assert.rejects(selectLocalOperation(selection.id,home),reason("operation_incompatible"));assert.equal(await readFile(pointer,"utf8"),before);
}));
