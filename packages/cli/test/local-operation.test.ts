import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerOperationPlugin, listOperationPlugins } from '../src/operation-plugins.js';
import { bindLocalOperation, runLocalOperation, LOCAL_OPERATION_PROFILES, outputBudget, startOutputBudgetPoll } from '../src/local-operation.js';
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
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});assert.equal(result.status,'failed');assert.ok(['output_limit','output_validation'].includes(result.reason),result.reason);assert.deepEqual(result.outputs,[]);const outputs=path.join(path.dirname(result.manifest),'outputs');assert.deepEqual(await readdir(outputs),['escape']);const {lstat,readlink}=await import('node:fs/promises');assert.ok((await lstat(path.join(outputs,'escape'))).isSymbolicLink());assert.equal(await readlink(path.join(outputs,'escape')),path.join(path.dirname(result.manifest),'inputs','scene.blend'));assert.equal(await readFile(f.resource,'utf8'),'synthetic-scene');
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

interface ToolReadiness { pid:number; operationPid:number }
async function waitForToolReadiness(file:string, signal:AbortSignal, timeoutMs=10000):Promise<ToolReadiness>{
  const deadline=performance.now()+timeoutMs;
  while(true){
    signal.throwIfAborted();
    try{
      const value=JSON.parse(await readFile(file,'utf8')) as ToolReadiness;
      assert.ok(Number.isInteger(value.pid)&&value.pid>0&&Number.isInteger(value.operationPid)&&value.operationPid>0,'valid fixture PIDs');
      return value;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(performance.now()>=deadline)throw Error('tool_readiness_timeout');
    await delay(10,undefined,{signal});
  }
}

test('controlled executable is cancelled together with operation child',async(t)=>{
  for(const release of [true,false])await t.test(release?'cancel after gated tool readiness':'readiness timeout still cleans up tool and operation',async()=>{
    let markers:{entered:string;ready:string;release:string};
    const f=await fixture(root=>{
      markers={entered:path.join(root,'tool-entered.json'),ready:path.join(root,'tool-ready.json'),release:path.join(root,'tool-release')};
      const script=`const fs=require('node:fs');const pids={pid:process.pid,operationPid:process.ppid};
        const mark=file=>{fs.writeFileSync(file+'.tmp',JSON.stringify(pids));fs.renameSync(file+'.tmp',file);};
        mark(${JSON.stringify(markers.entered)});
        const gate=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(markers.release)}))return;clearInterval(gate);
          fs.writeFileSync('tool.json',JSON.stringify(pids));mark(${JSON.stringify(markers.ready)});setInterval(()=>{},1000);},10);`;
      return `await port.runTool({tool:'node',argv:['--eval',${JSON.stringify(script)}]});return {outputs:[]};`;
    });
    const config={...f.config,tools:{node:process.execPath}};
    const bp:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);const binding:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,bp.digest,f.home);
    const controller=new AbortController();
    const running=runLocalOperation('local.fixture.compare.v1',f.bundle,binding.binding,f.input,{home:f.home,signal:controller.signal});
    const beforeCompletion=<T>(waiting:Promise<T>)=>Promise.race([waiting,running.then(result=>{throw Error(`operation ended before tool readiness: ${result.status}/${result.reason}`);})]);
    let observed:ToolReadiness|undefined;
    try{
      observed=await beforeCompletion(waitForToolReadiness(markers!.entered,controller.signal));
      process.kill(observed.pid,0);process.kill(observed.operationPid,0);
      // Startup is held by a gate, independently of scheduling or a nominal cancellation delay.
      await assert.rejects(readFile(markers!.ready),{code:'ENOENT'});
      if(release){
        await writeFile(markers!.release,'go');
        assert.deepEqual(await beforeCompletion(waitForToolReadiness(markers!.ready,controller.signal)),observed);
      }else await assert.rejects(beforeCompletion(waitForToolReadiness(markers!.ready,controller.signal,0)),/tool_readiness_timeout/);
      controller.abort();
      const result=await running;assert.equal(result.status,'cancelled_confirmed');
      if(release){const tool=JSON.parse(await readFile(path.join(path.dirname(result.manifest),'outputs','tool.json'),'utf8'));assert.deepEqual(tool,observed);}
      assert.throws(()=>process.kill(observed!.pid,0),{code:'ESRCH'});
      assert.throws(()=>process.kill(observed!.operationPid,0),{code:'ESRCH'});
    }finally{
      controller.abort();await Promise.allSettled([running]);
      // A failing liveness assertion must not leave this fixture's process group behind.
      if(observed)try{process.kill(-observed.operationPid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    }
  });
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

async function copiedNativeNode(root:string):Promise<string>{
  const {copyFile,chmod}=await import('node:fs/promises');const bin=path.join(root,'native-bin');await mkdir(bin);const file=path.join(bin,'node');await copyFile(process.execPath,file);await chmod(file,0o700);await symlink(path.resolve(path.dirname(process.execPath),'../lib'),path.join(root,'lib'),'dir');return file;
}
async function bindFixtureTool(f:Awaited<ReturnType<typeof fixture>>,file:string):Promise<string>{
  const config={...f.config,tools:{fixture:file}};const preview:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,preview.digest,f.home);return bound.binding;
}
test('dispatch refuses a binary changed during module initialization even when adapter catches the refusal',async()=>{
  const f=await fixture(root=>`try{await port.runTool({tool:'fixture',argv:['--eval',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(path.join(root,'executed'))},'executed')`)}]});}catch{}return {outputs:[]};`);
  const executable=await copiedNativeNode(f.root),entry=path.join(f.plugin,'entry.mjs');const original=await readFile(entry,'utf8');
  await writeFile(entry,`const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(path.join(f.root,'loaded'))},'loaded');while(true){try{await fs.stat(${JSON.stringify(path.join(f.root,'release'))});break;}catch{}await new Promise(r=>setTimeout(r,10));}\n`+original);
  const preview:any=await registerOperationPlugin(f.plugin,undefined,f.home);await registerOperationPlugin(f.plugin,preview.digest,f.home);const binding=await bindFixtureTool(f,executable);
  const running=runLocalOperation('local.fixture.compare.v1',f.bundle,binding,f.input,{home:f.home});
  let loaded=false;for(let i=0;i<100;i++){try{await readFile(path.join(f.root,'loaded'));loaded=true;break;}catch{}await new Promise(r=>setTimeout(r,10));}assert.ok(loaded);
  const {appendFile}=await import('node:fs/promises');await appendFile(executable,'changed');await writeFile(path.join(f.root,'release'),'release');
  const result=await running;assert.equal(result.status,'failed');assert.equal(result.reason,'tool_identity_changed');await assert.rejects(readFile(path.join(f.root,'executed')),{code:'ENOENT'});const manifest=JSON.parse(await readFile(result.manifest,'utf8'));assert.deepEqual(manifest.toolIdentityChanged,['fixture']);
});
test('post-completion binary changes cannot be hidden by adapter catch',async()=>{
  const toolScript="const fs=require('node:fs');const originalSize=fs.statSync(process.execPath).size;const replacement=process.execPath+'.replacement';fs.copyFileSync(process.execPath,replacement);fs.appendFileSync(replacement,'changed');fs.renameSync(replacement,process.execPath);process.on('exit',exitCode=>fs.writeFileSync('native-exit.json',JSON.stringify({exitCode,originalSize,replacedSize:fs.statSync(process.execPath).size})));process.exit(0)";
  const f=await fixture(`try{await port.runTool({tool:'fixture',argv:['--eval',${JSON.stringify(toolScript)}]});}catch{}return {outputs:[]};`);
  const executable=await copiedNativeNode(f.root),binding=await bindFixtureTool(f,executable);const {stat}=await import('node:fs/promises');const originalSize=(await stat(executable)).size;
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,binding,f.input,{home:f.home});const nativeExit=JSON.parse(await readFile(path.join(path.dirname(result.manifest),'outputs','native-exit.json'),'utf8'));
  assert.deepEqual(nativeExit,{exitCode:0,originalSize,replacedSize:originalSize+Buffer.byteLength('changed')});assert.equal((await stat(executable)).size,nativeExit.replacedSize);
  assert.equal(result.status,'failed');assert.equal(result.reason,'tool_identity_changed');assert.deepEqual(JSON.parse(await readFile(result.manifest,'utf8')).toolIdentityChanged,['fixture']);
});
async function nativeProbeFixture(t:{skip:(reason:string)=>void},root:string,singleOnly=false){
  const {spawnSync}=await import('node:child_process');
  if(spawnSync('cc',['--version'],{stdio:'ignore'}).status!==0){t.skip('native compiler unavailable for version probe fixture');return;}
  const source=path.join(root,'version-probe.c'),binary=path.join(root,'version-probe'),marker=path.join(root,'version-probe.argv');
  await writeFile(source,`#include <stdio.h>\n#include <string.h>\nint main(int argc,char**argv){FILE*f=fopen(${JSON.stringify(marker)},"a");for(int i=1;i<argc;i++)fprintf(f,"%s\\n",argv[i]);fclose(f);if(argc!=2||strcmp(argv[1],"-version")${singleOnly?'': '&&strcmp(argv[1],"--version")'})return 2;puts("fixture 1.0");return 0;}`);
  const built=spawnSync('cc',[source,'-o',binary],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
  return {binary,marker};
}
test('version flag selections reject every malformed later tool before any native probe executes',async(t)=>{
  const f=await fixture(),native=await nativeProbeFixture(t,f.root);if(!native)return;
  const badSelections:unknown[]=[null,[],0,{}, {path:native.binary},{versionFlag:'-version'}, {path:native.binary,versionFlag:'--help'}, {path:native.binary,versionFlag:['-version']}, {path:native.binary,versionFlag:'-version',argv:[]}, {path:native.binary,versionFlag:'-version',env:{}}, {path:7,versionFlag:'-version'}, {path:'relative',versionFlag:'-version'}, 'relative'];
  for(const invalid of badSelections){
    await assert.rejects(bindLocalOperation('local.fixture.compare.v1',f.bundle,{...f.config,tools:{first:native.binary,later:invalid}} as any,undefined,f.home),/tool_selection|absolute_tool_required/);
    await assert.rejects(readFile(native.marker),{code:'ENOENT'});
  }
  await assert.rejects(bindLocalOperation('local.fixture.compare.v1',f.bundle,{...f.config,tools:{first:native.binary,'bad handle':native.binary}},undefined,f.home),/tool_handle/);
  await assert.rejects(readFile(native.marker),{code:'ENOENT'});
  const wrapper=path.join(f.root,'wrapper');await writeFile(wrapper,'#!/bin/sh\nexit 0\n',{mode:0o700});
  await assert.rejects(bindLocalOperation('local.fixture.compare.v1',f.bundle,{...f.config,tools:{wrapper:{path:wrapper,versionFlag:'-version'}}},undefined,f.home),/native_tool_binary_required/);
});
test('version flag selects exactly one native probe with no automatic fallback and is retained in run evidence',async(t)=>{
  const f=await fixture(`const result=await port.runTool({tool:'fixture',argv:['-version']});if(result.exitCode!==0)throw Error('native_run_failed');return {outputs:[]};`),native=await nativeProbeFixture(t,f.root,true);if(!native)return;
  const config={...f.config,tools:{fixture:{path:native.binary,versionFlag:'-version' as const}}};
  await assert.rejects(bindLocalOperation('local.fixture.compare.v1',f.bundle,{...config,tools:{fixture:native.binary}},undefined,f.home),/tool_probe_failed/);
  assert.equal(await readFile(native.marker,'utf8'),'--version\n');
  const preview:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);assert.equal(preview.tools.fixture.versionFlag,'-version');assert.equal(preview.tools.fixture.version,'fixture 1.0');
  const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,preview.digest,f.home);
  const stored=JSON.parse(await readFile(path.join(f.home,'.superbee-state','local-operation-bindings',bound.binding+'.json'),'utf8'));assert.equal(stored.tools.fixture.versionFlag,'-version');
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home});assert.equal(result.status,'succeeded');
  const manifest=JSON.parse(await readFile(result.manifest,'utf8'));assert.deepEqual(manifest.tools.fixture,preview.tools.fixture);
  assert.equal(await readFile(native.marker,'utf8'),'--version\n-version\n-version\n-version\n');
});
test('version flag changes binding acceptance even when native bytes and version output agree',async(t)=>{
  const f=await fixture(),native=await nativeProbeFixture(t,f.root);if(!native)return;
  const config={...f.config,tools:{fixture:native.binary}};
  const defaults:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);
  const explicitDefault:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,{...config,tools:{fixture:{path:native.binary,versionFlag:'--version'}}},undefined,f.home);
  assert.equal(explicitDefault.digest,defaults.digest);assert.equal(defaults.tools.fixture.versionFlag,'--version');
  const changed={...config,tools:{fixture:{path:native.binary,versionFlag:'-version' as const}}};const preview:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,changed,undefined,f.home);
  assert.equal(preview.tools.fixture.sha256,defaults.tools.fixture.sha256);assert.equal(preview.tools.fixture.version,defaults.tools.fixture.version);assert.notEqual(preview.digest,defaults.digest);
  await assert.rejects(bindLocalOperation('local.fixture.compare.v1',f.bundle,changed,defaults.digest,f.home),/binding_acceptance_changed/);
});
test('version flag default preserves string tools and legacy binding and receipt bytes',async()=>{
  const f=await fixture(`const r=await port.runTool({tool:'node',argv:['--version']});if(r.exitCode!==0)throw Error('native_run_failed');return {outputs:[]};`);
  const config={...f.config,tools:{node:process.execPath}};const preview:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);assert.equal(preview.tools.node.versionFlag,'--version');assert.equal(preview.tools.node.version,process.version);
  const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,preview.digest,f.home);
  const bindingFile=path.join(f.home,'.superbee-state','local-operation-bindings',bound.binding+'.json');
  const binding=JSON.parse(await readFile(bindingFile,'utf8'));delete binding.tools.node.versionFlag;const legacyBinding=JSON.stringify(binding);await writeFile(bindingFile,legacyBinding);
  const earlier=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home});assert.equal(earlier.status,'succeeded');
  const oldReceipt=JSON.parse(await readFile(earlier.manifest,'utf8'));delete oldReceipt.tools.node.versionFlag;const legacyReceipt=JSON.stringify(oldReceipt,null,2);await writeFile(earlier.manifest,legacyReceipt);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home});assert.equal(result.status,'succeeded');assert.equal(JSON.parse(await readFile(result.manifest,'utf8')).tools.node.versionFlag,'--version');
  assert.equal(await readFile(bindingFile,'utf8'),legacyBinding);assert.equal(await readFile(earlier.manifest,'utf8'),legacyReceipt);
});
test('native version probe ignoring TERM and retaining descendant pipes settles within its finite escalation bound',async(t)=>{
  const {spawnSync}=await import('node:child_process');if(spawnSync('cc',['--version'],{stdio:'ignore'}).status!==0){t.skip('native compiler unavailable for adversarial executable fixture');return;}
  const f=await fixture(),source=path.join(f.root,'probe.c'),binary=path.join(f.root,'probe'),marker=path.join(f.root,'probe.pid');
  await writeFile(source,`#include <signal.h>\n#include <unistd.h>\n#include <stdio.h>\nint main(){signal(SIGTERM,SIG_IGN);pid_t child=fork();if(child==0){for(;;)sleep(1);}FILE*f=fopen(${JSON.stringify(marker)},"w");fprintf(f,"%d %d",getpid(),child);fclose(f);for(;;)sleep(1);}`);
  const built=spawnSync('cc',[source,'-o',binary],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
  const cleanup=async()=>{try{for(const pid of (await readFile(marker,'utf8')).trim().split(' ').map(Number))try{process.kill(pid,'SIGKILL');}catch{}}catch{}};const watchdog=setTimeout(()=>void cleanup(),7000);
  const started=Date.now();try{await assert.rejects(bindFixtureTool(f,binary),/tool_probe_timed_out|tool_probe_interrupted_unconfirmed/);assert.ok(Date.now()-started<6500,'probe must settle without the independent watchdog');}finally{clearTimeout(watchdog);await cleanup();}
});

test('live output scan restarts whole enumeration after actual file and directory deletion with fresh counters',async(t)=>{
  await t.test('enumerated file disappears after a counted surviving file',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'sb-output-scan-'));await writeFile(path.join(root,'a-retained'),'x');await writeFile(path.join(root,'z-temporary'),'x');
    let reads=0,retainedStats=0;
    const io={readdir:async(dir:string)=>{const entries=(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));if(++reads===1)await rm(path.join(root,'z-temporary'));return entries;},lstat:async(file:string)=>{if(path.basename(file)==='a-retained')retainedStats++;return lstat(file);}};
    assert.equal(await outputBudget(root,1,1,true,io),true);assert.equal(reads,2);assert.equal(retainedStats,2);
  });
  await t.test('directory disappears after stat and before recursive entry',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'sb-output-scan-')),nested=path.join(root,'temporary');await mkdir(nested);let rootReads=0,deleted=false;
    const io={readdir:async(dir:string)=>{if(dir===root)rootReads++;if(dir===nested&&!deleted){await rm(nested,{recursive:true});deleted=true;}return readdir(dir,{withFileTypes:true});},lstat};
    assert.equal(await outputBudget(root,1,1,true,io),true);assert.equal(rootReads,2);assert.equal(deleted,true);
  });
});
test('live output scan refuses repeated churn after exactly three attempts and final scan remains single pass',async()=>{
  for(const live of [true,false]){
    const root=await mkdtemp(path.join(tmpdir(),'sb-output-scan-'));let reads=0;
    const io={readdir:async(dir:string)=>{const file=path.join(dir,`temporary-${++reads}`);await writeFile(file,'x');const entries=await readdir(dir,{withFileTypes:true});await rm(file);return entries;},lstat};
    await assert.rejects(outputBudget(root,1,1,live,io),{message:'output_scan_failed',errno:'ENOENT',syscall:'lstat'});assert.equal(reads,live?3:1);
  }
});
test('live output scan refuses root loss other filesystem errors unsafe entries and exceeded budgets without retries',async(t)=>{
  await t.test('root ENOENT is not a vanished descendant',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'sb-output-scan-'));await rm(root,{recursive:true});let reads=0;
    await assert.rejects(outputBudget(root,1,1,true,{readdir:async dir=>{reads++;return readdir(dir,{withFileTypes:true});},lstat}),{errno:'ENOENT',syscall:'scandir'});assert.equal(reads,1);
  });
  await t.test('actual ENOTDIR does not retry',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'sb-output-scan-')),nested=path.join(root,'entry');await mkdir(nested);let reads=0;
    const io={readdir:async(dir:string)=>{reads++;return readdir(dir,{withFileTypes:true});},lstat:async(file:string)=>{const status=await lstat(file);if(file===nested){await rm(nested,{recursive:true});await writeFile(nested,'x');}return status;}};
    await assert.rejects(outputBudget(root,1,1,true,io),{errno:'ENOTDIR',syscall:'scandir'});assert.equal(reads,2);
  });
  for(const kind of ['symlink','special','bytes','entries'])await t.test(kind,async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'sb-output-scan-'));let reads=0;
    if(kind==='symlink')await symlink(root,path.join(root,'link'));
    else if(kind==='special'){const {spawnSync}=await import('node:child_process');const made=spawnSync('/usr/bin/mkfifo',[path.join(root,'fifo')],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);}
    else await writeFile(path.join(root,'entry'),'xx');
    assert.equal(await outputBudget(root,kind==='bytes'?1:16,kind==='entries'?0:8,true,{readdir:async dir=>{reads++;return readdir(dir,{withFileTypes:true});},lstat}),false);assert.equal(reads,1);
  });
});
test('live output poll drains an in-flight scan before final decisions and never reports after stopping',async(t)=>{
  for(const disappear of [false,true])await t.test(disappear?'pending filesystem failure':'pending complete scan',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'sb-output-scan-'));await writeFile(path.join(root,'temporary'),'x');
    let enter!:()=>void,release!:()=>void,scans=0,held=false;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),events:string[]=[];
    const scan:typeof outputBudget=async(directory,bytes,files,live)=>{scans++;return outputBudget(directory,bytes,files,live,{readdir:async dir=>{const entries=await readdir(dir,{withFileTypes:true});if(!held){held=true;enter();await gate;if(disappear)await rm(root,{recursive:true});}return entries;},lstat});};
    const stop=startOutputBudgetPoll(root,16,8,reason=>events.push(reason),scan);
    try{
      await Promise.race([entered,delay(1000).then(()=>{throw Error('scan_did_not_start');})]);
      const draining=stop().then(()=>{events.push('drained');});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(events.length,0);
      release();await draining;assert.deepEqual(events,disappear?['output_validation','drained']:['drained']);
      if(disappear)await assert.rejects(outputBudget(root,16,8),{errno:'ENOENT'});else assert.equal(await outputBudget(root,16,8),true);
      events.push('final_decision');await delay(75);assert.deepEqual(events,disappear?['output_validation','drained','final_decision']:['drained','final_decision']);assert.equal(scans,1);
    }finally{release();await stop();}
  });
});
test('output validation failure evidence retains only bounded phase errno and syscall diagnostics',async()=>{
  const f=await fixture(`const fs=await import('node:fs/promises');await fs.rm(invocation.outputDirectory,{recursive:true});await new Promise(()=>{});`);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});assert.equal(result.status,'failed');assert.equal(result.reason,'output_validation');
  const manifest=JSON.parse(await readFile(result.manifest,'utf8'));assert.deepEqual(manifest.outputValidationFailure,{phase:'live',errno:'ENOENT',syscall:'scandir'});assert.ok(!JSON.stringify(manifest.outputValidationFailure).includes(f.root));
  const final=await fixture(`await port.writeJson('undeclared.json',{x:1});return {outputs:[]};`);
  const finalResult=await runLocalOperation('local.fixture.compare.v1',final.bundle,final.binding,final.input,{home:final.home});assert.equal(finalResult.status,'failed');assert.equal(finalResult.reason,'output_validation');
  assert.deepEqual(JSON.parse(await readFile(finalResult.manifest,'utf8')).outputValidationFailure,{phase:'final',errno:'unknown',syscall:'unknown'});
});

test('HTML export refuses all in-bundle and alias shapes with an ordinary-output control',async()=>{
  const f=await fixture();const config={...f.config,outputRoot:f.root};const preview:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,undefined,f.home);const bound:any=await bindLocalOperation('local.fixture.compare.v1',f.bundle,config,preview.digest,f.home);
  const indexBefore=await readFile(path.join(f.bundle,'index.md'),'utf8');const doc=path.join(f.bundle,'document.md');await writeFile(doc,'retained document');await symlink(f.bundle,path.join(f.root,'outside-alias'),'dir');await symlink(path.join(f.bundle,'new.md'),path.join(f.root,'outside-dangling.html'));const outside=path.join(f.root,'outside');await mkdir(outside);await symlink(outside,path.join(f.bundle,'alias-out'),'dir');
  const targets=[doc,path.join(f.bundle,'index.md'),path.join(f.bundle,'export.html'),path.join(f.root,'outside-alias','document.md'),path.join(f.root,'outside-dangling.html'),path.join(f.bundle,'alias-out','export.html')];
  for(const target of targets){const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home,exportHtml:target});assert.equal(result.status,'succeeded');assert.equal(result.export.status,'failed');}
  assert.equal(await readFile(path.join(f.bundle,'index.md'),'utf8'),indexBefore);await assert.rejects(readFile(path.join(f.bundle,'export.html')),{code:'ENOENT'});assert.equal(await readFile(doc,'utf8'),'retained document');await assert.rejects(readFile(path.join(f.bundle,'new.md')),{code:'ENOENT'});await assert.rejects(readFile(path.join(outside,'export.html')),{code:'ENOENT'});
  const control=await runLocalOperation('local.fixture.compare.v1',f.bundle,bound.binding,f.input,{home:f.home,exportHtml:path.join(f.root,'ordinary.html')});assert.equal(control.export.status,'exported');
});

test('readJson uses bounded inode reads for regular JSON and refuses symlink, directory, hardlink and oversized leaves',async()=>{
  const f=await fixture(`
    const fs=await import('node:fs/promises');
    await port.writeJson('normal.json',{value:7});
    const normal=await port.readJson('normal.json');if(normal.value!==7)throw Error('normal_json_changed');
    const rejected=[];
    const refuse=async name=>{try{await port.readJson(name);}catch{rejected.push(name);return;}throw Error('unsafe_json_accepted:'+name);};
    await fs.symlink(invocation.outputDirectory+'/normal.json',invocation.outputDirectory+'/symlink.json');await refuse('symlink.json');await fs.unlink(invocation.outputDirectory+'/symlink.json');
    await fs.mkdir(invocation.outputDirectory+'/directory.json');await refuse('directory.json');await fs.rmdir(invocation.outputDirectory+'/directory.json');
    await fs.link(invocation.outputDirectory+'/normal.json',invocation.outputDirectory+'/hardlink.json');await refuse('hardlink.json');await fs.unlink(invocation.outputDirectory+'/hardlink.json');
    await fs.writeFile(invocation.outputDirectory+'/oversized.json',' '.repeat(65537));await refuse('oversized.json');await fs.unlink(invocation.outputDirectory+'/oversized.json');
    return {settings:{value:normal.value,rejected},outputs:[{role:'normal',path:'normal.json',mimeType:'application/json'}]};
  `);
  const result=await runLocalOperation('local.fixture.compare.v1',f.bundle,f.binding,f.input,{home:f.home});assert.equal(result.status,'succeeded');
  const manifest=JSON.parse(await readFile(result.manifest,'utf8'));assert.deepEqual(manifest.settings,{value:7,rejected:['symlink.json','directory.json','hardlink.json','oversized.json']});
  const inputFile=path.join(f.root,'read-input.json');await writeFile(inputFile,JSON.stringify(f.input));
  const {runCommandBatch}=await import('./support/command-batch.js');const rows=runCommandBatch([{id:'read_json',argv:['op','run','local.fixture.compare.v1','--local','--binding',f.binding,'--input-file',inputFile,'--dir',f.bundle,'--json']}],{cwd:f.root,home:f.home});const compiled=rows.get('read_json')!;assert.equal(compiled.status,0,compiled.stdout);assert.equal(compiled.stderr,'');assert.equal(JSON.parse(compiled.stdout).status,'succeeded');
});
