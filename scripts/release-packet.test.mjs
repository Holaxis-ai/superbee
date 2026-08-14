import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PACKET_OWNER,
  createReleasePacket,
  preparePacketOutputDir,
  staticPacketClosure,
  validatePacketInputManifest,
  verifyReleasePacket,
} from "./release-packet.mjs";
import { fileSha256 } from "./verify-npm-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetManifest = JSON.parse(await readFile(path.join(repoRoot, "release", "targets.json"), "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const parent = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: repoRoot, encoding: "utf8" }).trim();

function refs(schema, extras = {}) {
  return {
    schema,
    public_main: parent,
    public_ancestor_P: parent,
    private_R: head,
    held_board_ref: "refs/heads/board",
    allowed_refs: ["refs/heads/main", "refs/notes/review", "refs/tags/v0.1.0-pre.11"],
    required_categories: ["main", "notes", "tags"],
    ...(schema === "superbee.ref-assertions.v1" ? { observed_refs: ["refs/heads/main", "refs/notes/review", "refs/tags/v0.1.0-pre.11"] } : {}),
    ...extras,
  };
}

async function fixture(root) {
  const candidates = {};
  for (const id of ["bridge", "successor", "rehearsal-reject", "rehearsal-approve"]) {
    const tuple = targetManifest.allowed_tuples[id];
    const target = targetManifest.targets[id];
    const dir = path.join(root, "input", id);
    await mkdir(dir, { recursive: true });
    const filename = `${target.tarball_basename}-${tuple.version}.tgz`;
    const tarball = path.join(dir, filename);
    await writeFile(tarball, `retained ${id}\n`);
    await writeFile(path.join(dir, "candidate.json"), JSON.stringify({
      schema: "superbee.release-candidate.v1",
      target: id,
      package: { name: tuple.package },
      version: tuple.version,
      tag: tuple.tag,
      source: { commit: head, dirty: false },
      tarball: { filename, version: tuple.version, sha256: await fileSha256(tarball) },
    }, null, 2));
    candidates[id] = dir;
  }
  const evidenceDir = path.join(root, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const evidence = {
    "planning-heads": path.join(evidenceDir, "planning-heads.json"),
    "registry-snapshot": path.join(evidenceDir, "registry-snapshot.json"),
    "refs-baseline": path.join(evidenceDir, "refs-baseline.json"),
    "refs-recheck": path.join(evidenceDir, "refs-recheck.json"),
    "settings-baseline": path.join(evidenceDir, "settings-baseline.json"),
    "settings-recheck": path.join(evidenceDir, "settings-recheck.json"),
    "transfer-bundle": path.join(evidenceDir, "transfer-bundle"),
    "transfer-allowlist": path.join(evidenceDir, "transfer-allowlist.json"),
    "cutover-script": path.join(evidenceDir, "cutover-script"),
  };
  await writeFile(evidence["planning-heads"], JSON.stringify({
    schema: "superbee.planning-heads.v1",
    plan: `sha256:${"1".repeat(64)}`,
    contract: `sha256:${"2".repeat(64)}`,
    successor_coordinate_decision: `sha256:${"3".repeat(64)}`,
  }));
  await writeFile(evidence["registry-snapshot"], "opaque registry snapshot\n");
  await writeFile(evidence["refs-baseline"], JSON.stringify(refs("superbee.ref-assertions.v1")));
  await writeFile(evidence["refs-recheck"], JSON.stringify(refs("superbee.ref-assertions.v1")));
  await writeFile(evidence["settings-baseline"], "opaque settings baseline\n");
  await writeFile(evidence["settings-recheck"], "opaque settings recheck\n");
  await writeFile(evidence["transfer-bundle"], "opaque transfer bundle\n");
  await writeFile(evidence["transfer-allowlist"], JSON.stringify(refs("superbee.transfer-allowlist.v1")));
  await writeFile(evidence["cutover-script"], "#!/bin/sh\n# operator-owned, non-executing artifact\n");
  return { candidates, evidence };
}

test("the committed packet-input manifest is the exact static closure plus explicit inputs", async () => {
  const result = await validatePacketInputManifest();
  assert.ok(result.paths.includes("scripts/release-packet.mjs"));
  assert.ok(result.paths.includes("packages/cli/scripts/prepare-bundle-inputs.mjs"));
});

test("the packet-input manifest rejects missing, extra, and escaping rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-manifest-"));
  try {
    const committed = JSON.parse(await readFile(path.join(repoRoot, "release", "review-packet-inputs.json"), "utf8"));
    const manifest = path.join(root, "inputs.json");
    await writeFile(manifest, JSON.stringify({ ...committed, paths: committed.paths.slice(1) }));
    await assert.rejects(validatePacketInputManifest({ manifestPath: manifest }), /missing:/);
    await writeFile(manifest, JSON.stringify({ ...committed, paths: [...committed.paths, "README.md"].sort() }));
    await assert.rejects(validatePacketInputManifest({ manifestPath: manifest }), /extra:/);
    await writeFile(manifest, JSON.stringify({ ...committed, paths: [...committed.paths.slice(0, -1), "../escape.mjs"].sort() }));
    await assert.rejects(validatePacketInputManifest({ manifestPath: manifest }), /invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the closure rejects dynamic, unresolved, and escaping local imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-closure-"));
  try {
    await writeFile(path.join(root, "dynamic.mjs"), 'await import("./x.mjs");\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["dynamic.mjs"] }), /dynamic import/);
    await writeFile(path.join(root, "unresolved.mjs"), 'import "./x.mjs";\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["unresolved.mjs"] }), /missing|unresolved/);
    await writeFile(path.join(root, "escape.mjs"), 'import "../x.mjs";\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["escape.mjs"] }), /invalid|escapes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation retains exactly four slots with detached self-free digest and verifies offline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-"));
  try {
    const input = await fixture(root);
    const out = path.join(root, "packet");
    const result = await createReleasePacket({
      commit: head,
      publicAncestor: parent,
      out,
      ...input,
      observedSource: { commit: head, dirty: false },
    });
    assert.deepEqual(Object.keys(result.packet.candidates).sort(), ["bridge", "rehearsal-approve", "rehearsal-reject", "successor"]);
    assert.ok(!JSON.stringify(result.packet).includes("release-packet.sha256"));
    assert.equal((await readFile(path.join(out, PACKET_OWNER), "utf8")).trim(), "superbee release review packet output v1");
    await verifyReleasePacket({ packet: path.join(out, "release-packet.json") });
    await writeFile(path.join(out, "evidence", "settings-recheck.json"), "tampered\n");
    await assert.rejects(verifyReleasePacket({ packet: path.join(out, "release-packet.json") }), /inventory differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation rejects transfer of the held board ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-board-"));
  try {
    const input = await fixture(root);
    const allowlist = JSON.parse(await readFile(input.evidence["transfer-allowlist"], "utf8"));
    allowlist.allowed_refs.push("refs/heads/board");
    allowlist.allowed_refs.sort();
    await writeFile(input.evidence["transfer-allowlist"], JSON.stringify(allowlist));
    await assert.rejects(
      createReleasePacket({ commit: head, publicAncestor: parent, out: path.join(root, "packet"), ...input, observedSource: { commit: head, dirty: false } }),
      /must not be transferable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet output cleanup refuses foreign non-empty directories", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "superbee-packet-output-"));
  try {
    await writeFile(path.join(out, "user-file"), "keep\n");
    await assert.rejects(preparePacketOutputDir(out), /not owned/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
