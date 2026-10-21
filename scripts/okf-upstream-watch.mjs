// Report drift in the upstream OKF specification: SPEC.md in its canonical repository, plus its
// sample bundles read through the built CLI. (MCP SDK drift arrives as Dependabot PRs instead.)
//
// Usage:
//   node scripts/okf-upstream-watch.mjs [--collect FILE | --dry-run]
//   node scripts/okf-upstream-watch.mjs report --input FILE [--dry-run]
//
// Two phases, so reading upstream content never shares a job with the issue-writing token:
//   collect   compares the latest SPEC.md commit with the reviewed pin and runs
//             `superbee status --json` on every upstream sample bundle. It only writes a small
//             JSON result file.
//   report    re-validates that JSON strictly, renders the Markdown summary, and opens at most one
//             deduplicated `upstream-drift` issue. It never reads upstream content directly.
// Without --collect or report, both phases run in one process for local use (pair with
// --dry-run, which prints the would-be issue instead of touching the tracker).
//
// The pin in scripts/okf-upstream-watch.json is bumped by humans after review; this script never
// writes it. Child processes take argv arrays (never a shell) and no credential variables.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PIN_PATH = path.join(repoRoot, "scripts", "okf-upstream-watch.json");
export const CLI_PATH = path.join(repoRoot, "packages", "superbee", "dist", "superbee.mjs");
export const LABEL = "upstream-drift";
const GITHUB_API = "https://api.github.com";
export const ISSUE_AUTHOR = "github-actions[bot]";
export const RESULT_SCHEMA = "superbee.okf-upstream-watch.result.v1";
export const LIMITS = Object.freeze({
  body: 60000, // GitHub rejects issue bodies above 65536 characters.
  inline: 200,
  files: 50,
  storedFiles: 1000,
  bundles: 100,
  log: 3000,
  error: 500,
  resultBytes: 2 * 1024 * 1024,
  jsonBytes: 5 * 1024 * 1024,
  tarballBytes: 100 * 1024 * 1024,
});
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ZWJ = String.fromCharCode(0x200d);

// ---------- untrusted text ----------

export function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}... (truncated, ${value.length} characters)`;
}

// Safe inside a code span in a GFM table cell: one line, no backticks, escaped pipes, no live
// mentions (a zero-width joiner follows each @), and no link, image, or HTML brackets.
export function sanitizeInline(text, max = LIMITS.inline) {
  return truncate(String(text ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "), max)
    .replaceAll("`", "'")
    .replaceAll("\\", "/")
    .replaceAll("|", "\\|")
    .replaceAll("@", `@${ZWJ}`)
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replaceAll("<", "(")
    .replaceAll(">", ")");
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

const shortHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 10);

// ---------- pin ----------

export function parsePin(text) {
  const pin = JSON.parse(text);
  const fail = (message) => { throw new Error(`scripts/okf-upstream-watch.json: ${message}`); };
  if (pin?.schema !== "superbee.okf-upstream-watch.v1") fail("unexpected schema");
  if (!REPO.test(pin.repo ?? "")) fail("repo must be owner/name");
  if (pin.path !== "SPEC.md") fail("path must be SPEC.md");
  if (!SHA.test(pin.commit ?? "")) fail("commit must be a full lowercase commit SHA");
  return pin;
}

// ---------- collect ----------

export function readStatusCounts(stdout) {
  let json;
  try { json = JSON.parse(stdout); } catch { return { parsed: false, docs: null, malformed: null, invalidTimestamps: null }; }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { parsed: false, docs: null, malformed: null, invalidTimestamps: null };
  const number = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    parsed: true,
    docs: number(json.docs),
    malformed: number(json.malformed),
    // The top-level count is omitted when zero; the row block carries the same total.
    invalidTimestamps: number(json.invalid_timestamps ?? json.invalid_timestamp_fields?.total ?? 0),
  };
}

// Never follows a link, so a dangling or looping symlink is counted rather than crashing.
export function countSymlinks(dir) {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) { count += 1; continue; }
    if (stat.isDirectory()) for (const name of readdirSync(current)) stack.push(path.join(current, name));
  }
  return count;
}

const lexists = (file) => { try { lstatSync(file); return true; } catch { return false; } };

export async function collectOkf({ pin, github, fetchTree, runStatus }) {
  const { repo, path: specPath } = pin;
  let tree;
  try {
    const sha = (rows, what) => {
      const value = Array.isArray(rows) ? rows[0]?.sha : undefined;
      if (!SHA.test(value ?? "")) throw new Error(`GitHub returned no commit SHA for ${what}`);
      return value;
    };
    const latestSpec = sha(await github(`/repos/${repo}/commits?path=${specPath}&per_page=1`), specPath);
    const head = sha(await github(`/repos/${repo}/commits?per_page=1`), "the default branch");
    let files = [];
    if (latestSpec !== pin.commit) {
      const compare = await github(`/repos/${repo}/compare/${pin.commit}...${latestSpec}`);
      files = (Array.isArray(compare?.files) ? compare.files : []).slice(0, LIMITS.storedFiles)
        .map((file) => truncate(String(file?.filename ?? ""), LIMITS.inline));
    }
    tree = await fetchTree(repo, head);
    const bundlesDir = path.join(tree.root, "bundles");
    const bundlesLinked = lexists(bundlesDir) && lstatSync(bundlesDir).isSymbolicLink();
    const names = lexists(bundlesDir) && !bundlesLinked
      ? readdirSync(bundlesDir).filter((name) => {
        const stat = lstatSync(path.join(bundlesDir, name));
        return stat.isDirectory() || stat.isSymbolicLink();
      }).sort()
      : [];
    if (names.length > LIMITS.bundles) throw new Error(`upstream has ${names.length} sample bundles; the watcher reads at most ${LIMITS.bundles}`);
    const bundles = [];
    for (const name of names) {
      const dir = path.join(bundlesDir, name);
      const symlinks = countSymlinks(dir);
      const base = { name: truncate(name, LIMITS.inline), symlinks };
      if (symlinks > 0) {
        bundles.push({ ...base, code: null, parsed: false, docs: null, malformed: null, invalidTimestamps: null, stderr: "" });
        continue;
      }
      const { code, stdout, stderr } = await runStatus(dir);
      bundles.push({ ...base, code, ...readStatusCounts(stdout), stderr: truncate(stderr, LIMITS.log) });
    }
    return { schema: RESULT_SCHEMA, status: "ok", latestSpec, head, files, bundlesLinked, bundles };
  } catch (error) {
    return { schema: RESULT_SCHEMA, status: "error", error: truncate(error instanceof Error ? error.message : String(error), LIMITS.error) };
  } finally {
    tree?.cleanup();
  }
}

// ---------- report: strict validation of the collected result ----------

export function validateResult(raw) {
  const fail = (message) => { throw new Error(`result rejected: ${message}`); };
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value, allowed, label) => {
    if (!isRecord(value)) fail(`${label} must be an object`);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} has unknown key ${sanitizeInline(key, 40)}`);
    for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  };
  const str = (value, max, label) => { if (typeof value !== "string" || value.length > max) fail(`${label} must be a string of at most ${max} characters`); return value; };
  const count = (value, label) => { if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 1e9)) fail(`${label} must be a non-negative integer or null`); return value; };
  const exit = (value, label) => { if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 255)) fail(`${label} must be an exit code or null`); return value; };
  const bool = (value, label) => { if (typeof value !== "boolean") fail(`${label} must be a boolean`); return value; };

  if (!isRecord(raw) || raw.schema !== RESULT_SCHEMA) fail("unknown schema");
  if (raw.status === "error") {
    keys(raw, ["schema", "status", "error"], "result");
    return { status: "error", error: str(raw.error, LIMITS.error + 60, "error") };
  }
  if (raw.status !== "ok") fail("unknown status");
  keys(raw, ["schema", "status", "latestSpec", "head", "files", "bundlesLinked", "bundles"], "result");
  if (!SHA.test(raw.latestSpec) || !SHA.test(raw.head)) fail("commit SHAs must be 40 lowercase hex characters");
  if (!Array.isArray(raw.files) || raw.files.length > LIMITS.storedFiles) fail("files must be a bounded array");
  if (!Array.isArray(raw.bundles) || raw.bundles.length > LIMITS.bundles) fail("bundles must be a bounded array");
  return {
    status: "ok", latestSpec: raw.latestSpec, head: raw.head,
    files: raw.files.map((file, i) => str(file, LIMITS.inline + 60, `files[${i}]`)),
    bundlesLinked: bool(raw.bundlesLinked, "bundlesLinked"),
    bundles: raw.bundles.map((bundle, i) => {
      const label = `bundles[${i}]`;
      keys(bundle, ["name", "symlinks", "code", "parsed", "docs", "malformed", "invalidTimestamps", "stderr"], label);
      return {
        name: str(bundle.name, LIMITS.inline + 60, `${label}.name`),
        symlinks: count(bundle.symlinks, `${label}.symlinks`) ?? fail(`${label}.symlinks must be an integer`),
        code: exit(bundle.code, `${label}.code`),
        parsed: bool(bundle.parsed, `${label}.parsed`),
        docs: count(bundle.docs, `${label}.docs`),
        malformed: count(bundle.malformed, `${label}.malformed`),
        invalidTimestamps: count(bundle.invalidTimestamps, `${label}.invalidTimestamps`),
        stderr: str(bundle.stderr, LIMITS.log + 60, `${label}.stderr`),
      };
    }),
  };
}

// ---------- report: rendering ----------

export function bundleReasons(bundle) {
  if (bundle.symlinks > 0) return [`contains ${bundle.symlinks} symbolic link(s); not read`];
  const reasons = [];
  if (bundle.code !== 0) reasons.push(`exit ${bundle.code ?? "unknown"}`);
  if (!bundle.parsed) reasons.push("status output is not a JSON object");
  else {
    if (bundle.docs === null || bundle.malformed === null || bundle.invalidTimestamps === null) reasons.push("status JSON is missing expected counts");
    if (bundle.docs === 0) reasons.push("no documents read");
    if (bundle.malformed > 0) reasons.push(`${bundle.malformed} malformed`);
    if (bundle.invalidTimestamps > 0) reasons.push(`${bundle.invalidTimestamps} invalid timestamps`);
  }
  return reasons;
}

// A persistent failure keeps one key across upstream commits until the failure set or pin changes.
export function conformanceKey(pinned, failures) {
  const lines = failures.map(({ name, reasons }) => `${name}\t${reasons.join("; ")}`).sort();
  return `okf-conformance:${pinned}:${shortHash(lines.join("\n"))}`;
}

export function renderOkf(result, pin) {
  if (result.status === "error") {
    return {
      kind: "error",
      summary: ["## OKF upstream watch", "", "**The watcher itself failed; this is not upstream drift.**", "", fence(result.error, LIMITS.error)].join("\n"),
      title: "Upstream watch failing: okf",
      key: "failing:okf",
      openOnly: true,
    };
  }
  const { repo, commit: pinned } = pin;
  const { latestSpec, head, files, bundles } = result;
  const specChanged = latestSpec !== pinned;
  const rows = bundles.map((bundle) => ({ ...bundle, reasons: bundleReasons(bundle) }));
  const failures = rows.filter((row) => row.reasons.length > 0);
  const noBundles = rows.length === 0;
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
  if (noBundles) lines.push(result.bundlesLinked ? "**`bundles/` is a symbolic link; nothing was read.**" : "**No sample bundles were found under `bundles/`.**");
  else {
    lines.push("| Bundle | Exit | Docs | Malformed | Invalid timestamps | Result |", "| --- | --- | --- | --- | --- | --- |");
    const cell = (value) => (value === null ? "-" : String(value));
    for (const row of rows) {
      const outcome = row.reasons.length ? `FAIL: ${row.reasons.join("; ")}` : "ok";
      lines.push(`| \`${sanitizeInline(row.name, 80)}\` | ${cell(row.code)} | ${cell(row.docs)} | ${cell(row.malformed)} | ${cell(row.invalidTimestamps)} | ${outcome} |`);
    }
    for (const row of failures.filter((r) => r.stderr.trim())) {
      lines.push("", `stderr from \`${sanitizeInline(row.name, 80)}\`:`, "", fence(row.stderr));
    }
  }
  const summary = lines.join("\n");
  if (specChanged) return { kind: "drift", summary, title: `Upstream drift: OKF SPEC.md at ${latestSpec.slice(0, 7)}`, key: `okf-spec:${latestSpec}` };
  if (failures.length > 0 || noBundles) {
    const key = conformanceKey(pinned, noBundles ? [{ name: "(none)", reasons: ["no sample bundles"] }] : failures);
    return { kind: "drift", summary, title: `Upstream drift: OKF sample bundle conformance (${key.slice(-10)})`, key };
  }
  return { kind: "ok", summary, title: null, key: null };
}

// ---------- issues ----------

export const marker = (key) => `<!-- upstream-watch:${key} -->`;

export function issueBody(report, { runUrl } = {}) {
  const footer = ["", "---"];
  if (report.kind === "error") {
    footer.push("Opened by `.github/workflows/okf-upstream-watch.yml` because the watcher could not complete. Fix the", "watcher or its environment; close this issue once a run succeeds.");
  } else {
    footer.push(
      "Opened by `.github/workflows/okf-upstream-watch.yml`. Review the upstream change, adapt Superbee if needed,",
      "and bump the reviewed pin in `scripts/okf-upstream-watch.json` in the same PR. Closing this issue",
      "suppresses a repeat of this exact drift.",
    );
  }
  if (runUrl) footer.push("", `Run: ${runUrl}`);
  return capBody(`${marker(report.key)}\n${report.summary}\n${footer.join("\n")}`);
}

export async function fileIssue(report, body, { client, dryRun, log }) {
  if (!report.title) return { action: "none" };
  if (dryRun) {
    log(`Dry run: would open issue (label ${LABEL}) unless one carrying ${marker(report.key)} exists.\nTitle: ${report.title}\n\n${body}\n`);
    return { action: "dry-run" };
  }
  await client.ensureLabel(LABEL);
  if (await client.hasMarker(report.key, { openOnly: Boolean(report.openOnly) })) return { action: "duplicate" };
  const created = await client.createIssue({ title: report.title, body, labels: [LABEL] });
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
    const url = new URL(route, GITHUB_API);
    if (url.origin !== GITHUB_API || !route.startsWith("/")) throw new Error("GitHub route must be a path on the GitHub API");
    const response = await fetchImpl(url.href, {
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
      await request(`/repos/${repo}/labels`, { method: "POST", body: { name: label, color: "c5def5", description: "The upstream OKF spec or its sample bundles changed; see scripts/okf-upstream-watch.json" } });
    },
    // Search finds the marker regardless of label; the labelled listing covers search-index lag.
    // Only an issue this workflow opened counts, and only with the marker as its first line: anyone
    // can quote a marker in their own issue, and upstream text can carry one into a body.
    async hasMarker(key, { openOnly = false } = {}) {
      needRepo();
      const needle = `${marker(key)}\n`;
      const matches = (row) => !row.pull_request && row.user?.login === ISSUE_AUTHOR && typeof row.body === "string"
        && row.body.startsWith(needle) && (!openOnly || row.state === "open");
      const query = `repo:${repo} is:issue in:body "upstream-watch:${key}"${openOnly ? " is:open" : ""}`;
      const search = await request(`/search/issues?q=${encodeURIComponent(query)}&per_page=100`);
      if ((search?.items ?? []).some(matches)) return true;
      for (let page = 1; page <= 10; page += 1) {
        const rows = await request(`/repos/${repo}/issues?state=${openOnly ? "open" : "all"}&labels=${encodeURIComponent(LABEL)}&per_page=100&page=${page}`);
        if (rows.some(matches)) return true;
        if (rows.length < 100) break;
      }
      return false;
    },
    async createIssue(issue) {
      needRepo();
      return request(`/repos/${repo}/issues`, { method: "POST", body: issue });
    },
  };
}

// Children read upstream files, so they never inherit credential-shaped variables or workflow
// command files. This is defense in depth: the job running them also holds no write permission.
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT|GITHUB_ENV|GITHUB_PATH/i.test(name)));
}

function run(file, argv, { timeout = 120000, cwd = repoRoot, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, argv, { cwd, env: childEnv(), timeout, maxBuffer: 64 * 1024 * 1024, shell: false }, (error, stdout, stderr) => {
      // A spawn failure or timeout has no numeric exit code; report it as exit 1 with its message.
      const spawnFailure = error && typeof error.code !== "number";
      const code = error ? (spawnFailure ? 1 : error.code) : 0;
      resolve({ code: Math.min(Math.max(code, 0), 255), stdout: String(stdout ?? ""), stderr: `${stderr ?? ""}${spawnFailure ? String(error.message) : ""}` });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

// Downloads the upstream tree at an exact SHA and extracts it into a fresh temporary directory
// from memory; the archive itself never touches disk. tar keeps its default refusal of absolute
// and `..` member names; symlinks are counted by the caller.
async function fetchTree(repo, sha, fetchImpl = globalThis.fetch) {
  const dir = mkdtempSync(path.join(tmpdir(), "upstream-okf-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const response = await fetchImpl(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`tarball download failed with HTTP ${response.status}`);
    const archive = await readBounded(response, LIMITS.tarballBytes);
    const extract = path.join(dir, "tree");
    mkdirSync(extract);
    const result = await run("tar", ["-xzf", "-", "-C", extract], { input: archive });
    if (result.code !== 0) throw new Error(`tar exited ${result.code}`);
    const tops = readdirSync(extract);
    if (tops.length !== 1 || !lstatSync(path.join(extract, tops[0])).isDirectory()) throw new Error("unexpected tarball layout");
    return { root: path.join(extract, tops[0]), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------- CLI ----------

export function parseArgs(argv) {
  const usage = "usage: okf-upstream-watch.mjs [--collect FILE | --dry-run] | report --input FILE [--dry-run]";
  const rest = [...argv];
  const options = { command: "collect", dryRun: false, collect: null, input: null };
  if (rest[0] === "report") { options.command = "report"; rest.shift(); }
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--collect" && options.command === "collect" && rest[0]) options.collect = rest.shift();
    else if (flag === "--input" && options.command === "report" && rest[0]) options.input = rest.shift();
    else throw new Error(`unknown option ${flag}; ${usage}`);
  }
  if (options.command === "report" && !options.input) throw new Error(usage);
  if (options.collect && options.dryRun) throw new Error("--collect writes a result only; --dry-run applies to report");
  return options;
}

export async function report(raw, pin, env, deps, { dryRun }) {
  let result;
  try { result = validateResult(raw); } catch (error) { result = { status: "error", error: error.message }; }
  const rendered = renderOkf(result, pin);
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
  const log = deps.log ?? ((text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`));
  const client = deps.client ?? createGitHub({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY });
  const body = rendered.title ? issueBody(rendered, { runUrl }) : "";
  const outcome = await fileIssue(rendered, body, { client, dryRun, log });
  const issueLine = {
    none: "No drift: no issue needed.",
    "dry-run": `Dry run: would open \`${rendered.title}\`.`,
    duplicate: `An issue for this exact ${rendered.kind === "error" ? "watcher failure" : "drift"} already exists; not filing again.`,
    created: `Opened ${outcome.url ?? "an issue"}.`,
  }[outcome.action];
  const summary = `${rendered.summary}\n\n${issueLine}\n`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  else log(summary);
  return { rendered, outcome };
}

// Size and type are checked on the open descriptor that is then read, so the file cannot change
// between the check and the read.
function readResultFile(file) {
  const failed = (error) => ({ schema: RESULT_SCHEMA, status: "error", error });
  let fd;
  try { fd = openSync(file, "r"); } catch { return failed("the check job wrote no result"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMITS.resultBytes) return failed("the result file is too large");
    try { return JSON.parse(readFileSync(fd, "utf8")); } catch { return failed("the result file is not JSON"); }
  } finally {
    closeSync(fd);
  }
}

export async function main(argv, env = process.env, deps = {}) {
  const options = parseArgs(argv);
  const pin = parsePin(readFileSync(PIN_PATH, "utf8"));
  if (options.command === "report") return report(readResultFile(options.input), pin, env, deps, { dryRun: options.dryRun });
  if (!deps.runStatus && !existsSync(CLI_PATH)) throw new Error("built CLI is missing; run npm run build first");
  const result = await collectOkf({
    pin,
    github: (deps.github ?? createGitHub({ token: env.GITHUB_TOKEN })).get,
    fetchTree: deps.fetchTree ?? ((repo, sha) => fetchTree(repo, sha)),
    runStatus: deps.runStatus ?? ((dir) => run(process.execPath, [CLI_PATH, "status", "--json", "--dir", dir], { cwd: tmpdir() })),
  });
  if (options.collect) {
    mkdirSync(path.dirname(path.resolve(options.collect)), { recursive: true });
    writeFileSync(options.collect, `${JSON.stringify(result)}\n`);
    return { result };
  }
  // Local single-process mode still round-trips through JSON and the report-side validator.
  return report(JSON.parse(JSON.stringify(result)), pin, env, deps, { dryRun: options.dryRun });
}

if (isMainModule(import.meta.url)) {
  // A watcher failure files its own issue and still fails the run, so it is never a silent green.
  main(process.argv.slice(2)).then((outcome) => {
    if (outcome?.rendered?.kind === "error") process.exitCode = 1;
  }, (error) => {
    process.stderr.write(`okf-upstream-watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
