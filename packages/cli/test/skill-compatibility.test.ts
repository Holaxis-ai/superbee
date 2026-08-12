import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  classifySkillCompatibility,
  parseOwnedSkillManifest,
  type SkillCompatibilityInput,
} from "../src/skill-compatibility.js";

const FILES = ["SKILL.md", "references/guide.md"];
const LEGACY = {
  package: "@holaxis/aslite",
  version: "0.1.0-pre.3",
  installed_by: "aslite skill install",
  files: FILES,
};
const SOURCE_IDENTITY = {
  release_version: "0.1.0-pre.3",
  source_commit: null,
  artifact_channel: "npm-package",
  artifact_sha256: `sha256:${"a".repeat(64)}`,
};
const V2 = {
  schema: "aslite.skill-manifest.v2",
  ...LEGACY,
  compatibility_contract: 1,
  source_identity: SOURCE_IDENTITY,
  file_sha256: Object.fromEntries(FILES.map((file) => [file, `sha256:${"b".repeat(64)}`])),
};

test("owned manifest parser recognizes only exact historical ownership shapes", () => {
  for (const packageName of ["aslite", "@holaxis/aslite"]) {
    const parsed = parseOwnedSkillManifest({ ...LEGACY, package: packageName });
    assert.equal(parsed?.kind, "legacy");
    assert.equal(parsed?.receipt_valid, true);
  }
  assert.equal(parseOwnedSkillManifest(V2)?.kind, "v2");
  assert.equal(parseOwnedSkillManifest(V2)?.receipt_valid, true);

  for (const candidate of [
    { ...LEGACY, package: "somebody-else" },
    { ...LEGACY, installed_by: "aslite skill install " },
    { ...LEGACY, installed_by: "npx aslite skill install" },
    { ...LEGACY, files: ["references/guide.md", "SKILL.md"] },
    { ...LEGACY, files: ["SKILL.md", "SKILL.md"] },
    { ...LEGACY, files: ["SKILL.md", "../victim"] },
    { ...LEGACY, files: ["SKILL.md", "notes.md"] },
    { ...LEGACY, files: ["SKILL.md", "references/..\\..\\victim.txt"] },
    { ...LEGACY, files: ["SKILL.md", "references/bad\0name"] },
    { ...V2, schema: "aslite.skill-manifest.v3" },
  ]) {
    assert.equal(parseOwnedSkillManifest(candidate), null);
  }
});

test("Windows separators cannot turn an owned manifest path into an uninstall escape", () => {
  const target = "C:\\project\\.codex\\skills\\aslite";
  const relative = "references/..\\..\\victim.txt";
  const escaped = path.win32.join(target, ...relative.split("/"));
  assert.equal(escaped, "C:\\project\\.codex\\skills\\victim.txt");
  assert.equal(parseOwnedSkillManifest({ ...LEGACY, files: ["SKILL.md", relative] }), null);
});
test("a corrupt v2 extension stays owned but its receipt is invalid", () => {
  for (const candidate of [
    { ...V2, compatibility_contract: 0 },
    { ...V2, source_identity: { ...SOURCE_IDENTITY, source_commit: "not-a-commit" } },
    { ...V2, file_sha256: { "SKILL.md": `sha256:${"b".repeat(64)}` } },
    { ...V2, file_sha256: { ...V2.file_sha256, "references/guide.md": "sha256:nope" } },
  ]) {
    const parsed = parseOwnedSkillManifest(candidate);
    assert.equal(parsed?.kind, "v2");
    assert.equal(parsed?.receipt_valid, false);
  }
});

const BASE: SkillCompatibilityInput = {
  target: "owned",
  manifest: parseOwnedSkillManifest(V2)!,
  running_contract: 1,
  assets_match: true,
  receipt_digests_match: true,
  install_command: "aslite skill install --scope project",
};

test("compatibility classifier implements the additive state/remedy precedence table", () => {
  const rows: Array<{
    name: string;
    input: SkillCompatibilityInput;
    state: string;
    reason: string | null;
    publicState: string;
    remedy: string;
  }> = [
    {
      name: "absent",
      input: { ...BASE, target: "absent", manifest: null },
      state: "absent",
      reason: "target_absent",
      publicState: "absent",
      remedy: "install",
    },
    {
      name: "unmanaged",
      input: { ...BASE, target: "unmanaged", manifest: null },
      state: "unmanaged",
      reason: "ownership_unproven",
      publicState: "unmanaged",
      remedy: "user_decision",
    },
    {
      name: "current v2",
      input: BASE,
      state: "current",
      reason: null,
      publicState: "installed",
      remedy: "none",
    },
    {
      name: "legacy receipt",
      input: { ...BASE, manifest: parseOwnedSkillManifest(LEGACY)! },
      state: "current",
      reason: "legacy_receipt",
      publicState: "installed",
      remedy: "refresh_receipt",
    },
    {
      name: "corrupt receipt",
      input: { ...BASE, receipt_digests_match: false },
      state: "stale",
      reason: "receipt_invalid",
      publicState: "stale",
      remedy: "install",
    },
    {
      name: "older contract",
      input: {
        ...BASE,
        running_contract: 2,
      },
      state: "stale",
      reason: "installed_contract_older",
      publicState: "stale",
      remedy: "install",
    },
    {
      name: "asset drift",
      input: { ...BASE, assets_match: false },
      state: "stale",
      reason: "asset_drift",
      publicState: "stale",
      remedy: "install",
    },
    {
      name: "newer contract",
      input: {
        ...BASE,
        manifest: parseOwnedSkillManifest({ ...V2, compatibility_contract: 2 })!,
      },
      state: "newer_contract",
      reason: "installed_contract_newer",
      publicState: "installed",
      remedy: "upgrade_cli",
    },
  ];

  for (const row of rows) {
    const result = classifySkillCompatibility(row.input);
    assert.equal(result.compatibility.state, row.state, row.name);
    assert.equal(result.compatibility.reason, row.reason, row.name);
    assert.equal(result.state, row.publicState, row.name);
    assert.equal(result.compatibility.remedy.action, row.remedy, row.name);
    assert.ok(Object.hasOwn(result.compatibility, "installed_contract"), row.name);
    assert.ok(Object.hasOwn(result.compatibility, "running_contract"), row.name);
    assert.ok(Object.hasOwn(result.compatibility.remedy, "command"), row.name);
  }
});

test("informational provenance never changes compatible v2 assets", () => {
  const changedProvenance = parseOwnedSkillManifest({
    ...V2,
    version: "99.0.0",
    source_identity: {
      release_version: "99.0.0",
      source_commit: "c".repeat(40),
      artifact_channel: "npm-package",
      artifact_sha256: null,
    },
  })!;
  const result = classifySkillCompatibility({ ...BASE, manifest: changedProvenance });
  assert.equal(result.state, "installed");
  assert.equal(result.compatibility.state, "current");
});
