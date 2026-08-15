// Capture the repository settings a release depends on, in a shape the release packet can compare.
//
// The packet retains two captures — a baseline and a recheck — and proves they agree. That is only
// meaningful if the captures are (a) produced by something, (b) constrained by a schema, and (c)
// stripped of the fields a live API changes on its own. `gh api repos/OWNER/NAME` returns push
// timestamps, star counts and sizes that differ between any two calls, so this producer projects
// the response onto a fixed, release-relevant key set: volatile fields cannot reach the evidence
// because they are never copied into it.
//
// Each capture records the instant it was taken. Two captures of the same repository therefore
// always differ in `capture.captured_at`, which is how the packet tells a genuine recheck from the
// same file supplied twice.
//
// Usage:
//   node scripts/release-settings-capture.mjs --repo OWNER/NAME --out settings-baseline.json
//   node scripts/release-settings-capture.mjs --repo OWNER/NAME --source captured.json --out -
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { isMainModule } from "./is-main-module.mjs";

const execFileAsync = promisify(execFile);

export const RELEASE_SETTINGS_SCHEMA = "superbee.release-settings.v2";
// The settings that decide who can see, copy, or publish from this repository, and where releases
// come from. Merge-strategy and cosmetic fields are deliberately absent: they carry no release
// authority, and every extra key is one more way for an honest edit to look like drift.
export const CAPTURED_SETTINGS_KEYS = Object.freeze({
  allow_forking: "boolean",
  archived: "boolean",
  default_branch: "string",
  delete_branch_on_merge: "boolean",
  disabled: "boolean",
  fork: "boolean",
  has_discussions: "boolean",
  has_downloads: "boolean",
  has_issues: "boolean",
  has_pages: "boolean",
  has_projects: "boolean",
  has_wiki: "boolean",
  is_template: "boolean",
  private: "boolean",
  visibility: "string",
  web_commit_signoff_required: "boolean",
});
export const CAPTURED_REPOSITORY_KEYS = Object.freeze({ full_name: "string", id: "number", node_id: "string" });
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function captureError(message) {
  throw new Error(`release settings capture failed: ${message}`);
}

function project(payload, keys, label, fail) {
  const projected = {};
  for (const [key, type] of Object.entries(keys)) {
    const value = payload?.[key];
    if (typeof value !== type || (type === "number" && !Number.isSafeInteger(value)) || (type === "string" && value === "")) {
      fail(`${label} is missing or malformed: ${key}=${JSON.stringify(value)}`);
    }
    projected[key] = value;
  }
  return projected;
}

export function repositoryEndpoint(repository) {
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    captureError(`--repo must be OWNER/NAME, got ${JSON.stringify(repository)}`);
  }
  return `repos/${repository}`;
}

/** Project a `gh api repos/OWNER/NAME` response onto the pinned, non-volatile evidence shape. */
export function normalizeRepositorySettings(payload, { endpoint, capturedAt, fail = captureError } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("repository API response must be an object");
  if (typeof endpoint !== "string" || !endpoint.startsWith("repos/")) fail(`capture endpoint must be repos/OWNER/NAME, got ${JSON.stringify(endpoint)}`);
  if (typeof capturedAt !== "string" || !CAPTURED_AT.test(capturedAt)) fail(`capture timestamp must be an RFC 3339 UTC instant, got ${JSON.stringify(capturedAt)}`);
  const repository = project(payload, CAPTURED_REPOSITORY_KEYS, "repository identity", fail);
  if (`repos/${repository.full_name}` !== endpoint) {
    fail(`capture endpoint ${endpoint} does not name the captured repository ${repository.full_name}`);
  }
  return {
    schema: RELEASE_SETTINGS_SCHEMA,
    capture: { captured_at: capturedAt, endpoint },
    repository,
    settings: project(payload, CAPTURED_SETTINGS_KEYS, "repository settings", fail),
  };
}

/**
 * Validate a retained capture. Exported so the release packet enforces exactly the shape this
 * producer emits, rather than restating the schema somewhere else.
 */
export function validateReleaseSettingsCapture(value, label, fail = captureError) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (JSON.stringify(keys) !== JSON.stringify(["schema", "capture", "repository", "settings"])) {
    fail(`${label} keys differ (expected: schema,capture,repository,settings; actual: ${keys.join(",")})`);
  }
  if (value.schema !== RELEASE_SETTINGS_SCHEMA) fail(`${label} schema is not ${RELEASE_SETTINGS_SCHEMA}`);
  const capture = value.capture;
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) fail(`${label} capture must be an object`);
  const normalized = normalizeRepositorySettings(
    { ...value.repository, ...value.settings },
    { endpoint: capture.endpoint, capturedAt: capture.captured_at, fail: (message) => fail(`${label} ${message}`) },
  );
  // Byte-for-byte this producer's output: retained evidence is exactly what the capture wrote,
  // so key order carries no information a re-serialization could legitimately change.
  if (JSON.stringify(normalized) !== JSON.stringify(value)) fail(`${label} is not this producer's normalized output`);
  return normalized;
}

/** Order two captures of the same repository, refusing a "recheck" that is the baseline again. */
export function assertSettingsRecheckFollows(baseline, recheck, fail = captureError) {
  if (baseline.capture.endpoint !== recheck.capture.endpoint) {
    fail(`settings baseline captured ${baseline.capture.endpoint} but the recheck captured ${recheck.capture.endpoint}`);
  }
  if (!(Date.parse(recheck.capture.captured_at) > Date.parse(baseline.capture.captured_at))) {
    fail(`settings recheck must be captured after the baseline (baseline ${baseline.capture.captured_at}, recheck ${recheck.capture.captured_at})`);
  }
}

async function ghRepository(endpoint) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("gh", ["api", "-H", "Accept: application/vnd.github+json", endpoint], { maxBuffer: 20 * 1024 * 1024 }));
  } catch (error) {
    captureError(`gh api ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    captureError(`gh api ${endpoint} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function captureRepositorySettings({ repository, source, now = () => new Date(), api = ghRepository, read = readFile }) {
  const endpoint = repositoryEndpoint(repository);
  let payload;
  if (source === undefined) {
    payload = await api(endpoint);
  } else {
    let text;
    try {
      text = source === "-" ? await readStdin() : await read(source, "utf8");
    } catch (error) {
      captureError(`cannot read --source ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      payload = JSON.parse(text);
    } catch (error) {
      captureError(`--source ${source} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return normalizeRepositorySettings(payload, { endpoint, capturedAt: now().toISOString() });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function parseCaptureArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--repo" && flag !== "--out" && flag !== "--source") throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    const name = flag === "--repo" ? "repository" : flag.slice(2);
    if (parsed[name]) throw new Error(`repeated ${flag}`);
    parsed[name] = value;
    index += 1;
  }
  if (!parsed.repository || !parsed.out) {
    throw new Error("usage: release-settings-capture.mjs --repo <OWNER/NAME> --out <file|-> [--source <file|->]");
  }
  return parsed;
}

if (isMainModule(import.meta.url)) {
  try {
    const args = parseCaptureArgs(process.argv.slice(2));
    const capture = await captureRepositorySettings(args);
    const text = `${JSON.stringify(capture, null, 2)}\n`;
    if (args.out === "-") process.stdout.write(text);
    else await writeFile(args.out, text, { flag: "wx" });
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
