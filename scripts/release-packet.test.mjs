import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createReleasePacket,
  observedCheckout,
  preparePacketOutputDir,
  staticPacketClosure,
  trackedSourceFiles,
  validatePacketInputManifest,
  validateRefAssertionsEnvelope,
  verifyReleasePacket,
} from "./release-packet.mjs";
import { fileSha256 } from "./verify-npm-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetManifest = JSON.parse(await readFile(path.join(repoRoot, "release", "targets.json"), "utf8"));
// Pre-cutover transfer evidence preserves existing public history. Candidate/rehearsal tags are
// reserved in targets.json but do not exist until later human-authorized release work.
const transferRefs = ["refs/heads/main", "refs/notes/review", "refs/tags/v0.1.0-pre.10"].sort();
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const parent = head; // CI intentionally checks out depth one; synthetic P may equal R in unit fixtures.
const syntheticRetainedVerifier = async ({ manifest }) => {
  const candidate = JSON.parse(await readFile(manifest, "utf8"));
  const packageIdentity = { name: candidate.package.name, version: candidate.version };
  return {
    package: `${packageIdentity.name}@${packageIdentity.version}`,
    identity: { identity: { package: packageIdentity } },
  };
};

async function rewritePacket(out, mutate) {
  const packetPath = path.join(out, "release-packet.json");
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  mutate(packet);
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const sha = await fileSha256(packetPath);
  await writeFile(path.join(out, "release-packet.sha256"), `${sha.slice("sha256:".length)}  release-packet.json\n`);
}

function refs(schema, extras = {}) {
  return {
    schema,
    public_main: parent,
    public_ancestor_P: parent,
    private_R: head,
    held_board_ref: "refs/heads/board",
    allowed_refs: transferRefs,
    required_categories: ["main", "notes", "tags"],
    ...(schema === "superbee.ref-assertions.v1" ? { observed_refs: transferRefs } : {}),
    ...extras,
  };
}

async function fixture(root) {
  const candidates = {};
  for (const id of Object.keys(targetManifest.allowed_tuples)) {
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
  await writeFile(evidence["transfer-bundle"], "# opaque git bundle retained by digest only\n");
  await writeFile(evidence["transfer-allowlist"], JSON.stringify(refs("superbee.transfer-allowlist.v1")));
  await writeFile(evidence["cutover-script"], "#!/bin/sh\n# operator-owned, non-executing artifact\n");
  return { candidates, evidence };
}

async function ignoredCheckout(root) {
  const prefixes = [
    "node_modules/",
    "packages/board-git/dist/",
    "packages/cli/dist/",
    "packages/cli/src/generated/",
    "packages/core/dist/",
    "packages/markdown-renderer/dist/",
    "packages/mcp-app/dist/",
    "packages/mcp-app/src/generated/",
    "packages/server/dist/",
    "packages/ui-server/dist/",
    "packages/ui/dist/",
    "packages/ui/node_modules/",
    "packages/view-runtime/dist/",
    "release-candidate/",
  ];
  await writeFile(path.join(root, ".gitignore"), `${prefixes.join("\n")}\n*.tgz\npackages/ui/test-results/\n`);
  await writeFile(path.join(root, "tracked.txt"), "tracked\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=packet-test", "-c", "user.email=packet-test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root, stdio: "pipe" });
  return prefixes;
}

async function addCandidateTagToRetainedEvidence(out, tag) {
  const packetPath = path.join(out, "release-packet.json");
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  for (const id of ["refs-baseline", "refs-recheck", "transfer-allowlist"]) {
    const evidenceRow = packet.external_evidence.find((row) => row.category === id);
    const file = path.join(out, evidenceRow.path);
    const value = JSON.parse(await readFile(file, "utf8"));
    value.allowed_refs = [...value.allowed_refs, `refs/tags/${tag}`].sort();
    if (value.observed_refs) value.observed_refs = value.allowed_refs;
    await writeFile(file, `${JSON.stringify(value)}\n`);
    const bytes = await readFile(file);
    const sha256 = await fileSha256(file);
    evidenceRow.sha256 = sha256;
    evidenceRow.bytes = bytes.length;
    const inventoryRow = packet.inventory.find((row) => row.path === evidenceRow.path);
    inventoryRow.sha256 = sha256;
    inventoryRow.bytes = bytes.length;
  }
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const sha = await fileSha256(packetPath);
  await writeFile(path.join(out, "release-packet.sha256"), `${sha.slice("sha256:".length)}  release-packet.json\n`);
}

test("the committed packet-input manifest is the exact static closure plus explicit inputs", async () => {
  const result = await validatePacketInputManifest();
  assert.ok(result.paths.includes("scripts/release-packet.mjs"));
  assert.ok(result.paths.includes("packages/cli/scripts/prepare-bundle-inputs.mjs"));
  assert.ok(!result.paths.includes("release/bridge-phase.json"));
  assert.ok(!result.paths.includes("release/superbee-cutover.json"));
  for (const script of ["release-run-operations", "release-resolve-target", "release-verify-ordering", "release-verify-registry", "release-emit-receipt", "release-audit-tags"]) {
    assert.ok(result.paths.includes(`scripts/${script}.mjs`), `manifest must retain workflow-reached ${script}`);
  }
});

test("tracked source manifest is complete, sorted, and rooted in regular Git-index files", async () => {
  const rows = await trackedSourceFiles();
  assert.ok(rows.length > 0);
  assert.deepEqual(rows, [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  assert.ok(rows.some((row) => row.path === "scripts/release-packet.mjs"));
});

test("tracked source manifest rejects Git-index symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-index-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
    await writeFile(path.join(root, "real.mjs"), "export const value = true;\n");
    await symlink("real.mjs", path.join(root, "linked.mjs"));
    execFileSync("git", ["add", "real.mjs", "linked.mjs"], { cwd: root, stdio: "pipe" });
    await assert.rejects(trackedSourceFiles(root), /unsupported git index mode/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observed checkout allows exactly the normal generated-output roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-ignored-"));
  try {
    for (const prefix of await ignoredCheckout(root)) {
      await mkdir(path.join(root, prefix), { recursive: true });
      await writeFile(path.join(root, prefix, ".marker"), "generated\n");
      assert.deepEqual(await observedCheckout(root), {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        dirty: false,
      }, prefix);
      await rm(path.join(root, prefix), { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observed checkout rejects ignored output smuggling and names every offender", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-smuggle-"));
  try {
    await ignoredCheckout(root);
    await writeFile(path.join(root, "stray.tgz"), "smuggled tarball\n");
    await mkdir(path.join(root, "packages", "ui", "test-results"), { recursive: true });
    await writeFile(path.join(root, "packages", "ui", "test-results", "result.txt"), "smuggled test output\n");
    await assert.rejects(
      observedCheckout(root),
      /checkout has disallowed ignored paths: packages\/ui\/test-results\/, stray\.tgz; allowed generated-output prefixes:/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("the closure rejects dynamic, unresolved, escaping, and unsupported imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-closure-"));
  try {
    await writeFile(path.join(root, "dynamic.mjs"), 'await import("./x.mjs");\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["dynamic.mjs"] }), /dynamic import/);
    await writeFile(path.join(root, "unresolved.mjs"), 'import "./x.mjs";\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["unresolved.mjs"] }), /missing|unresolved/);
    await writeFile(path.join(root, "escape.mjs"), 'import "../x.mjs";\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["escape.mjs"] }), /invalid|escapes/);
    await writeFile(path.join(root, "url.mjs"), 'import "file:///tmp/x.mjs";\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["url.mjs"] }), /non-relative/);
    await writeFile(path.join(root, "package.mjs"), 'import "#hidden";\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["package.mjs"] }), /non-relative/);
    await writeFile(path.join(root, "commonjs.mjs"), 'import "./x.cjs";\n');
    await assert.rejects(staticPacketClosure({ root, entries: ["commonjs.mjs"] }), /extension/);
    await writeFile(path.join(root, "create-require.mjs"), 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nrequire("./hidden.cjs");\n');
    await writeFile(path.join(root, "hidden.cjs"), "module.exports = true;\n");
    await assert.rejects(staticPacketClosure({ root, entries: ["create-require.mjs"] }), /CommonJS interop/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the closure includes commented side-effect imports and static re-exports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-lexer-"));
  try {
    await writeFile(path.join(root, "entry.mjs"), "const banner = \"import { createRequire } from 'node:module';\"; import/* reviewer regression */ \"./hidden.mjs\"; export { value } from \"./re-exported.mjs\";\n");
    await writeFile(path.join(root, "hidden.mjs"), "export const hidden = true;\n");
    await writeFile(path.join(root, "re-exported.mjs"), "export const value = true;\n");
    assert.deepEqual(await staticPacketClosure({ root, entries: ["entry.mjs"] }), ["entry.mjs", "hidden.mjs", "re-exported.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation retains exactly five slots with detached self-free digest and verifies offline", async () => {
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
      retainedVerifier: syntheticRetainedVerifier,
    });
    assert.deepEqual(Object.keys(result.packet.candidates).sort(), Object.keys(targetManifest.allowed_tuples).sort());
    assert.ok(!JSON.stringify(result.packet).includes("release-packet.sha256"));
    assert.equal((await readdir(out)).includes(".superbee-release-packet-owned-v1"), false, "distributed packet must carry no deletion marker");
    assert.ok(result.packet.source_files.some((row) => row.path === "scripts/release-packet.mjs"));
    execFileSync("shasum", ["-a", "256", "-c", "release-packet.sha256"], { cwd: out, stdio: "pipe" });
    await verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } });
    await rewritePacket(out, (packet) => { packet.source_files[0].sha256 = `sha256:${"0".repeat(64)}`; });
    await assert.rejects(verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } }), /source files differ/);
    await rewritePacket(out, (packet) => { packet.source_files = result.packet.source_files; });
    await writeFile(path.join(out, "evidence", "settings-recheck.json"), "tampered\n");
    await assert.rejects(verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } }), /inventory differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation and verification accept a clean detached source checkout", async (t) => {
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim()) {
    t.skip("requires the test source to be committed before creating its exact detached checkout");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-detached-"));
  const sourceRoot = path.join(root, "source");
  try {
    execFileSync("git", ["worktree", "add", "--detach", sourceRoot, head], { cwd: repoRoot, stdio: "pipe" });
    await mkdir(path.join(sourceRoot, "node_modules"), { recursive: true });
    await cp(path.join(repoRoot, "node_modules", "es-module-lexer"), path.join(sourceRoot, "node_modules", "es-module-lexer"), { recursive: true });
    const isolatedPacket = await import(`${pathToFileURL(path.join(sourceRoot, "scripts", "release-packet.mjs")).href}?fixture=${Date.now()}`);
    const input = await fixture(root);
    const out = path.join(root, "packet");
    await isolatedPacket.createReleasePacket({ commit: head, publicAncestor: parent, out, ...input, root: sourceRoot, retainedVerifier: syntheticRetainedVerifier });
    await isolatedPacket.verifyReleasePacket({ packet: path.join(out, "release-packet.json"), root: sourceRoot, retainedVerifier: syntheticRetainedVerifier });
    await writeFile(path.join(sourceRoot, "ambient-untracked"), "must reject\n");
    await assert.rejects(
      verifyReleasePacket({ packet: path.join(out, "release-packet.json"), root: sourceRoot, retainedVerifier: syntheticRetainedVerifier }),
      /checkout has non-ignored changes: \?\? ambient-untracked/,
    );
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", sourceRoot], { cwd: repoRoot, stdio: "pipe" });
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
      createReleasePacket({ commit: head, publicAncestor: parent, out: path.join(root, "packet"), ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier }),
      /must not be transferable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transfer authority cross-attests pre-cutover history without requiring future candidate tags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-transfer-"));
  const create = async (input, suffix) => createReleasePacket({ commit: head, publicAncestor: parent, out: path.join(root, suffix), ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier });
  try {
    for (const [name, mutate, expected] of [
      ["omitted", async (input) => {
        const value = JSON.parse(await readFile(input.evidence["refs-baseline"], "utf8"));
        value.allowed_refs = value.allowed_refs.map((ref) => ref === "refs/tags/v0.1.0-pre.10" ? "refs/tags/v0.1.0-pre.9" : ref).sort();
        value.observed_refs = value.allowed_refs;
        await writeFile(input.evidence["refs-baseline"], JSON.stringify(value));
      }, /allowed refs differ/],
      ["drift", async (input) => {
        const value = JSON.parse(await readFile(input.evidence["refs-recheck"], "utf8"));
        value.allowed_refs = [...value.allowed_refs, "refs/tags/v0.1.0-pre.9"].sort();
        value.observed_refs = value.allowed_refs;
        await writeFile(input.evidence["refs-recheck"], JSON.stringify(value));
      }, /allowed refs differ/],
      ["future-tag", async (input) => {
        for (const id of ["refs-baseline", "refs-recheck", "transfer-allowlist"]) {
          const value = JSON.parse(await readFile(input.evidence[id], "utf8"));
          value.allowed_refs = [...value.allowed_refs, "refs/tags/v0.1.0"].sort();
          if (value.observed_refs) value.observed_refs = value.allowed_refs;
          await writeFile(input.evidence[id], JSON.stringify(value));
        }
      }, /pre-cutover packet cannot be created or verified after candidate tag exists/],
    ]) {
      const input = await fixture(path.join(root, name));
      await mutate(input);
      await assert.rejects(create(input, `packet-${name}`), expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transfer authority uses retained bytes after an evidence source changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-snapshot-"));
  try {
    const input = await fixture(root);
    await createReleasePacket({
      commit: head,
      publicAncestor: parent,
      out: path.join(root, "packet"),
      ...input,
      observedSource: { commit: head, dirty: false },
      retainedVerifier: syntheticRetainedVerifier,
      onEvidenceCaptured: async (id) => {
        if (id !== "refs-baseline") return;
        const changed = JSON.parse(await readFile(input.evidence[id], "utf8"));
        changed.allowed_refs = [...changed.allowed_refs, "refs/heads/board"].sort();
        changed.observed_refs = changed.allowed_refs;
        await writeFile(input.evidence[id], JSON.stringify(changed));
      },
    });
    const retained = JSON.parse(await readFile(path.join(root, "packet", "evidence", "refs-baseline.json"), "utf8"));
    assert.ok(!retained.allowed_refs.includes("refs/heads/board"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet verification rejects every reserved candidate tag after cutover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-post-cutover-"));
  try {
    for (const tuple of Object.values(targetManifest.allowed_tuples)) {
      const input = await fixture(path.join(root, tuple.target));
      const out = path.join(root, tuple.target, "packet");
      await createReleasePacket({ commit: head, publicAncestor: parent, out, ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier });
      await addCandidateTagToRetainedEvidence(out, tuple.tag);
      await assert.rejects(
        verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } }),
        new RegExp(`pre-cutover packet cannot be created or verified after candidate tag exists: refs/tags/${tuple.tag}`),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ref assertions reject board lookalikes and control characters", () => {
  assert.throws(
    () => validateRefAssertionsEnvelope(refs("superbee.transfer-allowlist.v1", { allowed_refs: ["refs/heads/board ", "refs/heads/main", "refs/notes/review", "refs/tags/v0.1.0-pre.11"] }), {
      publicAncestor: parent,
      privateCommit: head,
      allowlist: true,
    }),
    /invalid allowed refs/,
  );
  assert.throws(
    () => validateRefAssertionsEnvelope(refs("superbee.transfer-allowlist.v1", { allowed_refs: ["refs/heads/board", "refs/heads/main", "refs/notes/review", "refs/tags/v0.1.0-pre.11"] }), {
      publicAncestor: parent,
      privateCommit: head,
      allowlist: true,
    }),
    /must not be transferable/,
  );
});

test("packet output creation refuses every non-empty directory", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "superbee-packet-output-"));
  try {
    await writeFile(path.join(out, "user-file"), "keep\n");
    await assert.rejects(preparePacketOutputDir(out), /non-empty/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("packet verification binds to the clean checked-out HEAD and verified summary fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-binding-"));
  const dirtyFile = path.join(repoRoot, ".packet-test-dirty");
  try {
    const input = await fixture(root);
    const out = path.join(root, "packet");
    await createReleasePacket({ commit: head, publicAncestor: parent, out, ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier });
    await rewritePacket(out, (packet) => { packet.candidates.bridge.package = "forged-package"; });
    await assert.rejects(verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } }), /summary mismatch/);
    await rewritePacket(out, (packet) => { packet.source.commit = "0".repeat(40); });
    await assert.rejects(verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } }), /clean verification checkout/);
    await rewritePacket(out, (packet) => { packet.source.commit = head; });
    await writeFile(dirtyFile, "test\n");
    await assert.rejects(verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: true } }), /clean verification checkout/);
  } finally {
    await rm(dirtyFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a self-digest-matching text tarball cannot create a packet", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-tarball-"));
  try {
    const input = await fixture(root);
    await assert.rejects(
      createReleasePacket({ commit: head, publicAncestor: parent, out: path.join(root, "packet"), ...input, observedSource: { commit: head, dirty: false } }),
      /retained-tarball proof failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation and verification reject a verifier receipt from another same-shape slot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-cross-slot-"));
  const mismatchedVerifier = async (input) => {
    const receipt = await syntheticRetainedVerifier(input);
    const candidate = JSON.parse(await readFile(input.manifest, "utf8"));
    if (candidate.target === "rehearsal-reject") {
      const claimed = targetManifest.allowed_tuples["rehearsal-approve"];
      receipt.package = `${claimed.package}@${claimed.version}`;
      receipt.identity.identity.package = { name: claimed.package, version: claimed.version };
    }
    return receipt;
  };
  try {
    const rejectedInput = await fixture(path.join(root, "create"));
    await assert.rejects(
      createReleasePacket({
        commit: head,
        publicAncestor: parent,
        out: path.join(root, "rejected-packet"),
        ...rejectedInput,
        observedSource: { commit: head, dirty: false },
        retainedVerifier: mismatchedVerifier,
      }),
      /retained-tarball proof receipt does not match reviewed tuple/,
    );

    const acceptedInput = await fixture(path.join(root, "verify"));
    const out = path.join(root, "packet");
    await createReleasePacket({
      commit: head,
      publicAncestor: parent,
      out,
      ...acceptedInput,
      observedSource: { commit: head, dirty: false },
      retainedVerifier: syntheticRetainedVerifier,
    });
    await assert.rejects(
      verifyReleasePacket({
        packet: path.join(out, "release-packet.json"),
        observedSource: { commit: head, dirty: false },
        retainedVerifier: mismatchedVerifier,
      }),
      /retained-tarball proof receipt does not match reviewed tuple/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
