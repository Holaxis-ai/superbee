import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerOperationPlugin, listOperationPlugins } from '../src/operation-plugins.js';
import { bindLocalOperation, runLocalOperation, localBundle, LOCAL_OPERATION_PROFILES } from '../src/local-operation.js';
import { init } from '../src/commands/init.js';
import { SOURCE_PLUGIN_CORE_VERSION } from '@superbee/core/source-profiles';

const hash=(s:string)=>'sha256:'+createHash('sha256').update(s).digest('hex');
const capability={name:'fixture_compare_view',implementationId:'fixture-v1',description:'Synthetic comparison fixture',inputSchema:{type:'object'},maximumOutputBytes:65536};
async function fixture(body?:string|((root:string)=>string)){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'sb-local-op-'))),home=path.join(root,'home'),bundle=path.join(root,'bundle'),plugin=path.join(root,'plugin'),outputRoot=path.join(root,'export');
  await Promise.all([mkdir(home),mkdir(plugin),mkdir(outputRoot)]);await init(['--dir',bundle],{stdout:()=>{}});
  await writeFile(path.join(plugin,'package.json'),JSON.stringify({name:'fixture-operation',version:'1.0.0',superbeeLocalOperations:{contract:1,id:'fixture',core:SOURCE_PLUGIN_CORE_VERSION,helper:1,entry:'entry.mjs',assets:[],operations:[{id:'local.fixture.compare.v1',capability}]}}));
  const executeBody=typeof body==='function'?body(root):body;
  await writeFile(path.join(plugin,'entry.mjs'),`export function createLocalCapabilities({port,resources,invocation}){return [{...${JSON.stringify(capability)},async execute(input,{signal}){${executeBody??`await port.writeJson('evidence.json',{source:resources.scene.sha256});await import('node:fs/promises').then(fs=>fs.writeFile(invocation.outputDirectory+'/review.html','<!doctype html><p>'+invocation.id+'</p>'));return {settings:input,outputs:[{role:'data',path:'evidence.json',mimeType:'application/json'},{role:'review',path:'review.html',mimeType:'text/html'}]};`}}}]}`);
  const preview:any=await registerOperationPlugin(plugin,undefined,home);await registerOperationPlugin(plugin,preview.digest,home);
  const resource=path.join(root,'scene.blend');await writeFile(resource,'synthetic-scene');
  const config={resources:{scene:{path:resource,logicalRef:'synthetic-scene'}},tools:{},outputRoot,profile:'synthetic-v1' as const};
  const bindingPreview:any=await bindLocalOperation('local.fixture.compare.v1',bundle,config,undefined,home);const binding:any=await bindLocalOperation('local.fixture.compare.v1',bundle,config,bindingPreview.digest,home);
  return {root,home,bundle,plugin,resource,config,binding:binding.binding,input:{expectedInputs:{scene:hash('synthetic-scene')},settings:{camera:'test',units:'m'}}};
}
test('generic second adapter executes once, exports expected-absent HTML and preserves earlier evidence',async()=>{
  const f=await fixture();const exported=path.join(f.config.outputRoot,'review.html');
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home,exportHtml:exported});
  assert.equal(result.status,'succeeded');assert.equal(result.export.status,'exported');assert.match(await readFile(exported,'utf8'),new RegExp(result.invocationId));
  const manifest=JSON.parse(await readFile(result.manifest,'utf8'));assert.equal(manifest.publication,'not_attempted');assert.equal(manifest.inputs[0].sha256,f.input.expectedInputs.scene);assert.ok(!JSON.stringify(manifest).includes(f.resource));
  const repeated=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home,exportHtml:exported});assert.equal(repeated.status,'succeeded');assert.equal(repeated.export.status,'failed');assert.notEqual(repeated.invocationId,result.invocationId);assert.match(await readFile(exported,'utf8'),new RegExp(result.invocationId));
  await writeFile(f.resource,'changed');await assert.rejects(runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home}),/input_hash_changed/);assert.equal(await readFile(result.manifest,'utf8'),JSON.stringify(manifest,null,2));
});
test('changed source installation leaves accepted immutable generation unchanged',async()=>{
  const f=await fixture(`return {outputs:[]};`);await listOperationPlugins(f.home);
  // Altering source installation cannot alter the accepted immutable generation.
  await writeFile(path.join(f.plugin,'entry.mjs'),`throw Error('must never import changed installation')`);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});assert.equal(result.status,'succeeded');
});
test('output symlink and escape refuse with private partial files retained',async()=>{
  const f=await fixture(`const fs=await import('node:fs/promises');await fs.symlink(resources.scene.path,invocation.outputDirectory+'/escape');return {outputs:[{role:'escape',path:'escape',mimeType:'text/plain'}]};`);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});assert.equal(result.status,'failed');assert.equal(result.reason,'output_validation');assert.equal((await readdir(path.join(path.dirname(result.manifest),'outputs'))).length,1);
});
test('real child cancellation stops blocking module load and reports confirmed termination',async()=>{
  const f=await fixture();
  // Re-register a deliberately busy trusted module; the parent must own the module-load deadline.
  await writeFile(path.join(f.plugin,'entry.mjs'),`process.on('SIGTERM',()=>{});while(true){}; export function createLocalCapabilities(){}`);
  const preview:any=await registerOperationPlugin(f.plugin,undefined,f.home);await registerOperationPlugin(f.plugin,preview.digest,f.home);
  const bp:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,f.config,undefined,f.home);const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,f.config,bp.digest,f.home);
  const controller=new AbortController();setTimeout(()=>controller.abort(),150);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home,signal:controller.signal});assert.equal(result.status,'cancelled_confirmed');
});
test('export outside selected output root refuses without changing successful execution',async()=>{
  const f=await fixture();const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home,exportHtml:path.join(f.root,'outside.html')});assert.equal(result.status,'succeeded');assert.equal(result.export.status,'failed');
});

test('changed loaded descriptors refuse before execute',async()=>{
  const f=await fixture();
  await writeFile(path.join(f.plugin,'entry.mjs'),`export function createLocalCapabilities(){return [{...${JSON.stringify(capability)},description:'changed',execute(){throw Error('must not execute')}}]}`);
  const p:any=await registerOperationPlugin(f.plugin,undefined,f.home);await registerOperationPlugin(f.plugin,p.digest,f.home);
  const bp:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,f.config,undefined,f.home);const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,f.config,bp.digest,f.home);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home});assert.equal(result.reason,'descriptor_changed');assert.equal(result.status,'failed');
});
test('deadline covers blocking accepted module load',async()=>{
  const f=await fixture();await writeFile(path.join(f.plugin,'entry.mjs'),`process.on('SIGTERM',()=>{});while(true){}; export function createLocalCapabilities(){}`);
  const p:any=await registerOperationPlugin(f.plugin,undefined,f.home);await registerOperationPlugin(f.plugin,p.digest,f.home);
  const bp:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,f.config,undefined,f.home);const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,f.config,bp.digest,f.home);
  const started=Date.now();const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home});assert.equal(result.status,'timed_out_confirmed');assert.ok(Date.now()-started<35000);
});
test('ordinary resource symlink and changed output root require explicit selection',async()=>{
  const f=await fixture();const alias=path.join(f.root,'alias');await symlink(f.config.outputRoot,alias);
  await assert.rejects(bindLocalOperation('local.fixture.compare.v1',f.bundle,{...f.config,outputRoot:alias},undefined,f.home),/ordinary_output_directory_required/);
  await assert.rejects(runLocalOperation('documents.history.v1',f.bundle,f.binding,f.input,{home:f.home}),/unknown_local_operation/);
});

test('controlled executable is cancelled together with operation child',async()=>{
  const f=await fixture(`await port.runTool({tool:'node',argv:['--eval',"require('node:fs').writeFileSync('tool.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)"]});return {outputs:[]};`);
  const config={...f.config,tools:{node:process.execPath}};
  const bp:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);const binding:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,bp.digest,f.home);
  const controller=new AbortController();setTimeout(()=>controller.abort(),600);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,binding.binding,f.input,{home:f.home,signal:controller.signal});
  assert.equal(result.status,'cancelled_confirmed');
  const tool=JSON.parse(await readFile(path.join(path.dirname(result.manifest),'outputs','tool.json'),'utf8'));
  assert.throws(()=>process.kill(tool.pid,0),{code:'ESRCH'});
});

test('unexpected parent loss preserves an unconfirmed initial manifest, never successful or retryable',async()=>{
  const {spawn}=await import('node:child_process');const {pathToFileURL}=await import('node:url');
  const f=await fixture(`await port.writeJson('worker.json',{pid:process.pid});while(true){}`);
  const source=pathToFileURL(path.resolve(import.meta.dirname,'../src/local-operation.ts')).href;
  const script=`import {runLocalOperation} from ${JSON.stringify(source)};await runLocalOperation('local.fixture.compare.v1',${JSON.stringify(f.bundle)},${JSON.stringify(f.binding)},${JSON.stringify(f.input)},{home:${JSON.stringify(f.home)}});`;
  const parent=spawn(process.execPath,['--import',path.resolve(import.meta.dirname,'ts-loader.mjs'),'--input-type=module','--eval',script],{stdio:'ignore'});
  const area=path.join(f.home,'.superbee-state','local-operation-runs');let worker:number|undefined,manifestFile='';
  try{
    for(let attempt=0;attempt<100;attempt++){
      try{const ids=await readdir(area);for(const id of ids){manifestFile=path.join(area,id,'manifest.json');try{worker=JSON.parse(await readFile(path.join(area,id,'outputs','worker.json'),'utf8')).pid;}catch{}}}catch{}
      if(worker!==undefined)break;await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(worker,'child entered deliberate blocking execution');
    const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
    const manifest=JSON.parse(await readFile(manifestFile,'utf8'));assert.equal(manifest.status,'interrupted_unconfirmed');assert.equal(manifest.reason,'parent_outcome_unknown');assert.equal(manifest.publication,'not_attempted');
  }finally{parent.kill('SIGKILL');if(worker!==undefined)try{process.kill(-worker,'SIGKILL');}catch{}}
});

test('original mutation after capture does not change bytes the tool consumes',async()=>{
  const f=await fixture(root=>`const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(path.join(root,'ready'))},'ready');await new Promise(resolve=>setTimeout(resolve,300));const consumed=await fs.readFile(resources.scene.path,'utf8');await port.writeJson('consumed.json',{consumed});return {outputs:[{role:'consumed',path:'consumed.json',mimeType:'application/json'}]};`);
  const running=runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});
  let ready=false;for(let attempt=0;attempt<100;attempt++){try{await readFile(path.join(f.root,'ready'));ready=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(ready);
  await writeFile(f.resource,'new original content');const result=await running;assert.equal(result.status,'succeeded');
  const consumed=JSON.parse(await readFile(path.join(path.dirname(result.manifest),'outputs','consumed.json'),'utf8'));assert.equal(consumed.consumed,'synthetic-scene');
});
test('changed executable bytes require rebind before any operation code loads',async()=>{
  const f=await fixture();const bin=path.join(f.root,'bin');await mkdir(bin);const executable=path.join(bin,'tool');const {copyFile,chmod,appendFile}=await import('node:fs/promises');await copyFile(process.execPath,executable);await chmod(executable,0o700);await symlink(path.resolve(path.dirname(process.execPath),'../lib'),path.join(f.root,'lib'),'dir');
  const config={...f.config,tools:{fixture:executable}};const preview:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);const binding:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,preview.digest,f.home);
  await appendFile(executable,'changed');
  await assert.rejects(runLocalOperation('local.fixture.compare.v1',f.bundle,binding.binding,f.input,{home:f.home}),/tool_changed_rebind_required/);
});
test('host log bound interrupts a noisy module with finite retained logs',async()=>{
  const f=await fixture(`console.log('x'.repeat(131072));await new Promise(resolve=>setTimeout(resolve,1000));return {outputs:[]};`);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});assert.equal(result.status,'failed');assert.equal(result.reason,'log_limit');assert.ok((await readFile(path.join(path.dirname(result.manifest),'host.log'))).length<=LOCAL_OPERATION_PROFILES['synthetic-v1'].logBytes);
});

test('facade returns nonzero for execution/export failure with exactly one inspectable outcome record',async()=>{
  const {runCommandBatch}=await import('./support/command-batch.js');
  const f=await fixture(`if(input.fail)throw Error('deliberate operation fault');return {outputs:[]};`);
  const failed=path.join(f.root,'failed.json'),success=path.join(f.root,'success.json');
  await writeFile(failed,JSON.stringify({...f.input,settings:{fail:true}}));await writeFile(success,JSON.stringify(f.input));
  const command=(file:string)=>['op','run','local.fixture.compare.v1','--local','--binding',f.binding,'--input-file',file,'--dir',f.bundle,'--json'];
  const results=runCommandBatch([{id:'execution_failed',argv:command(failed)},{id:'execution_succeeded',argv:command(success)},{id:'export_failed',argv:[...command(success),'--export-html',path.join(f.config.outputRoot,'missing-review.html')]}],{cwd:f.root,home:f.home});
  assert.equal(results.get('execution_failed')!.status,1);assert.equal(results.get('execution_succeeded')!.status,0);assert.equal(results.get('export_failed')!.status,1);
  for(const row of results.values()){assert.equal(row.stderr,'');const outcome=JSON.parse(row.stdout);assert.ok(outcome.invocationId);assert.equal(outcome.publication,'not_attempted');}
});

test('replacing selected output directory requires new binding',async()=>{
  const {rename}=await import('node:fs/promises');const f=await fixture();await rename(f.config.outputRoot,f.config.outputRoot+'-old');await mkdir(f.config.outputRoot);
  await assert.rejects(runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home}),/output_root_changed_rebind_required/);
});
test('oversized output is retained but never admitted as validated evidence',async()=>{
  const f=await fixture(`const fs=await import('node:fs/promises');await fs.writeFile(invocation.outputDirectory+'/large.bin',Buffer.alloc(33*1024*1024));return {outputs:[{role:'large',path:'large.bin',mimeType:'application/octet-stream'}]};`);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});assert.equal(result.status,'failed');assert.deepEqual(result.outputs,[]);assert.equal((await readdir(path.join(path.dirname(result.manifest),'outputs'))).length,1);
});

test('HTML export cannot cross the private-state boundary',async()=>{
  const f=await fixture();const target=path.join(f.home,'.superbee-state','export.html');const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home,exportHtml:target});assert.equal(result.status,'succeeded');assert.equal(result.export.status,'failed');await assert.rejects(readFile(target),{code:'ENOENT'});
});

test('private host log retains bounded tool diagnostics even when adapter reports only a stage fault',async()=>{
  const f=await fixture(`const r=await port.runTool({tool:'node',argv:['--eval',"console.error('fixture-tool-diagnostic');process.exit(2)"]});if(r.exitCode!==0)throw Error('stage_failed');return {outputs:[]};`);
  const config={...f.config,tools:{node:process.execPath}};const preview:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,preview.digest,f.home);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home});assert.equal(result.status,'failed');const log=await readFile(path.join(path.dirname(result.manifest),'host.log'),'utf8');assert.match(log,/fixture-tool-diagnostic/);assert.ok(Buffer.byteLength(log)<=LOCAL_OPERATION_PROFILES['synthetic-v1'].logBytes);const manifest=await readFile(result.manifest,'utf8');assert.doesNotMatch(manifest,/fixture-tool-diagnostic/);
});
