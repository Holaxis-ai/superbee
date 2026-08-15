import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CAPTURED_SETTINGS_KEYS,
  RELEASE_SETTINGS_SCHEMA,
  assertSettingsRecheckFollows,
  captureRepositorySettings,
  normalizeRepositorySettings,
  parseCaptureArgs,
  validateReleaseSettingsCapture,
} from "./release-settings-capture.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capturePath = path.join(repoRoot, "scripts", "release-settings-capture.mjs");
const REPOSITORY = "capture-test-org/capture-test-repo";

// The volatile half of a real `gh api repos/OWNER/NAME` response: fields that differ between two
// calls seconds apart, and which therefore must never reach the retained evidence.
const VOLATILE_FIELDS = {
  pushed_at: "2026-08-15T04:00:00Z",
  updated_at: "2026-08-15T03:59:00Z",
  created_at: "2026-01-02T00:00:00Z",
  size: 91234,
  stargazers_count: 12,
  watchers_count: 12,
  forks_count: 1,
  open_issues_count: 4,
  subscribers_count: 2,
  network_count: 1,
  etag: "W/\"abc\"",
};

function payload(overrides = {}) {
  const settings = {
    allow_forking: false,
    archived: false,
    default_branch: "main",
    delete_branch_on_merge: false,
    disabled: false,
    fork: false,
    has_discussions: false,
    has_downloads: false,
    has_issues: false,
    has_pages: false,
    has_projects: true,
    has_wiki: false,
    is_template: false,
    private: true,
    visibility: "private",
    web_commit_signoff_required: false,
  };
  return { full_name: REPOSITORY, id: 42, node_id: "R_kgDOCaptureTest", ...VOLATILE_FIELDS, ...settings, ...overrides };
}

async function currentRepositorySlug() {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    return /github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(stdout)?.groups?.slug ?? null;
  } catch {
    return null;
  }
}

test("the capture projects a repository response onto the pinned, non-volatile settings", async () => {
  const capture = await captureRepositorySettings({
    repository: REPOSITORY,
    api: async () => payload(),
    now: () => new Date("2026-08-15T04:00:00.000Z"),
  });
  assert.deepEqual(Object.keys(capture), ["schema", "capture", "repository", "settings"]);
  assert.equal(capture.schema, RELEASE_SETTINGS_SCHEMA);
  assert.deepEqual(capture.capture, { captured_at: "2026-08-15T04:00:00.000Z", endpoint: `repos/${REPOSITORY}` });
  assert.deepEqual(capture.repository, { full_name: REPOSITORY, id: 42, node_id: "R_kgDOCaptureTest" });
  assert.deepEqual(Object.keys(capture.settings), Object.keys(CAPTURED_SETTINGS_KEYS));
  for (const field of Object.keys(VOLATILE_FIELDS)) {
    assert.equal(Object.hasOwn(capture.settings, field), false, `${field} must not reach the evidence`);
  }
  assert.deepEqual(validateReleaseSettingsCapture(capture, "capture"), capture);
});

test("two captures of an unchanged repository differ only in the instant they were taken", async () => {
  const first = await captureRepositorySettings({ repository: REPOSITORY, api: async () => payload(), now: () => new Date("2026-08-15T04:00:00.000Z") });
  const second = await captureRepositorySettings({
    repository: REPOSITORY,
    // A live API moves these on its own between two calls; the evidence must not move with them.
    api: async () => payload({ pushed_at: "2026-08-15T04:10:00Z", size: 91240, stargazers_count: 13 }),
    now: () => new Date("2026-08-15T04:10:00.000Z"),
  });
  assert.deepEqual(second.settings, first.settings);
  assert.deepEqual(second.repository, first.repository);
  assert.notEqual(second.capture.captured_at, first.capture.captured_at);
  assertSettingsRecheckFollows(first, second);
  assert.throws(() => assertSettingsRecheckFollows(second, first), /must be captured after the baseline/);
  assert.throws(() => assertSettingsRecheckFollows(first, first), /must be captured after the baseline/);
});

test("the capture fails closed on partial, mistyped, misattributed, and forged evidence", async () => {
  const at = { endpoint: `repos/${REPOSITORY}`, capturedAt: "2026-08-15T04:00:00.000Z" };
  const { private: _dropped, ...missingSetting } = payload();
  assert.throws(() => normalizeRepositorySettings(missingSetting, at), /repository settings is missing or malformed: private/);
  assert.throws(() => normalizeRepositorySettings(payload({ visibility: 7 }), at), /malformed: visibility=7/);
  assert.throws(() => normalizeRepositorySettings(payload({ default_branch: "" }), at), /malformed: default_branch=""/);
  assert.throws(() => normalizeRepositorySettings(payload({ id: 1.5 }), at), /malformed: id=1\.5/);
  assert.throws(() => normalizeRepositorySettings(payload({ full_name: "other-org/other-repo" }), at), /does not name the captured repository/);
  assert.throws(() => normalizeRepositorySettings(payload(), { ...at, capturedAt: "2026-08-15" }), /RFC 3339 UTC instant/);
  assert.throws(() => normalizeRepositorySettings("not-an-object", at), /must be an object/);

  const capture = await captureRepositorySettings({ repository: REPOSITORY, api: async () => payload(), now: () => new Date(at.capturedAt) });
  assert.throws(() => validateReleaseSettingsCapture({ ...capture, extra: true }, "evidence"), /keys differ/);
  assert.throws(
    () => validateReleaseSettingsCapture({ ...capture, settings: { ...capture.settings, pushed_at: "2026-08-15T04:00:00Z" } }, "evidence"),
    /is not this producer's normalized output/,
  );
  assert.throws(() => validateReleaseSettingsCapture({ ...capture, schema: "superbee.release-settings.v1" }, "evidence"), /schema is not/);
});

test("the capture CLI writes producer output and refuses to overwrite or guess", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-settings-cli-"));
  try {
    assert.throws(() => parseCaptureArgs(["--repo", REPOSITORY]), /usage: release-settings-capture\.mjs/);
    assert.throws(() => parseCaptureArgs(["--repo", REPOSITORY, "--out", "x", "--bogus", "y"]), /unknown argument/);
    assert.deepEqual(parseCaptureArgs(["--repo", REPOSITORY, "--out", "x", "--source", "y"]), { repository: REPOSITORY, out: "x", source: "y" });

    const source = path.join(root, "api.json");
    const out = path.join(root, "settings-baseline.json");
    await writeFile(source, JSON.stringify(payload()));
    await execFileAsync(process.execPath, [capturePath, "--repo", REPOSITORY, "--source", source, "--out", out]);
    const written = JSON.parse(await readFile(out, "utf8"));
    assert.deepEqual(validateReleaseSettingsCapture(written, "written"), written);

    await assert.rejects(
      execFileAsync(process.execPath, [capturePath, "--repo", REPOSITORY, "--source", source, "--out", out]),
      /EEXIST|already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Standard: do not harden a path you have not run. When gh is available and authorized, take two
// real captures of this repository and prove the normalization holds against the live API.
test("two live captures of this repository normalize identically", async (t) => {
  const slug = await currentRepositorySlug();
  if (!slug) {
    t.skip("no github.com origin remote to capture");
    return;
  }
  try {
    await execFileAsync("gh", ["auth", "status"]);
  } catch {
    t.skip("gh is not installed or not authenticated in this environment");
    return;
  }
  const first = await captureRepositorySettings({ repository: slug });
  const second = await captureRepositorySettings({ repository: slug });
  assert.deepEqual(validateReleaseSettingsCapture(first, "first live capture"), first);
  assert.deepEqual(second.settings, first.settings, "a live repository's pinned settings must not move between two calls");
  assert.deepEqual(second.repository, first.repository);
  assertSettingsRecheckFollows(first, second);
});
