import assert from "node:assert/strict";
import test from "node:test";

import { assertRegistryCandidate } from "./release-verify-registry.mjs";

const SHA = "sha256:" + "a".repeat(64);
const candidate = {
  target: "bridge",
  package: { name: "@holaxis/aslite" },
  version: "0.1.0-pre.4",
  source: { commit: "b".repeat(40), dirty: false },
  tarball: { sha256: SHA, shasum: "c".repeat(40), integrity: "sha512-YWJjZA==" },
  build_identity: { artifact: { sha256: "sha256:" + "d".repeat(64) } },
};
const packReceipt = {
  name: "@holaxis/aslite",
  version: candidate.version,
  shasum: candidate.tarball.shasum,
  integrity: candidate.tarball.integrity,
};
const packumentDist = {
  shasum: candidate.tarball.shasum,
  integrity: candidate.tarball.integrity,
  signatures: [{ keyid: "SHA256:test", sig: "test" }],
  attestations: {
    url: `https://registry.npmjs.org/-/npm/v1/attestations/%40holaxis%2faslite@${candidate.version}`,
    provenance: { predicateType: "https://slsa.dev/provenance/v1" },
  },
};
const installedIdentity = {
  identity: {
    package: { name: "@holaxis/aslite", version: candidate.version },
    source: candidate.source,
    artifact: { channel: "npm-package", sha256: candidate.build_identity.artifact.sha256 },
  },
};

test("registry proof requires packument, bytes, and installed identity to match candidate", () => {
  assert.doesNotThrow(() =>
    assertRegistryCandidate({ candidate, packReceipt, packumentDist, tarballSha256: SHA, installedIdentity }),
  );
});

test("registry proof fails closed on each independent mismatch", () => {
  assert.throws(
    () => assertRegistryCandidate({ candidate, packReceipt: { ...packReceipt, integrity: "sha512-bad" }, packumentDist, tarballSha256: SHA, installedIdentity }),
    /registry integrity/,
  );
  assert.throws(
    () => assertRegistryCandidate({ candidate, packReceipt, packumentDist, tarballSha256: "sha256:" + "0".repeat(64), installedIdentity }),
    /tarball SHA-256/,
  );
  assert.throws(
    () => assertRegistryCandidate({ candidate, packReceipt, packumentDist, tarballSha256: SHA, installedIdentity: { identity: { ...installedIdentity.identity, source: { commit: "e".repeat(40), dirty: false } } } }),
    /source identity/,
  );
  assert.throws(
    () => assertRegistryCandidate({ candidate, packReceipt, packumentDist: { ...packumentDist, attestations: undefined }, tarballSha256: SHA, installedIdentity }),
    /no npm-hosted SLSA provenance/,
  );
});

test("registry proof rejects ambiguous package-only identity instead of redirecting to bridge", () => {
  const ambiguous = structuredClone(candidate);
  delete ambiguous.target;
  ambiguous.package = { name: "superbee" };
  assert.throws(
    () => assertRegistryCandidate({ candidate: ambiguous, packReceipt, packumentDist, tarballSha256: SHA, installedIdentity }),
    /ambiguous across targets successor-preview, successor-stable; explicit target required/,
  );
});

// Regression (live run 31532497412): npm audit signatures verifies INSTALLED packages, so the
// scratch install must be REAL — a --package-lock-only install leaves nothing to audit and npm
// fails with "found no dependencies to audit that were installed from a supported registry".
// The suite mocks npm, so this pins the SOURCE invocation shape: the coordinate install that
// precedes the audit must not be lockfile-only.
test("the scratch install feeding audit signatures is a real install, not lockfile-only", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./release-verify-registry.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("--package-lock-only"), "lockfile-only install leaves audit signatures nothing to verify");
  const installAt = source.indexOf('"install", "--ignore-scripts"');
  const auditAt = source.indexOf('"audit", "signatures"');
  assert.ok(installAt !== -1 && auditAt !== -1 && installAt < auditAt, "real install precedes the signatures audit");
});
