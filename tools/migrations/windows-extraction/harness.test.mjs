import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { compare, normalizeDocument, canonicalCommand, assertNoWindowsInputs } from './compare.mjs';
import { isolatedEnvironment, run } from './process.mjs';
import { options } from './run.mjs';
const doc = "---\ntype: Note\ngenerated:\n  by: 'process:parity'\n  at: '2026-09-14T17:23:02.487Z'\nuser_clock: '2026-09-14T17:23:02.487Z'\n---\nat: '2026-09-14T17:23:02.487Z' C:\\Windows\\keep\n";
test('only fixture generated.at normalizes; real user data red probe remains visible',()=>{
  const normalized=normalizeDocument(doc);
  assert.match(normalized,/at: '<generated-at>'/);
  assert.ok(normalized.includes("user_clock: '2026-09-14T17:23:02.487Z'"));
  assert.ok(normalized.endsWith("at: '2026-09-14T17:23:02.487Z' C:\\Windows\\keep\n"));
  for (const changed of [doc.replace('user_clock:', 'user_timestamp:'),doc.replace('C:\\Windows\\keep','C:\\Windows\\lost'),doc.replace(/---\nat:/,'---\nbody_date:')]) assert.equal(compare({knowledge:normalized},{knowledge:normalizeDocument(changed)}).pass,false);
});
test('wrong exit, missing persisted field, wrong path and conflict bypass are red',()=>{
  const baseline={knowledge:{code:5,persisted:{custom:'retained'},path:'<fixture>/home/.superbee-state',refusal:'STALE_HEAD'}};
  for (const delta of [{code:0},{persisted:{}},{path:'<fixture>/home/.wrong-state'},{refusal:'success'}]) {
    assert.equal(compare(baseline,{knowledge:{...baseline.knowledge,...delta}}).pass,false);
  }
  assert.equal(compare(baseline,structuredClone(baseline)).pass,true);
});
test('command normalization keeps unknown doc fields, exit status and error content',()=>{
  const c={label:'read-a',result:{code:0,signal:null,failure:null,stdout:JSON.stringify({body:'/tmp/root/user',user_clock:'2024-01-01',head_version:'sha256:ok'}),stderr:''}};
  const n=canonicalCommand(c,'/tmp/root',{'sha256:ok':'<a>'});
  assert.equal(n.stdout.body,'/tmp/root/user'); assert.equal(n.stdout.user_clock,'2024-01-01');
  assert.throws(()=>canonicalCommand(c,'/tmp/root',{}),/unverified token/);
});
test('input graph future gate rejects Windows contamination without gating baseline by default',()=>{
  const graph={schema:'superbee.windows-extraction.inputs.v1',source:'a'.repeat(40),artifact_sha256:'b'.repeat(64),inputs:['packages/core/src/index.ts']};
  assert.doesNotThrow(()=>assertNoWindowsInputs(graph));
  for (const file of ['packages/windows-cli/index.ts','node_modules/@superbee/windows-filesystem/index.js','lib/win32.ts','src/host.windows.ts']) assert.throws(()=>assertNoWindowsInputs({...graph,inputs:[...graph.inputs,file]}));
  assert.throws(()=>assertNoWindowsInputs({...graph,inputs:[]}));
});
test('process timeout captures evidence and kills its process group',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'parity-test-'));
  try {
    const env=await isolatedEnvironment(root);
    assert.equal(env.NODE_OPTIONS,undefined); assert.equal(env.SUPERBEE_REMOTE,undefined);
    for(const key of ['HOME','USERPROFILE','LOCALAPPDATA','APPDATA','CLAUDE_CONFIG_DIR','CODEX_HOME','XDG_CONFIG_HOME','OPENCODE_CONFIG_DIR','npm_config_cache']) assert.ok(env[key].startsWith(root+path.sep));
    const result=await run(process.execPath,['-e','console.log("started"); setInterval(()=>{},1000)'],{cwd:root,env,timeout:250});
    assert.equal(result.failure,'timeout'); assert.match(result.stdout,/started/); assert.notEqual(result.code,0);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('explicit scenarios and artifact identities are required',()=>{
  assert.throws(()=>options([]),/Required/); assert.throws(()=>options(['--latest','true']),/Unknown/);
});
// Opt-in real artifact proof: CI has no archived baseline; reviewers supply the retained pins.
test('retained report proves baseline self comparison when explicitly supplied', {skip:!process.env.PARITY_SELF_REPORT && 'No retained artifact report supplied; unit tests do not claim artifact parity'},async()=>{
  const report=JSON.parse(await readFile(process.env.PARITY_SELF_REPORT,'utf8'));
  assert.equal(report.pass,true); assert.equal(report.cleanup,'removed');
  assert.deepEqual(report.selected,['knowledge','integrations','private-state','process']);
  assert.equal(report.artifacts.baseline.tarball.sha256,report.artifacts.candidate.tarball.sha256);
  const baseline=report.normalized.baseline;
  const controls=[
    ['wrong exit',(candidate)=>{candidate.knowledge.commands.find((c)=>c.label==='read-a').code=6;}],
    ['persisted field lost',(candidate)=>{candidate.knowledge.files['notes/a.md'].bytes=candidate.knowledge.files['notes/a.md'].bytes.replace(/^user_clock:.*\n/m,'');}],
    ['wrong state path',(candidate)=>{candidate['private-state'].stateRoot='<fixture>/home/.wrong-state';}],
    ['wrong config path',(candidate)=>{candidate.integrations.installed.codex=candidate.integrations.installed.claude; delete candidate.integrations.installed.claude;}],
    ['conflict bypass',(candidate)=>{const c=candidate.knowledge.commands.find((c)=>c.label==='stale-cas');c.code=0;c.stdout='success';}],
    ['user data hidden',(candidate)=>{candidate.knowledge.files['notes/a.md'].bytes=candidate.knowledge.files['notes/a.md'].bytes.replace('C:\\Windows\\notes','C:\\Windows\\lost');}],
  ];
  for (const [name,mutate] of controls) {const candidate=structuredClone(report.normalized.candidate);mutate(candidate);assert.equal(compare(baseline,candidate).pass,false,name);}

});
