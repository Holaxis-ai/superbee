// The five-tuple release packet, end to end, with nothing synthetic in the path that matters.
//
// F14: every packet test in scripts/release-packet.test.mjs injects a stand-in retained-tarball
// verifier over 19-byte text "tarballs", because the real one builds, packs, and installs. That
// leaves the deliverable — five reviewed tuples proven through the real verifier — never executed.
// This lane does execute it: `scripts/release-candidate.mjs` builds and packs all five candidates,
// and the packet is created and verified with the DEFAULT verifier, which installs each retained
// tarball into a scratch prefix and proves its identity.
//
// It is opt-in because it costs about a minute: `npm run test:packet-candidates`, wired into
// `npm run check` so CI runs it. It must run through npm — the retained-tarball proof needs a real
// npm environment — and it rebuilds packages/cli/dist for the npm-package channel, which is why it
// is the last step of the gate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createReleaseCandidate } from "./release-candidate.mjs";
import { createReleasePacket, verifyReleasePacket, REF_ASSERTIONS_SCHEMA, TRANSFER_ALLOWLIST_SCHEMA } from "./release-packet.mjs";
import { captureRepositorySettings } from "./release-settings-capture.mjs";
import { fileSha256 } from "./verify-npm-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetManifest = JSON.parse(await readFile(path.join(repoRoot, "release", "targets.json"), "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const liveTagRef = execFileSync("git", ["for-each-ref", "--count=1", "--format=%(refname)", "refs/tags"], { cwd: repoRoot, encoding: "utf8" }).trim();
const gitAuthorArgs = ["-c", "user.name=packet-test", "-c", "user.email=packet-test@example.invalid"];
const SETTINGS_REPOSITORY = "packet-test-org/packet-test-repo";
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function settingsPayload() {
  return {
    full_name: SETTINGS_REPOSITORY, id: 1234567, node_id: "R_kgDOPacketTest",
    pushed_at: new Date().toISOString(), size: 9876, stargazers_count: 1,
    allow_forking: false, archived: false, default_branch: "main", delete_branch_on_merge: false,
    disabled: false, fork: false, has_discussions: false, has_downloads: false, has_issues: false,
    has_pages: false, has_projects: true, has_wiki: false, is_template: false, private: true,
    visibility: "private", web_commit_signoff_required: false,
  };
}

function buildTransferBundle(bundleFile) {
  const source = `${bundleFile}-source`;
  execFileSync("git", ["init", "--quiet", "--bare", "--template=", source], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "fetch", "--quiet", "--no-tags", repoRoot, `${head}:refs/heads/main`], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "fetch", "--quiet", "--no-tags", repoRoot, `${liveTagRef}:${liveTagRef}`], { stdio: "pipe" });
  execFileSync("git", [...gitAuthorArgs, "-C", source, "notes", "--ref", "review", "add", "-m", "transfer review", "refs/heads/main"], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "bundle", "create", bundleFile, "refs/heads/main", liveTagRef, "refs/notes/review"], { stdio: "pipe" });
  const heads = {};
  for (const line of execFileSync("git", ["bundle", "list-heads", bundleFile], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).split("\n").filter(Boolean)) {
    const [, sha, ref] = /^([a-f0-9]{40})\s+(\S+)$/.exec(line);
    heads[ref] = sha;
  }
  return Object.fromEntries(Object.keys(heads).sort().map((ref) => [ref, heads[ref]]));
}

async function realEvidence(root) {
  const directory = path.join(root, "evidence");
  await mkdir(directory, { recursive: true });
  const evidence = {
    "planning-heads": path.join(directory, "planning-heads.json"),
    "registry-snapshot": path.join(directory, "registry-snapshot.json"),
    "refs-baseline": path.join(directory, "refs-baseline.json"),
    "refs-recheck": path.join(directory, "refs-recheck.json"),
    "settings-baseline": path.join(directory, "settings-baseline.json"),
    "settings-recheck": path.join(directory, "settings-recheck.json"),
    "transfer-bundle": path.join(directory, "transfer-bundle"),
    "transfer-allowlist": path.join(directory, "transfer-allowlist.json"),
    "cutover-script": path.join(directory, "cutover-script"),
  };
  const allowedRefs = buildTransferBundle(evidence["transfer-bundle"]);
  const envelope = (schema) => JSON.stringify({
    schema,
    public_main: head,
    public_ancestor_P: head,
    private_R: head,
    held_board_ref: "refs/heads/board",
    allowed_refs: allowedRefs,
    required_categories: ["main", "notes", "tags"],
    ...(schema === REF_ASSERTIONS_SCHEMA ? { observed_refs: allowedRefs } : {}),
  }, null, 2);
  const capture = async (at) => `${JSON.stringify(await captureRepositorySettings({
    repository: SETTINGS_REPOSITORY,
    api: async () => settingsPayload(),
    now: () => new Date(at),
  }), null, 2)}\n`;
  await writeFile(evidence["planning-heads"], JSON.stringify({
    schema: "superbee.planning-heads.v1",
    plan: `sha256:${"1".repeat(64)}`,
    contract: `sha256:${"2".repeat(64)}`,
    successor_coordinate_decision: `sha256:${"3".repeat(64)}`,
  }, null, 2));
  await writeFile(evidence["registry-snapshot"], "opaque registry snapshot\n");
  await writeFile(evidence["refs-baseline"], envelope(REF_ASSERTIONS_SCHEMA));
  await writeFile(evidence["refs-recheck"], envelope(REF_ASSERTIONS_SCHEMA));
  await writeFile(evidence["transfer-allowlist"], envelope(TRANSFER_ALLOWLIST_SCHEMA));
  await writeFile(evidence["settings-baseline"], await capture("2026-08-15T04:00:00.000Z"));
  await writeFile(evidence["settings-recheck"], await capture("2026-08-15T04:11:00.000Z"));
  await writeFile(evidence["cutover-script"], "#!/bin/sh\n# operator-owned, non-executing artifact\n");
  return evidence;
}

/** Build every reviewed tuple with the real packer: one build, one `npm pack`, per candidate. */
async function packEveryCandidate(root) {
  const candidates = {};
  for (const [id, tuple] of Object.entries(targetManifest.allowed_tuples)) {
    const out = path.join(root, "candidates", id);
    await createReleaseCandidate({
      target: id,
      tag: tuple.tag,
      commit: head,
      out,
      // The packet runs the retained-tarball proof for every candidate; running it here too would
      // double the slowest step in this lane and prove nothing extra.
      verify: false,
      // The test checkout carries the working-tree edits under test; the packet's own source
      // binding is what proves the reviewed commit.
      sourceFacts: { commit: head, dirty: false },
    });
    candidates[id] = out;
  }
  return candidates;
}

test("a packet of all five reviewed tuples is built by the real packer and proven by the real verifier", async (t) => {
  if (!process.env.npm_execpath) {
    throw new Error("run this lane through npm (npm run test:packet-candidates): the retained-tarball proof needs a real npm environment");
  }
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-candidates-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const candidates = await packEveryCandidate(root);
  const evidence = await realEvidence(root);
  const out = path.join(root, "packet");

  const { packet } = await createReleasePacket({
    commit: head,
    publicAncestor: head,
    out,
    candidates,
    evidence,
    observedSource: { commit: head, dirty: false },
  });

  assert.deepEqual(Object.keys(packet.candidates).sort(), Object.keys(targetManifest.allowed_tuples).sort());
  for (const [id, tuple] of Object.entries(targetManifest.allowed_tuples)) {
    const row = packet.candidates[id];
    assert.equal(row.package, tuple.package, id);
    assert.equal(row.version, tuple.version, id);
    assert.equal(row.tag, tuple.tag, id);
    const retained = path.join(out, row.tarball);
    const bytes = await readFile(retained);
    assert.ok(bytes.subarray(0, 2).equals(GZIP_MAGIC), `${id} retained a real gzip tarball`);
    assert.ok(bytes.length > 100_000, `${id} retained a real package, not a stub (${bytes.length} bytes)`);
    const inventoried = packet.inventory.find((entry) => entry.path === row.tarball);
    assert.equal(inventoried.sha256, await fileSha256(retained), id);
    const manifest = JSON.parse(await readFile(path.join(out, row.manifest), "utf8"));
    assert.equal(manifest.build_identity.artifact.channel, "npm-package", id);
  }

  await verifyReleasePacket({ packet: path.join(out, "release-packet.json"), observedSource: { commit: head, dirty: false } });

  // Prove the real verifier is load-bearing here: corrupt one retained tarball and re-record its
  // digest so every byte-level check still agrees, leaving only the install proof to fail.
  const forged = path.join(root, "forged");
  await mkdir(forged, { recursive: true });
  const bridge = targetManifest.allowed_tuples.bridge;
  const filename = `${targetManifest.targets.bridge.tarball_basename}-${bridge.version}.tgz`;
  const original = await readFile(path.join(candidates.bridge, filename));
  const corrupted = Buffer.from(original);
  corrupted[corrupted.length - 40] ^= 0xff;
  await writeFile(path.join(forged, filename), corrupted);
  const manifest = JSON.parse(await readFile(path.join(candidates.bridge, "candidate.json"), "utf8"));
  manifest.tarball.sha256 = await fileSha256(path.join(forged, filename));
  await writeFile(path.join(forged, "candidate.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    createReleasePacket({
      commit: head,
      publicAncestor: head,
      out: path.join(root, "forged-packet"),
      candidates: { ...candidates, bridge: forged },
      evidence: await realEvidence(path.join(root, "forged-evidence")),
      observedSource: { commit: head, dirty: false },
    }),
    /candidate bridge retained-tarball proof failed/,
  );
});
