import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { registerOperationPlugin, listOperationPlugins, removeOperationPlugin, selectLocalOperation } from "../src/operation-plugins.js";
import { listSourcePlugins, registeredRecipe } from "../src/source-plugins.js";
import { canonicalUserStateDir, ensureUserStateRoot, writeReadyUserStateFileAtomic0600 } from "../src/user-state.js";
import { sourceDigest } from "../src/source-local/state.js";
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

test("finite declarations refuse traversal, duplicate descriptors, incompatible ABI and malformed schema",()=>fixture(async(_base,home,root,m)=>{
 for(const mutate of [(d:any)=>d.assets.push("../escape"),(d:any)=>d.operations.push(d.operations[0]),(d:any)=>d.operations[0].capability.inputSchema.type="string",(d:any)=>d.operations[0].capability.execute="invented",(d:any)=>d.core="999.0.0",(d:any)=>d.helper=2,(d:any)=>d.operations[0].capability.description="x".repeat(5000)]) {
  const next=structuredClone(m);mutate(next.superbeeLocalOperations);await writeFile(join(root,"package.json"),JSON.stringify(next));await assert.rejects(registerOperationPlugin(root,undefined,home));
 }
}));

test("foreign plugin cannot shadow a selected operation",()=>fixture(async(_base,home,root,m)=>{
 await accept(root,home);m.superbeeLocalOperations.id="second";await writeFile(join(root,"package.json"),JSON.stringify(m));const p=await registerOperationPlugin(root,undefined,home);await assert.rejects(registerOperationPlugin(root,p.digest as string,home),reason("operation_conflict"));
}));
test("a second descriptor never implicitly grants the other capability",()=>fixture(async(base,home,root,m)=>{
 const source=await pluginFixture(base), sourceManifest=JSON.parse(await readFile(join(source,"package.json"),"utf8"));
 sourceManifest.superbeeLocalOperations=m.superbeeLocalOperations;await writeFile(join(source,"package.json"),JSON.stringify(sourceManifest));
 await registerFixture(source,home);assert.deepEqual((await listOperationPlugins(home)).plugins,[]);
 m.superbeeIntegration=sourceManifest.superbeeIntegration;await writeFile(join(root,"package.json"),JSON.stringify(m));await accept(root,home);
 assert.equal(((await listSourcePlugins(home)).plugins as unknown[]).length,1);assert.equal((await registeredRecipe("github:work-items",home))?.ok,true);
}));
for(const id of ["constructor","prototype"])test(`historically accepted operation id ${id} remains visible, selectable and removable`,()=>fixture(async(_base,home,root,m)=>{
 // Seed the exact historical v1 pointer and finite generation rather than re-registering it.
 m.superbeeLocalOperations.id=id;await writeFile(join(root,"package.json"),JSON.stringify(m));
 const files=[];for(const file of ["package.json","dist/entry.mjs","dist/helper.py"])files.push({path:file,bytes:await readFile(join(root,file),"utf8")});
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const digest=sourceDigest(files),generation=`g-${digest.slice(7)}-${"a".repeat(16)}`,state=await ensureUserStateRoot(home);
 const captured=join(state,"operation-plugins",generation);await mkdir(join(captured,"dist"),{recursive:true,mode:0o700});
 for(const file of files)await writeFile(join(captured,file.path),file.bytes,{mode:0o600});
 await writeReadyUserStateFileAtomic0600(home,"operation-plugins.json",JSON.stringify([{v:1,kind:"local-operation",plugin:id,generation,digest}])+"\n");
 assert.equal(((await listOperationPlugins(home)).plugins as {plugin:string}[])[0]!.plugin,id);
 assert.equal((await selectLocalOperation("local.fixture.compare.v1",home))!.plugin,id);
 m.superbeeLocalOperations.id="unrelated";m.superbeeLocalOperations.operations[0].id="local.fixture.unrelated.v1";m.superbeeLocalOperations.operations[0].capability.name="fixture_unrelated";
 await writeFile(join(root,"package.json"),JSON.stringify(m));await accept(root,home);
 assert.deepEqual(((await listOperationPlugins(home)).plugins as {plugin:string}[]).map(row=>row.plugin),[id,"unrelated"]);
 assert.equal((await selectLocalOperation("local.fixture.unrelated.v1",home))!.plugin,"unrelated");
 assert.equal((await removeOperationPlugin(id,home)).removed,true);
 assert.deepEqual(((await listOperationPlugins(home)).plugins as {plugin:string}[]).map(row=>row.plugin),["unrelated"]);
 assert.equal((await selectLocalOperation("local.fixture.unrelated.v1",home))!.plugin,"unrelated");
 // New explicit registration uses the same historical lexical operation-id contract.
 m.superbeeLocalOperations.id=id;m.superbeeLocalOperations.operations[0].id="local.fixture.compare.v1";m.superbeeLocalOperations.operations[0].capability.name="fixture_compare";
 await writeFile(join(root,"package.json"),JSON.stringify(m));await accept(root,home);assert.equal((await selectLocalOperation("local.fixture.compare.v1",home))!.plugin,id);
}));
