import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { canonicalJsonString } from "./canonical-json.mjs";
import { loadReleaseTargets } from "./release-targets.mjs";
import { fileSha256 } from "./verify-npm-package.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
export const EXHAUSTIVE_RELEASE_PROOF_SCHEMA = "superbee.release-exhaustive-proof.v1";

async function checkoutFacts(root) {
  const [commit, tree, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ]);
  return { commit: commit.stdout.trim(), tree: tree.stdout.trim(), dirty: status.stdout.length > 0 };
}

export async function assertExactExhaustiveSource(expectedCommit, root = repoRoot) {
  if (!COMMIT.test(expectedCommit ?? "")) throw new Error("exact exhaustive proof requires a 40-hex source commit");
  const facts = await checkoutFacts(root);
  if (facts.commit !== expectedCommit || facts.dirty) {
    throw new Error(`exact exhaustive proof requires clean checked-out HEAD ${expectedCommit}; observed ${facts.commit} dirty=${facts.dirty}`);
  }
  return facts;
}

async function candidateProofRows(candidateDirs, targets) {
  const rows = {};
  for (const id of Object.keys(targets.allowed_tuples)) {
    const directory = candidateDirs[id];
    if (!directory) throw new Error(`missing exhaustive candidate ${id}`);
    const manifestPath = path.join(directory, "candidate.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const tarballPath = path.join(directory, manifest.tarball.filename);
    const tuple = targets.allowed_tuples[id];
    rows[id] = {
      package: tuple.package,
      version: tuple.version,
      tag: tuple.tag,
      candidate_manifest_sha256: await fileSha256(manifestPath),
      tarball_sha256: await fileSha256(tarballPath),
    };
  }
  return rows;
}

/** Write only after the all-five packet and its real retained-tarball verifier have passed. */
export async function writeExhaustiveReleaseProof({ out, sourceCommit, packetFile, candidateDirs, root = repoRoot }) {
  const source = await assertExactExhaustiveSource(sourceCommit, root);
  const targets = await loadReleaseTargets(path.join(root, "release", "targets.json"), {
    burnedFile: path.join(root, "release", "burned-versions.json"),
    cliPackageFile: path.join(root, "packages", "cli", "package.json"),
    contractFile: path.join(root, "release", "cutover-contract.json"),
  });
  const receipt = {
    schema: EXHAUSTIVE_RELEASE_PROOF_SCHEMA,
    source: { commit: source.commit, tree: source.tree, dirty: false },
    release_targets_sha256: await fileSha256(path.join(root, "release", "targets.json")),
    harness: {
      packet_candidates_sha256: await fileSha256(path.join(root, "scripts", "release-packet-candidates.test.mjs")),
      candidate_builder_sha256: await fileSha256(path.join(root, "scripts", "release-candidate.mjs")),
    },
    packet_sha256: await fileSha256(packetFile),
    candidates: await candidateProofRows(candidateDirs, targets),
  };
  await writeFile(out, `${canonicalJsonString(receipt, "exhaustive release proof")}\n`, { flag: "wx" });
  return receipt;
}

export async function verifyExhaustiveReleaseProof({ proof, commit, root = repoRoot }) {
  const text = await readFile(proof, "utf8");
  const receipt = JSON.parse(text);
  assert.equal(text, `${canonicalJsonString(receipt, "exhaustive release proof")}\n`, "exhaustive release proof must be canonical");
  assert.deepEqual(Object.keys(receipt).sort(), ["candidates", "harness", "packet_sha256", "release_targets_sha256", "schema", "source"]);
  assert.equal(receipt.schema, EXHAUSTIVE_RELEASE_PROOF_SCHEMA);
  assert.deepEqual(Object.keys(receipt.source).sort(), ["commit", "dirty", "tree"]);
  assert.deepEqual(Object.keys(receipt.harness).sort(), ["candidate_builder_sha256", "packet_candidates_sha256"]);
  const source = await assertExactExhaustiveSource(commit, root);
  assert.deepEqual(receipt.source, { commit: source.commit, tree: source.tree, dirty: false });
  assert.equal(receipt.release_targets_sha256, await fileSha256(path.join(root, "release", "targets.json")));
  assert.deepEqual(receipt.harness, {
    packet_candidates_sha256: await fileSha256(path.join(root, "scripts", "release-packet-candidates.test.mjs")),
    candidate_builder_sha256: await fileSha256(path.join(root, "scripts", "release-candidate.mjs")),
  });
  assert.match(receipt.packet_sha256, SHA);
  const targets = await loadReleaseTargets(path.join(root, "release", "targets.json"), {
    burnedFile: path.join(root, "release", "burned-versions.json"),
    cliPackageFile: path.join(root, "packages", "cli", "package.json"),
    contractFile: path.join(root, "release", "cutover-contract.json"),
  });
  assert.deepEqual(Object.keys(receipt.candidates).sort(), Object.keys(targets.allowed_tuples).sort());
  for (const [id, tuple] of Object.entries(targets.allowed_tuples)) {
    const row = receipt.candidates[id];
    assert.deepEqual(Object.keys(row).sort(), ["candidate_manifest_sha256", "package", "tag", "tarball_sha256", "version"]);
    assert.equal(row.package, tuple.package);
    assert.equal(row.version, tuple.version);
    assert.equal(row.tag, tuple.tag);
    assert.match(row.candidate_manifest_sha256, SHA);
    assert.match(row.tarball_sha256, SHA);
  }
  return receipt;
}
