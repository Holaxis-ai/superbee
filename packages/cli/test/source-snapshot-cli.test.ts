import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdown } from "@superbee/core";
import { canonicalJson } from "@superbee/core/site-capabilities";
import { signalConvention } from "../../core/test/record-overlay-helpers.js";
import { source } from "../src/commands/source.js";
import { CliError } from "../src/errors.js";
import { bindLocalSnapshot, runLocalSnapshot, checkLocalSnapshot, type SnapshotDeps } from "../src/source-local/snapshot.js";
import { canonicalUserStateDir } from "../src/user-state.js";
import { isSnapshotBinding, readSourceEnvelope, sourceDigest, sourceStateFile, withSourceState, writeSourceEnvelope } from "../src/source-local/state.js";
const feed="snapshots/benchmark",resource="urn:example:benchmark";
const hash=(data:string|Buffer)=>`sha256:${createHash("sha256").update(data).digest("hex")}`;
const declaration={type:"Reference",title:"Benchmark",resource,target_kind:"Result",identity:{id:"{key}"},fields:{title:"result.label",score:"result.score",labels:"result.labels"},owned_fields:["title","score","labels"],auto_apply:["new","changed"],needs_review:["disappeared"],completeness:"partial"};
interface Fixture {base:string;root:string;home:string;file:string;map:string;deps:SnapshotDeps;stateFile:string;sourceFile:string;kindFile:string}
const record=(score=12,key="trial-001")=>({key,result:{label:"Private benchmark label",score,labels:["benchmark","nested"]}});
const snapshot=(generation=1,records:Record<string,unknown>[]=[record()],extra:Record<string,unknown>={})=>({v:1,resource,generation,complete:false,records,...extra});
const reason=(expected:string)=>(e:unknown)=>e instanceof CliError&&e.details?.reason===expected;
async function fixture(run:(f:Fixture)=>Promise<void>){
 const base=await mkdtemp(join(tmpdir(),"snapshot-cli-")),root=join(base,"bundle"),home=join(base,"user");await mkdir(root);await mkdir(home);
 await writeFile(join(root,"index.md"),"---\nokf_version: '0.2'\n---\n# Snapshot fixture\n");await mkdir(join(root,"conventions"));await mkdir(join(root,"snapshots"));
 const kindFile=join(root,"conventions/result.md"),sourceFile=join(root,`${feed}.md`),file=join(base,"snapshot.json"),map=join(base,"inputs.json");
 await writeFile(kindFile,'---\n'+JSON.stringify({type:"Convention",governs:"Result",title:"Result",fields:{required:["title"],optional:["score","labels","note"],types:{score:"number",labels:"string-list"}}})+'\n---\n');
 await writeFile(join(root,"conventions/signal.md"),'---\n'+JSON.stringify(signalConvention("superbee_progress_status"))+'\n---\n');
 await writeFile(sourceFile,'---\n'+JSON.stringify(declaration)+'\n---\nSource policy\n');await writeFile(file,JSON.stringify(snapshot()));await writeFile(map,JSON.stringify({inputs:{}}));
 const deps={stateInput:home,lockRoot:join(base,"locks")};
 try{await run({base,root,home,file,map,deps,stateFile:sourceStateFile(await realpath(root),feed),sourceFile,kindFile});}finally{await rm(base,{recursive:true,force:true});}
}
async function bind(f:Fixture){const preview=await bindLocalSnapshot(feed,{dir:f.root},f.deps);await bindLocalSnapshot(feed,{dir:f.root,accept:String(preview.digest)},f.deps);return preview;}
async function preview(f:Fixture){return runLocalSnapshot(feed,{dir:f.root,snapshot:f.file},f.deps);}
async function execute(f:Fixture,deps:SnapshotDeps=f.deps){const p=await preview(f);return runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},deps);}
async function target(f:Fixture,name="one",id="trial-001",extra:Record<string,unknown>={}){await mkdir(join(f.root,"results"),{recursive:true});const path=join(f.root,`results/${name}.md`);await writeFile(path,'---\n'+JSON.stringify({type:"Result",title:"Private benchmark label",sources:[{resource,id}],note:"Human measurement",...extra})+'\n---\nHuman conclusion\n');return path;}
async function tree(dir:string):Promise<Record<string,string>>{const out:Record<string,string>={};for(const name of await readdir(dir,{withFileTypes:true})){if(name.isDirectory())for(const [key,value]of Object.entries(await tree(join(dir,name.name))))out[`${name.name}/${key}`]=value;else out[name.name]=hash(await readFile(join(dir,name.name)));}return out;}
async function state(f:Fixture){return (await readSourceEnvelope(f.stateFile,f.home))!;}
async function stateBytes(f:Fixture){return readFile(join(canonicalUserStateDir(f.home),f.stateFile),"utf8");}

test("bind/input previews preserve bytes and absent private directories; snapshot consent contains no credentials",()=>fixture(async f=>{
 const before=await tree(f.base);const b=await bindLocalSnapshot(feed,{dir:f.root},f.deps);assert.equal(b.accepted,false);assert.deepEqual(await tree(f.base),before);
 await assert.rejects(access(canonicalUserStateDir(f.home)));
 await bind(f);const after=await tree(f.base),p=await preview(f);assert.equal(p.status,"input_preview");assert.equal(p.effects_planned,false);assert.equal(p.applied,false);assert.deepEqual(await tree(f.base),after);
 const e=await state(f);assert.equal(isSnapshotBinding(e.binding),true);assert.equal(e.binding.consent.acquisition,"local-snapshot");assert.match(String(e.binding.consent.core_binding_digest),/^sha256:/);assert.ok(!("credential" in e.binding.consent));assert.ok(!JSON.stringify(p).includes("Private benchmark"));assert.ok(!JSON.stringify(p).includes(f.base));
}));
test("exact acceptance changes on snapshot bytes, source head, Kind policy, binding and private version without writes",()=>fixture(async f=>{
 await bind(f);await target(f);const p=await preview(f),before=await tree(f.root),original=await readFile(f.file);
 await writeFile(f.file,Buffer.concat([original,Buffer.from(" ")]));await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},f.deps),reason("snapshot_input_changed"));assert.deepEqual(await tree(f.root),before);await writeFile(f.file,original);
 for(const path of [f.sourceFile,f.kindFile]){const prior=await readFile(path,"utf8");await writeFile(path,prior+"\nChanged metadata/body\n");if(path===f.sourceFile)await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},f.deps),reason("binding_changed"));else { // Kind shape, not irrelevant prose, owns policy acceptance.
 await writeFile(path,prior.replace('"note"','"note","extra"'));await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},f.deps),reason("binding_changed"));}await writeFile(path,prior);}
 const current=await state(f);await withSourceState(await realpath(f.root),feed,()=>writeSourceEnvelope(f.stateFile,{...current,version:current.version+1},f.home),f.home,f.deps.lockRoot);
 const bytes=await stateBytes(f);await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},f.deps),reason("snapshot_input_changed"));assert.equal(await stateBytes(f),bytes);assert.deepEqual(await tree(f.root),before);
}));
test("shared mapping applies nested fields/lists, preserves human fields and follows stable identity across rename",()=>fixture(async f=>{
 await bind(f);const path=await target(f);const first=await execute(f);assert.equal(first.outcome,"observed");assert.equal(first.applied,true);
 let doc=parseMarkdown(await readFile(path,"utf8"));assert.equal(doc.frontmatter.title,"Private benchmark label");assert.equal(doc.frontmatter.score,12);assert.deepEqual(doc.frontmatter.labels,["benchmark","nested"]);assert.equal(doc.frontmatter.note,"Human measurement");assert.match(doc.body,/Human conclusion/);
 const moved=join(f.root,"results/renamed.md");await rename(path,moved);await writeFile(f.file,JSON.stringify(snapshot(2,[{...record(15),result:{...record(15).result,label:"Renamed object label"}}])));await execute(f);doc=parseMarkdown(await readFile(moved,"utf8"));assert.equal(doc.frontmatter.score,15);assert.equal(doc.frontmatter.title,"Renamed object label");assert.equal((await state(f)).accepted.entries[0]!.target,"results/renamed");
}));
test("human owned-field conflict is held; unrelated human measurement survives",()=>fixture(async f=>{
 await bind(f);const path=await target(f);await execute(f);const raw=await readFile(path,"utf8");await writeFile(path,raw.replace("score: 12","score: 99"));await writeFile(f.file,JSON.stringify(snapshot(2,[record(15)])));const report=await execute(f);assert.ok(Number(report.refused_count)>0);const doc=parseMarkdown(await readFile(path,"utf8"));assert.equal(doc.frontmatter.score,99);assert.equal(doc.frontmatter.note,"Human measurement");
 const signals=(await readdir(join(f.root,"signals"))).filter(n=>n.endsWith(".md"));assert.ok(signals.length>0);const signal=parseMarkdown(await readFile(join(f.root,"signals",signals[0]!),"utf8"));assert.equal(signal.frontmatter.type,"Signal");assert.doesNotMatch(signal.body,/\[from feed\]/);assert.equal(signal.frontmatter.provider,resource);
}));
test("custom existing Signal vocabulary links the actual snapshot source and target Kinds",()=>fixture(async f=>{
 await writeFile(join(f.root,"conventions/signal.md"),'---\n'+JSON.stringify(signalConvention("superbee_progress_status",{links:{"from snapshot":"Reference","about result":"Result"}}))+'\n---\n');
 await bind(f);const path=await target(f);await execute(f);await writeFile(path,(await readFile(path,"utf8")).replace("score: 12","score: 99"));await writeFile(f.file,JSON.stringify(snapshot(2,[record(15)])));await execute(f);
 const signals=(await readdir(join(f.root,"signals"))).filter(n=>n.endsWith(".md"));assert.ok(signals.length>0);const signal=parseMarkdown(await readFile(join(f.root,"signals",signals[0]!),"utf8"));assert.match(signal.body,/\[from snapshot\]\(.*benchmark\.md\)/);assert.match(signal.body,/\[about result\]\(.*one\.md\)/);assert.doesNotMatch(signal.body,/\[from feed\]/);
}));
test("rollback/collision are refused before reconciliation can populate a newly linked target; replay converges without new page",()=>fixture(async f=>{
 await bind(f);await execute(f);const path=await target(f),before=await readFile(path,"utf8"),oldState=await stateBytes(f);
 for(const data of [snapshot(1,[record(13)]),snapshot(0)]){await writeFile(f.file,JSON.stringify(data));await assert.rejects(preview(f),reason(data.generation===0?"SNAPSHOT_INPUT_INVALID":"SNAPSHOT_GENERATION_COLLISION"));assert.equal(await readFile(path,"utf8"),before);assert.equal(await stateBytes(f),oldState);}
 await writeFile(f.file,JSON.stringify(snapshot(2)));await execute(f);await writeFile(f.file,JSON.stringify(snapshot(1)));await assert.rejects(preview(f),reason("SNAPSHOT_GENERATION_ROLLBACK"));
 await writeFile(f.file,JSON.stringify(snapshot(2)));const replay=await execute(f);assert.equal(replay.observation,"replay");assert.equal(replay.pages,0);assert.equal((await state(f)).observation!.complete_observations,0);
}));
test("complete missing thresholds advance only on fresh complete snapshots; partial/replay do not",()=>fixture(async f=>{
 await writeFile(f.sourceFile,'---\n'+JSON.stringify({...declaration,completeness:"complete",scope:"all-results",missing_threshold:2})+'\n---\n');
 await writeFile(f.file,JSON.stringify(snapshot(1,[record()],{complete:true,scope:"all-results"})));await bind(f);await target(f);await execute(f);
 await writeFile(f.file,JSON.stringify(snapshot(2,[])));await execute(f);assert.equal((await state(f)).observation!.records["trial-001"]!.missing,0);
 await writeFile(f.file,JSON.stringify(snapshot(3,[],{complete:true,scope:"all-results"})));await execute(f);await execute(f);assert.equal((await state(f)).observation!.records["trial-001"]!.missing,1);
 await writeFile(f.file,JSON.stringify(snapshot(4,[],{complete:true,scope:"all-results"})));const gone=await execute(f);assert.equal((await state(f)).observation!.records["trial-001"]!.missing,2);assert.equal((gone.changes as {disappeared:number}).disappeared,1);
 const signals=(await readdir(join(f.root,"signals"))).filter(n=>n.endsWith(".md"));assert.ok(signals.length>0);const signal=parseMarkdown(await readFile(join(f.root,"signals",signals[0]!),"utf8"));assert.equal(signal.frontmatter.change_kind,"disappeared");assert.doesNotMatch(signal.body,/\[from feed\]/);
}));
test("execution uses a fresh identity index after preview and reports duplicate claims through the overlay",()=>fixture(async f=>{
 await bind(f);const p=await preview(f),path=await target(f);
 const first=await runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},f.deps);assert.equal(first.outcome,"observed");assert.equal(parseMarkdown(await readFile(path,"utf8")).frontmatter.score,12);
 await writeFile(f.file,JSON.stringify(snapshot(2,[record(15)])));const next=await preview(f);await target(f,"duplicate");
 const report=await runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(next.digest)},f.deps);assert.ok(Number(report.refused_count)>0);assert.equal(parseMarkdown(await readFile(path,"utf8")).frontmatter.score,12);
}));
test("membership added after the captured index is detected on the next run, preserving documented CAS scope",()=>fixture(async f=>{
 await bind(f);const path=await target(f);await execute(f);await writeFile(f.file,JSON.stringify(snapshot(2,[record(15)])));const p=await preview(f);let inserted=false;
 const report=await runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},{...f.deps,publish:async(file,e,home)=>{
  await writeSourceEnvelope(file,e,home);if(!inserted){inserted=true;await target(f,"concurrent");}
 }});assert.equal(report.outcome,"observed");assert.equal(parseMarkdown(await readFile(path,"utf8")).frontmatter.score,15);
 await writeFile(f.file,JSON.stringify(snapshot(3,[record(17)])));const next=await execute(f);assert.ok(Number(next.refused_count)>0);assert.equal(parseMarkdown(await readFile(path,"utf8")).frontmatter.score,15);
}));
test("history refuses changed policy rebind without resetting old envelope",()=>fixture(async f=>{
 await bind(f);await execute(f);const before=await stateBytes(f);await writeFile(f.sourceFile,'---\n'+JSON.stringify({...declaration,title:"Changed policy head"})+'\n---\n');await assert.rejects(bindLocalSnapshot(feed,{dir:f.root},f.deps),reason("SNAPSHOT_BINDING_CHANGED"));assert.equal(await stateBytes(f),before);
}));
test("duplicate/invalid records and cumulative mapped capacity refuse with target/envelope unchanged",()=>fixture(async f=>{
 await bind(f);await target(f);const before=await tree(f.root),bytes=await stateBytes(f);
 for(const [data,code]of [[snapshot(1,[record(),record()]),"SNAPSHOT_IDENTITY_DUPLICATE"],[snapshot(1,[{key:"",result:{}}]),"SNAPSHOT_IDENTITY_INVALID"],[snapshot(1,[record()]),null]] as const){if(code){await writeFile(f.file,JSON.stringify(data));await assert.rejects(preview(f),reason(code));}}
 assert.deepEqual(await tree(f.root),before);assert.equal(await stateBytes(f),bytes);
 // Small input, large retained/mapped duplication: the pre-write admission budgets all retry/tuple copies.
 const huge="x".repeat(1000000);await writeFile(f.file,JSON.stringify(snapshot(1,[{key:"trial-001",result:{label:huge,score:12,labels:[]}}])));await assert.rejects(preview(f),reason("SNAPSHOT_CAPACITY_EXCEEDED"));assert.deepEqual(await tree(f.root),before);assert.equal(await stateBytes(f),bytes);
}));
test("cumulative partial retained data refuses before newly linked reconciliation",()=>fixture(async f=>{
 await bind(f);await writeFile(f.file,JSON.stringify(snapshot(1,[{key:"trial-001",result:{label:"x".repeat(550000),score:12,labels:[]}}])));await execute(f);
 const path=await target(f),before=await tree(f.root),bytes=await stateBytes(f);await writeFile(f.file,JSON.stringify(snapshot(2,[record(13,"trial-002")])));
 await assert.rejects(preview(f),reason("SNAPSHOT_CAPACITY_EXCEEDED"));await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:"sha256:capacity-probe"},f.deps),reason("SNAPSHOT_CAPACITY_EXCEEDED"));assert.deepEqual(await tree(f.root),before);assert.equal(await stateBytes(f),bytes);assert.equal(parseMarkdown(await readFile(path,"utf8")).frontmatter.score,undefined);
}));
test("invalid existing attention Kind refuses before pending/reconciliation or private writes",()=>fixture(async f=>{
 await bind(f);await execute(f);await target(f);await rm(join(f.root,"conventions/signal.md"));const before=await tree(f.root),bytes=await stateBytes(f);
 await assert.rejects(preview(f),reason("snapshot_overlay_policy_invalid"));assert.deepEqual(await tree(f.root),before);assert.equal(await stateBytes(f),bytes);
}));
test("late-link reconcile publication failure stops before observation and retries converge",()=>fixture(async f=>{
 await bind(f);await execute(f);const path=await target(f),p=await preview(f),bytes=await stateBytes(f);let publishes=0;
 await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},{...f.deps,publish:async()=>{publishes++;throw Error("private-reconcile-sentinel");}}),reason("state_persist_failed"));assert.equal(publishes,1);assert.equal(await stateBytes(f),bytes);assert.equal(parseMarkdown(await readFile(path,"utf8")).frontmatter.score,12);
 const replay=await execute(f);assert.equal(replay.observation,"replay");assert.equal(replay.pages,0);assert.equal((await state(f)).accepted.entries.length,1);
}));
test("HTTP and snapshot private consent cannot be consumed across acquisition modes",()=>fixture(async f=>{
 await bind(f);const e=await state(f);e.binding.consent={v:1,root:e.binding.root,feed};e.binding.digest=sourceDigest(e.binding.consent);
 await withSourceState(e.binding.root,feed,()=>writeSourceEnvelope(f.stateFile,e,f.home),f.home,f.deps.lockRoot);
 await assert.rejects(preview(f),reason("acquisition_mismatch"));await assert.rejects(bindLocalSnapshot(feed,{dir:f.root},f.deps),reason("acquisition_mismatch"));
}));
test("failed private publication stops and discards acceptance; retry converges through existing adapter",()=>fixture(async f=>{
 await bind(f);const path=await target(f),p=await preview(f),before=await stateBytes(f);let publishes=0;
 await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:f.file,accept:String(p.digest)},{...f.deps,publish:async()=>{publishes++;throw Error("private sentinel");}}),reason("state_persist_failed"));assert.equal(publishes,1);assert.equal(await stateBytes(f),before);assert.equal((await state(f)).accepted.entries.length,0);assert.equal(parseMarkdown(await readFile(path,"utf8")).frontmatter.score,12);
 const next=await execute(f);assert.equal(next.outcome,"observed");assert.equal((await state(f)).accepted.entries.length,1);
}));
test("private state, bundle aliases, symlinks and hardlinks cannot become snapshot ingress",()=>fixture(async f=>{
 await bind(f);const p=await preview(f);const privateFile=join(canonicalUserStateDir(f.home),f.stateFile),alias=join(f.base,"alias");await symlink(f.root,alias);await writeFile(join(f.root,"ordinary.json"),await readFile(f.file));
 const soft=join(f.base,"soft.json"),hard=join(f.base,"hard.json");await symlink(f.file,soft);await link(f.file,hard);
 for(const path of [privateFile,join(f.root,"ordinary.json"),join(alias,"ordinary.json"),soft,hard])await assert.rejects(runLocalSnapshot(feed,{dir:f.root,snapshot:path,accept:String(p.digest)},f.deps));
 const output=JSON.stringify(await checkLocalSnapshot(f.file,{inputsFile:f.map},f.deps).catch(e=>({message:e.message,details:e.details})));assert.ok(!output.includes(f.base));
}));
test("freshness uses separate namespaces/original settings; mismatch wins unknown and never prints paths",()=>fixture(async f=>{
 const original=join(f.base,"original.blend"),tool=join(f.base,"tool.bin"),settings=join(f.base,"settings.json"),inputBytes="original model bytes";await writeFile(original,inputBytes);await writeFile(tool,"tool bytes");await writeFile(settings,'{"b":2,"a":1}');
 const evidence={v:1,association:"caller_asserted",inputs:[{id:"same",sha256:hash(inputBytes)}],required_identities:[{id:"same",sha256:hash("tool bytes")}],settings_digest:hash(canonicalJson({a:1,b:2}))};
 await writeFile(f.file,JSON.stringify(snapshot(1,[record()],{evidence})));await writeFile(f.map,JSON.stringify({inputs:{same:original},required_identities:{same:tool}}));
 const opts={inputsFile:f.map,settingsFile:settings};let report=await checkLocalSnapshot(f.file,opts,f.deps);assert.equal(report.status,"current");assert.equal(report.association,"caller_asserted");assert.ok(!JSON.stringify(report).includes(f.base));
 await writeFile(original,"changed");await rm(tool);report=await checkLocalSnapshot(f.file,opts,f.deps);assert.equal(report.status,"stale");assert.deepEqual((report.rows as {status:string}[]).map(r=>r.status),["mismatch","unknown","equal"]);
 await writeFile(original,inputBytes);assert.equal((await checkLocalSnapshot(f.file,opts,f.deps)).status,"unverifiable");await writeFile(tool,"tool bytes");assert.equal((await checkLocalSnapshot(f.file,{inputsFile:f.map},f.deps)).status,"unverifiable");
 await writeFile(f.map,JSON.stringify({inputs:{same:original},unexpected:"private"}));await assert.rejects(checkLocalSnapshot(f.file,opts,f.deps),reason("snapshot_selection_invalid"));
}));
test("freshness original models exceed snapshot bound, absent evidence is unverifiable, private inputs/maps/settings refuse",()=>fixture(async f=>{
 const large=join(f.base,"model.blend"),bytes=Buffer.alloc(3*1024*1024,42);await writeFile(large,bytes);await writeFile(f.file,JSON.stringify(snapshot(1,[],{evidence:{v:1,association:"caller_asserted",inputs:[{id:"model",sha256:hash(bytes)}]}})));await writeFile(f.map,JSON.stringify({inputs:{model:large}}));assert.equal((await checkLocalSnapshot(f.file,{inputsFile:f.map},f.deps)).status,"current");
 await bind(f);const privateFile=join(canonicalUserStateDir(f.home),f.stateFile);for(const namespace of ["inputs","required_identities"]){await writeFile(f.map,JSON.stringify({inputs:{},[namespace]:{model:privateFile}}));await assert.rejects(checkLocalSnapshot(f.file,{inputsFile:f.map},f.deps),reason("snapshot_file_selection_invalid"));}
 await writeFile(f.map,JSON.stringify({inputs:{}}));await assert.rejects(checkLocalSnapshot(f.file,{inputsFile:privateFile},f.deps));await assert.rejects(checkLocalSnapshot(f.file,{inputsFile:f.map,settingsFile:privateFile},f.deps));
 await writeFile(f.file,JSON.stringify(snapshot()));assert.equal((await checkLocalSnapshot(f.file,{inputsFile:f.map},f.deps)).status,"unverifiable");
}));
test("snapshot parser has closed action flags and exact leaf operands",async()=>{
 for(const argv of [["snapshot","bind","one","extra"],["snapshot","run","one"],["snapshot","run","one","--snapshot","x","--complete"],["snapshot","bind","one","--anonymous"],["snapshot","check","file"],["snapshot","check","file","--inputs-file","x","--dir","bundle"],["snapshot","check","one","two","--inputs-file","x"]])await assert.rejects(source(argv,{stdout:()=>{}}),e=>e instanceof CliError&&e.exitCode===2);
 for(const action of ["bind","run","check"]){let out="";await source(["snapshot",action,"--help"],{stdout:t=>{out+=t;}});assert.match(out,/input_preview/);assert.match(out,/required_identities/);}
});
