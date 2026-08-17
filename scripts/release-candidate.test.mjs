import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCandidateSource,
  createReleaseCandidate,
  parseCandidateArgs,
  prepareCandidateOutputDir,
  releaseCandidateFixtureIdentity,
  releaseCandidateFixtureKey,
} from "./release-candidate.mjs";
import { createReleaseCandidateFixtureCache, createRetainedVerifierCache } from "./release-candidate-fixture.mjs";
import { verifyRetainedTarball, fileSha256 } from "./verify-npm-package.mjs";
import { loadReleaseTargets } from "./release-targets.mjs";
import { buildCli } from "../packages/cli/build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let realFixtureRoot;
let realFixtureCache;

function headCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function realCandidateFixture(targetId) {
  const commit = headCommit();
  if (!commit || !process.env.npm_execpath) return null;
  if (!realFixtureRoot) {
    realFixtureRoot = await mkdtemp(path.join(tmpdir(), "superbee-candidate-cache-"));
    realFixtureCache = createReleaseCandidateFixtureCache({ cacheRoot: path.join(realFixtureRoot, "cache") });
  }
  const targets = await loadReleaseTargets();
  const tuple = targets.allowed_tuples[targetId];
  const out = await mkdtemp(path.join(realFixtureRoot, `private-${targetId}-`));
  return realFixtureCache.materialize({
    target: targetId,
    tag: tuple.tag,
    commit,
    sourceFacts: { commit, dirty: false },
  }, out);
}

after(async () => {
  if (!realFixtureRoot) return;
  await rm(realFixtureRoot, { recursive: true, force: true });
  // Candidate construction intentionally rewrites the one shared dist. Keep the test file
  // serialized and restore the ordinary dev artifact once, after every cached consumer finishes.
  await buildCli("local-dev");
});

test("parseCandidateArgs validates the tag shape and 40-hex commit", () => {
  assert.deepEqual(parseCandidateArgs(["--target", "bridge", "--tag", "v0.1.0-pre.4", "--commit", "a".repeat(40)]), {
    tag: "v0.1.0-pre.4",
    commit: "a".repeat(40),
    target: "bridge",
    manifest: path.join(repoRoot, "release", "targets.json"),
    out: "release-candidate",
    json: false,
  });
  assert.equal(parseCandidateArgs(["--target", "successor-preview", "--tag", "v0.1.1-pre.1", "--commit", "b".repeat(40), "--out", "cand", "--json"]).json, true);
  assert.throws(() => parseCandidateArgs(["--target", "bridge", "--tag", "1.2.3", "--commit", "a".repeat(40)]), /v-prefixed SemVer/);
  assert.throws(() => parseCandidateArgs(["--target", "bridge", "--tag", "v1.2.3", "--commit", "xyz"]), /40-hex/);
  assert.throws(() => parseCandidateArgs(["--commit", "a".repeat(40)]), /usage:/);
});

test("createReleaseCandidate refuses a target/version/tag tuple not listed in the release manifest — before building", async () => {
  const distPath = path.join(repoRoot, "packages", "cli", "dist", "superbee.mjs");
  const before = await fileSha256(distPath).catch(() => null);
  await assert.rejects(
    createReleaseCandidate({ target: "bridge", tag: "v99.99.99", commit: "a".repeat(40), out: path.join(tmpdir(), "never"), verify: false }),
    /is not allowlisted/,
  );
  // The mismatch is caught before any build overwrites dist.
  const after = await fileSha256(distPath).catch(() => null);
  assert.equal(after, before, "a target tuple mismatch must not rebuild dist");
});

test("candidate source facts must match HEAD and prove a clean checkout", () => {
  const commit = "a".repeat(40);
  assert.deepEqual(assertCandidateSource(commit, { commit, dirty: false }), { commit, dirty: false });
  assert.throws(() => assertCandidateSource(commit, { commit: "b".repeat(40), dirty: false }), /does not match checked-out HEAD/);
  assert.throws(() => assertCandidateSource(commit, { commit, dirty: true }), /requires a clean checkout/);
  assert.throws(() => assertCandidateSource(commit, { commit, dirty: null }), /requires a clean checkout/);
});

test("fixture identity keys every source, policy, tuple, package/bin, channel, and update-policy boundary", async () => {
  const commit = headCommit();
  if (!commit) return;
  const described = await releaseCandidateFixtureIdentity({
    target: "successor-preview",
    tag: (await loadReleaseTargets()).allowed_tuples["successor-preview"].tag,
    commit,
    sourceFacts: { commit, dirty: false },
  });
  assert.deepEqual(Object.keys(described.identity).sort(), [
    "artifact_channel", "build_inputs", "package_identity", "release_policy_sha256", "schema", "source", "tuple", "update_policy",
  ]);
  assert.equal(described.identity.source.commit, commit);
  assert.match(described.identity.source.tree, /^[a-f0-9]{40}$/);
  assert.equal(described.identity.source.source_files_sha256, described.identity.build_inputs.source_files_sha256);
  assert.deepEqual(Object.keys(described.identity.build_inputs).sort(), [
    "cli_package_sha256", "package_lock_sha256", "root_package_sha256", "source_files_sha256",
  ]);
  assert.deepEqual(described.identity.package_identity.bins, { superbee: "dist/superbee.mjs" });
  assert.equal(described.identity.artifact_channel, "npm-package");

  const mutations = [
    (value) => { value.tuple.tag = "v9.9.9"; },
    (value) => { value.source.commit = "f".repeat(40); },
    (value) => { value.source.tree = "e".repeat(40); },
    (value) => { value.source.source_files_sha256 = `sha256:${"a".repeat(64)}`; },
    (value) => { value.release_policy_sha256 = `sha256:${"d".repeat(64)}`; },
    (value) => { value.build_inputs.package_lock_sha256 = `sha256:${"c".repeat(64)}`; },
    (value) => { value.package_identity.bins = { other: "dist/superbee.mjs" }; },
    (value) => { value.package_identity.version = "9.9.9"; },
    (value) => { value.artifact_channel = "local-dev"; },
    (value) => { value.update_policy.enabled = !value.update_policy.enabled; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(described.identity);
    mutate(changed);
    assert.notEqual(releaseCandidateFixtureKey(changed), described.key);
  }
});

test("fixture cache is exact-keyed, returns private copies, and survives A-B-A mutation order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-candidate-cache-contract-"));
  let serial = 0;
  const cache = createReleaseCandidateFixtureCache({
    cacheRoot: path.join(root, "cache"),
    identityFor: async ({ identity }) => ({ key: releaseCandidateFixtureKey(identity), identity }),
    buildCandidate: async ({ out, identity }) => {
      await mkdir(out, { recursive: true });
      const filename = `${identity.tuple.target}.tgz`;
      await writeFile(path.join(out, filename), `immutable-${identity.tuple.target}-${++serial}\n`);
      const candidate = { target: identity.tuple.target, tarball: { filename } };
      await writeFile(path.join(out, "candidate.json"), `${JSON.stringify(candidate)}\n`);
      return { outDir: out };
    },
  });
  const identity = (target) => ({
    schema: "fixture-test.v1",
    tuple: { target },
    source: { commit: "a".repeat(40), tree: "b".repeat(40) },
    release_policy_sha256: `sha256:${"c".repeat(64)}`,
    build_inputs: { source_files_sha256: `sha256:${"d".repeat(64)}` },
    package_identity: { name: target, version: "1.0.0", bins: { [target]: "dist/superbee.mjs" } },
    artifact_channel: "npm-package",
    update_policy: { enabled: target === "a" },
  });
  try {
    const firstA = await cache.materialize({ identity: identity("a") }, path.join(root, "first-a"));
    const originalA = await readFile(firstA.tarballPath, "utf8");
    await writeFile(firstA.tarballPath, "consumer mutation\n");
    await writeFile(firstA.manifestPath, "{}\n");
    await cache.materialize({ identity: identity("b") }, path.join(root, "only-b"));
    const secondA = await cache.materialize({ identity: identity("a") }, path.join(root, "second-a"));
    assert.equal(await readFile(secondA.tarballPath, "utf8"), originalA);
    assert.equal(secondA.candidate.target, "a");
    await cache.assertUnchanged({ identity: identity("a") });
    assert.deepEqual(cache.stats(), { builds: 2, keys: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained verifier reuse is byte-keyed and returns private immutable receipts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-retained-cache-contract-"));
  const targetsPath = path.join(root, "targets.json");
  const inputs = async (id) => {
    const directory = path.join(root, id);
    await mkdir(directory, { recursive: true });
    const tarball = path.join(directory, "candidate.tgz");
    const manifest = path.join(directory, "candidate.json");
    await writeFile(tarball, `tarball-${id}\n`);
    await writeFile(manifest, `${JSON.stringify({ target: id })}\n`);
    return { tarball, manifest, targetsPath };
  };
  await writeFile(targetsPath, "policy\n");
  let calls = 0;
  const cache = createRetainedVerifierCache({
    verifier: async ({ manifest }) => ({ proof: { manifest, serial: ++calls } }),
  });
  try {
    const a = await inputs("a");
    const b = await inputs("b");
    const firstA = await cache.verify(a);
    firstA.proof.serial = 999;
    await cache.verify(b);
    const secondA = await cache.verify(a);
    assert.equal(secondA.proof.serial, 1, "consumer mutation cannot alter the cached receipt");
    assert.deepEqual(cache.stats(), { verifications: 2, keys: 2 });
    await writeFile(a.tarball, "changed tarball\n");
    const changedA = await cache.verify(a);
    assert.equal(changedA.proof.serial, 3, "changed retained bytes require a new real proof");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate output cleanup refuses broad and foreign non-empty directories", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-out-safety-"));
  try {
    await assert.rejects(prepareCandidateOutputDir(repoRoot), /unsafe --out target/);
    await writeFile(path.join(scratch, "belongs-to-user.txt"), "keep\n");
    await assert.rejects(prepareCandidateOutputDir(scratch), /not owned by release-candidate/);
    assert.equal(await readFile(path.join(scratch, "belongs-to-user.txt"), "utf8"), "keep\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("candidate output cleanup permits an empty directory and its own later rerun", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-out-owned-"));
  try {
    await prepareCandidateOutputDir(scratch);
    await writeFile(path.join(scratch, "stale.tgz"), "stale\n");
    await prepareCandidateOutputDir(scratch);
    assert.deepEqual(await readdir(scratch), [".aslite-release-candidate-owned-v1"]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("build once, pack once: the retained manifest's SHA-256 is the tarball's actual bytes", async (t) => {
  const result = await realCandidateFixture("bridge");
  if (!result) {
    t.skip("requires a git checkout and npm_execpath (run via npm)");
    return;
  }
  const version = (await loadReleaseTargets()).allowed_tuples.bridge.version;
  try {
    const { candidate, tarballPath, outDir } = result;
    // Exactly one tarball retained, plus the manifest — never a second candidate.
    const entries = (await readdir(outDir)).filter((f) => f.endsWith(".tgz"));
    assert.equal(entries.length, 1, "exactly one retained tarball");
    assert.equal(candidate.schema, "superbee.release-candidate.v1");
    assert.equal(candidate.target, "bridge");
    assert.equal(candidate.package.name, "@holaxis/aslite");
    assert.equal(candidate.tag, `v${version}`);
    assert.equal(candidate.build_identity.artifact.channel, "npm-package");
    assert.deepEqual(candidate.source, { commit: headCommit(), dirty: false });
    // The recorded SHA-256 is exactly the retained bytes — a swap or rebuild would break this.
    assert.equal(candidate.tarball.sha256, await fileSha256(tarballPath));
    assert.ok(candidate.agreement.skill_md_sha256.startsWith("sha256:"));
    assert.ok(Object.keys(candidate.agreement.references_sha256).length > 0, "agreement pins the references tree");
  } finally {
    await rm(result.outDir, { recursive: true, force: true });
  }
});

test("verifyRetainedTarball fails closed when the tarball bytes do not match the manifest SHA", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-swap-"));
  try {
    const fakeTgz = path.join(scratch, "holaxis-aslite-0.0.0.tgz");
    await writeFile(fakeTgz, "not a real tarball\n");
    const manifestPath = path.join(scratch, "candidate.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        target: "bridge",
        tarball: { sha256: "sha256:" + "0".repeat(64) }, // deliberately wrong
        build_identity: { artifact: { channel: "npm-package" } },
      }),
    );
    // The SHA cross-check throws BEFORE any npm install is attempted.
    await assert.rejects(
      verifyRetainedTarball({ tarball: fakeTgz, manifest: manifestPath }),
      /does not match candidate manifest/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("verifyRetainedTarball fails closed when the recorded release-target agreement drifts", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-target-agreement-"));
  try {
    const fakeTgz = path.join(scratch, "superbee-release-rehearsal-0.0.0.tgz");
    await writeFile(fakeTgz, "not a real tarball\n");
    const actualSha = await fileSha256(fakeTgz);
    const manifestPath = path.join(scratch, "candidate.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema: "superbee.release-candidate.v1",
        target: "rehearsal-approve",
        package: { name: "superbee-release-rehearsal" },
        tarball: { sha256: actualSha },
        build_identity: { artifact: { channel: "npm-package" } },
        agreement: { release_targets_sha256: "sha256:" + "0".repeat(64) },
      }),
    );
    await assert.rejects(
      verifyRetainedTarball({ tarball: fakeTgz, manifest: manifestPath }),
      /release-target agreement/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("custom-root retained verification binds the sibling burn ledger", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-custom-burn-"));
  try {
    const targets = JSON.parse(await readFile(path.join(repoRoot, "release", "targets.json"), "utf8"));
    targets.allowed_tuples["successor-preview"].version = "0.1.0-pre.10";
    targets.allowed_tuples["successor-preview"].tag = "v0.1.0-pre.10";
    const targetsPath = path.join(scratch, "targets.json");
    await writeFile(targetsPath, JSON.stringify(targets));
    await writeFile(path.join(scratch, "burned-versions.json"), JSON.stringify({ burned: [{ version: "0.1.0-pre.10", reason: "burned fixture" }] }));
    const tarball = path.join(scratch, "candidate.tgz");
    await writeFile(tarball, "not a tarball\n");
    const manifest = path.join(scratch, "candidate.json");
    await writeFile(manifest, JSON.stringify({ target: "successor-preview", tarball: { sha256: await fileSha256(tarball) } }));
    await assert.rejects(verifyRetainedTarball({ tarball, manifest, targetsPath }), /uses burned version/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("verifyRetainedTarball fails closed when no manifest is supplied (QA finding #2)", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "aslite-nomanifest-"));
  try {
    const fakeTgz = path.join(scratch, "holaxis-aslite-0.0.0.tgz");
    await writeFile(fakeTgz, "not a real tarball\n");
    // No manifest -> refuse BEFORE any install, so a bare valid npm-package tarball can never pass
    // as "the staged candidate".
    await assert.rejects(
      verifyRetainedTarball({ tarball: fakeTgz }),
      /requires a candidate manifest/,
    );
    await assert.rejects(verifyRetainedTarball({ tarball: fakeTgz, manifest: null }), /requires a candidate manifest/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the retained-tarball verifier path contains no build or pack call (structural no-rebuild proof)", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "verify-npm-package.mjs"), "utf8");
  const at = source.indexOf("export async function verifyRetainedTarball");
  assert.notEqual(at, -1);
  const retainedRegion = source.slice(at); // to EOF: only the retained fn + CLI dispatch follow
  for (const token of ["build.mjs", "npm pack", "buildCli", '"pack"']) {
    assert.ok(!retainedRegion.includes(token), `retained verifier must not reference ${JSON.stringify(token)}`);
  }
});

test("retained verification rejects a real same-shape tarball relabeled across rehearsal slots", async (t) => {
  const result = await realCandidateFixture("rehearsal-reject");
  if (!result) {
    t.skip("requires a git checkout and npm_execpath (run via npm)");
    return;
  }
  const targets = await loadReleaseTargets();
  const sourceTuple = targets.allowed_tuples["rehearsal-reject"];
  const claimedTuple = targets.allowed_tuples["rehearsal-approve"];
  const out = result.outDir;
  try {
    const accepted = await verifyRetainedTarball({ tarball: result.tarballPath, manifest: result.manifestPath });
    assert.equal(accepted.package, `${sourceTuple.package}@${sourceTuple.version}`);
    const relabeledTarball = path.join(out, `superbee-release-rehearsal-${claimedTuple.version}.tgz`);
    await cp(result.tarballPath, relabeledTarball);
    const relabeled = structuredClone(result.candidate);
    relabeled.target = claimedTuple.target;
    relabeled.tag = claimedTuple.tag;
    relabeled.version = claimedTuple.version;
    relabeled.build_identity.package.version = claimedTuple.version;
    relabeled.tarball.filename = path.basename(relabeledTarball);
    relabeled.tarball.version = claimedTuple.version;
    relabeled.tarball.path = relabeledTarball;
    const relabeledManifest = path.join(out, "candidate-relabeled.json");
    await writeFile(relabeledManifest, `${JSON.stringify(relabeled, null, 2)}\n`);

    await assert.rejects(
      verifyRetainedTarball({ tarball: relabeledTarball, manifest: relabeledManifest }),
      /installed package coordinate does not match the reviewed tuple/,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("retained verification rejects a real Superbee tarball relabeled across successor preview/stable tuples", async (t) => {
  const result = await realCandidateFixture("successor-preview");
  if (!result) {
    t.skip("requires a git checkout and npm_execpath (run via npm)");
    return;
  }
  const targets = await loadReleaseTargets();
  const sourceTuple = targets.allowed_tuples["successor-preview"];
  const claimedTuple = targets.allowed_tuples["successor-stable"];
  const out = result.outDir;
  try {
    const accepted = await verifyRetainedTarball({ tarball: result.tarballPath, manifest: result.manifestPath });
    assert.equal(accepted.package, `${sourceTuple.package}@${sourceTuple.version}`);
    const relabeledTarball = path.join(out, `superbee-${claimedTuple.version}.tgz`);
    await cp(result.tarballPath, relabeledTarball);
    const relabeled = structuredClone(result.candidate);
    relabeled.target = claimedTuple.target;
    relabeled.tag = claimedTuple.tag;
    relabeled.version = claimedTuple.version;
    relabeled.build_identity.package.version = claimedTuple.version;
    relabeled.tarball.filename = path.basename(relabeledTarball);
    relabeled.tarball.version = claimedTuple.version;
    relabeled.tarball.path = relabeledTarball;
    const relabeledManifest = path.join(out, "candidate-successor-relabeled.json");
    await writeFile(relabeledManifest, `${JSON.stringify(relabeled, null, 2)}\n`);

    await assert.rejects(
      verifyRetainedTarball({ tarball: relabeledTarball, manifest: relabeledManifest }),
      /installed package coordinate does not match the reviewed tuple/,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("retained verification rejects omitted or self-attested compatibility claims on a real candidate", async (t) => {
  const result = await realCandidateFixture("successor-preview");
  if (!result) {
    t.skip("requires a git checkout and npm_execpath (run via npm)");
    return;
  }
  const out = result.outDir;
  try {
    const omitted = structuredClone(result.candidate);
    delete omitted.compatibility_contracts;
    const omittedManifest = path.join(out, "candidate-compatibility-omitted.json");
    await writeFile(omittedManifest, `${JSON.stringify(omitted, null, 2)}\n`);
    await assert.rejects(
      verifyRetainedTarball({ tarball: result.tarballPath, manifest: omittedManifest }),
      /candidate compatibility contracts do not agree/,
    );

    const selfAttested = structuredClone(result.candidate);
    selfAttested.compatibility_contracts = { skill: 99, hook: 99, mcp: 99 };
    selfAttested.build_identity.compatibility_contracts = structuredClone(selfAttested.compatibility_contracts);
    const selfAttestedManifest = path.join(out, "candidate-compatibility-self-attested.json");
    await writeFile(selfAttestedManifest, `${JSON.stringify(selfAttested, null, 2)}\n`);
    await assert.rejects(
      verifyRetainedTarball({ tarball: result.tarballPath, manifest: selfAttestedManifest }),
      /embedded compatibility contracts do not match the candidate build identity/,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
