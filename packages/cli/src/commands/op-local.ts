import { parseArgs } from 'node:util';
import path from 'node:path';
import { homedir } from 'node:os';
import { CliError } from '../errors.js';
import { readExternalTextFileWithin } from '../external-file.js';
import { render, resolveMode } from '../output.js';
import { localBundle, bindLocalOperation, runLocalOperation, type LocalBindingConfig, type LocalRunInput } from '../local-operation.js';
import { registerOperationPlugin, listOperationPlugins, removeOperationPlugin } from '../operation-plugins.js';
import { OP_USAGE, type OpDeps } from './op.js';
import { CLI_LEAVES } from '../command-spec.js';
import { parseLeafOrUsage } from '../args.js';
import { renderUsage } from '../output.js';
import { commandToken } from '../command-text.js';

export async function localOp(argv:string[],deps:Partial<OpDeps>&Pick<OpDeps,'stdout'>):Promise<void>{
  const sub=argv[0];
  const leaf=({register:CLI_LEAVES.opRegister,registered:CLI_LEAVES.opRegistered,unregister:CLI_LEAVES.opUnregister,bind:CLI_LEAVES.opBind,list:CLI_LEAVES.opList,run:CLI_LEAVES.opRun} as const)[sub as 'register'];
  if(!leaf)throw new CliError('USAGE','Unknown local operation command.');
  const options:Record<string,{type:'boolean'|'string';short?:string}>={local:{type:'boolean'},dir:{type:'string'},json:{type:'boolean'},help:{type:'boolean',short:'h'}};
  if(sub==='register'||sub==='bind')options.accept={type:'string'};
  if(sub==='bind')options['resources-file']={type:'string'};
  if(sub==='run'){options.binding={type:'string'};options['input-file']={type:'string'};options['export-html']={type:'string'};}
  const {values,positionals}=parseLeafOrUsage(()=>parseArgs({args:argv.slice(1),options,allowPositionals:true}),leaf);
  if(values.help){deps.stdout(renderUsage(OP_USAGE));return;}
  const cwd=deps.cwd??process.cwd(),home=deps.hosted?.auth?.home??homedir();
  if(values.local!==true)throw new CliError('USAGE','Local operation registration and binding require --local.');
  if(!['register','registered','unregister','list','bind','run'].includes(sub??''))throw new CliError('USAGE','Unknown local operation command.');
  const bundle=await localBundle(values.dir as string|undefined,cwd,home);const subject=positionals[0]!;
  const jsonFile=async(flag:string)=>{
    const selected=values[flag];if(typeof selected!=='string')throw new CliError('USAGE',`--${flag} is required.`);
    const text=await readExternalTextFileWithin(path.resolve(cwd,selected),65536,home);if(text===null)throw new CliError('USAGE',`--${flag} exceeds 64 KiB.`);
    try{return JSON.parse(text);}catch{throw new CliError('USAGE',`--${flag} must contain JSON.`);}
  };
  let result:unknown;
  if(sub==='register')result=await registerOperationPlugin(path.resolve(cwd,subject),values.accept as string|undefined,home);
  else if(sub==='registered'||sub==='list')result=await listOperationPlugins(home);
  else if(sub==='unregister')result=await removeOperationPlugin(subject,home);
  else if(sub==='bind')result=await bindLocalOperation(subject,bundle,await jsonFile('resources-file') as LocalBindingConfig,values.accept as string|undefined,home);
  else {
    if(typeof values.binding!=='string')throw new CliError('USAGE','--binding is required.');
    const controller=new AbortController();const abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
    try{result=await runLocalOperation(subject,bundle,values.binding,await jsonFile('input-file') as LocalRunInput,{home,signal:controller.signal,...(typeof values['export-html']==='string'?{exportHtml:path.resolve(cwd,values['export-html'])}:{})});}
    finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
  }
  if(typeof result==='object'&&result!==null){
    const receipt=result as Record<string,unknown>;
    if(sub==='register'&&receipt.accepted===false)receipt.next=`superbee op register ${commandToken(path.resolve(cwd,subject))} --local --accept ${commandToken(String(receipt.digest))} --dir ${commandToken(bundle)}`;
    if(sub==='bind'&&receipt.status==='preview')receipt.next=`superbee op bind ${commandToken(subject)} --local --resources-file ${commandToken(path.resolve(cwd,String(values['resources-file'])))} --accept ${commandToken(String(receipt.digest))} --dir ${commandToken(bundle)}`;
    if(sub==='bind'&&receipt.status==='bound')receipt.next=`superbee op run ${commandToken(subject)} --local --binding ${commandToken(String(receipt.binding))} --input-file <run-input.json> --dir ${commandToken(bundle)}`;
  }
  deps.stdout(render(result,resolveMode(values)));
  if(sub==='run'&&typeof result==='object'&&result!==null){const outcome=result as Record<string,any>;if(outcome.status!=='succeeded'||outcome.export?.status==='failed')throw new CliError('RUNTIME','Local operation or requested HTML export did not succeed.',{details:outcome,handled:true});}
}
