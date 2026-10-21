// Report drift in the upstream specifications Superbee depends on: the OKF spec (SPEC.md in its
// canonical repository, plus its sample bundles read through the built CLI) and the MCP SDK
// packages used by @superbee/mcp-app.
//
// Usage:
//   node scripts/upstream-watch.mjs okf [--collect FILE | --dry-run]
//   node scripts/upstream-watch.mjs mcp [--verify] [--collect FILE | --dry-run]
//   node scripts/upstream-watch.mjs report <okf|mcp> --input FILE [--dry-run]
//
// Two phases, so untrusted work never shares a job with the issue-writing token:
//   collect   (okf, mcp with --collect) reads upstream data and, for mcp --verify, installs and
//             tests newer packages. It only writes a small JSON result file.
//   report    re-validates that JSON strictly against the reviewed pins, renders the Markdown
//             summary, and opens at most one deduplicated `upstream-drift` issue. It never reads
//             upstream content directly or runs upstream code.
// Without --collect, okf and mcp run both phases in one process for local use (pair with
// --dry-run, which prints the would-be issue instead of touching the tracker).
//
// Pins in scripts/upstream-watch.json are bumped by humans after review; this script never
// writes them. Child processes take argv arrays (never a shell) and no credential variables.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";
import { compareStrictSemver, parseStrictSemver } from "./strict-semver.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PINS_PATH = path.join(repoRoot, "scripts", "upstream-watch.json");
export const CLI_PATH = path.join(repoRoot, "packages", "superbee", "dist", "superbee.mjs");
export const LABEL = "upstream-drift";
export const RESULT_SCHEMA = "superbee.upstream-watch.result.v1";
export const MCP_WORKSPACE = "@superbee/mcp-app";
export const INSTALL_LABEL = "npm install (mcp-app, --ignore-scripts)";
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
const PACKAGE = /^@[a-z0-9-]+\/[a-z0-9.-]+$/;
const ZWJ = String.fromCharCode(0x200d);

// ---------- untrusted text ----------

export function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}... (truncated, ${value.length} characters)`;
}

// Safe inside a code span in a GFM table cell: one line, no backticks, escaped pipes, no live
// mentions (a zero-width joiner follows each @), and no link or image brackets.
export function sanitizeInline(text, max = LIMITS.inline) {
  return truncate(String(text ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " "), max)
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

// ---------- collect: OKF ----------

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

const errorResult = (target, error) => ({
  schema: RESULT_SCHEMA,
  target,
  status: "error",
  error: truncate(error instanceof Error ? error.message : String(error), LIMITS.error),
});

export async function collectOkf({ pins, github, fetchTree, runStatus }) {
  const { repo, path: specPath } = pins.okf;
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
    if (latestSpec !== pins.okf.commit) {
      const compare = await github(`/repos/${repo}/compare/${pins.okf.commit}...${latestSpec}`);
      files = (Array.isArray(compare?.files) ? compare.files : []).slice(0, LIMITS.storedFiles)
        .map((file) => truncate(String(file?.filename ?? ""), LIMITS.inline));
    }
    tree = await fetchTree(repo, head);
    const bundlesDir = path.join(tree.root, "bundles");
    const lexists = (file) => { try { lstatSync(file); return true; } catch { return false; } };
    const bundlesLinked = lexists(bundlesDir) && lstatSync(bundlesDir).isSymbolicLink();
    const names = lexists(bundlesDir) && !bundlesLinked
      ? readdirSync(bundlesDir).filter((name) => {
        const stat = lstatSync(path.join(bundlesDir, name));
        return stat.isDirectory() || stat.isSymbolicLink();
      }).sort().slice(0, LIMITS.bundles)
      : [];
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
      const counts = readStatusCounts(stdout);
      bundles.push({ ...base, code, ...counts, stderr: truncate(stderr, LIMITS.log) });
    }
    return { schema: RESULT_SCHEMA, target: "okf", status: "ok", latestSpec, head, files, bundlesLinked, bundles };
  } catch (error) {
    return errorResult("okf", error);
  } finally {
    tree?.cleanup();
  }
}

// ---------- collect: MCP ----------

// Only a strictly greater stable release counts; prereleases and equal versions never do.
export function isNewerStable(candidate, pinned) {
  const parsed = parseStrictSemver(candidate);
  if (!parsed || parsed.prerelease !== null) return false;
  return compareStrictSemver(candidate, pinned) === 1;
}

export function newerPackages(pins, latest) {
  return Object.entries(pins.mcp)
    .filter(([name, pinned]) => isNewerStable(latest[name], pinned))
    .map(([name]) => ({ name, version: latest[name] }));
}

export function verificationSteps(updates) {
  return [
    { label: INSTALL_LABEL, argv: ["install", "--no-audit", "--no-fund", "--ignore-scripts", "-w", MCP_WORKSPACE, ...updates.map((u) => `${u.name}@${u.version}`)] },
    { label: "npm run build", argv: ["run", "build"] },
    { label: "npm run typecheck", argv: ["run", "typecheck"] },
    { label: `npm test -w ${MCP_WORKSPACE}`, argv: ["test", "-w", MCP_WORKSPACE] },
  ];
}
const STEP_LABELS = new Set(verificationSteps([]).map((step) => step.label));

export async function collectMcp({ pins, npmView, runNpm, verify }) {
  try {
    const latest = {};
    for (const name of Object.keys(pins.mcp)) latest[name] = truncate(String(await npmView(name)).trim(), 64);
    const packages = Object.keys(pins.mcp).map((name) => ({ name, latest: latest[name] }));
    const updates = newerPackages(pins, latest);
    let verification = null;
    if (verify && updates.length > 0) {
      verification = [];
      // Versions reaching argv passed isNewerStable, so they are strict semver.
      for (const step of verificationSteps(updates)) {
        const result = await runNpm(step.argv);
        verification.push({ label: step.label, code: result.code, output: truncate(`${result.stdout}\n${result.stderr}`.slice(-LIMITS.log), LIMITS.log) });
        if (result.code !== 0) break;
      }
    }
    return { schema: RESULT_SCHEMA, target: "mcp", status: "ok", packages, verification };
  } catch (error) {
    return errorResult("mcp", error);
  }
}

// ---------- report: strict validation of the collected result ----------

export function validateResult(raw, pins, target) {
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
  if (raw.target !== target) fail("target mismatch");
  if (raw.status === "error") {
    keys(raw, ["schema", "target", "status", "error"], "result");
    return { target, status: "error", error: str(raw.error, LIMITS.error + 60, "error") };
  }
  if (raw.status !== "ok") fail("unknown status");
  if (target === "okf") {
    keys(raw, ["schema", "target", "status", "latestSpec", "head", "files", "bundlesLinked", "bundles"], "result");
    if (!SHA.test(raw.latestSpec) || !SHA.test(raw.head)) fail("commit SHAs must be 40 lowercase hex characters");
    if (!Array.isArray(raw.files) || raw.files.length > LIMITS.storedFiles) fail("files must be a bounded array");
    if (!Array.isArray(raw.bundles) || raw.bundles.length > LIMITS.bundles) fail("bundles must be a bounded array");
    return {
      target, status: "ok", latestSpec: raw.latestSpec, head: raw.head,
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
  keys(raw, ["schema", "target", "status", "packages", "verification"], "result");
  const expected = Object.keys(pins.mcp);
  if (!Array.isArray(raw.packages) || raw.packages.length !== expected.length) fail("packages must list every pinned package");
  const packages = raw.packages.map((row, i) => {
    keys(row, ["name", "latest"], `packages[${i}]`);
    if (row.name !== expected[i]) fail(`packages[${i}] is not the pinned package in pin order`);
    return { name: row.name, latest: str(row.latest, 64 + 60, `packages[${i}].latest`) };
  });
  let verification = null;
  if (raw.verification !== null) {
    if (!Array.isArray(raw.verification) || raw.verification.length === 0 || raw.verification.length > STEP_LABELS.size) fail("verification must be null or a bounded array");
    verification = raw.verification.map((step, i) => {
      keys(step, ["label", "code", "output"], `verification[${i}]`);
      if (!STEP_LABELS.has(step.label)) fail(`verification[${i}] has an unknown step`);
      const code = exit(step.code, `verification[${i}].code`);
      if (code === null) fail(`verification[${i}].code must be an integer`);
      return { label: step.label, code, output: str(step.output, LIMITS.log + 60, `verification[${i}].output`) };
    });
  }
  return { target, status: "ok", packages, verification };
}

// ---------- report: rendering ----------

export function bundleReasons(bundle) {
  const reasons = [];
  if (bundle.symlinks > 0) return [`contains ${bundle.symlinks} symbolic link(s); not read`];
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

function watcherError(target, message) {
  return {
    kind: "error",
    summary: [`## ${target.toUpperCase()} upstream watch`, "", "**The watcher itself failed; this is not upstream drift.**", "", fence(message, LIMITS.error)].join("\n"),
    title: `Upstream watch failing: ${target}`,
    key: `failing:${target}`,
    openOnly: true,
  };
}

export function renderOkf(result, pins) {
  if (result.status === "error") return watcherError("okf", result.error);
  const { repo, commit: pinned } = pins.okf;
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
  const failed = failures.length > 0 || noBundles;
  const summary = lines.join("\n");
  if (specChanged) return { kind: "drift", summary, title: `Upstream drift: OKF SPEC.md at ${latestSpec.slice(0, 7)}`, key: `okf-spec:${latestSpec}` };
  if (failed) {
    const key = conformanceKey(pinned, noBundles ? [{ name: "(none)", reasons: ["no sample bundles"] }] : failures);
    return { kind: "drift", summary, title: `Upstream drift: OKF sample bundle conformance (${key.slice(-10)})`, key };
  }
  return { kind: "ok", summary, title: null, key: null };
}

// Registry, network, and API failures say nothing about compatibility.
const INFRASTRUCTURE = /\b(E(?:AI_AGAIN|CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|NETUNREACH|TARGET|404|403|429|5\d\d)|ETIMEDOUT|socket hang up|fetch failed|network (?:request|error)|registry\.npmjs\.org.*\b(?:5\d\d|429)\b)/;
export function isInfrastructureFailure(step) {
  return step.label === INSTALL_LABEL && step.code !== 0 && INFRASTRUCTURE.test(step.output);
}

export function renderMcp(result, pins) {
  if (result.status === "error") return watcherError("mcp", result.error);
  const latest = Object.fromEntries(result.packages.map((row) => [row.name, row.latest]));
  const updates = newerPackages(pins, latest);
  const lines = ["## MCP upstream watch", "", "| Package | Reviewed pin | npm latest | Status |", "| --- | --- | --- | --- |"];
  for (const [name, pinned] of Object.entries(pins.mcp)) {
    const value = latest[name];
    const valid = parseStrictSemver(value) !== undefined;
    const status = !valid ? "unreadable version" : isNewerStable(value, pinned) ? "**newer**" : "current";
    lines.push(`| \`${name}\` | ${pinned} | ${valid ? value : `\`${sanitizeInline(value, 60)}\``} | ${status} |`);
  }
  if (updates.length === 0) return { kind: "ok", summary: lines.join("\n"), title: null, key: null };
  const verification = result.verification;
  const failing = verification?.find((step) => step.code !== 0);
  if (failing && isInfrastructureFailure(failing)) {
    return watcherError("mcp", `${failing.label} failed for a registry or network reason:\n${failing.output.slice(-LIMITS.error)}`);
  }
  lines.push("");
  if (!verification) lines.push("Verification against the newer versions was skipped (run with `--verify`).");
  else {
    lines.push(`Verification with ${updates.map((u) => `\`${u.name}@${u.version}\``).join(", ")} installed into \`${MCP_WORKSPACE}\` (not committed):`, "");
    lines.push("| Step | Exit |", "| --- | --- |");
    for (const step of verification) lines.push(`| \`${step.label}\` | ${step.code} |`);
    if (failing) lines.push("", `Output tail from \`${failing.label}\`:`, "", fence(failing.output.slice(-LIMITS.log)));
    else lines.push("", "All verification steps passed.");
  }
  const names = updates.map((u) => `${u.name}@${u.version}`).join(",");
  return {
    kind: "drift",
    summary: lines.join("\n"),
    title: `Upstream drift: ${updates.map((u) => `${u.name} ${u.version}`).join(", ")}`,
    key: `mcp:${names}`,
  };
}

// ---------- issues ----------

export const marker = (key) => `<!-- upstream-watch:${key} -->`;

export function issueBody(report, { runUrl } = {}) {
  const footer = ["", "---"];
  if (report.kind === "error") {
    footer.push("Opened by `.github/workflows/upstream-watch.yml` because the watcher could not complete. Fix the", "watcher or its environment; close this issue once a run succeeds.");
  } else {
    footer.push(
      "Opened by `.github/workflows/upstream-watch.yml`. Review the upstream change, adapt Superbee if needed,",
      "and bump the reviewed pin in `scripts/upstream-watch.json` in the same PR. Closing this issue",
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
    // Search finds the marker regardless of label; the labelled listing covers search-index lag.
    async hasMarker(key, { openOnly = false } = {}) {
      needRepo();
      const needle = marker(key);
      const matches = (row) => !row.pull_request && typeof row.body === "string" && row.body.includes(needle) && (!openOnly || row.state === "open");
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

// Children run upstream code (a newer SDK under test) or read upstream files, so they never
// inherit credential-shaped variables. This is defense in depth: the job running them also holds
// no write permission.
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT|GITHUB_ENV|GITHUB_PATH/i.test(name)));
}

function run(file, argv, { timeout = 30 * 60 * 1000, cwd = repoRoot } = {}) {
  return new Promise((resolve) => {
    execFile(file, argv, { cwd, env: childEnv(), timeout, maxBuffer: 64 * 1024 * 1024, shell: false }, (error, stdout, stderr) => {
      // A spawn failure or timeout has no numeric exit code; report it as exit 1 with its message.
      const spawnFailure = error && typeof error.code !== "number";
      const code = error ? (spawnFailure ? 1 : error.code) : 0;
      resolve({ code: Math.min(Math.max(code, 0), 255), stdout: String(stdout ?? ""), stderr: `${stderr ?? ""}${spawnFailure ? String(error.message) : ""}` });
    });
  });
}

// Downloads the upstream tree at an exact SHA into a fresh temporary directory. tar keeps its
// default refusal of absolute and `..` member names; symlinks are counted by the caller.
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
    if (tops.length !== 1 || !lstatSync(path.join(extract, tops[0])).isDirectory()) throw new Error("unexpected tarball layout");
    return { root: path.join(extract, tops[0]), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------- CLI ----------

export function parseArgs(argv) {
  const usage = "usage: upstream-watch.mjs okf|mcp [--verify] [--collect FILE | --dry-run] | report okf|mcp --input FILE [--dry-run]";
  const [command, ...rest] = argv;
  const options = { command, target: command, dryRun: false, verify: false, collect: null, input: null };
  if (command === "report") {
    options.target = rest.shift();
    if (options.target !== "okf" && options.target !== "mcp") throw new Error(usage);
  } else if (command !== "okf" && command !== "mcp") throw new Error(usage);
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--verify" && command === "mcp") options.verify = true;
    else if (flag === "--collect" && command !== "report" && rest[0]) options.collect = rest.shift();
    else if (flag === "--input" && command === "report" && rest[0]) options.input = rest.shift();
    else throw new Error(`unknown option ${flag}; ${usage}`);
  }
  if (command === "report" && !options.input) throw new Error(usage);
  if (options.collect && options.dryRun) throw new Error("--collect writes a result only; --dry-run applies to report");
  return options;
}

async function collect(options, pins, env, deps) {
  if (options.target === "okf") {
    if (!deps.runStatus && !existsSync(CLI_PATH)) throw new Error("built CLI is missing; run npm run build first");
    const github = deps.github ?? createGitHub({ token: env.GITHUB_TOKEN });
    return collectOkf({
      pins,
      github: github.get,
      fetchTree: deps.fetchTree ?? ((repo, sha) => fetchTree(repo, sha)),
      runStatus: deps.runStatus ?? ((dir) => run(process.execPath, [CLI_PATH, "status", "--json", "--dir", dir], { timeout: 120000, cwd: tmpdir() })),
    });
  }
  return collectMcp({
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

export async function report(target, raw, pins, env, deps, { dryRun }) {
  let result;
  try { result = validateResult(raw, pins, target); } catch (error) { result = { status: "error", error: error.message }; }
  const rendered = target === "okf" ? renderOkf(result, pins) : renderMcp(result, pins);
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

function readResultFile(file) {
  if (!existsSync(file)) return { schema: RESULT_SCHEMA, status: "missing" };
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > LIMITS.resultBytes) return { schema: RESULT_SCHEMA, status: "oversize" };
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { schema: RESULT_SCHEMA, status: "unparseable" }; }
}

export async function main(argv, env = process.env, deps = {}) {
  const options = parseArgs(argv);
  const pins = parsePins(readFileSync(PINS_PATH, "utf8"));
  if (options.command === "report") {
    const raw = readResultFile(options.input);
    const missing = { missing: "the check job wrote no result", oversize: "the result file is too large", unparseable: "the result file is not JSON" }[raw.status];
    const input = missing ? { schema: RESULT_SCHEMA, target: options.target, status: "error", error: missing } : raw;
    return report(options.target, input, pins, env, deps, { dryRun: options.dryRun });
  }
  const result = await collect(options, pins, env, deps);
  if (options.collect) {
    mkdirSync(path.dirname(path.resolve(options.collect)), { recursive: true });
    writeFileSync(options.collect, `${JSON.stringify(result)}\n`);
    return { result };
  }
  // Local single-process mode still round-trips through JSON and the report-side validator.
  return report(options.target, JSON.parse(JSON.stringify(result)), pins, env, deps, { dryRun: options.dryRun });
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`upstream-watch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
