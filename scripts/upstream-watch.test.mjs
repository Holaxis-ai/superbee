import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import {
  LABEL,
  LIMITS,
  capBody,
  childEnv,
  collectMcp,
  collectOkf,
  createGitHub,
  evaluateBundle,
  fence,
  fileIssue,
  isNewerStable,
  issueBody,
  main,
  mcpReport,
  parseArgs,
  parsePins,
  sanitizeInline,
  verificationSteps,
} from "./upstream-watch.mjs";
import { parseActionDocument, validateIdentities } from "./workflow-actions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realPins = parsePins(readFileSync(path.join(root, "scripts", "upstream-watch.json"), "utf8"));
const LS = String.fromCharCode(0x2028); // LINE SEPARATOR, a newline to some Markdown renderers
const PIN = "a".repeat(40);
const NEXT = "b".repeat(40);
const HEAD = "c".repeat(40);
const pins = {
  schema: "superbee.upstream-watch.v1",
  okf: { repo: "example/okf", path: "SPEC.md", commit: PIN },
  mcp: { "@modelcontextprotocol/sdk": "1.32.1", "@modelcontextprotocol/ext-apps": "1.7.5" },
};
const HOSTILE = "evil`name`$(touch /tmp/pwned)${{ secrets.GITHUB_TOKEN }}\n@everyone" + LS + "```";
const clean = { code: 0, stdout: JSON.stringify({ docs: 9, malformed: 0 }), stderr: "" };

// A GitHub API fake keyed by route; unknown routes fail the test.
function githubFake(routes) {
  const calls = [];
  const get = async (route) => {
    calls.push(route);
    assert.ok(Object.hasOwn(routes, route), `unexpected route ${route}`);
    return routes[route];
  };
  return { get, calls };
}

function treeFake(bundleNames) {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-watch-test-"));
  const rootDir = path.join(dir, "okf-main");
  for (const name of bundleNames) mkdirSync(path.join(rootDir, "bundles", name), { recursive: true });
  if (bundleNames.length === 0) mkdirSync(rootDir, { recursive: true });
  let cleaned = false;
  return {
    fetchTree: async () => ({ root: rootDir, cleanup: () => { cleaned = true; rmSync(dir, { recursive: true, force: true }); } }),
    get cleaned() { return cleaned; },
  };
}

const okfRoutes = (latestSpec, files = []) => ({
  "/repos/example/okf/commits?path=SPEC.md&per_page=1": [{ sha: latestSpec }],
  "/repos/example/okf/commits?per_page=1": [{ sha: HEAD }],
  [`/repos/example/okf/compare/${PIN}...${latestSpec}`]: { files: files.map((filename) => ({ filename })) },
});

function throwingClient() {
  const fail = () => { throw new Error("issue client must not be called"); };
  return { ensureLabel: fail, issueTitles: fail, createIssue: fail };
}

test("the committed pin file is valid and names the dependencies the workspace actually uses", () => {
  assert.equal(realPins.okf.repo, "GoogleCloudPlatform/open-knowledge-format");
  const manifest = JSON.parse(readFileSync(path.join(root, "packages", "mcp-app", "package.json"), "utf8"));
  for (const name of Object.keys(realPins.mcp)) assert.ok(manifest.dependencies?.[name], `${name} is not an mcp-app dependency`);
  for (const broken of [
    { ...pins, schema: "other" },
    { ...pins, okf: { ...pins.okf, commit: "main" } },
    { ...pins, okf: { ...pins.okf, repo: "a/b/c" } },
    { ...pins, mcp: { "@modelcontextprotocol/sdk": "^1.0.0" } },
    { ...pins, mcp: {} },
  ]) assert.throws(() => parsePins(JSON.stringify(broken)));
});

test("an unchanged SPEC pin with conforming bundles produces no issue", async () => {
  const github = githubFake(okfRoutes(PIN));
  const tree = treeFake(["acme_retail", "ga4"]);
  const seen = [];
  const report = await collectOkf({ pins, github: github.get, fetchTree: tree.fetchTree, runStatus: async (dir) => { seen.push(path.basename(dir)); return clean; } });
  assert.equal(report.title, null);
  assert.equal(report.changed, false);
  assert.equal(report.failed, false);
  assert.deepEqual(seen, ["acme_retail", "ga4"]);
  assert.ok(tree.cleaned, "the downloaded tree is always removed");
  assert.ok(!github.calls.some((route) => route.includes("/compare/")), "no compare call when the pin is current");
  assert.deepEqual(await fileIssue({ title: report.title, body: "" }, { client: throwingClient(), dryRun: false, log: () => {} }), { action: "none" });
});

test("a changed SPEC commit produces the deterministic title, compare link and file list", async () => {
  const github = githubFake(okfRoutes(NEXT, ["SPEC.md", "bundles/ga4/index.md"]));
  const tree = treeFake(["ga4"]);
  const report = await collectOkf({ pins, github: github.get, fetchTree: tree.fetchTree, runStatus: async () => clean });
  assert.equal(report.title, "Upstream drift: OKF SPEC.md at bbbbbbb");
  assert.equal(report.changed, true);
  const body = issueBody(report, { runUrl: "https://github.com/o/r/actions/runs/1" });
  assert.match(body, new RegExp(`https://github.com/example/okf/compare/${PIN}\\.\\.\\.${NEXT}`));
  assert.match(body, /Changed files \(2\): `SPEC\.md`, `bundles\/ga4\/index\.md`/);
  assert.match(body, /bump the reviewed pin in `scripts\/upstream-watch\.json`/);
  assert.match(body, /Run: https:\/\/github.com\/o\/r\/actions\/runs\/1/);
});

test("conformance failures are reported per bundle and title an issue even with an unchanged spec", async () => {
  const outcomes = {
    exits: { code: 2, stdout: "", stderr: "boom" },
    malformed: { code: 0, stdout: JSON.stringify({ docs: 3, malformed: 2 }), stderr: "" },
    timestamps: { code: 0, stdout: JSON.stringify({ docs: 3, malformed: 0, invalid_timestamps: 4, invalid_timestamp_fields: { total: 4 } }), stderr: "" },
    rowsonly: { code: 0, stdout: JSON.stringify({ docs: 3, malformed: 0, invalid_timestamp_fields: { total: 1 } }), stderr: "" },
    empty: { code: 0, stdout: JSON.stringify({ docs: 0, malformed: 0 }), stderr: "" },
    garbage: { code: 0, stdout: "not json", stderr: "" },
    ok: clean,
  };
  const github = githubFake(okfRoutes(PIN));
  const tree = treeFake(Object.keys(outcomes));
  const report = await collectOkf({ pins, github: github.get, fetchTree: tree.fetchTree, runStatus: async (dir) => outcomes[path.basename(dir)] });
  assert.equal(report.failed, true);
  assert.equal(report.title, "Upstream drift: OKF sample bundle conformance at ccccccc");
  for (const expected of [
    /`exits` \| 2 \| \? \| \? \| \? \| FAIL: exit 2; status output is not a JSON object/,
    /`malformed` \| 0 \| 3 \| 2 \| 0 \| FAIL: 2 malformed/,
    /`timestamps` \| 0 \| 3 \| 0 \| 4 \| FAIL: 4 invalid timestamps/,
    /`rowsonly` \| 0 \| 3 \| 0 \| 1 \| FAIL: 1 invalid timestamps/,
    /`empty` \| 0 \| 0 \| 0 \| 0 \| FAIL: no documents read/,
    /`garbage` \| 0 .* FAIL: status output is not a JSON object/,
    /`ok` \| 0 \| 9 \| 0 \| 0 \| ok/,
  ]) assert.match(report.summary, expected);
  assert.match(report.summary, /stderr from `exits`:\n\n```text\nboom\n```/);

  const none = await collectOkf({ pins, github: githubFake(okfRoutes(PIN)).get, fetchTree: treeFake([]).fetchTree, runStatus: async () => clean });
  assert.equal(none.failed, true, "an upstream tree without sample bundles is a failure, not a pass");
  assert.match(none.summary, /No sample bundles were found/);
});

test("MCP drift counts only strictly newer stable releases", () => {
  assert.equal(isNewerStable("1.33.0", "1.32.1"), true);
  assert.equal(isNewerStable("2.0.0", "1.99.99"), true);
  assert.equal(isNewerStable("1.32.1", "1.32.1"), false);
  assert.equal(isNewerStable("1.32.0", "1.32.1"), false);
  assert.equal(isNewerStable("1.33.0-beta.1", "1.32.1"), false);
  assert.equal(isNewerStable("1.10.0", "1.9.0"), true, "numeric, not lexical, comparison");
  for (const junk of ["", "latest", "v1.33.0", "1.33", "1.33.0 ; rm -rf /"]) assert.equal(isNewerStable(junk, "1.32.1"), false);

  const current = mcpReport({ pins, latest: { "@modelcontextprotocol/sdk": "1.32.1", "@modelcontextprotocol/ext-apps": "1.8.0-rc.1" } });
  assert.equal(current.title, null);
  const both = mcpReport({ pins, latest: { "@modelcontextprotocol/sdk": "1.33.0", "@modelcontextprotocol/ext-apps": "2.0.3" } });
  assert.equal(both.title, "Upstream drift: @modelcontextprotocol/sdk 1.33.0, @modelcontextprotocol/ext-apps 2.0.3");
  const one = mcpReport({ pins, latest: { "@modelcontextprotocol/sdk": "1.33.0", "@modelcontextprotocol/ext-apps": "1.7.5" } });
  assert.equal(one.title, "Upstream drift: @modelcontextprotocol/sdk 1.33.0");
  const hostile = mcpReport({ pins, latest: { "@modelcontextprotocol/sdk": HOSTILE, "@modelcontextprotocol/ext-apps": "1.7.5" } });
  assert.equal(hostile.title, null);
  assert.match(hostile.summary, /unreadable version/);
  assert.doesNotMatch(hostile.summary, /\n@everyone/);
});

test("MCP verification runs argv arrays in order, stops at the first failure, and is skipped without --verify", async () => {
  const latest = { "@modelcontextprotocol/sdk": "1.33.0\n", "@modelcontextprotocol/ext-apps": "1.7.5" };
  const npmView = async (name) => latest[name];
  const skipped = await collectMcp({ pins, npmView, runNpm: async () => assert.fail("must not run npm without --verify"), verify: false });
  assert.match(skipped.summary, /Verification against the newer versions was skipped/);

  const calls = [];
  const runNpm = async (argv) => {
    calls.push(argv);
    return argv[1] === "typecheck" ? { code: 2, stdout: "x".repeat(10000), stderr: "TS2345 ```" } : { code: 0, stdout: "", stderr: "" };
  };
  const report = await collectMcp({ pins, npmView, runNpm, verify: true });
  assert.deepEqual(calls, verificationSteps([{ name: "@modelcontextprotocol/sdk", version: "1.33.0" }]).slice(0, 3).map((step) => step.argv));
  assert.deepEqual(calls[0], ["install", "--no-audit", "--no-fund", "--ignore-scripts", "-w", "@superbee/mcp-app", "@modelcontextprotocol/sdk@1.33.0"]);
  assert.equal(report.failed, true);
  assert.match(report.summary, /\| `npm run typecheck` \| 2 \|/);
  assert.match(report.summary, /````text\n[\s\S]*TS2345 ```\n````/, "the fence outgrows backtick runs in tool output");
  assert.ok(report.summary.length < LIMITS.log + 2000, "tool output is capped");

  const passing = await collectMcp({ pins, npmView, runNpm: async () => ({ code: 0, stdout: "", stderr: "" }), verify: true });
  assert.equal(passing.failed, false);
  assert.match(passing.summary, /All verification steps passed/);
});

test("issues are deduplicated against open and closed titles, labelled, and sent as JSON", async () => {
  const requests = [];
  const existing = [
    { title: "Upstream drift: OKF SPEC.md at bbbbbbb", state: "open" },
    { title: "Upstream drift: @modelcontextprotocol/sdk 1.33.0", state: "closed" },
    { title: "Upstream drift: OKF SPEC.md at ddddddd", state: "open", pull_request: {} },
  ];
  let labelExists = false;
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const respond = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status });
    if (url.endsWith(`/labels/${LABEL}`)) return labelExists ? respond(200, { name: LABEL }) : respond(404, { message: "Not Found" });
    if (url.endsWith("/labels")) { labelExists = true; return respond(201, { name: LABEL }); }
    if (url.includes("/issues?")) return respond(200, existing);
    if (url.endsWith("/issues")) return respond(201, { html_url: "https://github.com/o/r/issues/9" });
    return respond(500, {});
  };
  const client = createGitHub({ token: "t", repo: "o/r", fetchImpl });
  const log = () => {};
  for (const title of ["Upstream drift: OKF SPEC.md at bbbbbbb", "Upstream drift: @modelcontextprotocol/sdk 1.33.0"]) {
    assert.deepEqual(await fileIssue({ title, body: "b" }, { client, dryRun: false, log }), { action: "duplicate" });
  }
  assert.ok(requests.some((r) => r.url === `https://api.github.com/repos/o/r/issues?state=all&labels=${LABEL}&per_page=100&page=1`));
  assert.ok(requests.some((r) => r.method === "POST" && r.url.endsWith("/labels")), "a missing label is created");

  const fresh = "Upstream drift: OKF SPEC.md at ddddddd";
  const created = await fileIssue({ title: fresh, body: HOSTILE }, { client, dryRun: false, log });
  assert.deepEqual(created, { action: "created", url: "https://github.com/o/r/issues/9" });
  const post = requests.at(-1);
  assert.equal(post.url, "https://api.github.com/repos/o/r/issues");
  assert.deepEqual(post.body, { title: fresh, body: HOSTILE, labels: [LABEL] }, "a pull request with the same title does not suppress an issue");
  assert.equal(post.auth, "Bearer t");
  await assert.rejects(createGitHub({ repo: "o/r", fetchImpl }).createIssue({}), /GITHUB_TOKEN/);
});

test("dry run prints the would-be issue and never calls the issue client", async () => {
  const printed = [];
  const outcome = await fileIssue({ title: "Upstream drift: x", body: "body text" }, { client: throwingClient(), dryRun: true, log: (text) => printed.push(text) });
  assert.deepEqual(outcome, { action: "dry-run" });
  assert.match(printed.join(""), /Title: Upstream drift: x\n\nbody text/);
});

test("untrusted upstream text is neutralized, fenced safely, and capped", async () => {
  const inline = sanitizeInline(HOSTILE);
  assert.ok(!inline.includes("`") && !inline.includes("\n") && !inline.includes(LS));
  assert.ok(inline.includes("$(touch /tmp/pwned)") && inline.includes("${{ secrets.GITHUB_TOKEN }}"), "text is data, passed through literally");
  assert.ok(sanitizeInline("x".repeat(5000)).length < LIMITS.inline + 60);
  assert.match(fence("a ````` b"), /^``````text\n/);

  const files = Array.from({ length: 400 }, (_, i) => `${HOSTILE}${"y".repeat(1000)}${i}`);
  const github = githubFake(okfRoutes(NEXT, files));
  const report = await collectOkf({ pins, github: github.get, fetchTree: treeFake([HOSTILE.replace(new RegExp(`[\n${LS}/]`, "g"), "_")]).fetchTree, runStatus: async () => ({ code: 1, stdout: "", stderr: `${HOSTILE}${"z".repeat(100000)}` }) });
  const body = issueBody(report);
  assert.ok(body.length <= LIMITS.body);
  assert.match(body, /Changed files \(400\): .* and 350 more/);
  // Raw upstream stderr only appears inside a fence that its own backtick runs cannot close.
  assert.match(body, /````text\nevil`name`/);
  const outsideFences = body.replace(/(`{3,})text\n[\s\S]*?\n\1(?!`)/g, "");
  assert.ok(!/\n@everyone/.test(outsideFences), "no upstream text starts a line of its own outside a fence");
  assert.ok(!body.includes("z".repeat(LIMITS.log + 1)), "stderr is capped");
  assert.equal(capBody("q".repeat(LIMITS.body + 10)).length, LIMITS.body);
  assert.match(capBody("q".repeat(LIMITS.body + 10)), /Report truncated/);
});

test("child processes never inherit credentials", () => {
  const env = childEnv({ PATH: "/bin", GITHUB_TOKEN: "x", GH_TOKEN: "x", NPM_TOKEN: "x", ACTIONS_RUNTIME_TOKEN: "x", MY_SECRET: "x", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("arguments are strict", () => {
  assert.deepEqual(parseArgs(["okf", "--dry-run"]), { target: "okf", dryRun: true, verify: false });
  assert.deepEqual(parseArgs(["mcp", "--verify"]), { target: "mcp", dryRun: false, verify: true });
  for (const bad of [[], ["both"], ["okf", "--verify"], ["mcp", "--force"]]) assert.throws(() => parseArgs(bad));
});

test("main writes the summary to the step summary file and reports the issue outcome", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-watch-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summaryFile = path.join(dir, "summary.md");
  const latest = Object.fromEntries(Object.keys(realPins.mcp).map((name) => [name, realPins.mcp[name]]));
  const result = await main(["mcp"], { GITHUB_STEP_SUMMARY: summaryFile }, {
    github: throwingClient(),
    npmView: async (name) => latest[name],
    log: () => assert.fail("summary goes to the file when GITHUB_STEP_SUMMARY is set"),
  });
  assert.equal(result.outcome.action, "none");
  assert.match(readFileSync(summaryFile, "utf8"), /## MCP upstream watch[\s\S]*No drift: no issue needed\./);
});

test("the workflow reports only, gates jobs by schedule, and keeps upstream data out of expressions", () => {
  const text = readFileSync(path.join(root, ".github", "workflows", "upstream-watch.yml"), "utf8");
  const identities = validateIdentities(JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8")).github_actions.identities);
  const { document } = parseActionDocument(text, "upstream-watch.yml", { identities });
  const on = document.on ?? document[true];
  assert.deepEqual(on.schedule.map((row) => row.cron), ["41 6 * * 1", "29 6 * * *"]);
  assert.equal(on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(on.workflow_dispatch.inputs.target.options, ["both", "okf", "mcp"]);
  assert.deepEqual(document.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(document.jobs).sort(), ["mcp", "okf"]);
  assert.match(document.jobs.okf.if, /github\.event\.schedule == '41 6 \* \* 1'/);
  assert.match(document.jobs.mcp.if, /github\.event\.schedule == '29 6 \* \* \*'/);
  for (const job of Object.values(document.jobs)) {
    assert.deepEqual(job.permissions, { contents: "read", issues: "write" });
    assert.equal(job.steps[0].with["persist-credentials"], false);
    for (const step of job.steps.filter((row) => typeof row.run === "string")) {
      assert.doesNotMatch(step.run, /\$\{\{/, "run scripts take inputs through env, never templated");
      assert.doesNotMatch(step.run, /\b(git push|git commit|gh pr|npm publish)\b/);
    }
  }
  assert.match(document.jobs.mcp.steps.at(-1).run, /upstream-watch\.mjs mcp --verify/);
  assert.match(document.jobs.okf.steps.map((step) => step.run ?? "").join("\n"), /npm run build[\s\S]*upstream-watch\.mjs okf/);
  assert.ok(yaml.safeLoad(text));
});
