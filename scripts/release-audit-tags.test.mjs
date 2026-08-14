import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  NetworkUnavailableError,
  auditRegistryState,
  checkSourceDrift,
  checkVersionScheme,
  classifyRegistryStatus,
  compareSemver,
  expectedTagState,
  fetchRegistryState,
  parsePhaseDeclaration,
  readBurnedDeclaration,
  saneSuccessors,
} from "./release-audit-tags.mjs";

// Fixture mirroring the live registry at build time. No test hits the network.
function registryFixture(overrides = {}) {
  return {
    distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.3" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3"],
    time: {
      "0.1.0-pre.1": "2026-07-21T23:37:30.463Z",
      "0.1.0-pre.2": "2026-07-31T13:46:17.102Z",
      "0.1.0-pre.3": "2026-08-03T20:15:11.843Z",
    },
    ...overrides,
  };
}

const AT_REST = { phase: "at_rest", kind: null, version: null };

function codes(result) {
  return result.violations.map((v) => v.code).sort();
}

test("current live reality passes: at_rest, latest==next==pre.3, source pre.3", () => {
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.3", registry: registryFixture() });
  assert.deepEqual(result.violations, []);
  assert.equal(result.facts.source_state, "in-sync");
  assert.deepEqual(result.facts.expected_tags, { latest: "0.1.0-pre.3", next: "0.1.0-pre.3" });
});

test("source one increment ahead (pre.4) passes as staged-prep", () => {
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.4", registry: registryFixture() });
  assert.deepEqual(result.violations, []);
  assert.equal(result.facts.source_state, "staged-prep");
});

// --- a. dist-tag policy per phase ---

test("at_rest: latest moved off the newest prerelease is a violation", () => {
  const registry = registryFixture({ distTags: { latest: "0.1.0-pre.2", next: "0.1.0-pre.3" } });
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.3", registry });
  assert.deepEqual(codes(result), ["latest_off_policy"]);
});

test("at_rest: next trailing behind latest is a violation", () => {
  const registry = registryFixture({ distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.2" } });
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.3", registry });
  assert.deepEqual(codes(result), ["next_off_policy"]);
});

test("at_rest: a missing next dist-tag is a violation", () => {
  const registry = registryFixture({ distTags: { latest: "0.1.0-pre.3" } });
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.3", registry });
  assert.deepEqual(codes(result), ["next_off_policy"]);
});

test("a dist-tag outside latest/next is a violation", () => {
  const registry = registryFixture({ distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.3", beta: "0.1.0-pre.1" } });
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.3", registry });
  assert.deepEqual(codes(result), ["unexpected_dist_tag"]);
});

test("staged phase, candidate published: latest stays prior, next floats to candidate", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.4" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(result.violations, []);
});

// Transition windows: the tag flip cannot land atomically with the phase-file commit, so any
// phase of the DECLARED transaction is tolerated (with a note), never a red.

test("window A: tags already promoted while phase still approved is tolerated", () => {
  const declaration = { phase: "approved", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.4", next: "0.1.0-pre.4" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(result.violations, []);
  assert.match(result.notes.join("\n"), /transaction phase promoted .*transition window.*declared phase is approved/);
});

test("window B: phase promoted while tags not yet moved is tolerated", () => {
  const declaration = { phase: "promoted", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.4" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(result.violations, []);
  assert.match(result.notes.join("\n"), /transition window.*declared phase is promoted/);
});

test("window C: registry restored during rollback while phase still approved is tolerated", () => {
  const declaration = { phase: "approved", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.3" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(result.violations, []);
  assert.match(result.notes.join("\n"), /transition window.*declared phase is approved/);
});

test("counter: tags matching NO phase of the declared transaction still red", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.4", next: "0.1.0-pre.3" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(codes(result), ["latest_off_policy", "next_off_policy"]);
});

test("counter: tags pointing outside the transaction entirely (stale pre.1) still red", () => {
  const declaration = { phase: "approved", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.1", next: "0.1.0-pre.4" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(codes(result), ["latest_off_policy"]);
});

test("staged phase, candidate not yet published: tags must still hold the prior known-good", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.0-pre.4" };
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry: registryFixture() });
  assert.deepEqual(result.violations, []);
  assert.match(result.notes.join("\n"), /not yet published/);
});

test("approved phase behaves like staged for tags (candidate published)", () => {
  const declaration = { phase: "approved", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.4" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  assert.deepEqual(auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry }).violations, []);
});

test("promoted phase with an unpublished candidate is a violation", () => {
  const declaration = { phase: "promoted", kind: "prerelease", version: "0.1.0-pre.4" };
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry: registryFixture() });
  assert.deepEqual(codes(result), ["candidate_unpublished"]);
});

test("failed phase: tags restored to prior known-good pass, and the deprecate expectation is noted", () => {
  const declaration = { phase: "failed", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(result.violations, []);
  assert.match(result.notes.join("\n"), /deprecated/);
});

test("failed phase: tags matching no transaction state (latest on the failed candidate) still red", () => {
  const declaration = { phase: "failed", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.4", next: "0.1.0-pre.3" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.deepEqual(codes(result), ["latest_off_policy"]);
});

test("post-stable at rest: latest on newest stable with next collapsed passes", () => {
  const registry = {
    distTags: { latest: "0.1.0", next: "0.1.0" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0"],
    time: { ...registryFixture().time, "0.1.0": "2026-09-01T00:00:00.000Z" },
  };
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0", registry });
  assert.deepEqual(result.violations, []);
});

test("post-stable at rest: a genuine newer published preview may hold next", () => {
  const registry = {
    distTags: { latest: "0.1.0", next: "0.2.0-pre.1" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0", "0.2.0-pre.1"],
    time: {
      ...registryFixture().time,
      "0.1.0": "2026-09-01T00:00:00.000Z",
      "0.2.0-pre.1": "2026-09-02T00:00:00.000Z",
    },
  };
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.2.0-pre.1", registry });
  assert.deepEqual(result.violations, []);
});

test("post-stable at rest: next pointing at an OLDER version than latest is a violation", () => {
  const registry = {
    distTags: { latest: "0.1.0", next: "0.1.0-pre.3" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0"],
    time: { ...registryFixture().time, "0.1.0": "2026-09-01T00:00:00.000Z" },
  };
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0", registry });
  assert.deepEqual(codes(result), ["next_off_policy"]);
});

// --- b. version scheme ---

test("gapped pre.N (pre.2 missing) is a violation", () => {
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.3" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.3"],
    time: { "0.1.0-pre.1": "2026-07-21T23:37:30.463Z", "0.1.0-pre.3": "2026-08-03T20:15:11.843Z" },
  });
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.3", registry });
  assert.deepEqual(codes(result), ["pre_n_gap"]);
});

test("off-scheme prerelease 0.1.1-pre.1 is a violation", () => {
  const registry = registryFixture({
    versions: [...registryFixture().versions, "0.1.1-pre.1"],
    time: { ...registryFixture().time, "0.1.1-pre.1": "2026-08-05T00:00:00.000Z" },
    distTags: { latest: "0.1.1-pre.1", next: "0.1.1-pre.1" },
  });
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.1-pre.1", registry });
  assert.ok(codes(result).includes("off_scheme_version"), codes(result).join(","));
});

test("off-scheme prerelease label (rc) is a violation", () => {
  const violations = checkVersionScheme(["0.1.0-rc.1"], { "0.1.0-rc.1": "2026-08-01T00:00:00.000Z" });
  assert.deepEqual(violations.map((v) => v.code), ["off_scheme_version"]);
});

test("publish times out of order for pre.N is a violation", () => {
  const time = {
    "0.1.0-pre.1": "2026-07-21T00:00:00.000Z",
    "0.1.0-pre.2": "2026-08-03T00:00:00.000Z",
    "0.1.0-pre.3": "2026-07-31T00:00:00.000Z",
  };
  const violations = checkVersionScheme(["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3"], time);
  assert.deepEqual(violations.map((v) => v.code), ["pre_n_order"]);
});

test("a second prerelease line restarting at pre.1 is on-scheme", () => {
  const time = {
    "0.1.0-pre.1": "2026-07-21T00:00:00.000Z",
    "0.2.0-pre.1": "2026-08-05T00:00:00.000Z",
  };
  assert.deepEqual(checkVersionScheme(["0.1.0-pre.1", "0.2.0-pre.1"], time), []);
});

test("post-stable ordinary SemVer versions carry no scheme violations", () => {
  assert.deepEqual(checkVersionScheme(["0.1.0", "0.1.1", "0.2.0"], {}), []);
});

// --- c. source-vs-registry drift ---

test("source behind registry is a violation with guidance", () => {
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.2", registry: registryFixture() });
  assert.deepEqual(codes(result), ["source_behind_registry"]);
  assert.match(result.violations[0].message, /BEHIND newest published 0\.1\.0-pre\.3/);
});

test("source jumping more than one increment ahead is a violation naming the sane successors", () => {
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.6", registry: registryFixture() });
  assert.deepEqual(codes(result), ["source_version_jump"]);
  assert.match(result.violations[0].message, /0\.1\.0-pre\.4/);
});

test("sane successors of a prerelease: next pre.N, next minor pre.1, the line's stable", () => {
  assert.deepEqual(saneSuccessors("0.1.0-pre.3"), ["0.1.0-pre.4", "0.2.0-pre.1", "0.1.0"]);
});

test("sane successors of a stable: patch, minor, major, and their first previews", () => {
  assert.deepEqual(saneSuccessors("0.1.0"), ["0.1.1", "0.2.0", "1.0.0", "0.2.0-pre.1", "1.0.0-pre.1"]);
});

test("first-stable prep passes: source 0.1.0 over newest 0.1.0-pre.3", () => {
  assert.deepEqual(checkSourceDrift("0.1.0", registryFixture().versions).violations, []);
});

test("non-semver source version is a violation", () => {
  assert.deepEqual(
    checkSourceDrift("not-a-version", registryFixture().versions).violations.map((v) => v.code),
    ["invalid_source_version"],
  );
});

// --- phase declaration ---

test("absent phase file defaults to at_rest", () => {
  assert.deepEqual(parsePhaseDeclaration(null), AT_REST);
});

test("at_rest declaration ignores documentation keys and null kind/version", () => {
  const raw = { schema: "aslite.release-phase.v1", phase: "at_rest", kind: null, version: null, semantics: {} };
  assert.deepEqual(parsePhaseDeclaration(raw), AT_REST);
});

test("unknown phase is rejected", () => {
  assert.throws(() => parsePhaseDeclaration({ phase: "shipping" }), /phase must be one of/);
});

test("transaction phase without kind or version is rejected", () => {
  assert.throws(() => parsePhaseDeclaration({ phase: "staged", version: "0.1.0-pre.4" }), /requires kind/);
  assert.throws(() => parsePhaseDeclaration({ phase: "staged", kind: "prerelease" }), /candidate version/);
});

test("transaction phase with no published prior release is a violation", () => {
  const state = expectedTagState({
    declaration: { phase: "staged", kind: "prerelease", version: "0.1.0-pre.1" },
    versions: [],
    observedTags: {},
  });
  assert.deepEqual(state.violations.map((v) => v.code), ["no_prior_release"]);
});

test("at_rest with an unpublished package is a violation", () => {
  const state = expectedTagState({ declaration: AT_REST, versions: [], observedTags: {} });
  assert.deepEqual(state.violations.map((v) => v.code), ["package_unpublished"]);
});

// --- declaration cross-validation (external review: green-but-nonsense declarations) ---

test("staged declaration naming a candidate that is not the source version is red", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.0-pre.99" };
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.3", registry: registryFixture() });
  assert.deepEqual(codes(result), ["declaration_source_mismatch"]);
});

test("staged declaration with kind stable for a prerelease-form candidate is red", () => {
  const declaration = { phase: "staged", kind: "stable", version: "0.1.0-pre.4" };
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.3", registry: registryFixture() });
  assert.deepEqual(codes(result), ["declaration_kind_mismatch", "declaration_source_mismatch"]);
});

test("staged declaration with kind prerelease for a stable-form candidate is red", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.0" };
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.3", registry: registryFixture() });
  assert.deepEqual(codes(result), ["declaration_kind_mismatch", "declaration_source_mismatch"]);
});

test("failed phase: source advanced to the replacement while declaring the failed candidate passes", () => {
  const declaration = { phase: "failed", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.5", registry });
  assert.deepEqual(result.violations, []);
  assert.equal(result.facts.source_state, "staged-prep");
});

test("failed phase still enforces kind/form agreement on the declared candidate", () => {
  const declaration = { phase: "failed", kind: "stable", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0-pre.4", registry });
  assert.ok(codes(result).includes("declaration_kind_mismatch"), codes(result).join(","));
});

// --- network-vs-violation classification (structural) ---

test("HTTP status classes: 200 data, 404 violation-class, others network-class", () => {
  assert.equal(classifyRegistryStatus(200), "ok");
  assert.equal(classifyRegistryStatus(404), "missing");
  for (const status of [301, 403, 429, 500, 503]) assert.equal(classifyRegistryStatus(status), "unavailable");
});

test("fetch exceptions (DNS/timeout/abort) surface as NetworkUnavailableError", async () => {
  await assert.rejects(
    fetchRegistryState({ fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
    NetworkUnavailableError,
  );
});

test("5xx and non-JSON registry responses surface as NetworkUnavailableError", async () => {
  await assert.rejects(
    fetchRegistryState({ fetchImpl: async () => new Response("bad gateway", { status: 502 }) }),
    NetworkUnavailableError,
  );
  await assert.rejects(
    fetchRegistryState({ fetchImpl: async () => new Response("<html>", { status: 200 }) }),
    NetworkUnavailableError,
  );
});

test("malformed 200 packument bodies classify as NetworkUnavailableError, never crash or red", async () => {
  const malformed = [
    null,
    {},
    { versions: {}, time: {} }, // missing dist-tags
    { "dist-tags": {}, versions: {} }, // missing time
    { "dist-tags": [], versions: {}, time: {} }, // wrong dist-tags shape
    { "dist-tags": {}, versions: [1, 2], time: {} }, // wrong versions element shape
  ];
  for (const body of malformed) {
    await assert.rejects(
      fetchRegistryState({ fetchImpl: async () => Response.json(body) }),
      NetworkUnavailableError,
      JSON.stringify(body),
    );
  }
});

test("404 is NOT network-class: it reports the package as missing", async () => {
  const state = await fetchRegistryState({ fetchImpl: async () => new Response("not found", { status: 404 }) });
  assert.deepEqual(state, { missing: true });
});

test("a 200 packument parses into dist-tags, versions, and per-version times", async () => {
  const body = {
    "dist-tags": { latest: "0.1.0-pre.3", next: "0.1.0-pre.3" },
    versions: { "0.1.0-pre.3": {} },
    time: { created: "2026-07-21T23:37:30.153Z", modified: "2026-08-06T23:06:58.146Z", "0.1.0-pre.3": "2026-08-03T20:15:11.843Z" },
  };
  const state = await fetchRegistryState({ fetchImpl: async () => Response.json(body) });
  assert.deepEqual(state, {
    missing: false,
    distTags: { latest: "0.1.0-pre.3", next: "0.1.0-pre.3" },
    versions: ["0.1.0-pre.3"],
    time: { "0.1.0-pre.3": "2026-08-03T20:15:11.843Z" },
  });
});

// --- the executable's exit-code contract (the structural distinction CI branches on) ---

const execFileAsync = promisify(execFile);
const scriptFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-audit-tags.mjs");

async function runAudit(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptFile, ...args], { timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("CLI exit codes: 0 on policy pass, 1 on violation, 20 on network failure", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-release-audit-"));
  const passing = path.join(scratch, "passing.json");
  const violating = path.join(scratch, "violating.json");
  const repoRoot = path.dirname(path.dirname(scriptFile));
  const cliVersion = JSON.parse(await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8")).version;
  // Derive a scheme-consistent published set from the ACTUAL source version so this test keeps
  // passing across future version bumps (the audit reads the real package.json + phase and
  // burned-versions files — so the synthesized registry must not publish a declared burn).
  const committedBurns = readBurnedDeclaration(
    JSON.parse(await readFile(path.join(repoRoot, "release", "burned-versions.json"), "utf8").catch(() => "null")),
  );
  const line = /^(\d+)\.(\d+)\.0-pre\.(\d+)$/.exec(cliVersion);
  const versions = (line
    ? Array.from({ length: Number(line[3]) }, (_, i) => `${line[1]}.${line[2]}.0-pre.${i + 1}`)
    : [cliVersion]).filter((v) => !committedBurns.includes(v));
  const publishedTip = versions.at(-1);
  assert.ok(
    publishedTip && versions.includes(publishedTip) && !committedBurns.includes(publishedTip),
    "synthetic dist-tags must point to an included published version, never a declared burn",
  );
  const time = Object.fromEntries(versions.map((v, i) => [v, new Date(Date.UTC(2026, 6, 1 + i)).toISOString()]));
  await writeFile(passing, JSON.stringify({ "dist-tags": { latest: publishedTip, next: publishedTip }, versions, time }));
  await writeFile(violating, JSON.stringify({ "dist-tags": { latest: "0.0.1", next: publishedTip }, versions, time }));

  const pass = await runAudit(["--registry-json", passing]);
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /release-audit: PASS/);

  const fail = await runAudit(["--registry-json", violating]);
  assert.equal(fail.code, 1, fail.stderr);
  assert.match(fail.stderr, /VIOLATION\[latest_off_policy\]/);

  // Closed loopback port: connection refused is a NETWORK condition, never a red.
  const network = await runAudit(["--registry-url", "http://127.0.0.1:1/@holaxis%2faslite"]);
  assert.equal(network.code, 20, network.stderr);
  assert.match(network.stderr, /release-audit: NETWORK/);
});

test("CLI exit 20 on valid-JSON but malformed packument payloads", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-release-audit-malformed-"));
  const payloads = {
    "null-body.json": "null",
    "empty-object.json": "{}",
    "missing-dist-tags.json": JSON.stringify({ versions: {}, time: {} }),
    "missing-time.json": JSON.stringify({ "dist-tags": {}, versions: {} }),
  };
  for (const [name, payload] of Object.entries(payloads)) {
    const file = path.join(scratch, name);
    await writeFile(file, payload);
    const run = await runAudit(["--registry-json", file]);
    assert.equal(run.code, 20, `${name}: ${run.stderr}`);
    assert.match(run.stderr, /release-audit: NETWORK/, name);
  }
});

// --- semver compare (the audit's ordering primitive) ---

test("compareSemver orders prereleases below their release and pre.N numerically", () => {
  assert.ok(compareSemver("0.1.0-pre.2", "0.1.0-pre.10") < 0);
  assert.ok(compareSemver("0.1.0-pre.3", "0.1.0") < 0);
  assert.ok(compareSemver("0.2.0-pre.1", "0.1.0") > 0);
  assert.equal(compareSemver("0.1.0-pre.3", "0.1.0-pre.3"), 0);
});

// Burned versions: numbers consumed by an immutable tag without publication. The declaration lets
// successor chains step over EXPLICIT burns; undeclared skips still fail, stable numbers cannot be
// burned, and a burn the registry has published is itself a violation.
test("a declared burned number lets the successor chain step over it", () => {
  const drift = checkSourceDrift("0.1.0-pre.5", ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3"], ["0.1.0-pre.4"]);
  assert.equal(drift.violations.length, 0);
  assert.equal(drift.state, "staged-prep");
});

test("an UNDECLARED skip still fails source drift", () => {
  const drift = checkSourceDrift("0.1.0-pre.5", ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3"], []);
  assert.equal(drift.violations.length, 1);
  assert.equal(drift.violations[0].code, "source_version_jump");
});

test("burns chain: two consecutive burned numbers admit the third", () => {
  const drift = checkSourceDrift("0.1.0-pre.6", ["0.1.0-pre.3"], ["0.1.0-pre.4", "0.1.0-pre.5"]);
  assert.equal(drift.violations.length, 0);
  const gap = checkSourceDrift("0.1.0-pre.6", ["0.1.0-pre.3"], ["0.1.0-pre.4"]);
  assert.equal(gap.violations.length, 1, "a burn chain with a hole does not admit versions past the hole");
});

test("a burned number the registry HAS published is a violation", () => {
  const drift = checkSourceDrift("0.1.0-pre.4", ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3"], ["0.1.0-pre.3"]);
  assert.equal(drift.violations.length, 1);
  assert.equal(drift.violations[0].code, "burned_version_published");
});

test("burning still respects the successor shapes: an unrelated burn admits nothing", () => {
  const drift = checkSourceDrift("0.3.0-pre.1", ["0.1.0-pre.3"], ["0.1.0-pre.4"]);
  assert.equal(drift.violations.length, 1);
  assert.equal(drift.violations[0].code, "source_version_jump");
});

test("auditRegistryState threads burnedVersions through to source drift", () => {
  const clean = auditRegistryState({
    declaration: AT_REST, sourceVersion: "0.1.0-pre.5", registry: registryFixture(),
    burnedVersions: ["0.1.0-pre.4"],
  });
  assert.deepEqual(clean.violations, []);
  assert.equal(clean.facts.source_state, "staged-prep");
  const missing = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.0-pre.5", registry: registryFixture() });
  assert.equal(missing.violations.length, 1);
});

test("readBurnedDeclaration validates shape, prerelease-only, reasons, and duplicates", () => {
  assert.deepEqual(readBurnedDeclaration(null), []);
  assert.deepEqual(
    readBurnedDeclaration({ burned: [{ version: "0.1.0-pre.4", reason: "tag burned" }] }),
    ["0.1.0-pre.4"],
  );
  assert.throws(() => readBurnedDeclaration([]), /must be a JSON object/);
  assert.throws(() => readBurnedDeclaration({}), /requires a burned: \[\] array/);
  assert.throws(() => readBurnedDeclaration({ burned: [{ version: "nope", reason: "x" }] }), /not SemVer/);
  assert.throws(() => readBurnedDeclaration({ burned: [{ version: "0.1.0", reason: "x" }] }), /STABLE version/);
  assert.throws(() => readBurnedDeclaration({ burned: [{ version: "0.1.0-pre.4", reason: " " }] }), /non-empty reason/);
  assert.throws(
    () => readBurnedDeclaration({ burned: [
      { version: "0.1.0-pre.4", reason: "x" },
      { version: "0.1.0-pre.4", reason: "y" },
    ] }),
    /declared twice/,
  );
});

test("the COMMITTED burned-versions declaration parses and admits the current source version", async () => {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const committed = JSON.parse(await readFile(path.join(repoRoot, "release", "burned-versions.json"), "utf8"));
  const burned = readBurnedDeclaration(committed);
  assert.ok(burned.includes("0.1.0-pre.4"), "the pre.4 burn that motivated this mechanism is declared");
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "packages", "cli", "package.json"), "utf8"));
  // Fixture mirrors the live registry at build time: 0.1.0-pre.8 published 2026-08-11 (the first
  // release through the staged machinery), pre.4..pre.7 burned. Update alongside real publishes.
  const published = ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.8"];
  const drift = checkSourceDrift(manifest.version, published, burned);
  assert.deepEqual(drift.violations, []);
});

test("a declared burn fills the published pre.N contiguity hole; an undeclared hole still reds", () => {
  const published = ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.5"];
  const time = Object.fromEntries(published.map((v, i) => [v, new Date(Date.UTC(2026, 6, 1 + i)).toISOString()]));
  const withBurn = checkVersionScheme(published, time, ["0.1.0-pre.4"]);
  assert.deepEqual(withBurn, []);
  const withoutBurn = checkVersionScheme(published, time, []);
  assert.equal(withoutBurn.length, 1);
  assert.equal(withoutBurn[0].code, "pre_n_gap");
  const wrongBurn = checkVersionScheme(published, time, ["0.2.0-pre.1"]);
  assert.equal(wrongBurn.length, 1, "a burn on a different line fills nothing");
});

test("the FUTURE live registry shape — pre.5 published over the pre.4 burn — passes the full audit", () => {
  const registry = {
    distTags: { latest: "0.1.0-pre.5", next: "0.1.0-pre.5" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.5"],
    time: {
      "0.1.0-pre.1": "2026-07-21T23:37:30.463Z",
      "0.1.0-pre.2": "2026-07-31T13:46:17.102Z",
      "0.1.0-pre.3": "2026-08-03T20:15:11.843Z",
      "0.1.0-pre.5": "2026-08-11T00:00:00.000Z",
    },
  };
  const result = auditRegistryState({
    declaration: AT_REST, sourceVersion: "0.1.0-pre.5", registry, burnedVersions: ["0.1.0-pre.4"],
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.facts.source_state, "in-sync");
});
