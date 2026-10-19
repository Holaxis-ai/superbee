import test from "node:test";
import assert from "node:assert/strict";
import { guardTransport, DEFAULT_SOURCE_BUDGET, DEFAULT_STATUS_RULES, sourceHostSet, type GuardContext } from "../src/source-engine/guard.js";
import { fetchIdentity } from "../src/source-engine/index.js";

const start = "https://api.github.com/repos/octo/project/issues?state=open";
function setup() {
  const sent: Array<{url: string; method: string; headers: Readonly<Record<string, string>>; credentialHost: boolean; body?: string}> = [];
  const set = sourceHostSet({auth: {kind: "token", provider: "github"}, domains: []}, ["api.github.com"]);
  assert.ok(set.ok);
  const ctx: GuardContext = {
    hosts: set.hosts, identity: fetchIdentity("CallbackTest/1 (+https://example.org)")!, budget: {...DEFAULT_SOURCE_BUDGET}, statuses: {...DEFAULT_STATUS_RULES}, conditional: false, now: () => new Date(), rules: {},
    authority: {url: url => url.hostname === "api.github.com" && url.pathname === "/repos/octo/project/issues" && url.searchParams.get("state") === "open", post: (_url, body) => body === '{"read":true}', header: name => name === "x-version"},
    transport: {async request(input) {sent.push({...input, headers: {...input.headers}}); return {ok: true, status: 200, headers: {"content-type": "application/json"}, body: "[]", bytes: 2};}},
  };
  return {ctx, sent};
}

for (const phase of ["url", "header", "post", "response", "redirect"] as const) test(`callback ${phase} views are isolated from executed request and response`, async () => {
  const {ctx, sent} = setup();
  const mutate = (url: URL): true => {url.hostname = "other.example.org"; url.searchParams.set("state", "all"); ctx.hosts.credential.clear(); ctx.identity.userAgent = "Changed/1"; return true;};
  if (phase === "url" || phase === "redirect") ctx.rules.url = url => mutate(url);
  if (phase === "header") ctx.rules.header = (_name, url) => mutate(url);
  if (phase === "post") ctx.rules.post = (url, _body) => mutate(url);
  if (phase === "response") ctx.rules.response = response => {response.url = "https://other.example.org"; response.body = "changed"; (response.headers as Record<string, string>)["content-type"] = "changed";};
  if (phase === "redirect") {
    const inner = ctx.transport.request;
    ctx.transport.request = async input => {const response = await inner(input); return sent.length === 1 ? {ok: true, status: 302, headers: {location: `${start}&page=2`}, body: "", bytes: 0} : response;};
  }
  const guarded = guardTransport(ctx);
  const response = await guarded.transport.request({url: start, ...(phase === "post" ? {method: "POST", body: '{"read":true}'} : {}), ...(phase === "header" ? {headers: {"x-version": "one"}} : {})});
  assert.equal(sent.length, phase === "redirect" ? 2 : 1);
  for (const input of sent) {assert.equal(new URL(input.url).hostname, "api.github.com"); assert.equal(new URL(input.url).searchParams.get("state"), "open"); assert.equal(input.headers["user-agent"], "CallbackTest/1 (+https://example.org)"); assert.equal(input.credentialHost, true);}
  assert.equal(response.body, "[]"); assert.equal(response.headers["content-type"], "application/json"); assert.equal(new URL(response.url).hostname, "api.github.com");
  if (phase === "post") assert.equal(sent[0]!.body, '{"read":true}');
});

test("final core authority checks run after all narrowing callbacks", async () => {
  const {ctx, sent} = setup();
  let allowed = true;
  ctx.authority!.url = () => allowed;
  ctx.rules.header = () => {allowed = false; return true;};
  const guard = guardTransport(ctx);
  await assert.rejects(guard.transport.request({url: start, headers: {"x-version": "one"}}));
  assert.equal(guard.stopped()?.reason, "url_refused"); assert.deepEqual(sent, []);
});
