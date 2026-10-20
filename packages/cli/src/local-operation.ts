import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalJson, DEFAULT_MAXIMUM_OUTPUT_BYTES } from '@superbee/core/site-capabilities';
import { resolveLocalBundleTarget } from './bundle.js';
import { bundleHomeAt } from './bundle-home.js';
import { commandToken } from './command-text.js';
import { CliError } from './errors.js';
import { assertPathOutsidePrivateState, assertBundleOutsidePrivateState } from './private-state-bundle-boundary.js';
import { ensureUserStateRoot, canonicalUserStateDir, readUserStateFile, writeUserStateFileAtomic0600, type UserStateInput } from './user-state.js';
import { selectLocalOperation } from './operation-plugins.js';
import { boundedLocalFileBytes } from './local-operation-file.js';
import { localOperationChild } from './local-operation-child.js';

export const LOCAL_OPERATION_PROFILES = Object.freeze({
  'synthetic-v1': { inputBytes: 16*1024*1024, outputBytes: 32*1024*1024, files: 32, deadlineMs: 30000, graceMs: 300, logBytes: 65536 },
  'comparison-v1': { inputBytes: 128*1024*1024, outputBytes: 128*1024*1024, files: 64, deadlineMs: 120000, graceMs: 1000, logBytes: 65536 },
});
type ProfileName = keyof typeof LOCAL_OPERATION_PROFILES;
type Resource = {path:string;logicalRef:string};
type Tool = {path:string;sha256:string;version:string};
export interface LocalBindingConfig {resources:Record<string,Resource>;tools:Record<string,string>;outputRoot:string;profile:ProfileName;}
interface Binding {v:1;bundle:string;operation:string;pluginDigest:string;generation:string;capability:unknown;resources:Record<string,Resource>;tools:Record<string,Tool>;outputRoot:string;outputRootIdentity:{dev:number;ino:number};profile:ProfileName;}
const record = (value:unknown):value is Record<string,any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (bytes:Buffer|string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const refuse = (reason:string) => new CliError('USAGE',`Local operation refused (${reason}).`,{details:{reason}});
const key = /^[a-z][a-z0-9_-]{0,63}$/;
const within = (root:string,target:string) => {const rel=path.relative(root,target);return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);};

export async function localFileBytes(file:string,maximum:number):Promise<Buffer>{
  try{return await boundedLocalFileBytes(file,maximum);}catch(error){if(error instanceof Error&&['file_shape_or_limit','input_changed'].includes(error.message))throw refuse(error.message);throw error;}
}
async function ordinaryDirectory(value:string,home:UserStateInput,bundle:string):Promise<string>{
  if(typeof value!=='string'||!path.isAbsolute(value))throw refuse('absolute_directory_required');
  assertPathOutsidePrivateState(value,home);
  const canonical=await realpath(value),status=await lstat(value);
  if(!status.isDirectory()||status.isSymbolicLink()||canonical!==value || canonical===bundle || within(bundle,canonical))throw refuse('ordinary_output_directory_required');
  return canonical;
}
export async function localBundle(dir:string|undefined,cwd=process.cwd(),home:UserStateInput=homedir()):Promise<string>{
  const target=await resolveLocalBundleTarget(dir,cwd);
  assertBundleOutsidePrivateState(target.canonicalRoot,home);
  const facts=await bundleHomeAt(target.canonicalRoot,{home:typeof home==='string'?home:homedir()});
  if(facts.home==='hosted')throw refuse('hosted_local_execution_not_supported');
  if(process.platform!=='darwin'&&process.platform!=='linux')throw refuse('unsupported_supervision_platform');
  return target.canonicalRoot;
}
async function toolIdentity(file:string):Promise<Tool>{
  if(typeof file!=='string'||!path.isAbsolute(file))throw refuse('absolute_tool_required');
  const resolved=await realpath(file); const bytes=await localFileBytes(resolved,256*1024*1024);
  const magic=bytes.subarray(0,4).toString('hex');
  const native=process.platform==='linux'?magic==='7f454c46':['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic);
  if(!native)throw refuse('native_tool_binary_required');
  // Availability is deliberately probed only during explicit binding, with a finite timeout.
  const version=await probeToolVersion(resolved);
  if(await realpath(resolved)!==resolved||hash(await localFileBytes(resolved,256*1024*1024))!==hash(bytes))throw refuse('tool_changed_rebind_required');
  return {path:resolved,sha256:hash(bytes),version};
}
async function probeToolVersion(file:string):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn(file,['--version'],{detached:true,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
    let settled=false,stdout='',bytes=0,failureReason:string|undefined;
    const finish=async(reason?:string)=>{
      failureReason??=reason;if(settled)return;settled=true;clearTimeout(timer);
      const stopped=child.pid===undefined||await stopGroup(child.pid,300);
      child.stdout.destroy();child.stderr.destroy();child.unref();
      if(!stopped)reject(refuse('tool_probe_interrupted_unconfirmed'));else if(failureReason)reject(refuse(failureReason));else resolve(stdout.trim().slice(0,1024));
    };
    const timer=setTimeout(()=>void finish('tool_probe_timed_out'),5000);
    const capture=(chunk:Buffer,isStdout:boolean)=>{bytes+=chunk.length;if(bytes>4096){void finish('tool_probe_log_limit');return;}if(isStdout)stdout+=chunk.toString();};
    child.stdout.on('data',chunk=>capture(chunk,true));child.stderr.on('data',chunk=>capture(chunk,false));
    child.once('error',()=>void finish('tool_probe_failed'));
    child.once('exit',(code)=>void finish(code===0?undefined:'tool_probe_failed'));
  });
}

export async function bindLocalOperation(operation:string,bundle:string,config:LocalBindingConfig,accept?:string,home:UserStateInput=homedir()):Promise<unknown>{
  if(await localBundle(bundle,process.cwd(),home)!==bundle)throw refuse('canonical_bundle_required');
  const selection=await selectLocalOperation(operation,home);
  if(!selection)throw refuse("unknown_local_operation");
  if(!record(config)||!record(config.resources)||!record(config.tools)||!Object.hasOwn(LOCAL_OPERATION_PROFILES,config.profile))throw refuse('binding_config');
  const profile=LOCAL_OPERATION_PROFILES[config.profile];
  if(Object.keys(config.resources).length===0||Object.keys(config.resources).length>profile.files||Object.keys(config.tools).length>8)throw refuse('binding_count');
  const resources:Record<string,Resource>={},tools:Record<string,Tool>={},expectedInputs:Record<string,string>={}; let total=0;
  for(const [role,value] of Object.entries(config.resources)){
    if(!key.test(role)||!record(value)||typeof value.path!=='string'||!path.isAbsolute(value.path)||typeof value.logicalRef!=='string'||!value.logicalRef||value.logicalRef.length>256||path.isAbsolute(value.logicalRef))throw refuse('resource_selection');
    assertPathOutsidePrivateState(value.path,home); const selected=await realpath(value.path);
    const bytes=await localFileBytes(selected,profile.inputBytes-total);total+=bytes.length;
    resources[role]={path:selected,logicalRef:value.logicalRef};expectedInputs[role]=hash(bytes);
  }
  for(const [handle,file]of Object.entries(config.tools)){if(typeof file!=='string')throw refuse('tool_selection');if(!key.test(handle))throw refuse('tool_handle');assertPathOutsidePrivateState(file,home);tools[handle]=await toolIdentity(file);}
  const outputRoot=await ordinaryDirectory(config.outputRoot,home,bundle),rootStatus=await lstat(outputRoot);
  const binding:Binding={v:1,bundle,operation,pluginDigest:selection.digest,generation:selection.generation,capability:selection.capability,resources,tools,outputRoot,outputRootIdentity:{dev:rootStatus.dev,ino:rootStatus.ino},profile:config.profile};
  const digest=hash(canonicalJson(binding));
  if(accept===undefined)return {status:'preview',digest,operation,profile:config.profile,expectedInputs,resources:Object.keys(resources),tools:Object.fromEntries(Object.entries(tools).map(([name,t])=>[name,{sha256:t.sha256,version:t.version}])),effects:['trusted code with ambient authority; no OS sandbox','copies selected inputs; creates private local files; consumes compute','supported adapter makes no network requests; network is not sandboxed','HTML export is separate from Artifact publication'],next:`superbee op bind ${commandToken(operation)} --local --resources-file <same-file> --accept ${commandToken(digest)} --dir <same-bundle>`};
  if(accept!==digest)throw refuse('binding_acceptance_changed');
  const id=randomUUID();await writeUserStateFileAtomic0600(home,path.join(canonicalUserStateDir(home),'local-operation-bindings'),`${id}.json`,JSON.stringify(binding));
  return {status:'bound',binding:id,digest,operation,expectedInputs,next:`superbee op run ${commandToken(operation)} --local --binding ${commandToken(id)} --input-file <run-input.json> --dir <same-bundle>`};
}
export interface LocalRunInput {expectedInputs:Record<string,string>;settings:Record<string,unknown>;}
export interface LocalRunOptions {home?:UserStateInput;signal?:AbortSignal;exportHtml?:string;}

async function outputBudget(directory:string,maximumBytes:number,maximumFiles:number):Promise<boolean>{
  let bytes=0,count=0;
  const scan=async(dir:string):Promise<boolean>=>{
    const entries=await readdir(dir,{withFileTypes:true});
    for(const entry of entries){
      if(++count>maximumFiles*2)return false;
      const file=path.join(dir,entry.name),status=await lstat(file);
      if(status.isSymbolicLink()||(!status.isFile()&&!status.isDirectory()))return false;
      if(status.isDirectory()){if(!await scan(file))return false;}
      else{bytes+=status.size;if(bytes>maximumBytes)return false;}
    }
    return true;
  };
  return scan(directory);
}

async function groupPresent(pid:number):Promise<boolean>{try{process.kill(-pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;return true;}}
async function stopGroup(pid:number,grace:number):Promise<boolean>{
  try{process.kill(-pid,'SIGTERM');}catch{}
  await new Promise(resolve=>setTimeout(resolve,grace));
  try{process.kill(-pid,'SIGKILL');}catch{}
  for(let i=0;i<20;i++){if(!await groupPresent(pid))return true;await new Promise(resolve=>setTimeout(resolve,25));}
  return false;
}

export async function runLocalOperation(operation:string,bundle:string,bindingId:string,input:LocalRunInput,options:LocalRunOptions={}):Promise<any>{
  const home=options.home??homedir();
  if(!/^[0-9a-f-]{36}$/.test(bindingId))throw refuse('binding_id');
  const binding=JSON.parse(await readUserStateFile(home,path.join(canonicalUserStateDir(home),'local-operation-bindings',`${bindingId}.json`),65536)) as Binding;
  if(await localBundle(bundle,process.cwd(),home)!==bundle)throw refuse('canonical_bundle_required');
  const selection=await selectLocalOperation(operation,home);
  if(!selection)throw refuse("unknown_local_operation");
  if(binding.v!==1||binding.bundle!==bundle||binding.operation!==operation||binding.pluginDigest!==selection.digest||binding.generation!==selection.generation||canonicalJson(binding.capability)!==canonicalJson(selection.capability))throw refuse('binding_changed_rebind_required');
  if(!Object.hasOwn(LOCAL_OPERATION_PROFILES,binding.profile))throw refuse('profile');const profile=LOCAL_OPERATION_PROFILES[binding.profile];
  if(!record(input)||!record(input.expectedInputs)||!record(input.settings)||Buffer.byteLength(canonicalJson(input))>65536||canonicalJson(Object.keys(input.expectedInputs).sort())!==canonicalJson(Object.keys(binding.resources).sort()))throw refuse('expected_inputs_required');
  await ordinaryDirectory(binding.outputRoot,home,bundle);
  const outputRootStatus=await lstat(binding.outputRoot);if(outputRootStatus.dev!==binding.outputRootIdentity.dev||outputRootStatus.ino!==binding.outputRootIdentity.ino)throw refuse("output_root_changed_rebind_required");
  for(const tool of Object.values(binding.tools)){assertPathOutsidePrivateState(tool.path,home);if(await realpath(tool.path)!==tool.path)throw refuse('tool_changed_rebind_required');if(hash(await localFileBytes(tool.path,256*1024*1024))!==tool.sha256)throw refuse('tool_changed_rebind_required');}
  const id=randomUUID(),state=await ensureUserStateRoot(home),area=path.join(state,'local-operation-runs');
  await mkdir(area,{mode:0o700,recursive:true});const areaStatus=await lstat(area);if(!areaStatus.isDirectory()||areaStatus.isSymbolicLink()||(areaStatus.mode&0o077)!==0)throw refuse('private_run_area');
  const workspace=path.join(area,id);await mkdir(workspace,{mode:0o700});
  const inputsDirectory=path.join(workspace,'inputs'),outputDirectory=path.join(workspace,'outputs');await mkdir(inputsDirectory,{mode:0o700});await mkdir(outputDirectory,{mode:0o700});
  const resources:Record<string,Resource&{sha256:string}>={},inputs:any[]=[];let inputBytes=0;
  for(const [role,resource]of Object.entries(binding.resources)){
    assertPathOutsidePrivateState(resource.path,home);if(await realpath(resource.path)!==resource.path)throw refuse('resource_selection_changed_rebind_required');
    const bytes=await localFileBytes(resource.path,profile.inputBytes-inputBytes);inputBytes+=bytes.length;const sha256=hash(bytes);
    if(input.expectedInputs[role]!==sha256)throw refuse('input_hash_changed');
    const captured=path.join(inputsDirectory,role+path.extname(resource.path));await writeFile(captured,bytes,{mode:0o400,flag:'wx'});
    resources[role]={path:captured,logicalRef:resource.logicalRef,sha256};inputs.push({role,logicalRef:resource.logicalRef,sha256,bytes:bytes.length});
  }
  const manifest:any={version:1,invocationId:id,operation,implementationId:selection.capability.implementationId,plugin:{digest:selection.digest,generation:selection.generation,assets:selection.assets},inputs,settingsDigest:hash(canonicalJson(input.settings)),tools:Object.fromEntries(Object.entries(binding.tools).map(([name,t])=>[name,{sha256:t.sha256,version:t.version}])),profile:binding.profile,platform:{os:process.platform,arch:process.arch,node:process.version},startedAt:new Date().toISOString(),status:'interrupted_unconfirmed',reason:'parent_outcome_unknown',outputs:[],publication:'not_attempted'};
  const manifestPath=path.join(workspace,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
  const maximumOutputBytes=Math.min(selection.capability.maximumOutputBytes??DEFAULT_MAXIMUM_OUTPUT_BYTES,DEFAULT_MAXIMUM_OUTPUT_BYTES);
  const child=spawn(process.execPath,['--input-type=module','--eval',`(${localOperationChild.toString()})(${boundedLocalFileBytes.toString()})`],{detached:true,env:{PATH:'/usr/bin:/bin'},cwd:workspace,stdio:['ignore','pipe','pipe','ipc']});
  let reason:string|undefined,result:any,closed=false,logBytes=0;const chunks:Buffer[]=[];
  const terminate=(why:string)=>{if(reason!==undefined)return;reason=why;if(child.connected)child.send({type:'abort'},()=>{});};
  const capture=(chunk:Buffer)=>{logBytes+=chunk.length;if(logBytes>profile.logBytes){terminate('log_limit');return;}chunks.push(chunk);};child.stdout!.on('data',capture);child.stderr!.on('data',capture);
  let checking=false;const budget=setInterval(()=>{if(checking)return;checking=true;void outputBudget(outputDirectory,profile.outputBytes,profile.files).then(ok=>{if(!ok)terminate('output_limit');}).catch(()=>terminate('output_validation')).finally(()=>{checking=false;});},50);
  const deadline=setTimeout(()=>terminate('deadline'),profile.deadlineMs);const abort=()=>terminate('cancelled');options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  await new Promise<void>(resolve=>{
    const poll=setInterval(()=>{if(reason){clearInterval(poll);resolve();}},10);
    child.on('error',()=>{terminate('child_fault');clearInterval(poll);resolve();});child.on('exit',(code)=>{closed=true;if(result===undefined||code!==0)terminate('child_exit');clearInterval(poll);resolve();});
    child.on('message',(message:any)=>{
      try {
      if(!record(message))return terminate('protocol');
      if(message.type==='ready'){
        const descriptors=message.descriptors;
        if(!Array.isArray(descriptors)||Buffer.byteLength(JSON.stringify(descriptors))>DEFAULT_MAXIMUM_OUTPUT_BYTES||canonicalJson(descriptors)!==canonicalJson(selection.capabilities))return terminate('descriptor_changed');
        child.send({type:'execute'});
      }else if(message.type==='result'){if(result!==undefined||Buffer.byteLength(JSON.stringify(message.result))>maximumOutputBytes)return terminate('result_limit');result=message.result;}
      else if(message.type==='tool_identity_changed'&&typeof message.tool==='string'&&Object.hasOwn(binding.tools,message.tool)){manifest.toolIdentityChanged=[...new Set([...(manifest.toolIdentityChanged??[]),message.tool])];terminate('tool_identity_changed');}
      else if(message.type==='overflow')terminate('log_limit');else terminate('child_fault');
      } catch { terminate('protocol'); }
    });
    child.send({type:'initialize',entryPath:selection.entryPath,capabilityName:selection.capability.name,maximumOutputBytes,protocolBytes:DEFAULT_MAXIMUM_OUTPUT_BYTES,tools:binding.tools,resources,profile,invocation:{id,outputDirectory,assetDirectory:selection.rootPath,profile:binding.profile},input:input.settings});
  });
  clearTimeout(deadline);clearInterval(budget);options.signal?.removeEventListener('abort',abort);
  // Even a successful adapter may have left a tool alive; never declare success before the group stops.
  const stopped=child.pid!==undefined ? await stopGroup(child.pid,profile.graceMs):closed;
  for(const [tool,identity]of Object.entries(binding.tools)){try{if(await realpath(identity.path)!==identity.path||hash(await localFileBytes(identity.path,256*1024*1024))!==identity.sha256)throw Error();}catch{manifest.toolIdentityChanged=[...new Set([...(manifest.toolIdentityChanged??[]),tool])];reason='tool_identity_changed';}}
  manifest.endedAt=new Date().toISOString();
  manifest.status=!stopped?'interrupted_unconfirmed':reason==='cancelled'?'cancelled_confirmed':reason==='deadline'?'timed_out_confirmed':reason?'failed':'succeeded';
  manifest.reason=!stopped?'descendants_unconfirmed':reason??'completed';
  manifest.partialOutputState='retained_unvalidated';
  await writeFile(path.join(workspace,'host.log'),Buffer.concat(chunks),{mode:0o600,flag:'wx'});
  if(manifest.status==='succeeded'){
    try{
      if(!await outputBudget(outputDirectory,profile.outputBytes,profile.files))throw refuse('output_limit');
      if(!record(result)||!Array.isArray(result.outputs)||result.outputs.length>profile.files)throw refuse('output_contract');
      let total=0;const seen=new Set<string>();
      for(const output of result.outputs){
        if(!record(output)||!key.test(output.role)||typeof output.path!=='string'||path.isAbsolute(output.path)||output.path.includes('\\')||output.path.split('/').some((x:string)=>!x||x==='.'||x==='..')||typeof output.mimeType!=='string'||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(output.mimeType)||seen.has(output.path))throw refuse('output_contract');
        seen.add(output.path);const file=path.join(outputDirectory,output.path);
        if(await realpath(file)!==file)throw refuse('output_escape');
        const bytes=await localFileBytes(file,profile.outputBytes-total);total+=bytes.length;
        manifest.outputs.push({role:output.role,path:output.path,mimeType:output.mimeType,bytes:bytes.length,sha256:hash(bytes)});
      }
      const all=await readdir(outputDirectory,{recursive:true,withFileTypes:true});
      if(all.length>profile.files*2||all.some(entry=>entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile())))throw refuse('output_tree');
      for(const entry of all)if(entry.isFile()&&!seen.has(path.relative(outputDirectory,path.join(entry.parentPath,entry.name))))throw refuse('undeclared_output');
      manifest.settings=result.settings??input.settings;manifest.partialOutputState='validated';
    }catch{manifest.status='failed';manifest.reason='output_validation';manifest.outputs=[];}
  }
  let exportPath:string|undefined;
  if(options.exportHtml!==undefined){
    manifest.export={status:'not_attempted'};
    if(manifest.status==='succeeded')try{
      const target=path.resolve(options.exportHtml);assertPathOutsidePrivateState(target,home);
      const outputRootNow=await lstat(binding.outputRoot);if(outputRootNow.dev!==binding.outputRootIdentity.dev||outputRootNow.ino!==binding.outputRootIdentity.ino)throw refuse("output_root_changed_rebind_required");
      if(!within(binding.outputRoot,target)||await realpath(path.dirname(target))!==path.dirname(target)||target===bundle||within(bundle,target))throw refuse('export_destination');
      const html=manifest.outputs.filter((row:any)=>row.mimeType==='text/html');if(html.length!==1)throw refuse('export_html_count');
      const bytes=await localFileBytes(path.join(outputDirectory,html[0].path),profile.outputBytes);
      if(hash(bytes)!==html[0].sha256)throw refuse('export_source_changed');
      await writeFile(target,bytes,{mode:0o600,flag:'wx'});exportPath=target;manifest.export={status:'exported',relativePath:path.relative(binding.outputRoot,target),sha256:hash(bytes)};
    }catch{manifest.export={status:'failed',reason:'export_refused_or_failed'};}
  }
  await writeFile(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
  return {invocationId:id,status:manifest.status,reason:manifest.reason,manifest:manifestPath,outputs:manifest.outputs,export:manifest.export===undefined?undefined:{...manifest.export,...(exportPath?{path:exportPath}:{})},publication:'not_attempted'};
}
