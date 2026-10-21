// Report drift in the upstream specifications Superbee depends on: the OKF spec (SPEC.md in its
// canonical repository, plus its sample bundles read through the built CLI) and the MCP SDK
// packages used by @superbee/mcp-app.
//
// Usage: node scripts/upstream-watch.mjs <okf|mcp> [--dry-run] [--verify]
//   okf       compare the latest SPEC.md commit with the reviewed pin, then run
//             `superbee status --json` against every upstream sample bundle.
//   mcp       compare each package's npm `latest` with the reviewed pin. With --verify, install
//             the newer versions into the mcp-app workspace (never committed) and run build,
//             typecheck and the mcp-app tests.
//   --dry-run print the would-be issue instead of touching the issue tracker.
//
// REPORTING ONLY: the Markdown summary always goes to $GITHUB_STEP_SUMMARY (stdout locally), and
// drift or a conformance failure opens at most one `upstream-drift` issue per deterministic title.
// An existing open or closed issue with that title suppresses a new one. Pins in
// scripts/upstream-watch.json are bumped by humans after review; this script never writes them.
//
// Upstream content is untrusted. Child processes take argv arrays (never a shell), upstream text
// only reaches the issue body through sanitizers and length caps, and the body travels as JSON.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";
import { compareStrictSemver, parseStrictSemver } from "./strict-semver.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PINS_PATH = path.join(repoRoot, "scripts", "upstream-watch.json");
export const CLI_PATH = path.join(repoRoot, "packages", "superbee", "dist", "superbee.mjs");
export const LABEL = "upstream-drift";
export const MCP_WORKSPACE = "@superbee/mcp-app";
export const LIMITS = Object.freeze({
  body: 60000, // GitHub rejects issue bodies above 65536 characters.
  inline: 200,
  files: 50,
  log: 3000,
  jsonBytes: 5 * 1024 * 1024,
  tarballBytes: 100 * 1024 * 1024,
});
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PACKAGE = /^@[a-z0-9-]+\/[a-z0-9.-]+$/;

// ---------- untrusted text ----------

export function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}... (truncated, ${value.length} characters)`;
}

// One line, no control characters, no backticks, so it is always safe inside a code span.
export function sanitizeInline(text, max = LIMITS.inline) {
  return truncate(String(text ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replaceAll("`", "'"), max);
}

// A fence longer than any backtick run in the text cannot be closed early by that text.
export function fence(text, max = LIMITS.log) {
  const value = truncate(text, max);
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}text\n${value}\n${marker}`;
}

export function capBody(body, max = LIMITS.body) {
  if (body.length <= max) return body;
  const note = "\n\n(Report truncated; see the workflow run summary for the rest.)";
  return body.slice(0, max - note.length) + note;
}

// ---------- pins ----------

export function parsePins(text) {
  const pins = JSON.parse(text);
  const fail = (message) => { throw new Error(`scripts/upstream-watch.json: ${message}`); };
  if (pins?.schema !== "superbee.upstream-watch.v1") fail("unexpected schema");
  const { okf, mcp } = pins;
  if (!REPO.test(okf?.repo ?? "")) fail("okf.repo must be owner/name");
  if (okf.path !== "SPEC.md") fail("okf.path must be SPEC.md");
  if (!SHA.test(okf.commit ?? "")) fail("okf.commit must be a full lowercase commit SHA");
  if (!mcp || typeof mcp !== "object" || Object.keys(mcp).length === 0) fail("mcp must name at least one package");
  for (const [name, version] of Object.entries(mcp)) {
    if (!PACKAGE.test(name)) fail(`invalid package name ${name}`);
    if (!parseStrictSemver(version)) fail(`invalid pinned version for ${name}`);
  }
  return pins;
}

// ---------- OKF ----------

export function readStatusCounts(stdout) {
  let json;
  try { json = JSON.parse(stdout); } catch { return null; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const number = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    docs: number(json.docs),
    malformed: number(json.malformed),
    // The top-level count is omitted when zero; the row block carries the same total.
    invalidTimestamps: number(json.invalid_timestamps ?? json.invalid_timestamp_fields?.total ?? 0),
  };
}

export function evaluateBundle(name, { code, stdout, stderr }) {
  const counts = readStatusCounts(stdout);
  const reasons = [];
  if (code !== 0) reasons.push(`exit ${code}`);
  if (!counts) reasons.push("status output is not a JSON object");
  else {
    if (counts.docs === null || counts.malformed === null || counts.invalidTimestamps === null) reasons.push("status JSON is missing expected counts");
    if (counts.docs === 0) reasons.push("no documents read");
    if (counts.malformed > 0) reasons.push(`${counts.malformed} malformed`);
    if (counts.invalidTimestamps > 0) reasons.push(`${counts.invalidTimestamps} invalid timestamps`);
  }
  return { name, code, ...(counts ?? { docs: null, malformed: null, invalidTimestamps: null }), reasons, stderr: reasons.length ? String(stderr ?? "") : "" };
}

export function okfReport({ pins, latestSpec, head, files = [], bundles }) {
  const { repo, commit: pinned } = pins.okf;
  const specChanged = latestSpec !== pinned;
  const failures = bundles.filter((bundle) => bundle.reasons.length > 0);
  const noBundles = bundles.length === 0;
  const lines = [
    "## OKF upstream watch",
    "",
    `- Repository: https://github.com/${repo}`,
    `- Reviewed SPEC.md pin: \`${pinned.slice(0, 12)}\``,
    `- Latest SPEC.md commit: \`${latestSpec.slice(0, 12)}\` (${specChanged ? "**changed**" : "unchanged"})`,
  ];
  if (specChanged) {
    lines.push(`- Compare: https://github.com/${repo}/compare/${pinned}...${latestSpec}`);
    const shown = files.slice(0, LIMITS.files).map((file) => `\`${sanitizeInline(file)}\``);
    const more = files.length > shown.length ? ` and ${files.length - shown.length} more` : "";
    lines.push(`- Changed files (${files.length}): ${shown.join(", ") || "none listed"}${more}`);
  }
  lines.push("", `Sample bundles at \`${head.slice(0, 12)}\`, read with \`superbee status --json --dir\`:`, "");
  if (noBundles) lines.push("**No sample bundles were found under `bundles/`.**");
  else {
    lines.push("| Bundle | Exit | Docs | Malformed | Invalid timestamps | Result |", "| --- | --- | --- | --- | --- | --- |");
    for (const bundle of bundles) {
      const cell = (value) => (value === null ? "?" : String(value));
      const result = bundle.reasons.length ? `FAIL: ${sanitizeInline(bundle.reasons.join("; "))}` : "ok";
      lines.push(`| \`${sanitizeInline(bundle.name, 80)}\` | ${bundle.code} | ${cell(bundle.docs)} | ${cell(bundle.malformed)} | ${cell(bundle.invalidTimestamps)} | ${result} |`);
    }
    for (const bundle of failures.filter((row) => row.stderr.trim())) {
      lines.push("", `stderr from \`${sanitizeInline(bundle.name, 80)}\`:`, "", fence(bundle.stderr));
    }
  }
  const failed = failures.length > 0 || noBundles;
  let title = null;
  if (specChanged) title = `Upstream drift: OKF SPEC.md at ${latestSpec.slice(0, 7)}`;
  else if (failed) title = `Upstream drift: OKF sample bundle conformance at ${head.slice(0, 7)}`;
  return { changed: specChanged, failed, summary: lines.join("\n"), title };
}

export async function collectOkf({ pins, github, fetchTree, runStatus }) {
  const { repo, path: specPath } = pins.okf;
  const sha = (rows, what) => {
    const value = Array.isArray(rows) ? rows[0]?.sha : undefined;
    if (!SHA.test(value ?? "")) throw new Error(`GitHub returned no commit SHA for ${what}`);
    return value;
  };
  const latestSpec = sha(await github(`/repos/${repo}/commits?path=${specPath}&per_page=1`), specPath);
  const head = sha(await github(`/repos/${repo}/commits?per_page=1`), "the default branch");
  let files = [];
  if (latestSpec !== pins.okf.commit) {
    const compare = await github(`/repos/${repo}/compare/${pins.okf.commit}...${latestSpec}`);
    files = (Array.isArray(compare?.files) ? compare.files : []).map((file) => String(file?.filename ?? ""));
  }
  const tree = await fetchTree(repo, head);
  try {
    const bundlesDir = path.join(tree.root, "bundles");
    const names = existsSync(bundlesDir)
      ? readdirSync(bundlesDir).filter((name) => statSync(path.join(bundlesDir, name)).isDirectory()).sort()
      : [];
    const bundles = [];
    for (const name of names) bundles.push(evaluateBundle(name, await runStatus(path.join(bundlesDir, name))));
    return okfReport({ pins, latestSpec, head, files, bundles });
  } finally {
    tree.cleanup();
  }
}

// ---------- MCP ----------

// Only a strictly greater stable release counts; prereleases and equal versions never do.
export function isNewerStable(candidate, pinned) {
  const parsed = parseStrictSemver(candidate);
  if (!parsed || parsed.prerelease !== null) return false;
  return compareStrictSemver(candidate, pinned) === 1;
}

export function mcpReport({ pins, latest, verification }) {
  const updates = [];
  const lines = ["## MCP upstream watch", "", "| Package | Reviewed pin | npm latest | Status |", "| --- | --- | --- | --- |"];
  for (const [name, pinned] of Object.entries(pins.mcp)) {
    const value = latest[name];
    const valid = parseStrictSemver(value) !== undefined;
    const newer = valid && isNewerStable(value, pinned);
    if (newer) updates.push({ name, version: value });
    const status = !valid ? "unreadable version" : newer ? "**newer**" : "current";
    lines.push(`| \`${name}\` | ${pinned} | ${valid ? value : `\`${sanitizeInline(value, 60)}\``} | ${status} |`);
  }
  let failed = false;
  if (updates.length > 0) {
    lines.push("");
    if (!verification) lines.push("Verification against the newer versions was skipped (run with `--verify`).");
    else {
      lines.push(`Verification with ${updates.map((u) => `\`${u.name}@${u.version}\``).join(", ")} installed into \`${MCP_WORKSPACE}\` (not committed):`, "");
      lines.push("| Step | Exit |", "| --- | --- |");
      for (const step of verification) lines.push(`| \`${step.label}\` | ${step.code} |`);
      const failing = verification.find((step) => step.code !== 0);
      failed = Boolean(failing);
      if (failing) lines.push("", `Output tail from \`${failing.label}\`:`, "", fence(failing.output.slice(-LIMITS.log)));
      else lines.push("", "All verification steps passed.");
    }
  }
  const title = updates.length ? `Upstream drift: ${updates.map((u) => `${u.name} ${u.version}`).join(", ")}` : null;
  return { changed: updates.length > 0, failed, updates, summary: lines.join("\n"), title };
}

export function verificationSteps(updates) {
  return [
    { label: "npm install (mcp-app, --ignore-scripts)", argv: ["install", "--no-audit", "--no-fund", "--ignore-scripts", "-w", MCP_WORKSPACE, ...updates.map((u) => `${u.name}@${u.version}`)] },
    { label: "npm run build", argv: ["run", "build"] },
    { label: "npm run typecheck", argv: ["run", "typecheck"] },
    { label: `npm test -w ${MCP_WORKSPACE}`, argv: ["test", "-w", MCP_WORKSPACE] },
  ];
}

export async function collectMcp({ pins, npmView, runNpm, verify }) {
  const latest = {};
  for (const name of Object.keys(pins.mcp)) latest[name] = (await npmView(name)).trim();
  const probe = mcpReport({ pins, latest });
  if (!verify || probe.updates.length === 0) return probe;
  const verification = [];
  for (const step of verificationSteps(probe.updates)) {
    // Versions reaching argv were validated as strict semver by mcpReport.
    const result = await runNpm(step.argv);
    verification.push({ label: step.label, code: result.code, output: `${result.stdout}\n${result.stderr}` });
    if (result.code !== 0) break;
  }
  return mcpReport({ pins, latest, verification });
}

// ---------- issues ----------

export function issueBody(report, { runUrl } = {}) {
  const footer = [
    "",
    "---",
    "Opened by `.github/workflows/upstream-watch.yml`. Review the upstream change, adapt Superbee if needed,",
    "and bump the reviewed pin in `scripts/upstream-watch.json` in the same PR. Closing this issue",
    "suppresses a repeat for this exact title.",
  ];
  if (runUrl) footer.push("", `Run: ${runUrl}`);
  return capBody(`${report.summary}\n${footer.join("\n")}`);
}

export async function fileIssue({ title, body }, { client, dryRun, log }) {
  if (!title) return { action: "none" };
  if (dryRun) {
    log(`Dry run: would open issue (label ${LABEL}) unless one titled exactly this exists.\nTitle: ${title}\n\n${body}\n`);
    return { action: "dry-run" };
  }
  await client.ensureLabel(LABEL);
  const titles = await client.issueTitles(LABEL);
  if (titles.has(title)) return { action: "duplicate" };
  const created = await client.createIssue({ title, body, labels: [LABEL] });
  return { action: "created", url: created?.html_url };
}

// ---------- I/O adapters ----------

async function readBounded(response, max) {
  const length = response.headers.get("content-length");
  if (length && Number(length) > max) { await response.body?.cancel(); throw new Error("response too large"); }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > max) throw new Error("response too large");
  return bytes;
}

export function createGitHub({ token, repo, fetchImpl = globalThis.fetch } = {}) {
  const request = async (route, { method = "GET", body, allow404 = false } = {}) => {
    const response = await fetchImpl(`https://api.github.com${route}`, {
      method,
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub HTTP ${response.status} for ${method} ${route.split("?")[0]}`); }
    return JSON.parse((await readBounded(response, LIMITS.jsonBytes)).toString("utf8"));
  };
  const needRepo = () => { if (!REPO.test(repo ?? "") || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to file issues"); };
  return {
    get: (route) => request(route),
    async ensureLabel(label) {
      needRepo();
      if (await request(`/repos/${repo}/labels/${encodeURIComponent(label)}`, { allow404: true })) return;
      await request(`/repos/${repo}/labels`, { method: "POST", body: { name: label, color: "c5def5", description: "An upstream spec or dependency changed; see scripts/upstream-watch.json" } });
    },
    async issueTitles(label) {
      needRepo();
      const titles = new Set();
      for (let page = 1; page <= 10; page += 1) {
        const rows = await request(`/repos/${repo}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`);
        for (const row of rows) if (!row.pull_request) titles.add(row.title);
        if (rows.length < 100) break;
      }
      return titles;
    },
    async createIssue(issue) {
      needRepo();
      return request(`/repos/${repo}/issues`, { method: "POST", body: issue });
    },
  };
}

// Children run upstream code (a newer SDK under test) or read upstream files, so they never
// inherit the issue-writing token or any other credential-shaped variable.
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)));
}

function run(file, argv, { timeout = 30 * 60 * 1000, cwd = repoRoot } = {}) {
  return new Promise((resolve) => {
    execFile(file, argv, { cwd, env: childEnv(), timeout, maxBuffer: 64 * 1024 * 1024, shell: false }, (error, stdout, stderr) => {
      // A spawn failure or timeout has no numeric exit code; report it as exit 1 with its message.
      const spawnFailure = error && typeof error.code !== "number";
      const code = error ? (spawnFailure ? 1 : error.code) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: `${stderr ?? ""}${spawnFailure ? String(error.message) : ""}` });
    });
  });
}

// Downloads the upstream tree at an exact SHA into a fresh temporary directory.
async function fetchTree(repo, sha, fetchImpl = globalThis.fetch) {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-okf-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const response = await fetchImpl(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`tarball download failed with HTTP ${response.status}`);
    const archive = path.join(dir, "upstream.tgz");
    writeFileSync(archive, await readBounded(response, LIMITS.tarballBytes));
    const extract = path.join(dir, "tree");
    mkdirSync(extract);
    const result = await run("tar", ["-xzf", archive, "-C", extract], { timeout: 120000 });
    if (result.code !== 0) throw new Error(`tar exited ${result.code}`);
    const tops = readdirSync(extract);
    if (tops.length !== 1) throw new Error("unexpected tarball layout");
    return { root: path.join(extract, tops[0]), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------- CLI ----------

export function parseArgs(argv) {
  const [target, ...rest] = argv;
  if (target !== "okf" && target !== "mcp") throw new Error("usage: upstream-watch.mjs <okf|mcp> [--dry-run] [--verify]");
  const flags = { dryRun: false, verify: false };
  for (const flag of rest) {
    if (flag === "--dry-run") flags.dryRun = true;
    else if (flag === "--verify" && target === "mcp") flags.verify = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return { target, ...flags };
}

export async function main(argv, env = process.env, deps = {}) {
  const options = parseArgs(argv);
  const pins = parsePins(readFileSync(PINS_PATH, "utf8"));
  const github = deps.github ?? createGitHub({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY });
  const log = deps.log ?? ((text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`));
  let report;
  if (options.target === "okf") {
    if (!deps.runStatus && !existsSync(CLI_PATH)) throw new Error("built CLI is missing; run npm run build first");
    report = await collectOkf({
      pins,
      github: github.get,
      fetchTree: deps.fetchTree ?? ((repo, sha) => fetchTree(repo, sha)),
      runStatus: deps.runStatus ?? ((dir) => run(process.execPath, [CLI_PATH, "status", "--json", "--dir", dir], { timeout: 120000, cwd: tmpdir() })),
    });
  } else {
    report = await collectMcp({
      pins,
      npmView: deps.npmView ?? (async (name) => {
        const result = await run("npm", ["view", name, "version"], { timeout: 60000 });
        if (result.code !== 0) throw new Error(`npm view ${name} exited ${result.code}`);
        return result.stdout;
      }),
      runNpm: deps.runNpm ?? ((args) => run("npm", args)),
      verify: options.verify,
    });
  }
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
  const outcome = await fileIssue({ title: report.title, body: report.title ? issueBody(report, { runUrl }) : "" }, { client: github, dryRun: options.dryRun, log });
  const issueLine = {
    none: "No drift: no issue needed.",
    "dry-run": `Dry run: would open \`${report.title}\`.`,
    duplicate: `An issue titled \`${report.title}\` already exists (open or closed); not filing again.`,
    created: `Opened ${outcome.url ?? "an issue"}.`,
  }[outcome.action];
  const summary = `${report.summary}\n\n${issueLine}\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  else log(summary);
  return { report, outcome };
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`upstream-watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
