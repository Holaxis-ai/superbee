import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyAccepted, readSourceEnvelope, sourceDigest, sourceMachineState, sourceStateFile, withSourceState, writeSourceEnvelope, type SourceEnvelope, type AcceptedStage } from "../src/source-local/state.js";
import { canonicalUserStateDir, hardenUserState } from "../src/user-state.js";
const observation=(title:string)=>({v:1 as const,profile:{id:"github-issues",version:1},cursor:null,open:false,records:{one:{after:{title},digest:title,missing:0,seen_at:"2026-10-19T00:00:00Z"}},complete_observations:0});
async function fixture(run:(f:{home:string;root:string;locks:string;file:string;envelope:SourceEnvelope})=>Promise<void>) {
 const home=await mkdtemp(join(tmpdir(),"source-state-")); const root=join(home,"bundle"),locks=join(home,"locks"); const file=sourceStateFile(root,"feeds/one"); const consent={root,feed:"feeds/one"};
 const envelope:SourceEnvelope={product:"superbee",schema_version:1,v:1,binding:{v:1,root,feed:"feeds/one",consent,digest:sourceDigest(consent),credential:{kind:"none"}},version:1,observation:observation("A"),accepted:emptyAccepted()};
 try {await withSourceState(root,"feeds/one",async()=>writeSourceEnvelope(file,envelope,home),home,locks); await run({home,root,locks,file,envelope});} finally {await rm(home,{recursive:true,force:true});}
}
function stage():AcceptedStage & {candidate:ReturnType<typeof emptyAccepted>|null} {
 return {candidate:null,snapshot:emptyAccepted,stagedSnapshot(){return this.candidate;},consume(){this.candidate=null;},discard(){this.candidate=null;}};
}
test("joint publication failure preserves matching old pair and discards staged acceptance",()=>fixture(async f=>{
 const a=stage(); a.candidate={v:1,entries:[{feed:"feeds/one",resource:"r",external_id:"one",target:"items/one",after:{title:"B"}}]};
 const machine=sourceMachineState(f.file,f.envelope,a,f.home,async()=>{throw new Error("injected crash");});machine.beginCommit();
 await assert.rejects(machine.write("feeds/one",observation("B"),"1"));assert.equal(a.candidate,null);
 const old=await readSourceEnvelope(f.file,f.home);assert.equal(old!.observation!.records.one!.after.title,"A");assert.deepEqual(old!.accepted,emptyAccepted());
}));
test("joint success publishes observation and acceptance together; ordinary writes reject a staged page",()=>fixture(async f=>{
 const a=stage();a.candidate={v:1,entries:[{feed:"feeds/one",resource:"r",external_id:"one",target:"items/one",after:{title:"B"}}]};
 const machine=sourceMachineState(f.file,f.envelope,a,f.home);await assert.rejects(machine.write("feeds/one",observation("B"),"1"));
 a.candidate={v:1,entries:[{feed:"feeds/one",resource:"r",external_id:"one",target:"items/one",after:{title:"B"}}]};machine.beginCommit();await machine.write("feeds/one",observation("B"),"1");
 const e=await readSourceEnvelope(f.file,f.home);assert.equal(e!.observation!.records.one!.after.title,"B");assert.equal(e!.accepted.entries[0]!.after.title,"B");assert.equal(a.candidate,null);
}));
test("envelope permissions, corrupt-file preservation and stale MachineState CAS",()=>fixture(async f=>{
 const path=join(canonicalUserStateDir(f.home),f.file);assert.equal((await stat(path)).mode&0o777,0o600);
 const machine=sourceMachineState(f.file,f.envelope,stage(),f.home);await assert.rejects(machine.write("feeds/one",observation("B"),"0"));
 await writeFile(path,"{broken",{mode:0o600});await assert.rejects(readSourceEnvelope(f.file,f.home));assert.equal(await readFile(path,"utf8"),"{broken");
}));
test("per-binding lock excludes simultaneous runner without waiting",()=>fixture(async f=>{
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const first=withSourceState(f.root,"feeds/one",async()=>{entered();await hold;},f.home,f.locks);await ready;
 try{await assert.rejects(withSourceState(f.root,"feeds/one",async()=>{},f.home,f.locks),e=>(e as {details?:{reason:string}}).details?.reason==="source_busy");}finally{release();await first;}
}));
test("consent serialization includes RegExp and provider rule semantics",()=>{
 assert.notEqual(sourceDigest({exclude:/a/i}),sourceDigest({exclude:/a/g}));assert.notEqual(sourceDigest({read_paths:["/a"]}),sourceDigest({read_paths:["/b"]}));
 assert.equal(sourceDigest({a:1,b:new Set(["z","x"])}),sourceDigest({b:new Set(["x","z"]),a:1}));
});

test("recognized source envelope survives the existing private-state harden recovery",()=>fixture(async f=>{
 const path=join(canonicalUserStateDir(f.home),f.file),before=await readFile(path,"utf8");await chmod(path,0o644);await chmod(canonicalUserStateDir(f.home),0o777);
 await hardenUserState(f.home);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(await readFile(path,"utf8"),before);
}));

test("per-binding state lock excludes an independent Node process",()=>fixture(async f=>{
 const moduleUrl=new URL("../src/source-local/state.ts",import.meta.url).href;
 const loader=fileURLToPath(new URL("./ts-loader.mjs",import.meta.url));
 const script=`import {withSourceState} from ${JSON.stringify(moduleUrl)};await withSourceState(${JSON.stringify(f.root)},"feeds/one",async()=>{process.stdout.write("ready");await new Promise(r=>process.stdin.once("data",r));},${JSON.stringify(f.home)},${JSON.stringify(f.locks)});`;
 const child=spawn(process.execPath,["--import",loader,"--input-type=module","-e",script],{stdio:["pipe","pipe","pipe"]});
 try {await once(child.stdout,"data");await assert.rejects(withSourceState(f.root,"feeds/one",async()=>{},f.home,f.locks),e=>(e as {details?:{reason:string}}).details?.reason==="source_busy");}
 finally {child.stdin.end("done");const [exit]=await once(child,"exit");assert.equal(exit,0);}
}));
