import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as lifecycle from "@superbee/core/recipe-lifecycle";
import { retirementFiles, parsedRetirementSource } from "../../core/test/fixtures/recipe-retirement.js";
import { CliError } from "../src/errors.js";
const token = `retirement-apply/v1:sha256:${"a".repeat(64)}`;
let calls: any[] = []; let ready = true; let fail = false;
class RetirementError extends Error { reason="outcome_unknown"; plan={}; completed=[]; failed={id:"conventions/widget",reason:"outcome_unknown"};pending_definitions=["conventions/widget"]; }
if (!process.execArgv.includes("--experimental-test-module-mocks")) {
 test("retirement CLI projection subprocess", () => {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--import", fileURLToPath(new URL("./ts-loader.mjs", import.meta.url)), fileURLToPath(import.meta.url)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
 });
} else {
mock.module("@superbee/core/recipe-lifecycle", { namedExports: { ...lifecycle,
 planRecipeDeclarationRetirementApply: async (...args: any[]) => {calls.push(["plan",...args]);return {recipe:"declaration retirement apply",ready_for_next_stage:ready,next_definition:"conventions/widget",pending_definitions:["conventions/widget"],...(ready?{plan_token:token}:{}),blockers:ready?[]:[{code:"BLOCKED"}],consumers:{status:"unassessed"},external_consumers:"unknown"};},
 applyRecipeDeclarationRetirement: async (...args: any[]) => {calls.push(["apply",...args]);if(fail)throw new RetirementError("ambiguous outcome");return {completed:[{id:"conventions/widget",version:"saved",changed:true,stamped:true}],pending_definitions:["conventions/second"],complete:false,refresh_needed:true,consumers:{status:"unassessed"},external_consumers:"unknown"};},
 RecipeRetirementApplyError: RetirementError,
}});
const {recipe} = await import("../src/commands/recipe.js");
const scope=["--remove-deprecated","--retirement-scope","cooperating-local-writers-v1"];
async function run(args:string[]) {let out="";await recipe([...args,"--json"],{stdout:s=>{out+=s;}});return JSON.parse(out);}
test("retirement flags refuse incompatible or missing authority before resolving source", async()=>{
 for(const flags of [["--remove-deprecated"],[...scope,"--retirement-scan"],["--retirement-scan","--apply",token],["--retirement-scope","cooperating-local-writers-v1"],["--retirement-definition","conventions/widget"],["--apply",token],[...scope,"--apply","sha256:old"],[...scope,"--remote","https://example.invalid"],[...scope,"--retirement-definition",""]]){
  await assert.rejects(run(["evolve","/nonexistent",...flags]),(e:unknown)=>e instanceof CliError && e.code==="USAGE");
 }
 assert.equal(calls.length,0);
});
test("CLI projects Core one-stage plan/apply without converting blocked or ambiguous outcomes to success",async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),"retirement-apply-cli-"));
 try {
  const bundle=path.join(temp,"bundle"), source=path.join(temp,"source");await mkdir(bundle);
  for(const file of retirementFiles(parsedRetirementSource("2",true))){const p=path.join(source,file.path);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,file.bytes);}
  const args=["evolve",source,...scope,"--dir",bundle];
  const plan=await run(args);assert.ok(plan.commands.apply.includes("--retirement-definition"));assert.ok(plan.commands.apply.includes(token));assert.match(plan.writer_scope,/unregistered overlapping roots/);
  assert.equal(calls.at(-1)[3].scope,"cooperating-local-writers-v1");assert.equal(Object.hasOwn(calls.at(-1)[3],"consumerEvidence"),false);
  ready=false;const blocked=await run(args);assert.equal(Object.hasOwn(blocked,"commands"),false);ready=true;
  const receipt=await run([...args,"--apply",token]);assert.equal(receipt.complete,false);assert.match(receipt.commands.inspect_next_stage,/--remove-deprecated/);assert.equal(receipt.completed[0].version,"saved");
  fail=true;await assert.rejects(run([...args,"--apply",token]),(e:unknown)=>e instanceof CliError && e.code==="CONFLICT" && e.details?.reason==="outcome_unknown" && (e.details?.completed as any[]).length===0);fail=false;
  const evidence=path.join(temp,"evidence.json");await writeFile(evidence,"null");await run([...args,"--retirement-evidence",evidence]);assert.equal(calls.at(-1)[3].consumerEvidence,null);
 }finally{await rm(temp,{recursive:true,force:true});}
});

}
