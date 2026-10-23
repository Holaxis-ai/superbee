import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_PROVIDER_REQUEST_RULES, PROVIDER_HEADER_RULES, bindSourceFeed, connectorPinDigest, inspectSourceReadPolicy, parseConnectorDoc, validateConnectorRequest, type Connector, type ConnectorRequest, type BoundFeed } from "../src/connectors.js";
import { buildKindRegistry } from "../src/kinds.js";
import { fetchIdentity, MemoryMachineState, observeSource, type ObserveSourceOptions, type SourceProfile, type ProfileRequest } from "../src/source-engine/index.js";
import { restJsonProfile } from "../src/source-profiles/index.js";
import { peerTransport, ScriptedPeer, runSourceScenario, type PeerRequest } from "../src/source-harness/index.js";

import { SOURCE_FEED_CONVENTION, signalConvention } from "./record-overlay-helpers.js";

const registry = buildKindRegistry([{id:"conventions/issue",body:"",frontmatter:{type:"Convention",title:"Issue",governs:"Issue",path:"issues/",fields:{required:["title"]}}}], [], {okfVersion:"0.2"});
const identity = fetchIdentity("ReadPolicyTest/1 (+https://example.org/policy)")!;
function declaration(detail = false, anonymous = false): Connector {
  const request: ConnectorRequest = {host:"api.github.com",method:"GET",path:`/repos/{owner}/{repo}/pulls${detail ? "/{number}" : ""}`,items:"",complete:"always",
    headers:{accept:"application/vnd.github+json","x-github-api-version":"2026-03-10"},
    ...(detail ? {paging:{kind:"none"}} : {query:{state:"all"},paging:{kind:"page-number",page_param:"page",size_param:"per_page",size:30}}),
    read_policy:{contract:1,kind:"bound-get",bindings:{owner:"segment",repo:"segment",...(detail ? {number:"positive-integer"} : {})},
      ...(anonymous ? {} : {required_permissions:{pull_requests:"read"}}),header_provider:"github"}};
  const parsed = parseConnectorDoc({id:"connectors/pulls",body:"",frontmatter:{type:"Connector",title:"External pulls",auth:anonymous ? {kind:"none"} : {kind:"github-app",permissions:{pull_requests:"read"}},domains:anonymous ? ["api.github.com"] : [],record_sources:[{name:"pulls",profile:"rest-json",target_kind:"Issue",identity:{resource:`https://github.com/{owner}/{repo}/${detail ? "pull/{number}" : "pulls"}`,id:"{id}"},fields:{title:"title"},completeness:"complete",request}]}},{kinds:registry});
  assert.ok(parsed.ok,parsed.ok ? "" : JSON.stringify(parsed.errors));return parsed.connector;
}
function bind(c: Connector, resource = `https://github.com/octo/project/${c.sources[0]!.request!.path.endsWith("{number}") ? "pull/580" : "pulls"}`): BoundFeed {
  return bindSourceFeed(c,{id:"source-feeds/pulls",frontmatter:{type:"Source Feed",connector:c.id,source:"pulls",url:resource,owned_fields:["title"]}},registry,{okfVersion:"0.2"});
}
function oneRequest(input: ProfileRequest): SourceProfile {
  return {...restJsonProfile,async observe({transport}) {await transport.request(input);return {records:[],nextCursor:null,more:false,complete:false};}};
}
const target = "https://api.github.com/repos/octo/project/pulls?state=all&page=1&per_page=30";
const headers = () => ({accept:"application/vnd.github+json","x-github-api-version":"2026-03-10"});
async function run(c = declaration(), input?: ProfileRequest, overrides: Partial<ObserveSourceOptions> = {}) {
  const bound = bind(c),sent: PeerRequest[] = [];
  const peer = new ScriptedPeer(request => {sent.push(request);return {status:request.url.endsWith("/robots.txt") ? 404 : 200,body:"[]"};});
  const receipt = await observeSource({connector:c,bound,profile:input ? oneRequest(input) : restJsonProfile,spec:bound.source,state:new MemoryMachineState(),transport:peerTransport(peer),identity,mode:"complete",commit:async()=>{},readPolicyApproval:{contract:1,digest:inspectSourceReadPolicy(c,bound).digest},...overrides});return {receipt,sent};
}

test("explicit approved list and bound detail execute through the shared engine",async()=>{
  assert.deepEqual(AUTH_PROVIDER_REQUEST_RULES.github!.read_paths,["/repos/{owner}/{repo}/issues","/graphql"]);assert.ok(Object.isFrozen(PROVIDER_HEADER_RULES.github.headers));
  const list = await run();assert.equal(list.receipt.outcome,"observed");assert.equal(list.sent.length,1);assert.deepEqual([...new URL(list.sent[0]!.url).searchParams].sort(),[...new URL(target).searchParams].sort());
  const detail = await run(declaration(true),{url:"https://api.github.com/repos/octo/project/pulls/580",headers:headers()});assert.equal(detail.receipt.outcome,"observed");assert.equal(detail.sent.length,1);
});

test("new policies default deny before profile callbacks, state access or replay",async()=>{
  for (const readPolicyApproval of [undefined,{contract:1 as const,digest:`sha256:${"0".repeat(64)}`}]) {
    let calls=0;const fail=()=>{calls++;throw Error("must not run");};
    const {receipt,sent}=await run(declaration(),undefined,{readPolicyApproval,profile:{...restJsonProfile,validateSpec:fail,hostsFor:fail,observe:fail},state:{read:fail,write:fail},commit:fail});assert.equal(receipt.reason,"read_policy_unapproved");assert.equal(calls,0);assert.deepEqual(sent,[]);
  }
});

test("public inspector requires exact typed parameter keys and resource agreement",async()=>{
  const c=declaration(true),bound=bind(c),before=inspectSourceReadPolicy(c,bound).digest;
  for (const edit of [(b:BoundFeed)=>b.parameters.extra="x",(b:BoundFeed)=>delete b.parameters.repo,(b:BoundFeed)=>b.parameters.repo="other",(b:BoundFeed)=>b.resource=b.resource.replace("project","other"),(b:BoundFeed)=>b.parameters.number="0580",(b:BoundFeed)=>b.parameters.number="0",(b:BoundFeed)=>b.parameters.number="9007199254740992",(b:BoundFeed)=>b.parameters.owner="..",(b:BoundFeed)=>b.parameters.repo="x%2fy"]) {
    const bad=structuredClone(bound);edit(bad);assert.throws(()=>inspectSourceReadPolicy(c,bad));let accessed=0;
    const {receipt}=await run(c,undefined,{bound:bad,readPolicyApproval:{contract:1,digest:before},state:{read:async()=>{accessed++;return null;},write:async()=>{accessed++;throw Error();}}});assert.equal(receipt.reason,"binding_invalid");assert.equal(accessed,0);
  }
  for(const number of ["0","01","-1","1e2","9007199254740992"])assert.throws(()=>bind(c,`https://github.com/octo/project/pull/${number}`));
});

test("one closed declaration refuses method, header, permission and paging authority ambiguity",()=>{
  const c=declaration();
  const cases: Array<(r:any,c:Connector)=>void> = [
    r=>r.read_policy.extra=true,r=>r.read_policy.contract=2,r=>r.read_policy.bindings.extra="segment",r=>r.read_policy.bindings.repo="any",r=>r.read_policy.required_permissions.pull_requests="write",
    (_r,c)=>c.auth.permissions={},r=>delete r.read_policy.required_permissions,r=>r.method="POST",r=>r.body={},r=>r.watermark={field:"x",param:"since",overlap_seconds:0},
    r=>r.headers.authorization="Bearer anything",r=>r.headers.cookie="x",r=>r.headers["x-http-method-override"]="DELETE",r=>r.headers["x-github-api-version"]="not-a-date",r=>r.headers["x-github-api-version"]="2026-02-30",r=>r.headers.accept="Bearer abc1234567890123456789",r=>r.read_policy.header_provider="other",r=>r.host="other.example.org",
    r=>r.paging.page_param="per_page",r=>r.query.page=1,r=>r.query.per_page=30,r=>r.query.free="{page}",r=>r.query.free="{cursor}",r=>r.query.free="{watermark}",r=>r.paging={kind:"none",size:30},r=>r.paging.next_path="next",r=>r.paging.kind="link-header",r=>r.path="/repos/{repo}/{repo}/pulls",r=>r.path="/repos/{owner}/{repo}/{cursor}",
  ];
  for(const edit of cases){const changed=structuredClone(c);edit(changed.sources[0]!.request,changed);assert.ok(validateConnectorRequest(changed.sources[0]!,changed).length,edit.toString());}assert.deepEqual(validateConnectorRequest(c.sources[0]!,c),[]);
});

for(const [label,input] of [
  ["omitted version",{url:target,headers:{accept:"application/vnd.github+json"}}],["omitted accept",{url:target,headers:{"x-github-api-version":"2026-03-10"}}],
  ["changed version",{url:target,headers:{...headers(),"x-github-api-version":"2022-11-28"}}],["changed accept",{url:target,headers:{...headers(),accept:"text/html"}}],
  ["case duplicate",{url:target,headers:{...headers(),Accept:"application/vnd.github+json"}}],["undeclared",{url:target,headers:{...headers(),"x-other":"x"}}],["forbidden",{url:target,headers:{...headers(),authorization:"Bearer test"}}],
  ["missing page",{url:target.replace("&page=1",""),headers:headers()}],["missing size",{url:target.replace("&per_page=30",""),headers:headers()}],["duplicate page",{url:target+"&page=2",headers:headers()}],["duplicate size",{url:target+"&per_page=30",headers:headers()}],
  ["changed size",{url:target.replace("per_page=30","per_page=100"),headers:headers()}],["zero page",{url:target.replace("page=1&","page=0&"),headers:headers()}],["changed literal",{url:target.replace("state=all","state=open"),headers:headers()}],["undeclared query",{url:target+"&base=main",headers:headers()}],
  ["other repo",{url:target.replace("project","other"),headers:headers()}],["other owner",{url:target.replace("octo","other"),headers:headers()}],["other host",{url:target.replace("api.github.com","other.example.org"),headers:headers()}],
  ["provider alias",{url:"https://api.github.com/repositories/1/pulls?state=all&page=1&per_page=30",headers:headers()}],["detail from list",{url:target.replace("pulls?","pulls/580?"),headers:headers()}],["POST",{url:target,method:"POST",headers:headers()}],
] as Array<[string,ProfileRequest]>)test(`new policy refuses ${label} before send`,async()=>{
  const {receipt,sent}=await run(declaration(),input,{rules:{url:()=>true,header:()=>true,post:()=>true}});assert.equal(receipt.outcome,"refused");assert.deepEqual(sent,[]);
});

test("detail never admits a different number, list or subresource",async()=>{
  for(const path of ["pulls/581","pulls","pulls/580/files"]) {const {receipt,sent}=await run(declaration(true),{url:`https://api.github.com/repos/octo/project/${path}`,headers:headers()});assert.equal(receipt.outcome,"refused");assert.deepEqual(sent,[]);}
});

test("whole header comparison and scope hold on every redirect hop",async()=>{
  for(const to of [target.replace("page=1&","page=2&"),target.replace("project","other"),"https://other.example.org/collect"]) {
    const c=declaration(),bound=bind(c);let calls=0;
    const receipt=await observeSource({connector:c,bound,profile:oneRequest({url:target,headers:headers()}),spec:bound.source,state:new MemoryMachineState(),transport:{async request(){calls++;return calls===1 ? {ok:true,status:302,headers:{location:to},body:"",bytes:0} : {ok:true,status:200,headers:{},body:"[]",bytes:2};}},identity,commit:async()=>{},readPolicyApproval:{contract:1,digest:inspectSourceReadPolicy(c,bound).digest}});
    assert.equal(receipt.outcome,to.includes("page=2") ? "observed" : "refused");assert.equal(calls,to.includes("page=2") ? 2 : 1);
  }
});

test("anonymous provider header grants no credential host and preserves robots",async()=>{
  const c=declaration(false,true),scope=inspectSourceReadPolicy(c,bind(c));assert.deepEqual(scope.credential_hosts,[]);
  const {receipt,sent}=await run(c);assert.equal(receipt.outcome,"observed");assert.equal(sent.length,2);assert.ok(sent[0]!.url.endsWith("/robots.txt"));assert.equal(sent[1]!.headers["x-github-api-version"],"2026-03-10");assert.ok(sent.every(r=>!("authorization" in r.headers)));
});

test("only enumerated default and conditional validator exceptions are admitted",async()=>{
  const c=declaration();delete c.sources[0]!.request!.headers;assert.equal((await run(c,{url:target,headers:{accept:"application/json"}})).receipt.outcome,"observed");assert.equal((await run(c,{url:target,headers:{}})).receipt.outcome,"refused");
  for(const mode of ["incremental","complete"] as const)assert.equal((await run(declaration(),{url:target,headers:{...headers(),"if-none-match":'"one"'}},{mode})).receipt.outcome,mode==="incremental" ? "observed" : "refused");
  c.sources[0]!.request!.headers={};assert.equal((await run(c,{url:target})).receipt.outcome,"observed");
});

test("new policy changes affect approval while historical issue pins retain bytes",()=>{
  const c=declaration(),bound=bind(c),before=inspectSourceReadPolicy(c,bound).digest,pin=connectorPinDigest(c);c.sources[0]!.request!.headers!["x-github-api-version"]="2022-11-28";assert.notEqual(inspectSourceReadPolicy(c,bind(c)).digest,before);assert.notEqual(connectorPinDigest(c),pin);
  const legacy=parseConnectorDoc({id:"connectors/legacy",body:"",frontmatter:{type:"Connector",title:"Legacy issues",auth:{kind:"token",provider:"github"},record_sources:[{name:"issues",profile:"rest-json",target_kind:"Issue",identity:{resource:"https://github.com/{owner}/{repo}",id:"{id}"},fields:{title:"title"},completeness:"complete",request:{host:"api.github.com",method:"GET",path:"/repos/{owner}/{repo}/issues",items:"",headers:{"x-github-api-version":"2022-11-28"}}}]}});assert.ok(legacy.ok);
  // Captured by executing the unmodified base 5892891d before implementation.
  assert.equal(connectorPinDigest(legacy.connector),"sha256:6aaf2379c941589197437bc20061030bad25c06d150c7438285a2ca58b366345");
});


test("public harness forwards only explicit fixture approval; omission remains denied",async()=>{
  const c=declaration(),bound=bind(c);
  const documents=[{id:"conventions/issue",body:"",frontmatter:{type:"Convention",title:"Issue",governs:"Issue",path:"issues/",fields:{required:["title"]}}},
    {id:"conventions/source-feed",body:"",frontmatter:SOURCE_FEED_CONVENTION},{id:"conventions/signal",body:"",frontmatter:signalConvention("superbee_progress_status")},
    {id:"source-feeds/pulls",body:"",frontmatter:{type:"Source Feed",title:"Pulls",feed_kind:"connector",connector:c.id,source:"pulls",url:bound.resource,owned_fields:["title"],exclude_pattern:"never-match"}}];
  const fixture={connector:c,profile:oneRequest({url:target,headers:headers()}),spec:bound.source,documents,feed:"source-feeds/pulls"};
  const denied=await runSourceScenario(fixture,{name:"policy.denied",runs:[{exchanges:[]}]});assert.equal(denied.runs[0]!.receipt.reason,"read_policy_unapproved");assert.deepEqual(denied.runs[0]!.received,[]);
  const accepted=await runSourceScenario({...fixture,readPolicyApproval:{contract:1,digest:inspectSourceReadPolicy(c,bound).digest}},{name:"policy.approved",runs:[{exchanges:[{request:{url:target},response:{status:200,body:"[]"}}]}]});assert.equal(accepted.runs[0]!.receipt.outcome,"observed");assert.equal(accepted.runs[0]!.received.length,1);
});
