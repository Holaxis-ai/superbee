/** Finite local data acquisition; Core owns admission, mapping, replay and overlay decisions. */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { blobVersion, loadKinds, readBundleOkfVersion, readDocVersioned } from "@superbee/core";
import { buildSourceIndex, planRecordOverlay } from "@superbee/core/record-overlay";
import { canonicalJson } from "@superbee/core/site-capabilities";
import { admitSnapshot, assessSnapshotFreshness, bindSnapshotSource, createSourceOverlayAdapter, decodeSnapshot, observeSnapshot,
  SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_RECORDS, SnapshotRefusal, SnapshotEvidenceRefusal, type SnapshotCapacityInput } from "@superbee/core/source-engine";
import { assertActorAcceptedByBundle, resolveActor } from "../actor.js";
import { findBundleRoot, openBundle } from "../bundle.js";
import { CliError } from "../errors.js";
import { bindingForPath } from "../hosted/binding.js";
import { boundedLocalFileBytes } from "../local-operation-file.js";
import { LOCAL_OPERATION_PROFILES } from "../local-operation.js";
import { assertPathOutsidePrivateState, relateToPrivateState } from "../private-state-bundle-boundary.js";
import type { UserStateInput } from "../user-state.js";
import { publicSourceReason } from "./run.js";
import { emptyAccepted, isSnapshotBinding, readSourceEnvelope, SOURCE_STATE_MAX_BYTES, sourceDigest, sourceMachineState, sourceRefusal, sourceStateFile,
  withSourceState, writeSourceEnvelope, type SourceBinding, type SourceEnvelope, type SnapshotConsent } from "./state.js";

export interface SnapshotOptions { dir?:string; accept?:string; actor?:string; snapshot?:string }
export interface SnapshotDeps { stateInput?:UserStateInput; lockRoot?:string; publish?:typeof writeSourceEnvelope }
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const SUMMARY_MAX_BYTES=16*1024;
// Explicit original models use the existing comparison profile, not the smaller snapshot bound.
export const SNAPSHOT_ORIGINAL_MAX_BYTES=LOCAL_OPERATION_PROFILES["comparison-v1"].inputBytes;
const SELECTION_MAX_BYTES=64*1024;

/** Apply the existing inode relation to both the selected store and discovered bundle aliases. */
async function guardFile(file:string,home:UserStateInput,root?:string):Promise<string> {
  const selected=resolve(file);
  try {
    assertPathOutsidePrivateState(selected,home);
    if(root && relateToPrivateState(selected,root)!=="unrelated") throw sourceRefusal("snapshot_file_selection_invalid");
    const physical=await realpath(selected).catch(()=>selected);
    assertPathOutsidePrivateState(physical,home);
    const discovered=await findBundleRoot(dirname(physical));
    if(discovered && relateToPrivateState(physical,discovered)!=="unrelated") throw sourceRefusal("snapshot_file_selection_invalid");
    return selected;
  } catch {throw sourceRefusal("snapshot_file_selection_invalid");}
}
async function selectedBytes(file:string,maximum:number,home:UserStateInput,root?:string):Promise<Buffer> {
  const selected=await guardFile(file,home,root);
  try{return await boundedLocalFileBytes(selected,maximum);}catch{throw sourceRefusal("snapshot_file_unreadable");}
}
function safeError(error:unknown):never {
  if(error instanceof SnapshotRefusal || error instanceof SnapshotEvidenceRefusal) throw sourceRefusal(error.code);
  if(error instanceof CliError) throw error;
  throw sourceRefusal("snapshot_operation_failed","RUNTIME");
}
async function context(feed:string,dir:string|undefined,home:UserStateInput) {
  const bundle=await openBundle(dir),root=await realpath(bundle.root);
  assertPathOutsidePrivateState(root,home);
  if(await bindingForPath(typeof home==="string"?home:homedir(),root)) throw sourceRefusal("hosted_target_unsupported");
  const [registry,edition,source]=await Promise.all([loadKinds(bundle),readBundleOkfVersion(bundle),readDocVersioned(bundle,feed)]);
  const okfVersion:"0.1"|"0.2"=edition==="0.2"?"0.2":"0.1";
  const bound=bindSnapshotSource(source.doc,registry,{okfVersion});
  const consent:SnapshotConsent={v:1,acquisition:"local-snapshot",root,feed,document_version:source.version,core_binding_digest:bound.bindingDigest,edition:okfVersion,
    bounds:{input_bytes:SNAPSHOT_MAX_BYTES,records:SNAPSHOT_MAX_RECORDS,envelope_bytes:SOURCE_STATE_MAX_BYTES}};
  const binding:SourceBinding={v:1,root,feed,consent,digest:sourceDigest(consent),credential:{kind:"none"}};
  return {bundle,root,registry,okfVersion,bound,binding,sourceKind:source.doc.frontmatter.type};
}
function assertBinding(current:SourceEnvelope|null,binding:SourceBinding):void {
  if(current && !isSnapshotBinding(current.binding)) throw sourceRefusal("acquisition_mismatch");
  if(current?.observation && current.binding.digest!==binding.digest) throw sourceRefusal("SNAPSHOT_BINDING_CHANGED","CONFLICT");
}
export async function bindLocalSnapshot(feed:string,options:SnapshotOptions,deps:SnapshotDeps={}):Promise<Record<string,unknown>> {
  try {
    const home=deps.stateInput??homedir(),c=await context(feed,options.dir,home);
    const current=await readSourceEnvelope(sourceStateFile(c.root,feed),home);assertBinding(current,c.binding);
    const preview={operation:"source snapshot bind",source:feed,acquisition:"local-snapshot",digest:c.binding.digest,accepted:false,resource:c.bound.resource,
      owned_fields:c.bound.policy.owned_fields,bounds:c.binding.consent.bounds};
    if(!options.accept)return preview;
    return await withSourceState(c.root,feed,async file=>{
      const fresh=await context(feed,options.dir,home),stored=await readSourceEnvelope(file,home);assertBinding(stored,fresh.binding);
      if(fresh.root!==c.root || fresh.binding.digest!==c.binding.digest || fresh.binding.digest!==options.accept)throw sourceRefusal("binding_changed","CONFLICT");
      if(stored?.binding.digest!==fresh.binding.digest) await (deps.publish??writeSourceEnvelope)(file,{product:"superbee",schema_version:1,v:1,binding:fresh.binding,
        version:(stored?.version??0)+1,observation:null,accepted:emptyAccepted()},home);
      return {...preview,accepted:true};
    },home,deps.lockRoot);
  }catch(error){return safeError(error);}
}
function capacityOverhead(envelope:SourceEnvelope):number {
  // Core budgets observation/accepted. Reserve every other existing key, maximum version growth,
  // both current and future safe summary, JSON punctuation and the writer's final newline.
  return Buffer.byteLength(JSON.stringify({...envelope,version:Number.MAX_SAFE_INTEGER,observation:null,accepted:null,summary:null}))
    +Math.max(SUMMARY_MAX_BYTES,Buffer.byteLength(JSON.stringify(envelope.summary??null)))+1;
}
async function prepared(feed:string,options:SnapshotOptions,home:UserStateInput) {
  const c=await context(feed,options.dir,home);
  const actor=resolveActor(options.actor)??"process:superbee";await assertActorAcceptedByBundle(c.bundle,actor);
  const envelope=await readSourceEnvelope(sourceStateFile(c.root,feed),home);
  if(!envelope)throw sourceRefusal("binding_missing");
  assertBinding(envelope,c.binding);
  if(envelope.binding.digest!==c.binding.digest)throw sourceRefusal("binding_changed","CONFLICT");
  if(!isSnapshotBinding(envelope.binding))throw sourceRefusal("acquisition_mismatch");
  if(!Number.isSafeInteger(envelope.version+4))throw sourceRefusal("state_version_exhausted");
  if(!options.snapshot)throw sourceRefusal("snapshot_file_required");
  const snapshot=decodeSnapshot(await selectedBytes(options.snapshot,SNAPSHOT_MAX_BYTES,home,c.root));
  const overlays=await buildSourceIndex(c.bundle,{type:c.bound.kind.governs});
  const capacity:SnapshotCapacityInput={accepted:envelope.accepted,overlays,envelopeOverheadBytes:capacityOverhead(envelope),maxEnvelopeBytes:SOURCE_STATE_MAX_BYTES};
  const previousBindingDigest=envelope.binding.consent.core_binding_digest;
  const admission=admitSnapshot({bound:c.bound,snapshot,state:envelope.observation,previousBindingDigest,capacity});
  // Validate the existing overlay prerequisites through their owner. Empty changes evaluate no
  // target effects, and the same execution index is retained for reconciliation and commits.
  try{await planRecordOverlay({content:{bundle:c.bundle,registry:c.registry,okfVersion:c.okfVersion},ops:{bundle:c.bundle,registry:c.registry,okfVersion:c.okfVersion},policy:c.bound.policy,
    changes:[],observedAt:new Date().toISOString(),overlays,sameBundle:true,signals:{feedKind:c.sourceKind}});}catch{throw sourceRefusal("snapshot_overlay_policy_invalid");}
  const digest=sourceDigest({v:1,acquisition:"local-snapshot",binding:c.binding.digest,snapshot:snapshot.sha256,state_version:envelope.version,actor});
  return {c,actor,envelope,snapshot,overlays,capacity,previousBindingDigest,admission,digest};
}
export async function runLocalSnapshot(feed:string,options:SnapshotOptions,deps:SnapshotDeps={}):Promise<Record<string,unknown>> {
  try {
    const home=deps.stateInput??homedir();
    if(!options.accept){
      const p=await prepared(feed,options,home);
      return {operation:"source snapshot run",source:feed,status:"input_preview",effects_planned:false,applied:false,digest:p.digest,binding_digest:p.c.binding.digest,
        sha256:p.snapshot.sha256,resource:p.c.bound.resource,generation:p.admission.generation,current_generation:p.admission.currentGeneration,observation:p.admission.observation,
        records:p.admission.records,bytes:p.snapshot.byteLength,capacity:p.admission.capacity,owned_fields:p.c.bound.policy.owned_fields,
        policy:{auto_apply:p.c.bound.policy.auto_apply,needs_review:p.c.bound.policy.needs_review,completeness:p.c.bound.source.completeness},
        effects:"Target-document effects have not been evaluated; execution may hold conflicts."};
    }
    // Only resolve the lock identity before entry; all accepted facts and the one execution index
    // are reread under the existing root/feed lock. Preview never initializes private state.
    const first=await context(feed,options.dir,home);
    return await withSourceState(first.root,feed,async file=>{
      const p=await prepared(feed,options,home);
      if(p.c.root!==first.root || p.digest!==options.accept)throw sourceRefusal("snapshot_input_changed","CONFLICT");
      const {c,envelope,snapshot,overlays,capacity,previousBindingDigest,actor}=p;
      const adapter=createSourceOverlayAdapter({content:{bundle:c.bundle,registry:c.registry,okfVersion:c.okfVersion},policy:c.bound.policy,actor,overlays,accepted:capacity.accepted,sameBundle:true,signals:{feedKind:c.sourceKind}});
      const state=sourceMachineState(file,envelope,adapter,home,deps.publish);
      let applied=0,refused=0;
      if(envelope.observation){
        const reconciled=await adapter.reconcile(envelope.observation,new Date().toISOString());
        applied+=reconciled.receipt.results.filter(row=>row.outcome==="applied").length;
        refused+=reconciled.receipt.refusals.length+reconciled.receipt.results.filter(row=>row.outcome==="refused").length;
        try{await state.publishReconcile();}catch{throw sourceRefusal("state_persist_failed","RUNTIME");}
      }
      let persistFailed=false;
      const tracked={read:state.read,async write(...args:Parameters<typeof state.write>){try{return await state.write(...args);}catch(error){persistFailed=true;throw error;}}};
      const receipt=await observeSnapshot({bound:c.bound,snapshot,previousBindingDigest,state:tracked,capacity,commit:async page=>{
        const result=await adapter.commit(page);state.beginCommit();
        applied+=result.receipt.results.filter(row=>row.outcome==="applied").length;
        refused+=result.receipt.refusals.length+result.receipt.results.filter(row=>row.outcome==="refused").length;
        return result;
      }});
      if(persistFailed)throw sourceRefusal("state_persist_failed","RUNTIME");
      adapter.discard();
      const findings=receipt.findings.length?await adapter.applyFindings(receipt.findings,receipt.observed_at):{refusals:[],results:[]};
      const summary={operation:"source snapshot run",source:feed,status:"executed",effects_planned:false,applied:applied>0,applied_count:applied,refused_count:refused,
        digest:p.digest,binding_digest:c.binding.digest,sha256:receipt.sha256,generation:receipt.generation,observation:receipt.observation,outcome:receipt.outcome,
        ...(receipt.reason===undefined?{}:{reason:publicSourceReason(receipt.reason)}),retry:receipt.retry,pages:receipt.pages,held:receipt.held,pending:receipt.pending,changes:receipt.changes,
        pass:receipt.pass,diagnostic_count:receipt.diagnostics.length,finding_count:receipt.findings.length,
        finding_refusals:findings.refusals.length+findings.results.filter(row=>row.outcome==="refused").length};
      if(Buffer.byteLength(JSON.stringify(summary))>SUMMARY_MAX_BYTES)throw sourceRefusal("summary_too_large","RUNTIME");
      await (deps.publish??writeSourceEnvelope)(file,{...envelope,summary},home);
      return summary;
    },home,deps.lockRoot);
  }catch(error){return safeError(error);}
}

export interface SnapshotCheckOptions {inputsFile:string;settingsFile?:string}
function selectionMap(value:unknown):Record<string,string> {
  if(!object(value)||Object.keys(value).length>64||!Object.entries(value).every(([id,file])=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)&&typeof file==="string"&&file.length>0&&file.length<=4096))throw sourceRefusal("snapshot_selection_invalid");
  return Object.fromEntries(Object.entries(value).map(([id,file])=>[id,String(file)]));
}
export async function checkLocalSnapshot(file:string,options:SnapshotCheckOptions,deps:SnapshotDeps={}):Promise<Record<string,unknown>> {
  try {
    const home=deps.stateInput??homedir();
    const snapshot=decodeSnapshot(await selectedBytes(file,SNAPSHOT_MAX_BYTES,home));
    let raw:unknown;try{raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await selectedBytes(options.inputsFile,SELECTION_MAX_BYTES,home)));}catch{throw sourceRefusal("snapshot_selection_invalid");}
    if(!object(raw)||!Object.hasOwn(raw,"inputs")||!Object.keys(raw).every(k=>["inputs","required_identities"].includes(k)))throw sourceRefusal("snapshot_selection_invalid");
    const inputs=selectionMap(raw.inputs),identities=raw.required_identities===undefined?{}:selectionMap(raw.required_identities);
    // Validate every path before observing any bytes. The evidence descriptor selects no files.
    for(const selected of [...Object.values(inputs),...Object.values(identities),...(options.settingsFile?[options.settingsFile]:[])])await guardFile(selected,home);
    let total=0;
    const observe=async (map:Record<string,string>):Promise<Record<string,string|null>>=>{
      const result:Record<string,string|null>=Object.create(null);
      for(const [id,selected]of Object.entries(map)){
        try{const bytes=await selectedBytes(selected,SNAPSHOT_ORIGINAL_MAX_BYTES-total,home);total+=bytes.length;result[id]=blobVersion(bytes);}catch{result[id]=null;}
      }
      return result;
    };
    const observedInputs=await observe(inputs),observedIdentities=await observe(identities);
    let settings_digest:string|null=null;
    if(options.settingsFile)try{const bytes=await selectedBytes(options.settingsFile,SELECTION_MAX_BYTES,home);settings_digest=blobVersion(Buffer.from(canonicalJson(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)))));}catch{/* Explicit unavailable/malformed originals are unknown. */}
    return {operation:"source snapshot check",sha256:snapshot.sha256,...assessSnapshotFreshness(snapshot.data.evidence,{inputs:observedInputs,required_identities:observedIdentities,settings_digest}),
      observation:"Files were hashed now; this does not establish historical consumption.",scope:"Informational tool labels outside required_identities are outside this applicability claim.",bounds:{original_bytes:SNAPSHOT_ORIGINAL_MAX_BYTES,selection_bytes:SELECTION_MAX_BYTES}};
  }catch(error){return safeError(error);}
}
