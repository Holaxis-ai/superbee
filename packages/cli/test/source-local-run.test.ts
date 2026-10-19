import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown } from "@superbee/core";
import { bindLocalSource, runLocalSource, type LocalSourceDeps } from "../src/source-local/run.js";
import { readSourceEnvelope, sourceStateFile } from "../src/source-local/state.js";
const repo=fileURLToPath(new URL("../../..",import.meta.url));
const feed="source-feeds/github",resource="https://github.com/example-org/widgets";
async function fixture(run:(f:{root:string;home:string;deps:LocalSourceDeps;issues:Record<string,unknown>[]})=>Promise<void>) {
 const base=await mkdtemp(join(tmpdir(),"source-run-")),root=join(base,"bundle"),home=join(base,"user");await mkdir(root);await mkdir(home);
 await writeFile(join(root,"index.md"),"---\nokf_version: '0.2'\n---\n# Fixture\n");
 for(const recipe of ["source-feeds","work-items"]) for(const folder of ["conventions","connectors"]) await cp(join(repo,"examples/recipes",recipe,folder),join(root,folder),{recursive:true}).catch(e=>{if(e.code!=="ENOENT")throw e;});
 await mkdir(join(root,"source-feeds"));await writeFile(join(root,`${feed}.md`),`---\ntype: Source Feed\ntitle: Fixture\nfeed_kind: connector\nconnector: connectors/github\nsource: issues\nurl: ${resource}\nowned_fields: [title, key]\nexclude_pattern: never-match\n---\n`);
 const issues=JSON.parse(await readFile(join(repo,"examples/integrations/work-items-github/issues.json"),"utf8")).issues as Record<string,unknown>[];
 try{await run({root,home,issues,deps:{stateInput:home,lockRoot:join(base,"locks")}});}finally{await rm(base,{recursive:true,force:true});}
}
async function accept(root:string,deps:LocalSourceDeps) {const p=await bindLocalSource(feed,{dir:root,anonymous:true},deps);assert.equal(p.accepted,false);await bindLocalSource(feed,{dir:root,anonymous:true,accept:p.digest as string},deps);}
test("binding preview reads no credential; stale declaration refuses before secret read or network",()=>fixture(async f=>{
 let reads=0,sends=0;const env=new Proxy({},{get(){reads++;throw new Error("sentinel");}});
 const p=await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN"},{...f.deps,env});assert.equal(reads,0);
 await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN",accept:p.digest as string},f.deps);
 const connector=join(f.root,"connectors/github.md");await writeFile(connector,(await readFile(connector,"utf8")).replace('2026-03-10','2022-11-28'));
 await assert.rejects(runLocalSource(feed,{dir:f.root},{...f.deps,env,transport:{async request(){sends++;throw new Error();}}}),e=>(e as {details?:{reason:string}}).details?.reason==="binding_changed");assert.equal(reads,0);assert.equal(sends,0);
}));
test("anonymous observation then late adoption on304 uses cached provider fields once",()=>fixture(async f=>{
 await accept(f.root,f.deps);let calls=0;
 const transport={async request(){calls++;const body=JSON.stringify([f.issues[0]]);return {ok:true as const,status:200,headers:{etag:'"fixture"'},body,bytes:Buffer.byteLength(body)};}};
 const first=await runLocalSource(feed,{dir:f.root},{...f.deps,transport});assert.equal(first.outcome,"observed");assert.equal(calls,1);
 await mkdir(join(f.root,"work-items"));await writeFile(join(f.root,"work-items/one.md"),`---\ntype: Work Item\ntitle: Synthetic issue 42\nsources:\n  - resource: ${resource}\n    id: ${f.issues[0]!.node_id}\n---\nHuman notes\n`);
 const second=await runLocalSource(feed,{dir:f.root},{...f.deps,transport:{async request(){return {ok:true as const,status:304,headers:{},body:"",bytes:0};}}});assert.equal(second.outcome,"observed");
 const doc=parseMarkdown(await readFile(join(f.root,"work-items/one.md"),"utf8"));assert.equal(doc.frontmatter.title,f.issues[0]!.title);assert.equal(doc.frontmatter.key,"example-org/widgets#42");assert.ok(doc.body.includes("Human notes"));
 const state=await readSourceEnvelope(sourceStateFile(await realpath(f.root),feed),f.home);assert.equal(state!.accepted.entries.length,1);
 assert.ok(!JSON.stringify(second).includes(f.issues[0]!.title as string));assert.ok(!("cursor" in second));
}));
test("missing credential and arbitrary runtime profile refuse without network",()=>fixture(async f=>{
 const p=await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN"},f.deps);await bindLocalSource(feed,{dir:f.root,credentialEnv:"TOKEN",accept:p.digest as string},f.deps);
 await assert.rejects(runLocalSource(feed,{dir:f.root},{...f.deps,env:{}}),e=>(e as {details?:{reason:string}}).details?.reason==="credential_missing");
 const connector=join(f.root,"connectors/github.md");await writeFile(connector,(await readFile(connector,"utf8")).replace("profile: github-issues","profile: arbitrary-module"));await assert.rejects(bindLocalSource(feed,{dir:f.root,anonymous:true},f.deps));
}));
