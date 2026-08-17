import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJsonString } from "./canonical-json.mjs";
import { assertExactCheckout } from "./ci-release-exhaustive.mjs";
import {
  assertExactExhaustiveSource,
  verifyExhaustiveReleaseProof,
  writeExhaustiveReleaseProof,
} from "./release-packet-exhaustive-proof.mjs";
import { validatePacketInputManifest } from "./release-packet.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitAuthorArgs = ["-c", "user.name=exhaustive-proof-test", "-c", "user.email=exhaustive-proof-test@example.invalid"];
const reviewedFiles = [
  "packages/cli/package.json",
  "release/burned-versions.json",
  "release/cutover-contract.json",
  "release/targets.json",
  "scripts/release-candidate-fixture.mjs",
  "scripts/release-candidate.mjs",
  "scripts/release-packet-candidates.test.mjs",
];

async function initializeRepository(root, files = reviewedFiles) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "fixture-seed.txt"), "release proof fixture\n");
  for (const relative of files) {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await cp(path.join(repoRoot, relative), path.join(root, relative));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", [...gitAuthorArgs, "commit", "--quiet", "-m", "proof fixture"], { cwd: root, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

async function proofFixture() {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-exhaustive-proof-"));
  const root = path.join(scratch, "repo");
  const commit = await initializeRepository(root);
  const packetFile = path.join(scratch, "release-packet.json");
  await writeFile(packetFile, '{"packet":"reviewed"}\n');
  const targets = JSON.parse(await readFile(path.join(root, "release", "targets.json"), "utf8"));
  const candidateDirs = {};
  for (const id of Object.keys(targets.allowed_tuples)) {
    const directory = path.join(scratch, "candidates", id);
    const filename = `${id}.tgz`;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, filename), `tarball-${id}\n`);
    await writeFile(path.join(directory, "candidate.json"), `${JSON.stringify({ tarball: { filename } })}\n`);
    candidateDirs[id] = directory;
  }
  const proof = path.join(scratch, "proof.json");
  const receipt = await writeExhaustiveReleaseProof({ out: proof, sourceCommit: commit, packetFile, candidateDirs, root });
  return { scratch, root, commit, proof, receipt };
}

async function writeCanonical(file, value) {
  await writeFile(file, `${canonicalJsonString(value, "exhaustive proof test receipt")}\n`);
}

test("packet closure binds the dynamically reached exhaustive candidate harness", async () => {
  const { paths } = await validatePacketInputManifest();
  assert.ok(paths.includes("scripts/release-candidate-fixture.mjs"));
  assert.ok(paths.includes("scripts/release-packet-candidates.test.mjs"));
});

test("exact checkout guards reject wrong SHA plus tracked and untracked dirt", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "superbee-exact-source-"));
  const root = path.join(scratch, "repo");
  try {
    const commit = await initializeRepository(root, []);
    await writeFile(path.join(root, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root, stdio: "pipe" });
    execFileSync("git", [...gitAuthorArgs, "commit", "--quiet", "-m", "tracked fixture"], { cwd: root, stdio: "pipe" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    assert.equal(assertExactCheckout(head, root), head);
    assert.equal((await assertExactExhaustiveSource(head, root)).commit, head);
    assert.throws(() => assertExactCheckout(commit, root), /expected .* checked out/);
    await assert.rejects(assertExactExhaustiveSource(commit, root), /requires clean checked-out HEAD/);

    await writeFile(path.join(root, "tracked.txt"), "changed\n");
    assert.throws(() => assertExactCheckout(head, root), /requires a clean checkout/);
    await assert.rejects(assertExactExhaustiveSource(head, root), /dirty=true/);
    await writeFile(path.join(root, "tracked.txt"), "tracked\n");

    await writeFile(path.join(root, "untracked.txt"), "untracked\n");
    assert.throws(() => assertExactCheckout(head, root), /requires a clean checkout/);
    await assert.rejects(assertExactExhaustiveSource(head, root), /dirty=true/);
    await rm(path.join(root, "untracked.txt"));
    assert.equal(assertExactCheckout(head, root), head);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("exact receipt is canonical and verifies against clean reviewed checkout bytes", async () => {
  const fixture = await proofFixture();
  try {
    assert.equal(await readFile(fixture.proof, "utf8"), `${canonicalJsonString(fixture.receipt, "receipt")}\n`);
    assert.deepEqual(await verifyExhaustiveReleaseProof({ proof: fixture.proof, commit: fixture.commit, root: fixture.root }), fixture.receipt);
  } finally {
    await rm(fixture.scratch, { recursive: true, force: true });
  }
});

test("receipt verification rejects noncanonical, tree, policy, harness, tuple, and hash drift", async () => {
  const fixture = await proofFixture();
  try {
    const cases = [
      ["noncanonical bytes", (value) => JSON.stringify(value, null, 2), /must be canonical/],
      ["source tree", (value) => { value.source.tree = "f".repeat(40); }, /Expected values to be strictly deep-equal/],
      ["targets digest", (value) => { value.release_targets_sha256 = `sha256:${"0".repeat(64)}`; }, /strictly equal/],
      ["candidate fixture harness", (value) => { value.harness.candidate_fixture_sha256 = `sha256:${"0".repeat(64)}`; }, /strictly deep-equal/],
      ["tuple row", (value) => { value.candidates.bridge.package = "not-the-reviewed-package"; }, /strictly equal/],
      ["tuple hash", (value) => { value.candidates.bridge.tarball_sha256 = "not-a-sha"; }, /did not match/],
    ];
    for (const [name, mutate, expected] of cases) {
      const changed = structuredClone(fixture.receipt);
      const replacement = mutate(changed);
      if (typeof replacement === "string") await writeFile(fixture.proof, replacement);
      else await writeCanonical(fixture.proof, changed);
      await assert.rejects(
        verifyExhaustiveReleaseProof({ proof: fixture.proof, commit: fixture.commit, root: fixture.root }),
        expected,
        name,
      );
    }
  } finally {
    await rm(fixture.scratch, { recursive: true, force: true });
  }
});
