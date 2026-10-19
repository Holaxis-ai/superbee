/** One lock and one atomic envelope own binding, observation and accepted tuple publication. */
import { PRIVATE_STATE_MAX_RECORD_BYTES } from "@superbee/board-git";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSourceState, isSourceOverlaySnapshot, MachineStateConflict, type MachineState, type SourceState, type SourceOverlaySnapshot } from "@superbee/core/source-engine";
import { CliError } from "../errors.js";
import { withCliFilesystemMutationLock } from "../filesystem-runtime.js";
import { canonicalUserStateDir, ensureUserStateRoot, readUserStateFile, writeReadyUserStateFileAtomic0600, type UserStateInput } from "../user-state.js";
export const SOURCE_STATE_MAX_BYTES = PRIVATE_STATE_MAX_RECORD_BYTES;
export function sourceCanonical(v: unknown): unknown {
    if (v instanceof RegExp) return {regexp:v.source,flags:v.flags};
    if (v instanceof Set) return [...v].sort();
    if (Array.isArray(v)) return v.map(sourceCanonical);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).filter(([,x])=>x!==undefined).map(([k,x])=>[k,sourceCanonical(x)]));
    return v;
}
export function sourceDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sourceCanonical(value))).digest("hex")}`;
}
export interface SourceBinding { v:1; root:string; feed:string; digest:string; consent:Record<string,unknown>; credential:{kind:"none"}|{kind:"env";name:string} }
export interface SourceEnvelope { product:"superbee"; schema_version:1; v:1; binding:SourceBinding; version:number; observation:SourceState|null; accepted:SourceOverlaySnapshot; summary?:Record<string,unknown> }
export const emptyAccepted = (): SourceOverlaySnapshot => ({v:1,entries:[]});
export const sourceStateFile = (root:string,feed:string):string => `source-${sourceDigest([root,feed]).slice(7)}.json`;
export function sourceRefusal(reason:string, code:"USAGE"|"RUNTIME"|"CONFLICT"="USAGE"): CliError {
  return new CliError(code, `Local source operation refused (${reason}).`, {details:{reason}});
}
export async function readSourceEnvelope(file:string,input:UserStateInput=homedir()):Promise<SourceEnvelope|null> {
  try {
    const raw = await readUserStateFile(input,join(canonicalUserStateDir(input),file),SOURCE_STATE_MAX_BYTES);
    const e = JSON.parse(raw) as SourceEnvelope;
    if (e?.product!=="superbee" || e.schema_version!==1 || e.v!==1 || !Number.isSafeInteger(e.version) || e.version<0 || e.binding?.v!==1 || typeof e.binding.root!=="string" || typeof e.binding.feed!=="string" || typeof e.binding.digest!=="string" || !e.binding.consent || typeof e.binding.consent!=="object" || !["none","env"].includes(e.binding.credential?.kind) || e.binding.credential.kind==="env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.binding.credential.name) || !isSourceOverlaySnapshot(e.accepted) || e.observation!==null && !isSourceState(e.observation)) throw new Error();
    if (sourceDigest(e.binding.consent)!==e.binding.digest || sourceStateFile(e.binding.root,e.binding.feed)!==file) throw new Error();
    return e;
  } catch(e) { if ((e as NodeJS.ErrnoException).code==="ENOENT") return null; throw sourceRefusal("state_invalid"); }
}
export async function writeSourceEnvelope(file:string,e:SourceEnvelope,input:UserStateInput=homedir()):Promise<void> {
  const raw = JSON.stringify(e)+"\n";
  if (Buffer.byteLength(raw)>SOURCE_STATE_MAX_BYTES) throw sourceRefusal("state_too_large");
  try { await writeReadyUserStateFileAtomic0600(input,file,raw); } catch { throw sourceRefusal("state_persist_failed","RUNTIME"); }
}
export async function withSourceState<T>(root:string,feed:string,body:(file:string)=>Promise<T>,input:UserStateInput=homedir(),lockRoot?:string):Promise<T> {
  await ensureUserStateRoot(input);
  const file = sourceStateFile(root,feed);
  try { return await withCliFilesystemMutationLock(join(canonicalUserStateDir(input),file),()=>body(file),{portableRoot:root,waitMs:0,...(lockRoot?{lockRoot}:{})}); }
  catch(e) { if ((e as Error).name==="FilesystemMutationLockError") throw sourceRefusal("source_busy","CONFLICT"); throw e; }
}
export interface AcceptedStage { snapshot():SourceOverlaySnapshot; stagedSnapshot():SourceOverlaySnapshot|null; consume():void; discard():void }
/** Only a post-commit state write may consume a staged adapter result. */
export function sourceMachineState(file:string,envelope:SourceEnvelope,stage:AcceptedStage,input:UserStateInput=homedir(),publish=writeSourceEnvelope):MachineState & {publishReconcile():Promise<void>; beginCommit():void} {
  let commitStaged = false;
  const persist = async (next:SourceState|null,expected:string|null,reconcile=false):Promise<string> => {
    const current = await readSourceEnvelope(file,input);
    if (!current || current.version!==envelope.version || (envelope.observation ? String(envelope.version):null)!==expected) {stage.discard(); throw new MachineStateConflict(envelope.binding.feed);}
    const staged = stage.stagedSnapshot();
    if (staged && !commitStaged && !reconcile) {stage.discard(); throw sourceRefusal("acceptance_order","RUNTIME");}
    const candidate:SourceEnvelope = {...envelope,version:envelope.version+1,observation:next,accepted:staged??stage.snapshot()};
    try { await publish(file,candidate,input); }
    catch(e) { stage.discard(); commitStaged=false; throw e; }
    Object.assign(envelope,candidate); stage.consume(); commitStaged=false;
    return String(envelope.version);
  };
  return { async read(key) { if(key!==envelope.binding.feed) throw sourceRefusal("state_key"); return envelope.observation ? {state:structuredClone(envelope.observation),version:String(envelope.version)}:null; },
    async write(key,state,expected) {if(key!==envelope.binding.feed) throw sourceRefusal("state_key"); return persist(state,expected);},
    async publishReconcile() {await persist(envelope.observation,envelope.observation?String(envelope.version):null,true);},
    beginCommit() {commitStaged=true;},
  };
}
