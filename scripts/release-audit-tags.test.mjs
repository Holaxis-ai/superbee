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
  PACKAGE,
  REGISTRY_URL,
  auditRegistryState as auditRegistryStateWithPolicy,
  checkSourceDrift,
  checkVersionScheme,
  classifyRegistryStatus,
  compareSemver,
  expectedTagState,
  fetchRegistryState,
  parsePhaseDeclaration,
  isNameReservingPlaceholder,
  main as auditMain,
  readBurnedDeclaration,
  registryUrlFor,
  releaseAuditPolicy,
  saneSuccessors,
} from "./release-audit-tags.mjs";
import { cutoverPolicyDigest, defaultReleaseManifest, normalizeReleaseTargets } from "./release-targets.mjs";

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
const committedManifest = defaultReleaseManifest();

function normalizeFixtureManifest(raw) {
  const contract = {
    schema: "superbee.cutover-contract.v1",
    targets: Object.fromEntries(
      Object.keys(raw.targets).map((id) => [id, { policy_sha256: cutoverPolicyDigest(raw, id) }]),
    ),
  };
  return normalizeReleaseTargets(raw, { contract });
}

function successorManifest({ stableVersion, previewVersion, packageName = PACKAGE, previewPromoteTag }) {
  const raw = structuredClone(committedManifest);
  for (const id of ["successor-stable", "successor-preview"]) {
    raw.targets[id].package.name = packageName;
    raw.allowed_tuples[id].package = packageName;
  }
  raw.allowed_tuples["successor-stable"].version = stableVersion;
  raw.allowed_tuples["successor-stable"].tag = `v${stableVersion}`;
  raw.allowed_tuples["successor-preview"].version = previewVersion;
  raw.allowed_tuples["successor-preview"].tag = `v${previewVersion}`;
  if (previewPromoteTag !== undefined) {
    raw.allowed_tuples["successor-preview"].publication.npm_promote_tag = previewPromoteTag;
  }
  return normalizeFixtureManifest(raw);
}

function divergentSuccessorPackageManifest(previewPackage) {
  const raw = structuredClone(committedManifest);
  raw.targets["successor-preview"].package.name = previewPackage;
  raw.allowed_tuples["successor-preview"].package = previewPackage;
  return normalizeFixtureManifest(raw);
}

function auditRegistryState(args, manifest = committedManifest) {
  return auditRegistryStateWithPolicy({
    ...args,
    policy: releaseAuditPolicy(manifest, args.declaration),
  });
}

const PREVIEW_TRANSACTION_MANIFEST = successorManifest({
  stableVersion: "0.1.0",
  previewVersion: "0.1.0-pre.4",
  previewPromoteTag: "latest",
});
const LATER_PREVIEW_MANIFEST = successorManifest({
  stableVersion: "0.1.2",
  previewVersion: "0.1.2-pre.1",
});
const FOLLOWUP_PREVIEW_MANIFEST = successorManifest({
  stableVersion: "0.1.2",
  previewVersion: "0.1.2-pre.2",
});

function laterPreviewRegistry({ published = false, latest = "0.1.1", next = published ? "0.1.2-pre.1" : "0.1.1" } = {}) {
  const versions = published ? ["0.1.1", "0.1.2-pre.1"] : ["0.1.1"];
  return {
    distTags: { latest, next },
    versions,
    time: Object.fromEntries(versions.map((version, index) => [version, `2026-08-${18 + index}T00:00:00.000Z`])),
  };
}

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
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
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
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
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
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
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
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
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
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
  assert.deepEqual(codes(result), ["latest_off_policy", "next_off_policy"]);
});

test("counter: tags pointing outside the transaction entirely (stale pre.1) still red", () => {
  const declaration = { phase: "approved", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    distTags: { latest: "0.1.0-pre.1", next: "0.1.0-pre.4" },
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
  assert.deepEqual(codes(result), ["latest_off_policy"]);
});

test("staged phase, candidate not yet published: tags must still hold the prior known-good", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.0-pre.4" };
  const result = auditRegistryState(
    { declaration, sourceVersion: "0.1.0", registry: registryFixture() },
    PREVIEW_TRANSACTION_MANIFEST,
  );
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
  assert.deepEqual(
    auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST).violations,
    [],
  );
});

test("promoted phase with an unpublished candidate is a violation", () => {
  const declaration = { phase: "promoted", kind: "prerelease", version: "0.1.0-pre.4" };
  const result = auditRegistryState(
    { declaration, sourceVersion: "0.1.0", registry: registryFixture() },
    PREVIEW_TRANSACTION_MANIFEST,
  );
  assert.deepEqual(codes(result), ["candidate_unpublished"]);
});

test("failed phase: tags restored to prior known-good pass, and the deprecate expectation is noted", () => {
  const declaration = { phase: "failed", kind: "prerelease", version: "0.1.0-pre.4" };
  const registry = registryFixture({
    versions: ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.4"],
    time: { ...registryFixture().time, "0.1.0-pre.4": "2026-08-08T00:00:00.000Z" },
  });
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
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
  const result = auditRegistryState({ declaration, sourceVersion: "0.1.0", registry }, PREVIEW_TRANSACTION_MANIFEST);
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

// A patch-line prerelease is LEGAL. This assertion used to run the other way — 0.1.1-pre.1 was a
// violation — because the contract pinned the patch digit to 0. Nothing in SemVer or npm requires
// that, and the restriction blocked previewing a patch release at all, so it was dropped.
test("a patch-line prerelease (0.1.1-pre.1) is allowed", () => {
  const registry = registryFixture({
    versions: [...registryFixture().versions, "0.1.1-pre.1"],
    time: { ...registryFixture().time, "0.1.1-pre.1": "2026-08-05T00:00:00.000Z" },
    distTags: { latest: "0.1.1-pre.1", next: "0.1.1-pre.1" },
  });
  const result = auditRegistryState({ declaration: AT_REST, sourceVersion: "0.1.1-pre.1", registry });
  assert.deepEqual(result.violations, [], codes(result).join(","));
});

test("contiguity is per FULL version line: a 0.1.1 preview does not fill a 0.1.0 hole", () => {
  // 0.1.0-pre.1 + 0.1.0-pre.3 is a genuine gap on the 0.1.0 line. Publishing 0.1.1-pre.2 alongside
  // must not be mistaken for the missing 0.1.0-pre.2 — which is what a line keyed on "A.B" would do.
  const versions = ["0.1.0-pre.1", "0.1.0-pre.3", "0.1.1-pre.1", "0.1.1-pre.2"];
  const time = Object.fromEntries(versions.map((v, i) => [v, new Date(Date.UTC(2026, 6, 1 + i)).toISOString()]));
  const violations = checkVersionScheme(versions, time);
  assert.deepEqual(violations.map((v) => v.code), ["pre_n_gap"]);
  assert.match(violations[0].message, /line 0\.1\.0-pre\.N/, "the gap belongs to the 0.1.0 line only");
});

test("a burn fills a hole only on its OWN patch line", () => {
  const versions = ["0.1.1-pre.2"];
  const time = { "0.1.1-pre.2": "2026-08-16T22:00:00.000Z" };
  assert.deepEqual(checkVersionScheme(versions, time, ["0.1.1-pre.1"]), [], "same line fills the hole");
  const wrongLine = checkVersionScheme(versions, time, ["0.1.0-pre.1"]);
  assert.deepEqual(wrongLine.map((v) => v.code), ["pre_n_gap"], "a 0.1.0 burn cannot fill a 0.1.1 hole");
});

test("off-scheme prerelease label (rc) is STILL a violation — one fixed -pre. label", () => {
  const violations = checkVersionScheme(["0.1.0-rc.1"], { "0.1.0-rc.1": "2026-08-01T00:00:00.000Z" });
  assert.deepEqual(violations.map((v) => v.code), ["off_scheme_version"]);
});

test("saneSuccessors carries the patch digit, so a preview can be followed by what it previews", () => {
  const from = saneSuccessors("0.1.1-pre.2");
  assert.ok(from.includes("0.1.1"), `0.1.1 must be a sane successor of its own preview; got ${from.join(", ")}`);
  assert.ok(from.includes("0.1.1-pre.3"), "the next preview on the same line");
  assert.ok(!from.includes("0.1.0"), "0.1.0 belongs to a different line and must NOT be offered");
  // The minor-line behaviour is unchanged for previews that really are on a .0 line.
  const fromMinor = saneSuccessors("0.1.0-pre.3");
  assert.ok(fromMinor.includes("0.1.0"), "a 0.1.0 preview is still followed by 0.1.0");
  assert.ok(fromMinor.includes("0.2.0-pre.1"), "and may still jump to the next minor line");
});

test("the LIVE registry shape — 0.0.1 placeholder plus 0.1.1-pre.2 over a declared burn — is clean", () => {
  const versions = ["0.0.1", "0.1.1-pre.2"];
  const time = { "0.0.1": "2026-08-15T00:00:00.000Z", "0.1.1-pre.2": "2026-08-16T22:00:00.000Z" };
  assert.deepEqual(checkVersionScheme(versions, time, ["0.1.1-pre.1"]), []);
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
  // This name always promised the patch's first preview too; the list omitted it, leaving no legal
  // way to START a patch preview from any stable.
  assert.deepEqual(saneSuccessors("0.1.0"), ["0.1.1", "0.2.0", "1.0.0", "0.1.1-pre.1", "0.2.0-pre.1", "1.0.0-pre.1"]);
});

test("a stable can START a patch preview — the ratified 0.1.0 -> 0.1.1-pre.1 transition is legal", () => {
  // decisions/npm-successor-version-line selected stable on `latest` with 0.1.1-pre.1 on `next`.
  // Allowing patch-line prereleases to EXIST while the successor authority refused to reach one made
  // that decision unimplementable, so this asserts the decision's own transition directly.
  assert.ok(saneSuccessors("0.1.0").includes("0.1.1-pre.1"));
  assert.deepEqual(checkSourceDrift("0.1.1-pre.1", ["0.0.1", "0.1.0"]).violations, []);
});

test("every stable can start its next patch preview, at any position in the number space", () => {
  for (const [from, want] of [["0.1.1", "0.1.2-pre.1"], ["0.1.2", "0.1.3-pre.1"], ["0.2.0", "0.2.1-pre.1"], ["1.0.0", "1.0.1-pre.1"]]) {
    assert.ok(saneSuccessors(from).includes(want), `${from} -> ${want}`);
  }
});

test("a PRERELEASE still cannot jump to the next patch's preview — it would skip its own release", () => {
  // The counterpart of the rule above, and the reason the two branches differ. From 0.1.1-pre.2 the
  // next patch preview would abandon 0.1.1 unreleased.
  assert.ok(!saneSuccessors("0.1.1-pre.2").includes("0.1.2-pre.1"));
  assert.ok(saneSuccessors("0.1.1-pre.2").includes("0.1.1"), "its own stable remains the way forward");
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

// --- declaration cross-validation: source target and transaction artifact are distinct ---

test("later-line preview is green while source is the planned stable target", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.2-pre.1" };
  const result = auditRegistryState(
    { declaration, sourceVersion: "0.1.2", registry: laterPreviewRegistry() },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.facts.selected_tuple, {
    id: "successor-preview",
    package: PACKAGE,
    version: "0.1.2-pre.1",
  });
  assert.equal(result.facts.source_state, "staged-prep");
});

test("a follow-up preview retains latest on the published stable while next holds the prior preview", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.2-pre.2" };
  const result = auditRegistryState(
    { declaration, sourceVersion: "0.1.2", registry: laterPreviewRegistry({ published: true }) },
    FOLLOWUP_PREVIEW_MANIFEST,
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.facts.expected_tags, { latest: "0.1.1", next: "0.1.2-pre.1" });
  assert.equal(result.facts.source_state, "staged-prep");
});

test("undeclared preview artifact is red even though stable source remains strict", () => {
  const declaration = { phase: "staged", kind: "prerelease", version: "0.1.2-pre.2" };
  const result = auditRegistryState(
    { declaration, sourceVersion: "0.1.2", registry: laterPreviewRegistry() },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(codes(result), ["declaration_tuple_mismatch"]);
});

test("stable and prerelease kinds cannot cross their selected tuples", () => {
  const stableAsPreview = auditRegistryState(
    {
      declaration: { phase: "staged", kind: "stable", version: "0.1.2-pre.1" },
      sourceVersion: "0.1.2",
      registry: laterPreviewRegistry(),
    },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(codes(stableAsPreview), ["declaration_kind_mismatch", "declaration_tuple_mismatch"]);

  const previewAsStable = auditRegistryState(
    {
      declaration: { phase: "staged", kind: "prerelease", version: "0.1.2" },
      sourceVersion: "0.1.2",
      registry: laterPreviewRegistry(),
    },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(codes(previewAsStable), ["declaration_kind_mismatch", "declaration_tuple_mismatch"]);
});

test("failed phase preserves a historical candidate but still enforces kind/form", () => {
  const historical = { phase: "failed", kind: "prerelease", version: "0.1.1-pre.9" };
  const recovered = auditRegistryState(
    { declaration: historical, sourceVersion: "0.1.2", registry: laterPreviewRegistry() },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(recovered.violations, []);
  assert.equal(recovered.facts.source_state, "staged-prep");

  const malformed = auditRegistryState(
    { declaration: { ...historical, kind: "stable" }, sourceVersion: "0.1.2", registry: laterPreviewRegistry() },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(codes(malformed), ["declaration_kind_mismatch"]);
});

test("phase-only settlement keeps stable source ahead and latest on the published stable", () => {
  const result = auditRegistryState(
    { declaration: AT_REST, sourceVersion: "0.1.2", registry: laterPreviewRegistry({ published: true }) },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.facts.expected_tags, { latest: "0.1.1", next: "0.1.2-pre.1" });
  assert.equal(result.facts.source_state, "staged-prep");
});

test("source drift remains strict across the later-line preview lifecycle", () => {
  const result = auditRegistryState(
    { declaration: AT_REST, sourceVersion: "0.1.3", registry: laterPreviewRegistry({ published: true }) },
    LATER_PREVIEW_MANIFEST,
  );
  assert.deepEqual(codes(result), ["source_version_jump"]);
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
  // This test is about CLI EXIT CODES, not about whatever release happens to be in flight. It
  // synthesizes its own registry, so it must pin its own phase too: reading the repo's live
  // release/phase.json coupled it to real releases and it went red the moment a staged
  // transaction was declared (the synthesized registry publishes only the candidate, so `staged`
  // reports no_prior_release). --phase-file is the CLI's own override for exactly this.
  const atRest = path.join(scratch, "phase-at-rest.json");
  await writeFile(atRest, JSON.stringify({ schema: "aslite.release-phase.v1", phase: "at_rest", kind: null, version: null }));
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
  const time = Object.fromEntries(versions.map((v, i) => [v, new Date(Date.UTC(2026, 6, 1 + i)).toISOString()]));
  await writeFile(passing, JSON.stringify({ "dist-tags": { latest: cliVersion, next: cliVersion }, versions, time }));
  await writeFile(violating, JSON.stringify({ "dist-tags": { latest: "0.0.1", next: cliVersion }, versions, time }));

  const pass = await runAudit(["--registry-json", passing, "--phase-file", atRest]);
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stdout, /release-audit: PASS/);

  const fail = await runAudit(["--registry-json", violating, "--phase-file", atRest]);
  assert.equal(fail.code, 1, fail.stderr);
  assert.match(fail.stderr, /VIOLATION\[latest_off_policy\]/);

  // Closed loopback port: connection refused is a NETWORK condition, never a red.
  const network = await runAudit(["--registry-url", "http://127.0.0.1:1/@holaxis%2faslite", "--phase-file", atRest]);
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
  // Fixture mirrors the live registry of the AUDITED package, per its own standing instruction to
  // update alongside real publishes. It modelled the pre-rename @holaxis/aslite line
  // (0.1.0-pre.1..pre.8); the audited package is now superbee, whose published set is the 0.0.1
  // name-reserving placeholder, the 0.1.1 preview/stable line, the 0.1.2 preview/stable line,
  // and stable 0.1.2, with 0.1.1-pre.1 burned.
  const published = ["0.0.1", "0.1.1-pre.2", "0.1.1-pre.3", "0.1.1", "0.1.2-pre.1", "0.1.2-pre.2", "0.1.2"];
  const drift = checkSourceDrift(manifest.version, published, burned);
  assert.deepEqual(drift.violations, []);
  assert.equal(drift.state, "staged-prep");
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

// ---------------------------------------------------------------------------------------------
// F2 — publication policy (release/targets.json) and audit policy agree BY CONSTRUCTION.
//
// The manifest is the ONE place a human declares where a version lands on npm; the audit reads
// that declaration instead of restating it. These tests pin the derivation in both directions, so
// a manifest edit can never leave the audit expecting a dist-tag state the release never produces
// (which is what made the scheduled audit permanently red once the bridge tuple stopped promoting
// to `latest`) — nor tolerate a state the manifest forbids.
// ---------------------------------------------------------------------------------------------

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bridgeTuple = committedManifest.allowed_tuples.bridge;

/**
 * The declared destiny of a tuple, restated INDEPENDENTLY of the implementation: a version lands on
 * `npm_tag` at stage and moves to `npm_promote_tag` at finalize, and those are the only dist-tags it
 * ever carries. The tests below compare the audit's expectations against this restatement, so they
 * follow a policy edit instead of pinning today's policy values.
 */
function declaredTagsOf(tuple) {
  return new Set([tuple.publication.npm_tag, tuple.publication.npm_promote_tag].filter((tag) => typeof tag === "string"));
}

// The live @holaxis/aslite registry as captured 2026-08-14: latest == next == 0.1.0-pre.8 over
// published pre.1, pre.2, pre.3, pre.8 (pre.4..pre.7, pre.9, pre.10 are declared burns).
const LIVE_PUBLISHED = ["0.1.0-pre.1", "0.1.0-pre.2", "0.1.0-pre.3", "0.1.0-pre.8"];
const LIVE_AT_REST = "0.1.0-pre.8";

/** A synthetic destiny map — the shape `distTagDestiny` produces — for one candidate version. */
function destinyOf(version, tags) {
  return new Map([[version, new Set(tags)]]);
}

/** The registry state the cutover PRODUCES: each dist-tag held by whichever version policy puts there. */
function postBridgeRegistry(overrides = {}) {
  const declared = declaredTagsOf(bridgeTuple);
  const versions = [...LIVE_PUBLISHED, bridgeTuple.version];
  return {
    distTags: {
      latest: declared.has("latest") ? bridgeTuple.version : LIVE_AT_REST,
      next: declared.has("next") ? bridgeTuple.version : LIVE_AT_REST,
    },
    versions,
    time: Object.fromEntries(versions.map((v, i) => [v, new Date(Date.UTC(2026, 6, 1 + i)).toISOString()])),
    ...overrides,
  };
}

async function committedBurns() {
  return readBurnedDeclaration(JSON.parse(await readFile(path.join(repoDir, "release", "burned-versions.json"), "utf8")));
}

test("F2: the post-bridge registry the manifest itself produces is GREEN at rest", async () => {
  const registry = postBridgeRegistry();
  const result = auditRegistryState({
    declaration: AT_REST,
    sourceVersion: bridgeTuple.version,
    registry,
    burnedVersions: await committedBurns(),
  });
  assert.deepEqual(result.violations, [], `state produced by release/targets.json must not be a violation: ${JSON.stringify(result.violations)}`);
  assert.deepEqual(result.facts.expected_tags, registry.distTags, "expected tags must equal the state the publication manifest declares");
});

test("F2: the expectation tracks the manifest in BOTH directions, not a value that happens to agree", () => {
  const candidate = "0.1.0-pre.11";
  const versions = [...LIVE_PUBLISHED, candidate];
  const nextOnly = expectedTagState({
    declaration: AT_REST, versions, observedTags: {}, destiny: destinyOf(candidate, ["next"]),
  });
  assert.deepEqual(nextOnly.expected, { latest: LIVE_AT_REST, next: candidate },
    "a candidate published to next only leaves latest on the newest latest-eligible version");
  const promoted = expectedTagState({
    declaration: AT_REST, versions, observedTags: {}, destiny: destinyOf(candidate, ["next", "latest"]),
  });
  assert.deepEqual(promoted.expected, { latest: candidate, next: candidate },
    "flipping npm_promote_tag to latest in the manifest moves the audit's expectation with it");
});

test("F2: a candidate sitting on a dist-tag the manifest never gives it is RED", () => {
  const result = auditRegistryState(
    {
      declaration: AT_REST,
      sourceVersion: "0.1.2",
      registry: laterPreviewRegistry({ published: true, latest: "0.1.2-pre.1" }),
    },
    LATER_PREVIEW_MANIFEST,
  );
  assert.ok(codes(result).includes("latest_off_policy"), codes(result).join(","));
});

test("F2: declaring a phase that would put a next-only candidate on latest is RED", () => {
  const candidate = "0.1.0-pre.11";
  const versions = [...LIVE_PUBLISHED, candidate];
  const state = expectedTagState({
    declaration: { phase: "promoted", kind: "prerelease", version: candidate },
    versions,
    observedTags: { latest: LIVE_AT_REST, next: candidate },
    destiny: destinyOf(candidate, ["next"]),
  });
  assert.deepEqual(state.violations.map((v) => v.code), ["phase_contradicts_publication_policy"]);
  assert.deepEqual(state.expected, { latest: LIVE_AT_REST, next: candidate },
    "the expectation falls back to the prior so the remaining comparison still says something");
});

test("F2: transition tolerance covers timing, never a state the manifest forbids", () => {
  const candidate = "0.1.0-pre.11";
  const versions = [...LIVE_PUBLISHED, candidate];
  const state = expectedTagState({
    declaration: { phase: "staged", kind: "prerelease", version: candidate },
    versions,
    observedTags: { latest: candidate, next: candidate },
    destiny: destinyOf(candidate, ["next"]),
  });
  const tolerated = (state.accepted ?? []).map((entry) => entry.tags);
  assert.ok(
    !tolerated.some((tags) => tags.latest === candidate),
    `no tolerated transition state may put a next-only candidate on latest, got ${JSON.stringify(tolerated)}`,
  );
});

test("one supplied normalized manifest controls package, selected tuple, and destiny in pure and live audits", async () => {
  const manifest = successorManifest({
    stableVersion: "7.4.0",
    previewVersion: "7.4.0-pre.1",
    packageName: "synthetic-release-audit",
  });
  const declaration = { phase: "staged", kind: "prerelease", version: "7.4.0-pre.1" };
  const registry = {
    distTags: { latest: "7.3.0", next: "7.4.0-pre.1" },
    versions: ["7.3.0", "7.4.0-pre.1"],
    time: {
      "7.3.0": "2026-08-18T00:00:00.000Z",
      "7.4.0-pre.1": "2026-08-19T00:00:00.000Z",
    },
  };
  const green = auditRegistryState({ declaration, sourceVersion: "7.4.0", registry }, manifest);
  assert.deepEqual(green.violations, []);
  assert.equal(green.facts.package, "synthetic-release-audit");
  assert.deepEqual(green.facts.selected_tuple, {
    id: "successor-preview",
    package: "synthetic-release-audit",
    version: "7.4.0-pre.1",
  });

  const forbidden = auditRegistryState(
    {
      declaration: AT_REST,
      sourceVersion: "7.4.0",
      registry: { ...registry, distTags: { latest: "7.4.0-pre.1", next: "7.4.0-pre.1" } },
    },
    manifest,
  );
  assert.ok(codes(forbidden).includes("latest_off_policy"), codes(forbidden).join(","));

  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-release-audit-snapshot-"));
  const phaseFile = path.join(scratch, "phase.json");
  const registryFile = path.join(scratch, "registry.json");
  const burnedFile = path.join(scratch, "burned.json");
  await writeFile(phaseFile, JSON.stringify(declaration));
  await writeFile(registryFile, JSON.stringify({ "dist-tags": registry.distTags, versions: registry.versions, time: registry.time }));
  await writeFile(burnedFile, JSON.stringify({ burned: [] }));
  const stdout = [];
  const stderr = [];
  const code = await auditMain(
    ["--phase-file", phaseFile, "--registry-json", registryFile, "--burned-file", burnedFile],
    { manifest, io: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) } },
  );
  assert.equal(code, 0, stderr.join("\n"));
  assert.match(stdout.join("\n"), /release-audit: package synthetic-release-audit/);
});

test("normalized cross-package successor is violation-class before the live audit reads a registry", async () => {
  const manifest = divergentSuccessorPackageManifest("synthetic-preview-only");
  const preview = manifest.allowed_tuples["successor-preview"];
  const stable = manifest.allowed_tuples["successor-stable"];
  const declaration = { phase: "staged", kind: "prerelease", version: preview.version };
  const registry = {
    distTags: { latest: stable.version, next: stable.version },
    versions: [stable.version],
    time: { [stable.version]: "2026-08-20T00:00:00.000Z" },
  };
  const result = auditRegistryState({ declaration, sourceVersion: stable.version, registry }, manifest);
  assert.deepEqual(codes(result), ["selected_tuple_package_mismatch"]);
  assert.equal(result.facts.package, stable.package);
  assert.equal(result.facts.selected_tuple.package, "synthetic-preview-only");

  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-release-audit-package-mismatch-"));
  const phaseFile = path.join(scratch, "phase.json");
  await writeFile(phaseFile, JSON.stringify(declaration));
  const stdout = [];
  const stderr = [];
  const code = await auditMain(
    ["--phase-file", phaseFile, "--registry-json", path.join(scratch, "must-not-be-read.json")],
    { manifest, io: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) } },
  );
  assert.equal(code, 1, stderr.join("\n"));
  assert.deepEqual(stdout, [], "a rejected policy must not emit a registry success receipt");
  assert.match(stderr.join("\n"), /VIOLATION\[selected_tuple_package_mismatch\]/);
  assert.doesNotMatch(stderr.join("\n"), /ENOENT|must-not-be-read/);
});


// ── the standing audit must follow the rename, not be pinned to the retiring name ──────────────
// This audit runs on every pull request and every push to the default branch. It was hardcoded to
// `@holaxis/aslite`, which meant that the moment the cutover completed it would keep watching an
// abandoned package and never observe the live one — precisely the drift it exists to catch.
//
// The expectation is stated INDEPENDENTLY of the implementation: the audited package is whatever
// the manifest's successor-stable tuple declares. A future rename moves both together, and a
// re-pinned literal fails here.
test("the audited package is derived from the manifest, not pinned to a name", () => {
  const declared = committedManifest.allowed_tuples["successor-stable"].package;
  assert.equal(PACKAGE, declared, "the standing audit must watch the successor coordinate the manifest declares");
  assert.notEqual(PACKAGE, "@holaxis/aslite", "the audit must not remain pinned to the retiring package after cutover");
  assert.equal(
    REGISTRY_URL,
    registryUrlFor(declared),
    "the registry endpoint must follow the derived package, not a separately written URL",
  );
});

// ── the successor coordinate before any release has happened ───────────────────────────────────
// Switching the audit to the successor immediately surfaced that `superbee` cannot satisfy an
// at-rest policy written for a package mid-lifecycle: it holds one placeholder version reserving
// the name, with `latest` on it and no `next`. That is the state the cutover plan expects to find,
// so it is legal — but only in that exact shape.
test("a name-reserving placeholder is a legal at-rest state, and only in that exact shape", () => {
  const destiny = releaseAuditPolicy(committedManifest, AT_REST).destiny;
  const placeholder = { versions: ["0.0.1"], observedTags: { latest: "0.0.1" }, destiny };
  assert.equal(isNameReservingPlaceholder(placeholder), true);

  // Every clause is load-bearing: each of these is NOT a placeholder and must stay auditable.
  assert.equal(isNameReservingPlaceholder({ ...placeholder, versions: ["0.0.1", "0.1.0"] }), false, "a second published version ends it");
  assert.equal(isNameReservingPlaceholder({ ...placeholder, observedTags: { latest: "0.0.1", next: "0.0.1" } }), false, "a next tag ends it");
  assert.equal(isNameReservingPlaceholder({ ...placeholder, observedTags: { next: "0.0.1" } }), false, "latest must be the tag held");
  // Derived: the clause under test is "the manifest DECLARES this version", so the example has to be
  // a currently-declared one. It was the literal 0.1.0, which stopped being declared when the
  // successor tuple retargeted to a reachable number.
  const declaredStable = committedManifest.allowed_tuples["successor-stable"].version;
  assert.equal(isNameReservingPlaceholder({ versions: [declaredStable], observedTags: { latest: declaredStable }, destiny }), false, "a manifest-declared version is a release, not a placeholder");

  // End to end over a placeholder-only registry. This is deliberately a PINNED historical scenario,
  // not the live shape: superbee now publishes 0.0.1 AND 0.1.1-pre.2, and adding the latter here
  // would end the placeholder state that is the whole point of this test. It previously read the
  // live successor tuple for its source version, which coupled a placeholder-state assertion to
  // whatever number the next release happens to target -- and 0.1.1 is legitimately NOT a sane
  // successor of 0.0.1, so that coupling went red the moment the tuple moved off 0.1.0.
  const result = auditRegistryState({
    declaration: AT_REST,
    sourceVersion: "0.1.0",
    registry: { distTags: { latest: "0.0.1" }, versions: ["0.0.1"], time: { "0.0.1": "2026-08-11T00:00:00.000Z" } },
  });
  assert.deepEqual(result.violations, [], "the placeholder state the plan expects must not be a violation");
  assert.match(result.notes.join("\n"), /name-reserving placeholder/);
});
