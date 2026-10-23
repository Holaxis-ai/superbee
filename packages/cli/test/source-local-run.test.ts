import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseMarkdown } from "@superbee/core";
import { source } from "../src/commands/source.js";
import { CliError } from "../src/errors.js";
import { selectSourceProfile, removeSourcePlugin } from "../src/source-plugins.js";
import { publicSourceReason, bindLocalSource, runLocalSource, type LocalSourceDeps } from "../src/source-local/run.js";
import { readSourceEnvelope, sourceStateFile, sourceDigest, writeSourceEnvelope, withSourceState } from "../src/source-local/state.js";
import { syntheticFeed,syntheticResource,syntheticRecords,syntheticFeedDoc,writeSyntheticRecipe,pluginFixture,registerFixture } from "./source-plugin-fixture.js";
const feed=syntheticFeed,resource=syntheticResource;
async function fixture(run:(f:{root:string;home:string;deps:LocalSourceDeps;issues:Record<string,unknown>[]})=>Promise<void>) {
 const base=await mkdtemp(join(tmpdir(),"source-run-")),root=join(base,"bundle"),home=join(base,"user");await mkdir(root);await mkdir(home);
 await writeFile(join(root,"index.md"),"---\nokf_version: '0.2'\n---\n# Fixture\n");
 for(const name of ["source-feeds","work-items"] as const){const recipe=await writeSyntheticRecipe(join(base,name),name);for(const folder of ["conventions","connectors"])await cp(join(recipe,folder),join(root,folder),{recursive:true}).catch(e=>{if(e.code!=="ENOENT")throw e;});}
 await mkdir(join(root,"source-feeds"));await writeFile(join(root,`${feed}.md`),`---\n${JSON.stringify(syntheticFeedDoc.frontmatter)}\n---\n`);
 await registerFixture(await pluginFixture(base),home);
 const issues=structuredClone(syntheticRecords);
 try{await run({root,home,issues,deps:{stateInput:home,lockRoot:join(base,"locks")}});}finally{await rm(base,{recursive:true,force:true});}
}
async function accept(root:string,deps:LocalSourceDeps) {const p=await bindLocalSource(feed,{dir:root,anonymous:true},deps);assert.equal(p.accepted,false);await bindLocalSource(feed,{dir:root,anonymous:true,accept:p.digest as string},deps);}
test("binding preview reads no credential; stale declaration refuses before secret read or network",()=>fixture(async f=>{
 let reads=0,sends=0;const env=new Proxy({},{get(){reads++;throw new Error("sentinel");}});
 const p=await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN"},{...f.deps,env});assert.equal(reads,0);
 await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN",accept:p.digest as string},f.deps);
 const connector=join(f.root,"connectors/github.md");await writeFile(connector,(await readFile(connector,"utf8")).replace('synthetic-v1','synthetic-v2'));
 await assert.rejects(runLocalSource(feed,{dir:f.root},{...f.deps,env,transport:{async request(){sends++;throw new Error();}}}),e=>(e as {details?:{reason:string}}).details?.reason==="binding_changed");assert.equal(reads,0);assert.equal(sends,0);
}));
test("anonymous observation then late adoption on304 uses cached provider fields once",()=>fixture(async f=>{
 await accept(f.root,f.deps);let calls=0;
 const transport={async request(){calls++;const body=JSON.stringify([f.issues[0]]);return {ok:true as const,status:200,headers:{etag:'"fixture"'},body,bytes:Buffer.byteLength(body)};}};
 const first=await runLocalSource(feed,{dir:f.root},{...f.deps,transport});assert.equal(first.outcome,"observed");assert.equal(calls,1);
 await mkdir(join(f.root,"tickets"));await writeFile(join(f.root,"tickets/one.md"),`---\ntype: Ticket\ntitle: ${f.issues[0]!.title}\nsources:\n  - resource: ${resource}\n    id: ${f.issues[0]!.id}\n---\nHuman notes\n`);
 const second=await runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){return {ok:true as const,status:304,headers:{},body:"",bytes:0};}}});assert.equal(second.outcome,"observed");
 const doc=parseMarkdown(await readFile(join(f.root,"tickets/one.md"),"utf8"));assert.equal(doc.frontmatter.title,f.issues[0]!.title);assert.equal(doc.frontmatter.key,"synthetic-key-42");assert.ok(doc.body.includes("Human notes"));
 const state=await readSourceEnvelope(sourceStateFile(await realpath(f.root),feed),f.home);assert.equal(state!.accepted.entries.length,1);
 assert.ok(!JSON.stringify(second).includes(f.issues[0]!.title as string));assert.ok(!("cursor" in second));
}));
test("a second registered source observes through existing transport policy alongside GitHub",()=>fixture(async f=>{
 const second=await pluginFixture(dirname(f.root),{id:"example",profiles:[{id:"example-records",version:1,entry:"entries/records.mjs"},{id:"example-other",version:1,entry:"entries/other.mjs"}]});await registerFixture(second,f.home);
 const connector=join(f.root,"connectors/github.md");await writeFile(connector,(await readFile(connector,"utf8")).replace("github-issues","example-records"));
 await accept(f.root,f.deps);
 const first=await runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){const body=JSON.stringify(f.issues);return {ok:true as const,status:200,headers:{etag:'"fixture"'},body,bytes:Buffer.byteLength(body)};}}});assert.equal(first.outcome,"observed");
 await mkdir(join(f.root,"tickets"));await writeFile(join(f.root,"tickets/second.md"),`---\ntype: Ticket\ntitle: ${f.issues[0]!.title}\nsources:\n  - resource: ${resource}\n    id: ${f.issues[0]!.id}\n---\nHuman notes\n`);
 await runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){return {ok:true as const,status:304,headers:{},body:"",bytes:0};}}});
 const doc=parseMarkdown(await readFile(join(f.root,"tickets/second.md"),"utf8"));assert.equal(doc.frontmatter.key,"synthetic-key-42");assert.ok(doc.body.includes("Human notes"));
 const upgrade=await pluginFixture(dirname(f.root),{id:"example",version:"1.1.0",prefix:"throw Error('new code must not execute with old consent');\n"});await registerFixture(upgrade,f.home);
 let reads=0,sends=0;await assert.rejects(runLocalSource(feed,{dir:f.root},{...f.deps,env:new Proxy({},{get(){reads++;throw Error();}}),transport:{async request(){sends++;throw Error();}}}),e=>(e as {details?:{reason:string}}).details?.reason==="binding_changed");assert.equal(reads,0);assert.equal(sends,0);
 assert.equal((await (await selectSourceProfile("github-issues",f.home))!.load()).id,"github-issues");await removeSourcePlugin("example",f.home);assert.ok(await selectSourceProfile("github-issues",f.home));
}));
test("missing credential and arbitrary runtime profile refuse without network",()=>fixture(async f=>{
 const p=await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN"},f.deps);await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN",accept:p.digest as string},f.deps);
 await assert.rejects(runLocalSource(feed,{dir:f.root},{...f.deps,env:{}}),e=>(e as {details?:{reason:string}}).details?.reason==="credential_missing");
 const connector=join(f.root,"connectors/github.md");await writeFile(connector,(await readFile(connector,"utf8")).replace("github-issues","arbitrary-module"));await assert.rejects(bindLocalSource(feed,{dir:f.root,anonymous:true},f.deps));
}));

test("terminal scope refusal emits one safe reason receipt and returns handled nonzero",()=>fixture(async f=>{
 await accept(f.root,f.deps);const sentinel="invented-private-value";let calls=0,output="";
 await assert.rejects(source(["run",feed,"--json"],{stdout:text=>{output+=text;},run:()=>runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){calls++;const body=JSON.stringify([f.issues[0]]);return {ok:true as const,status:200,headers:{link:`<https://api.github.com/repos/other/${sentinel}/issues?page=2>; rel="next"`},body,bytes:Buffer.byteLength(body)};}}})}),error=>error instanceof CliError && error.exitCode===2 && error.handled===true);
 const receipt=JSON.parse(output);assert.equal(receipt.outcome,"refused");assert.equal(receipt.reason,"url_refused");assert.equal(calls,1);assert.ok(!output.includes(sentinel));assert.ok(!output.includes("https://"));assert.ok(!("detail" in receipt));assert.ok(!("cursor" in receipt));
}));
test("rate-limit deferred continuation exits0 with retry metadata and safe reason",()=>fixture(async f=>{
 await accept(f.root,f.deps);let output="";
 await source(["run",feed,"--json"],{stdout:text=>{output+=text;},run:()=>runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){return {ok:true as const,status:429,headers:{},body:"invented-provider-secret",bytes:24};}}})});
 const receipt=JSON.parse(output);assert.equal(receipt.outcome,"deferred");assert.equal(receipt.reason,"rate_limited");assert.equal(receipt.retry,true);assert.ok(!output.includes("invented-provider-secret"));
}));
test("all terminal outcomes retain taxonomy without a duplicate envelope; unknown reasons are redacted",async()=>{
 assert.equal(publicSourceReason("url_refused"),"url_refused");assert.equal(publicSourceReason("invented-secret-detail"),"unclassified");assert.equal(publicSourceReason(undefined),undefined);
 for(const [outcome,exit] of [["credential_refused",4],["not_found",6],["refused",2],["unsupported_content",2],["too_large",2],["provider_unavailable",1],["failed",1]] as const){
  let output="";await assert.rejects(source(["run","feeds/test","--json"],{stdout:text=>{output+=text;},run:async()=>({outcome,reason:"unclassified",retry:false})}),e=>e instanceof CliError&&e.exitCode===exit&&e.handled===true);assert.equal(JSON.parse(output).outcome,outcome);
 }
});

test("plugin upgrade refuses before executable or credential access; rebind resets acquired state",()=>fixture(async f=>{
 const preview=await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN"},f.deps);
 await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN",accept:preview.digest as string},f.deps);
 await runLocalSource(feed,{dir:f.root},{...f.deps,env:{TOKEN:"synthetic-test-token"},transport:{async request(){const body=JSON.stringify([f.issues[0]]);return {ok:true as const,status:200,headers:{},body,bytes:Buffer.byteLength(body)};}}});
 const file=sourceStateFile(await realpath(f.root),feed);assert.ok((await readSourceEnvelope(file,f.home))!.observation);
 const sentinel="__superbeePluginUpgradeSentinel";const global=globalThis as unknown as Record<string,unknown>;global[sentinel]=0;
 const upgraded=await pluginFixture(dirname(f.root),{version:"1.1.0",prefix:`globalThis.${sentinel}++;\n`});await registerFixture(upgraded,f.home);
 let reads=0,sends=0;const env=new Proxy({},{get(){reads++;throw new Error("credential sentinel");}});
 await assert.rejects(runLocalSource(feed,{dir:f.root},{...f.deps,env,transport:{async request(){sends++;throw new Error();}}}),e=>(e as {details?:{reason:string}}).details?.reason==="binding_changed");
 assert.equal(global[sentinel],0);assert.equal(reads,0);assert.equal(sends,0);
 const rebind=await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN"},f.deps);await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN",accept:rebind.digest as string},f.deps);const reset=(await readSourceEnvelope(file,f.home))!;assert.equal(reset.observation,null);assert.deepEqual(reset.accepted.entries,[]);assert.equal(global[sentinel],1);
 delete global[sentinel];
}));
test("a run retains its selected generation while registration changes during transport",()=>fixture(async f=>{
 await accept(f.root,f.deps);const upgraded=await pluginFixture(dirname(f.root),{version:"1.1.0",prefix:"throw new Error('future selection only');\n"});let calls=0;
 const result=await runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){calls++;await registerFixture(upgraded,f.home);const body=JSON.stringify([f.issues[0]]);return {ok:true as const,status:200,headers:{},body,bytes:Buffer.byteLength(body)};}}});
 assert.equal(result.outcome,"observed");assert.equal(calls,1);
 await assert.rejects(runLocalSource(feed,{dir:f.root},f.deps),e=>(e as {details?:{reason:string}}).details?.reason==="binding_changed");
}));

// Snapshot consent is data-only; even a valid HTTP declaration cannot consume its state.
test("HTTP run and rebind explicitly reject snapshot consent before transport",()=>fixture(async f=>{
 await accept(f.root,f.deps);const root=await realpath(f.root),file=sourceStateFile(root,feed),e=(await readSourceEnvelope(file,f.home))!;
 e.binding.consent={v:1,acquisition:"local-snapshot",root,feed,document_version:"fixture",core_binding_digest:`sha256:${"a".repeat(64)}`,edition:"0.2",bounds:{input_bytes:2097152,records:10000,envelope_bytes:4194304}};e.binding.credential={kind:"none"};e.binding.digest=sourceDigest(e.binding.consent);
 await withSourceState(root,feed,()=>writeSourceEnvelope(file,e,f.home),f.home,f.deps.lockRoot);let sends=0;
 await assert.rejects(runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){sends++;throw Error();}}}),error=>(error as {details?:{reason:string}}).details?.reason==="acquisition_mismatch");assert.equal(sends,0);
 const sentinel="__snapshotHttpBindSentinel",global=globalThis as unknown as Record<string,unknown>;global[sentinel]=0;
 await registerFixture(await pluginFixture(dirname(f.root),{version:"1.1.0",prefix:`globalThis.${sentinel}++;\n`}),f.home);
 for(const accept of [undefined,"sha256:invalid"])await assert.rejects(bindLocalSource(feed,{dir:f.root,anonymous:true,accept},f.deps),error=>(error as {details?:{reason:string}}).details?.reason==="acquisition_mismatch");assert.equal(global[sentinel],0);delete global[sentinel];
}));
