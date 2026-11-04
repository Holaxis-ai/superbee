// `superbee workload register`: the prefill link it builds for the hosted workload apps page
// (fragment format v1, owned by superbee-hosted `browser/workload-apps-entry.ts`), from a fake `gh`
// and a site repository's release.config.json. Nothing here opens a browser or reaches GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { workload } from "../src/commands/workload.js";
import { CliError } from "../src/errors.js";

const RELEASE_CONFIG = {
  workflow: { path: ".github/workflows/release.yml", defaultBranch: "main" },
  content: { kind: "hosted", origin: "https://mcp.getsuperbee.com", workspace: "holaxis-sites", bundle: "investor-plan" },
  code: { repository: "Holaxis-ai/holaxis-investor-plan-site" },
};
const REPOSITORY = { id: 1048576, full_name: "Holaxis-ai/holaxis-investor-plan-site", default_branch: "main", owner: { id: 2097152 } };
const REF = "Holaxis-ai/holaxis-investor-plan-site/.github/workflows/release.yml@refs/heads/main";

async function site(config: unknown = RELEASE_CONFIG, workflowFile = "release.yml"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-workload-"));
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(dir, ".github", "workflows", workflowFile), "on: workflow_dispatch\n");
  await writeFile(path.join(dir, "release.config.json"), JSON.stringify(config));
  return dir;
}

const opened: string[] = [];
async function run(argv: string[], cwd: string, gh: (args: readonly string[]) => Promise<string> = async () => JSON.stringify(REPOSITORY)) {
  const out: string[] = [];
  opened.length = 0;
  const calls: string[][] = [];
  await workload(["register", ...argv], {
    cwd,
    stdout: (text) => void out.push(text),
    openBrowser: (url) => void opened.push(url),
    gh: async (args) => {
      calls.push([...args]);
      return gh(args);
    },
  });
  return { receipt: (decode(out.join("")) as any).workload_register, opened, calls };
}

const fragment = (url: string) => new URLSearchParams(url.slice(url.indexOf("#") + 1));

test("builds the v1 prefill from gh and release.config.json and opens it, registering nothing", async () => {
  const { receipt, opened, calls } = await run([], await site());
  assert.deepEqual(calls, [["api", "repos/Holaxis-ai/holaxis-investor-plan-site"]]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0], receipt.url);
  assert.equal(receipt.status, "opened");
  assert.equal(receipt.registered, false);
  const [base] = receipt.url.split("#");
  assert.equal(base, "https://holaxis-sites.getsuperbee.com/settings/workload-apps");
  assert.deepEqual(
    [...fragment(receipt.url)],
    [
      ["v", "1"],
      ["displayName", "Holaxis-ai/holaxis-investor-plan-site"],
      ["repository", "Holaxis-ai/holaxis-investor-plan-site"],
      ["repositoryId", "1048576"],
      ["repositoryOwnerId", "2097152"],
      ["branch", "main"],
      ["workflowRefs", REF],
      ["jobWorkflowRefs", REF],
      ["environment", ""],
      ["events", "schedule"],
      ["events", "repository_dispatch"],
      ["events", "workflow_dispatch"],
      ["bundles", "investor-plan read"],
    ],
  );
  assert.equal(receipt.environment, null);
  assert.match(receipt.environment_note, /outside any GitHub environment/);
  assert.equal(receipt.set_variable, "gh variable set HOSTED_APP_ID --repo Holaxis-ai/holaxis-investor-plan-site --body <app-id>");
  assert.equal(receipt.notes, undefined);
});

test("--no-open prints the link only; --environment, --name and --url reach the fragment", async () => {
  const { receipt, opened } = await run(
    ["--no-open", "--environment", "release", "--name", "Investor site", "--url", "https://holaxis.getsuperbee.com/"],
    await site(),
  );
  assert.deepEqual(opened, []);
  assert.equal(receipt.status, "printed");
  assert.ok(receipt.url.startsWith("https://holaxis.getsuperbee.com/settings/workload-apps#"));
  assert.equal(receipt.page_from, "--url");
  const values = fragment(receipt.url);
  assert.equal(values.get("environment"), "release");
  assert.equal(values.get("displayName"), "Investor site");
});

test("the branch and refs follow GitHub's default branch, and a missing code.repository is read from gh", async () => {
  const config = { ...RELEASE_CONFIG, code: {} };
  const { receipt, calls } = await run(["--no-open"], await site(config), async (args) =>
    args[0] === "repo" ? "Holaxis-ai/holaxis-investor-plan-site\n" : JSON.stringify({ ...REPOSITORY, default_branch: "trunk" }),
  );
  assert.match(receipt.notes[0], /workflow.defaultBranch is main, but GitHub's default branch is trunk/);
  assert.deepEqual(calls[0], ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  assert.equal(fragment(receipt.url).get("branch"), "trunk");
  assert.equal(fragment(receipt.url).get("workflowRefs"), REF.replace("@refs/heads/main", "@refs/heads/trunk"));
});

test("a gh failure names gh's own first line, so no access and signed out read differently", async () => {
  await assert.rejects(
    run([], await site(), async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stderr: "HTTP 404: Not Found (https://api.github.com/repos/x)\nmore" });
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.deepEqual(error.details, { reason: "gh_failed", gh_error: "HTTP 404: Not Found (https://api.github.com/repos/x)" });
      return true;
    },
  );
});

test("refuses before opening anything: no config, a non-hosted site, a missing workflow, an unknown address, gh missing", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "sb-workload-empty-"));
  const cases: [string, () => Promise<unknown>, string][] = [
    ["no config", () => run([], empty), "no_release_config"],
    ["not hosted", async () => run([], await site({ ...RELEASE_CONFIG, content: { kind: "r2" } })), "release_config_not_hosted"],
    ["workflow missing", async () => run([], await site(RELEASE_CONFIG, "other.yml")), "workflow_missing"],
    [
      "unknown address",
      async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, origin: "https://example.com" } })),
      "workspace_url_unknown",
    ],
    ["bad environment", async () => run(["--environment", "a b"], await site()), "environment_invalid"],
    ["bundle not portable", async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, bundle: "Investor-Plan" } })), "release_config_bundle"],
    ["bundle with a space", async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, bundle: "investor plan" } })), "release_config_bundle"],
    ["no content bundle", async () => run([], await site({ ...RELEASE_CONFIG, content: { ...RELEASE_CONFIG.content, bundle: "" } })), "release_config_content"],
    ["workflow outside workflows", async () => run([], await site({ ...RELEASE_CONFIG, workflow: { path: "release.yml" } })), "release_config_workflow"],
    ["branch the page refuses", async () => run([], await site(), async () => JSON.stringify({ ...REPOSITORY, default_branch: "release+v2" })), "branch_unsupported"],
    ["name too long", async () => run(["--name", "x".repeat(81)], await site()), "name_invalid"],
    ["url not https", async () => run(["--url", "http://holaxis.example.com"], await site()), "url_invalid"],
    [
      "gh missing",
      async () => run([], await site(), async () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      }),
      "gh_missing",
    ],
  ];
  for (const [name, attempt, reason] of cases) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof CliError, name);
      assert.equal((error.details as any)?.reason, reason, name);
      return true;
    });
    assert.deepEqual(opened, [], name);
  }
});

const SITE_CONFIG = {
  ...RELEASE_CONFIG,
  reconcile: { adapter: "hosted", gateway: "https://mcp.getsuperbee.com", workspace: "holaxis-sites", app: "00000000-0000-4000-8000-000000000000", site: "investor-plan", environment: "portal-release", artifactDirectory: "dist" },
};

test("a hosted publisher requests only its site grant, pins reconcile.environment and points at reconcile.app", async () => {
  const { receipt } = await run(["--no-open"], await site(SITE_CONFIG));
  const values = fragment(receipt.url);
  assert.deepEqual(values.getAll("bundles"), ["investor-plan site"]);
  assert.deepEqual(receipt.bundles, ["investor-plan site"]);
  assert.equal(values.get("environment"), "portal-release");
  assert.equal(receipt.environment, "portal-release");
  assert.equal(receipt.site, "investor-plan");
  assert.equal(receipt.set_variable, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), /HOSTED_APP_ID/);
  assert.match(receipt.next[1], /release\.config\.json as reconcile\.app \(it now holds 00000000-0000-4000-8000-000000000000\)/);
});

test("a hosted site refuses a missing or different environment and a site that is not its bundle", async () => {
  const cases: [string, () => Promise<unknown>, string][] = [
    ["no environment", async () => run([], await site({ ...SITE_CONFIG, reconcile: { ...SITE_CONFIG.reconcile, environment: undefined } })), "site_environment_required"],
    ["other environment", async () => run(["--environment", "release"], await site(SITE_CONFIG)), "environment_mismatch"],
    ["other site", async () => run([], await site({ ...SITE_CONFIG, reconcile: { ...SITE_CONFIG.reconcile, site: "intro" } })), "release_config_site"],
    [
      "site name the page refuses",
      async () => run([], await site({ ...SITE_CONFIG, content: { ...SITE_CONFIG.content, bundle: "team.notes" }, reconcile: { ...SITE_CONFIG.reconcile, site: "team.notes" } })),
      "release_config_site_name",
    ],
  ];
  for (const [name, attempt, reason] of cases) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof CliError, name);
      assert.equal((error.details as any)?.reason, reason, name);
      return true;
    });
    assert.deepEqual(opened, [], name);
  }
});

// The app-free GitHub lane is independent of Portal configuration and local person sign-in.
const WORKSPACE_ORIGIN = "https://team.example.com";
const GATEWAY_ORIGIN = "https://mcp.example.com";
const APPROVED_APP = "58ce99af-f79d-4795-99a0-baf54a68d0ec";
const OIDC = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzaWduZWQtY2FsbGVyIn0.signature";
const BEARER = "sbw_" + "b".repeat(40);
const CLOCK = 1793650000000;
const REQUEST = { version: 1, displayName: "Civic research", events: ["workflow_dispatch"], bundles: { "civic-research": "write" } };
const workflowEnv = () => ({ GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/job/idtoken?api-version=2", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token", SUPERBEE_ACCESS_TOKEN: "person-token-must-not-be-used", SUPERBEE_HOST: "https://wrong.invalid", SUPERBEE_WORKLOAD_APP_ID: "inherited-app-must-not-be-used" });
const approved = () => ({ version: 1, appId: APPROVED_APP, token: BEARER, expiresAt: CLOCK + 900000, workspace: { slug: "team", origin: WORKSPACE_ORIGIN }, bundles: { "civic-research": "write" }, sites: [] });
const pending = () => ({ refused: "workload_approval_pending", requestId: APPROVED_APP, state: "pending", expiresAt: CLOCK + 7 * 86400000, reviewUrl: WORKSPACE_ORIGIN + "/settings/workload-apps" });

async function execFixture(t: import("node:test").TestContext, value: unknown = REQUEST, gateway = GATEWAY_ORIGIN) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-workload-exec-"));
  const { rm } = await import("node:fs/promises");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "home"));
  const file = path.join(root, "request.json");
  await writeFile(file, JSON.stringify(value));
  const argv = ["exec", "--request-file", file, "--url", WORKSPACE_ORIGIN, "--workspace", "team", "--", "node", "--help"];
  const calls: { url: string; init?: RequestInit }[] = [], out: string[] = [], children: { argv: readonly string[]; env: NodeJS.ProcessEnv }[] = [], exits: number[] = [];
  let result: unknown = approved(), status = 200;
  const request = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === WORKSPACE_ORIGIN + "/.well-known/oauth-protected-resource/mcp") return new Response("", { status: 404 });
    if (url === WORKSPACE_ORIGIN + "/.well-known/superbee-workspace") return Response.json({ schema_version: 1, workspace_slug: "team", resource: gateway + "/mcp" });
    if (url === gateway + "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: gateway + "/mcp", authorization_servers: ["https://issuer.example.com"] });
    if (url === "https://issuer.example.com/.well-known/openid-configuration") return Response.json({ issuer: "https://issuer.example.com", token_endpoint: "https://issuer.example.com/oauth/token" });
    if (url.startsWith("https://pipelines.actions.githubusercontent.com/")) return Response.json({ value: OIDC });
    assert.equal(url, gateway + "/sync/v1/workload-exchange");
    return Response.json(result, { status });
  };
  const deps = { cwd: root, home: path.join(root, "home"), env: workflowEnv(), fetch: request, now: () => CLOCK, stdout: (text: string) => { out.push(text); }, child: async (args: readonly string[], env: NodeJS.ProcessEnv) => { children.push({ argv: args, env }); return 17; }, exit: (n: number) => { exits.push(n); } };
  return { root, file, argv, calls, out, children, exits, deps, answer: (body: unknown, code = 200) => { result = body; status = code; } };
}

test("workload exec resolves exact approved access without Portal config or app UUID and strips OIDC minting env", async t => {
  const f = await execFixture(t);
  await workload(f.argv, f.deps);
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0]!.argv, ["node", "--help"]); assert.deepEqual(f.exits, [17]);
  assert.equal(f.children[0]!.env.SUPERBEE_HOST, GATEWAY_ORIGIN); assert.equal(f.children[0]!.env.SUPERBEE_ACCESS_TOKEN, BEARER); assert.equal(f.children[0]!.env.SUPERBEE_WORKLOAD_APP_ID, approved().appId);
  assert.equal(f.children[0]!.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined); assert.equal(f.children[0]!.env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  const exchange = f.calls.find(x => x.url.endsWith("/workload-exchange"))!;
  assert.deepEqual(JSON.parse(String(exchange.init!.body)), { workspace: "team", request: REQUEST });
  assert.equal(new Headers(exchange.init!.headers).get("authorization"), "Bearer " + OIDC); assert.equal(exchange.init!.redirect, "error");
  const oidc = f.calls.find(x => x.url.startsWith("https://pipelines.actions.githubusercontent.com/"))!;
  assert.equal(new URL(oidc.url).searchParams.get("audience"), WORKSPACE_ORIGIN);
  assert.equal(new Headers(oidc.init!.headers).get("authorization"), "Bearer github-request-token");
  assert.deepEqual(f.out, [`::add-mask::${OIDC}\n`, `::add-mask::${BEARER}\n`]);
});

test("workload exec explicit host preserves workspace authority and refuses malformed or unverified receivers before minting", async t => {
  const host = "https://receiving-worker.example.workers.dev";
  const explicit = async () => {
    const f = await execFixture(t, REQUEST, host);
    f.argv.splice(f.argv.indexOf("--"), 0, "--host", host);
    return f;
  };
  const f = await explicit();
  await workload(f.argv, f.deps);
  assert.equal(f.children[0]!.env.SUPERBEE_HOST, host);
  assert.equal(f.children[0]!.env.SUPERBEE_WORKLOAD_APP_ID, APPROVED_APP);
  assert.equal(f.children[0]!.env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  assert.equal(f.children[0]!.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.deepEqual(f.exits, [17]);
  assert.equal(f.calls.some(c => c.url.startsWith(WORKSPACE_ORIGIN)), false);
  const oidc = f.calls.find(c => c.url.startsWith("https://pipelines.actions.githubusercontent.com/"))!;
  assert.equal(new URL(oidc.url).searchParams.get("audience"), WORKSPACE_ORIGIN);
  const exchange = f.calls.find(c => c.url.endsWith("/workload-exchange"))!;
  assert.equal(exchange.url, host + "/sync/v1/workload-exchange");
  assert.deepEqual(JSON.parse(String(exchange.init!.body)), { workspace: "team", request: REQUEST });
  assert.deepEqual(f.out, [`::add-mask::${OIDC}\n`, `::add-mask::${BEARER}\n`]);
  for (const target of ["http://localhost", host + "/", host + "/mcp", host + "/?q=1", host + "#fragment", "https://user:password@receiving-worker.example.workers.dev", host + ":443", "not-an-origin"]) {
    const bad = await execFixture(t); bad.argv.splice(bad.argv.indexOf("--"), 0, "--host", target);
    await assert.rejects(workload(bad.argv, bad.deps), e => e instanceof CliError && e.details?.reason === "workload_host_invalid");
    assert.equal(bad.calls.length, 0); assert.equal(bad.children.length, 0);
  }
  for (const response of [new Response("", { status: 302, headers: { location: GATEWAY_ORIGIN } }), Response.json({resource: GATEWAY_ORIGIN + "/mcp", authorization_servers: ["https://issuer.example.com"]}), Response.json({resource: host + "/mcp", authorization_servers: []})]) {
    const bad = await explicit(); const original = bad.deps.fetch;
    bad.deps.fetch = async (url, init) => { if (url === host + "/.well-known/oauth-protected-resource/mcp") { assert.equal(init?.redirect, "error"); return response; } return original(url, init); };
    await assert.rejects(workload(bad.argv, bad.deps), e => e instanceof CliError && e.details?.reason === "workspace_discovery_unavailable");
    assert.equal(bad.calls.some(c => c.url.startsWith("https://pipelines.actions.githubusercontent.com/")), false); assert.equal(bad.children.length, 0);
  }
  for (const [body,status] of [[pending(),403],[{refused:"workload_approval_denied"},403],[{refused:"workload_approval_expired"},403],[{...approved(),appId:"not-an-app"},200],[{...approved(),workspace:{slug:"team",origin:host}},200],[{...approved(),bundles:{"civic-research":"write",extra:"read"}},200],[{...approved(),expiresAt:CLOCK+4000000},200]] as const) {
    const bad = await explicit(); bad.answer(body,status);
    await assert.rejects(workload(bad.argv,bad.deps), e => e instanceof CliError); assert.equal(bad.children.length,0);
  }
  const automatic = await execFixture(t, REQUEST, host);
  await assert.rejects(workload(automatic.argv,automatic.deps), e => e instanceof CliError);
  assert.equal(automatic.calls.some(c=>c.url.startsWith("https://pipelines.actions.githubusercontent.com/")),false);
  assert.equal(automatic.children.length,0);
});

test("workload exec explicit host keeps a neutral browser audience separate from the exact workspace selector", async t => {
  const origin = "https://my.example.com", host = "https://receiving-worker.example.workers.dev";
  const selected = async () => {
    const f = await execFixture(t, REQUEST, host);
    f.argv[f.argv.indexOf("--url") + 1] = origin;
    f.argv.splice(f.argv.indexOf("--"), 0, "--host", host);
    f.answer({ ...approved(), workspace: { slug: "team", origin } });
    return f;
  };
  const f = await selected(); await workload(f.argv, f.deps);
  assert.equal(f.children.length, 1); assert.equal(f.children[0]!.env.SUPERBEE_HOST, host);
  assert.equal(f.children[0]!.env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined); assert.equal(f.children[0]!.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(new URL(f.calls.find(c => c.url.startsWith("https://pipelines.actions.githubusercontent.com/"))!.url).searchParams.get("audience"), origin);
  assert.deepEqual(JSON.parse(String(f.calls.find(c => c.url.endsWith("/workload-exchange"))!.init!.body)), {workspace:"team",request:REQUEST});
  assert.equal(f.calls.some(c=>c.url.startsWith(origin)),false);
  for (const reply of [
    { ...approved(), workspace: { slug: "my", origin } },
    { ...approved(), workspace: { slug: "team", origin: WORKSPACE_ORIGIN } },
    { ...approved(), workspace: { slug: "team", origin }, bundles: { "civic-research": "read" } },
  ]) {
    const bad=await selected(); bad.answer(reply); await assert.rejects(workload(bad.argv,bad.deps),e=>e instanceof CliError); assert.equal(bad.children.length,0);
  }
  const wait=await selected(); wait.answer({...pending(),reviewUrl:origin+"/settings/workload-apps"},403);
  await assert.rejects(workload(wait.argv,wait.deps), e=>e instanceof CliError && e.details?.review_url === origin+"/settings/workload-apps");
  assert.equal(wait.children.length,0);
});

test("workload exec pending contains only bounded review status, never starts the child or polls", async t => {
  const f = await execFixture(t); f.answer(pending(), 403);
  await assert.rejects(workload(f.argv, f.deps), error => {
    assert.ok(error instanceof CliError); assert.equal(error.code, "FORBIDDEN");
    assert.deepEqual(error.details, { reason: "workload_approval_pending", request_id: APPROVED_APP, state: "pending", expires_at: CLOCK + 7 * 86400000, review_url: WORKSPACE_ORIGIN + "/settings/workload-apps", child_started: false }); return true;
  });
  assert.equal(f.children.length, 0); assert.equal(f.calls.filter(x => x.url.endsWith("workload-exchange")).length, 1);
  assert.equal(f.out.join("").includes(BEARER), false);
});

test("workload exec denied, expired, foreign review links and arbitrary failure prose do not leak or start work", async t => {
  for (const [response, status] of [
    [{ refused: "workload_approval_denied", message: "private-body-canary" }, 403],
    [{ refused: "workload_approval_expired" }, 403],
    [{ ...pending(), reviewUrl: "https://attacker.invalid/?token=private-body-canary" }, 403],
    [{ ...pending(), expiresAt: CLOCK - 1 }, 403],
    [{ ...pending(), requestId: "not-an-id" }, 403],
    [{ refused: "evil\nprivate-body-canary", token: BEARER, prose: "private-body-canary" }, 500],
  ] as const) {
    const f = await execFixture(t); f.answer(response, status);
    await assert.rejects(workload(f.argv, f.deps), e => { assert.ok(e instanceof CliError); assert.doesNotMatch(JSON.stringify(e) + e.message, /private-body-canary|attacker\.invalid/); return true; });
    assert.equal(f.children.length, 0);
  }
});

test("workload exec refuses incomplete or wider exchange scope, bad expiry and unknown answer bytes", async t => {
  for (const answer of [
    { ...approved(), appId: undefined }, { ...approved(), token: "bad" }, { ...approved(), expiresAt: CLOCK + 20000 }, { ...approved(), expiresAt: CLOCK + 4000000 },
    { ...approved(), workspace: { slug: "other", origin: WORKSPACE_ORIGIN } }, { ...approved(), bundles: { "civic-research": "read" } },
    { ...approved(), bundles: { "civic-research": "write", secret: "read" } }, { ...approved(), sites: ["other"] },
    { ...approved(), unrelated: "x".repeat(70000) },
  ]) {
    const f = await execFixture(t); f.answer(answer);
    await assert.rejects(workload(f.argv, f.deps), e => e instanceof CliError); assert.equal(f.children.length, 0);
  }
});

test("workload exec strict finite intent refuses claim fields, unknown keys, malformed JSON and unsafe files before discovery", async t => {
  for (const request of [
    { ...REQUEST, repositoryId: "123" }, { ...REQUEST, environment: "main" }, { ...REQUEST, version: 2 }, { ...REQUEST, displayName: " bad " },
    { ...REQUEST, events: ["push"] }, { ...REQUEST, events: ["schedule", "schedule"] }, { ...REQUEST, bundles: {} }, { ...REQUEST, bundles: { "../../private": "write" } },
    { ...REQUEST, sites: ["not-in-bundles"] }, { ...REQUEST, displayName: "x".repeat(17000) },
  ]) {
    const f = await execFixture(t, request); await assert.rejects(workload(f.argv, f.deps), e => e instanceof CliError && e.code === "USAGE"); assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0);
  }
  const f = await execFixture(t); await writeFile(f.file, '{"version":1,"version":1,"displayName":"Civic","events":["workflow_dispatch"],"bundles":{"civic-research":"read","civic-research":"write"}}');
  await assert.rejects(workload(f.argv, f.deps), e => e instanceof CliError && e.code === "USAGE"); assert.equal(f.calls.length, 0);
  await writeFile(f.file, '{"version":1,');
  await assert.rejects(workload(f.argv, f.deps), e => e instanceof CliError && e.code === "USAGE"); assert.equal(f.calls.length, 0);
  const { symlink } = await import("node:fs/promises"); const link = path.join(f.root, "link.json"); await symlink(f.file, link); f.argv[2] = link;
  await assert.rejects(workload(f.argv, f.deps), e => e instanceof CliError && e.code === "USAGE"); assert.equal(f.calls.length, 0);
});

test("workload exec requires GitHub OIDC and refuses untrusted discovery before sending credentials", async t => {
  const f = await execFixture(t); f.deps.env = { ...workflowEnv(), ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" };
  await assert.rejects(workload(f.argv, f.deps), e => e instanceof CliError && e.code === "AUTH_REQUIRED"); assert.equal(f.calls.length, 0);
  f.deps.env = workflowEnv(); const ordinaryFetch = f.deps.fetch;
  f.deps.fetch = async (url, init) => url.endsWith("/.well-known/superbee-workspace") ? Response.json({ schema_version: 1, workspace_slug: "team", resource: "https://attacker.invalid/mcp" }) : ordinaryFetch(url, init);
  await assert.rejects(workload(f.argv, f.deps), e => e instanceof CliError); assert.equal(f.children.length, 0);
  assert.ok(f.calls.every(x => new Headers(x.init?.headers).get("authorization") === null));
});

test("workload exec preserves child argv boundaries and exit status in a real spawned process", async t => {
  const f = await execFixture(t); const result = path.join(f.root, "child-result.json");
  const code = `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({token:process.env.SUPERBEE_ACCESS_TOKEN,host:process.env.SUPERBEE_HOST,appId:process.env.SUPERBEE_WORKLOAD_APP_ID,mintUrl:process.env.ACTIONS_ID_TOKEN_REQUEST_URL,mintToken:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,args:process.argv.slice(2)}));process.exit(23)`;
  f.argv = [...f.argv.slice(0, -2), process.execPath, "-e", code, result, "literal $(do-not-execute)", "--help"];
  const { child: _mock, ...deps } = f.deps;
  await workload(f.argv, deps);
  const { readFile } = await import("node:fs/promises"); const actual = JSON.parse(await readFile(result, "utf8"));
  assert.deepEqual(actual, { token: BEARER, host: GATEWAY_ORIGIN, appId: approved().appId, args: ["literal $(do-not-execute)", "--help"] }); assert.deepEqual(f.exits, [23]);
});

test("workload exec requires the entire fixed Site read profile without repeated or extra Sites", async t => {
  const f = await execFixture(t, { version: 1, displayName: "Documentation publisher", events: ["schedule"], bundles: { documentation: "read" }, sites: ["documentation"] });
  f.answer({ ...approved(), bundles: { documentation: "read" }, sites: ["documentation"] });
  await workload(f.argv, f.deps); assert.equal(f.children.length, 1);
  for (const sites of [[], ["documentation", "documentation"], ["documentation", "other-site"], undefined]) {
    const other = await execFixture(t, { version: 1, displayName: "Documentation publisher", events: ["schedule"], bundles: { documentation: "read" }, sites: ["documentation"] });
    other.answer({ ...approved(), bundles: { documentation: "read" }, sites });
    await assert.rejects(workload(other.argv, other.deps), e => e instanceof CliError); assert.equal(other.children.length, 0);
  }
});

test("built workload exec preserves child help/argv and pending exit for automatic and explicit neutral targets", async t => {
  for (const gateway of [GATEWAY_ORIGIN, "https://receiving-worker.example.workers.dev"]) {
    const browserOrigin = gateway === GATEWAY_ORIGIN ? WORKSPACE_ORIGIN : "https://my.example.com";
    const f = await execFixture(t, REQUEST, gateway);
    f.argv[f.argv.indexOf("--url") + 1] = browserOrigin;
    if (gateway !== GATEWAY_ORIGIN) f.argv.splice(f.argv.indexOf("--"), 0, "--host", gateway);
    const { spawnSync } = await import("node:child_process"); const { fileURLToPath } = await import("node:url"); const { readFile, access } = await import("node:fs/promises");
    const cli = fileURLToPath(new URL("../../superbee/dist/superbee.mjs", import.meta.url));
    const preload = path.join(f.root, "fetch-fixture.mjs"), result = path.join(f.root, "native-child.json");
    const approvedReply = {...approved(),workspace:{slug:"team",origin:browserOrigin}};
    const pendingReply = {...pending(),reviewUrl:browserOrigin+"/settings/workload-apps",expiresAt:Date.now()+86400000};
    await writeFile(preload, `globalThis.fetch=async(input,init)=>{
      const url=String(input);
      if(url.startsWith(${JSON.stringify(WORKSPACE_ORIGIN)})){
        if(${JSON.stringify(gateway !== GATEWAY_ORIGIN)})throw Error('explicit selection must not use pointer fallback');
        if(url===${JSON.stringify(WORKSPACE_ORIGIN + "/.well-known/oauth-protected-resource/mcp")})return new Response('',{status:404});
        if(url===${JSON.stringify(WORKSPACE_ORIGIN + "/.well-known/superbee-workspace")})return Response.json({schema_version:1,workspace_slug:'team',resource:${JSON.stringify(gateway + "/mcp")}});
      }
      if(url===${JSON.stringify(gateway + "/.well-known/oauth-protected-resource/mcp")})return Response.json({resource:${JSON.stringify(gateway + "/mcp")},authorization_servers:['https://issuer.example.com']});
      if(url==='https://issuer.example.com/.well-known/openid-configuration')return Response.json({issuer:'https://issuer.example.com',token_endpoint:'https://issuer.example.com/oauth/token'});
      if(url.startsWith('https://pipelines.actions.githubusercontent.com/')){if(new URL(url).searchParams.get('audience')!==${JSON.stringify(browserOrigin)})throw Error('wrong signed audience');return Response.json({value:${JSON.stringify(OIDC)}});}
      if(url===${JSON.stringify(gateway + "/sync/v1/workload-exchange")}){if(JSON.parse(init.body).workspace!=='team')throw Error('workspace inferred from origin');return process.env.WORKLOAD_TEST_PENDING==='1'?Response.json(${JSON.stringify(pendingReply)},{status:403}):Response.json({...${JSON.stringify(approvedReply)},expiresAt:Date.now()+900000});}
      throw Error('unexpected fixture request');};`);
    const code = `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({host:process.env.SUPERBEE_HOST,appId:process.env.SUPERBEE_WORKLOAD_APP_ID,token:process.env.SUPERBEE_ACCESS_TOKEN,mint:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,mintUrl:process.env.ACTIONS_ID_TOKEN_REQUEST_URL,args:process.argv.slice(2)}));process.exit(23)`;
    const nativeArgs = ["--import", preload, cli, "workload", ...f.argv.slice(0, -2), process.execPath, "-e", code, result, "--help", "literal $(never-executed)"];
    const env = { ...process.env, ...workflowEnv(), HOME: f.deps.home, USERPROFILE: f.deps.home, SUPERBEE_NO_AUTOPULL: "1", SUPERBEE_NO_UPDATE_CHECK: "1" };
    const done = spawnSync(process.execPath, nativeArgs, { env, cwd: f.root, encoding: "utf8", timeout: 30000 });
    assert.equal(done.status, 23, done.stdout + done.stderr);
    assert.deepEqual(JSON.parse(await readFile(result, "utf8")), { host: gateway, token: BEARER, appId: approved().appId, args: ["--help", "literal $(never-executed)"] });
    const stoppedFile = path.join(f.root, "must-not-exist");
    const pendingArgs = ["--import", preload, cli, "workload", ...f.argv.slice(0, -2), process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'bad')", stoppedFile];
    const stopped = spawnSync(process.execPath, pendingArgs, { env: { ...env, WORKLOAD_TEST_PENDING: "1" }, cwd: f.root, encoding: "utf8", timeout: 30000 });
    assert.equal(stopped.status, 2, stopped.stdout + stopped.stderr); assert.match(stopped.stdout, /workload_approval_pending/); assert.equal(stopped.stderr, ""); await assert.rejects(access(stoppedFile));
  }
});
