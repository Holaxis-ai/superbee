import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { loadKinds, readBundleOkfVersion, readDoc } from "@superbee/core";
import { AUTH_PROVIDER_REQUEST_RULES, bindSourceFeed, connectorPinDigest, credentialHosts, parseConnectorDoc, renderRequestValue } from "@superbee/core/connectors";
import { buildSourceIndex } from "@superbee/core/record-overlay";
import { createSourceOverlayAdapter, DEFAULT_SOURCE_BUDGET, fetchIdentity, observeSource, type Transport } from "@superbee/core/source-engine";
import { getSourceProfile } from "@superbee/core/source-profiles";
import { openBundle } from "../bundle.js";
import { bindingForPath } from "../hosted/binding.js";
import { assertPathOutsidePrivateState } from "../private-state-bundle-boundary.js";
import { assertActorAcceptedByBundle, resolveActor } from "../actor.js";
import type { UserStateInput } from "../user-state.js";
import { nodeSourceTransport } from "./transport.js";
import { emptyAccepted, readSourceEnvelope, sourceCanonical, sourceDigest, sourceMachineState, sourceRefusal, withSourceState, writeSourceEnvelope, type SourceBinding, type SourceEnvelope } from "./state.js";
// Only fixed engine-owned codes may cross the public receipt boundary.
const PUBLIC_SOURCE_REASONS = new Set([
  "profile_invalid", "profile_mismatch", "mode_invalid", "declaration_invalid", "binding_invalid",
  "budget_invalid", "statuses_invalid", "identity_invalid", "spec_invalid", "profile_error",
  "hosts_invalid", "hosts_undeclared", "declaration_required", "state_invalid", "state_unreadable",
  "state_conflict", "state_unwritable", "deadline", "budget", "page_invalid", "cursor_stuck",
  "commit_failed", "not_modified", "rate_limited", "server_error", "status", "scheme_refused",
  "address_refused", "host_refused", "redirect_refused", "bot_challenge", "robots_unavailable",
  "robots_disallowed", "header_refused", "run_ended", "url_invalid", "method_refused",
  "body_refused", "request_invalid", "url_refused", "timeout", "transport", "redirect_invalid",
  "redirect_limit", "graphql_scope_unsupported",
]);
export function publicSourceReason(reason: unknown): string | undefined {
  return reason === undefined ? undefined : typeof reason === "string" && PUBLIC_SOURCE_REASONS.has(reason) ? reason : "unclassified";
}
export interface LocalSourceOptions { dir?:string; anonymous?:boolean; credentialEnv?:string; accept?:string; complete?:boolean; actor?:string }
export interface LocalSourceDeps { stateInput?:UserStateInput; lockRoot?:string; env?:NodeJS.ProcessEnv; transport?:Transport }
async function context(feedId:string,dir?:string) {
  const bundle = await openBundle(dir);
  const root = await realpath(bundle.root);
  assertPathOutsidePrivateState(root);
  if(await bindingForPath(homedir(),root)) throw sourceRefusal("hosted_target_unsupported");
  const [registry,edition,feed] = await Promise.all([loadKinds(bundle),readBundleOkfVersion(bundle),readDoc(bundle,feedId)]);
  if(feed.frontmatter.type!=="Source Feed" || typeof feed.frontmatter.connector!=="string") throw sourceRefusal("feed_invalid");
  const parsed = parseConnectorDoc(await readDoc(bundle,feed.frontmatter.connector),{kinds:registry});
  if(!parsed.ok) throw sourceRefusal("declaration_invalid");
  const bound = bindSourceFeed(parsed.connector,feed,registry,{okfVersion:edition==="0.2"?"0.2":"0.1"});
  const profile = getSourceProfile(bound.source.profile);
  if(!profile) throw sourceRefusal("profile_unsupported");
  const spec = profile.validateSpec(bound.source);
  if(!spec.ok) throw sourceRefusal("profile_spec_invalid");
  return {bundle,root,registry,okfVersion:edition==="0.2"?"0.2" as const:"0.1" as const,connector:parsed.connector,bound,profile,spec:spec.spec};
}
function binding(c:Awaited<ReturnType<typeof context>>,credential:SourceBinding["credential"]):SourceBinding {
  const consent = sourceCanonical({v:1,root:c.root,feed:c.bound.policy.feed,connector:c.connector.id,pin:connectorPinDigest(c.connector),resource:c.bound.resource,parameters:c.bound.parameters,
    policy:c.bound.policy,kind:c.bound.kind,profile:{id:c.profile.id,version:c.profile.version},credential,budget:DEFAULT_SOURCE_BUDGET,
    providerRules:AUTH_PROVIDER_REQUEST_RULES[c.connector.auth.kind==="github-app"?"github":c.connector.auth.provider??""]??null}) as Record<string,unknown>;
  return {v:1,root:c.root,feed:c.bound.policy.feed,consent,digest:sourceDigest(consent),credential};
}
export async function bindLocalSource(feed:string,options:LocalSourceOptions,deps:LocalSourceDeps={}):Promise<Record<string,unknown>> {
  if(options.anonymous===!!options.credentialEnv || !options.anonymous && !options.credentialEnv || options.credentialEnv!==undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.credentialEnv)) throw sourceRefusal("credential_reference_invalid");
  const credential:SourceBinding["credential"] = options.credentialEnv?{kind:"env",name:options.credentialEnv}:{kind:"none"};
  const c = await context(feed,options.dir);
  const b = binding(c,credential);
  const preview = {operation:"source bind",feed,digest:b.digest,accepted:false,resource:c.bound.resource,profile:{id:c.profile.id,version:c.profile.version},auth:credential,
    method:c.bound.source.request?.method??"GET",path:c.bound.source.request?renderRequestValue(c.bound.source.request.path,c.bound.parameters,{}):null,hosts:c.profile.hostsFor(c.spec,c.bound),owned_fields:c.bound.policy.owned_fields,budget:DEFAULT_SOURCE_BUDGET};
  if(!options.accept) return preview;
  return withSourceState(c.root,feed,async file=>{
    const fresh = binding(await context(feed,options.dir),credential);
    if(fresh.digest!==options.accept || fresh.digest!==b.digest) throw sourceRefusal("binding_changed","CONFLICT");
    const current = await readSourceEnvelope(file,deps.stateInput);
    if(current?.binding.digest!==fresh.digest) await writeSourceEnvelope(file,{product:"superbee",schema_version:1,v:1,binding:fresh,version:(current?.version??0)+1,observation:null,accepted:emptyAccepted()},deps.stateInput);
    return {...preview,accepted:true};
  },deps.stateInput,deps.lockRoot);
}
export async function runLocalSource(feed:string,options:LocalSourceOptions,deps:LocalSourceDeps={}):Promise<Record<string,unknown>> {
  const c = await context(feed,options.dir);
  const actor = resolveActor(options.actor)??"process:superbee";
  await assertActorAcceptedByBundle(c.bundle,actor);
  return withSourceState(c.root,feed,async file=>{
    const envelope = await readSourceEnvelope(file,deps.stateInput);
    if(!envelope) throw sourceRefusal("binding_missing");
    const fresh = await context(feed,options.dir);
    const currentBinding = binding(fresh,envelope.binding.credential);
    if(currentBinding.digest!==envelope.binding.digest) throw sourceRefusal("binding_changed","CONFLICT");
    let credential: {hosts:readonly string[];header:string;value:string}|undefined;
    if(envelope.binding.credential.kind==="env") {
      if(!(fresh.connector.auth.kind==="github-app" || fresh.connector.auth.kind==="token" && fresh.connector.auth.provider==="github")) throw sourceRefusal("credential_kind_unsupported");
      const token = (deps.env??process.env)[envelope.binding.credential.name];
      if(typeof token!=="string" || !/^[\x21-\x7e]{1,8192}$/.test(token)) throw sourceRefusal("credential_missing");
      credential = {hosts:credentialHosts(fresh.connector.auth),header:"authorization",value:`Bearer ${token}`};
    }
    const overlays = await buildSourceIndex(fresh.bundle,{type:fresh.bound.kind.governs});
    const content = {bundle:fresh.bundle,registry:fresh.registry,okfVersion:fresh.okfVersion};
    const adapter = createSourceOverlayAdapter({content,policy:fresh.bound.policy,actor,overlays,accepted:envelope.accepted,sameBundle:true});
    const state = sourceMachineState(file,envelope,adapter,deps.stateInput);
    if(envelope.observation) {await adapter.reconcile(envelope.observation,new Date().toISOString()); await state.publishReconcile();}
    let persistFailed = false;
    const trackedState = {read:state.read, async write(...args:Parameters<typeof state.write>) {try{return await state.write(...args);}catch(e){persistFailed=true;throw e;}}};
    const receipt = await observeSource({connector:fresh.connector,bound:fresh.bound,profile:fresh.profile,spec:fresh.spec,state:trackedState,
      transport:deps.transport??nodeSourceTransport({credential}),identity:fetchIdentity("Superbee/1 (+https://github.com/Holaxis-ai/superbee)")!,mode:options.complete?"complete":"incremental",
      commit:async page=>{const result=await adapter.commit(page);state.beginCommit();return result;},
    });
    if(persistFailed) throw sourceRefusal("state_persist_failed","RUNTIME");
    adapter.discard();
    const findingResult = await adapter.applyFindings(receipt.findings,receipt.observed_at);
    // Deliberately allowlist values: raw cursor, diagnostics, provider text and thrown details are private.
    const summary = {operation:"source run",feed,digest:currentBinding.digest,profile:receipt.profile,outcome:receipt.outcome,...(receipt.reason===undefined?{}:{reason:publicSourceReason(receipt.reason)}),retry:receipt.retry,pages:receipt.pages,held:receipt.held,pending:receipt.pending,changes:receipt.changes,pass:receipt.pass,
      requests:receipt.requests.map(r=>({method:r.method,purpose:r.purpose,...(r.status?{status:r.status}:{})})),diagnostic_count:receipt.diagnostics.length,finding_count:receipt.findings.length,finding_refusals:findingResult.refusals.length+findingResult.results.filter(r=>r.outcome==="refused").length};
    await writeSourceEnvelope(file,{...envelope,summary} satisfies SourceEnvelope,deps.stateInput);
    return summary;
  },deps.stateInput,deps.lockRoot);
}
