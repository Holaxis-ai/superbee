import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  REF_ASSERTIONS_SCHEMA,
  REVIEW_PACKET_SCHEMA,
  TRANSFER_ALLOWLIST_SCHEMA,
  createReleasePacket,
  observedCheckout,
  parsePacketArgs,
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
const gitAuthorArgs = ["-c", "user.name=packet-test", "-c", "user.email=packet-test@example.invalid"];
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const parent = head; // CI intentionally checks out depth one; synthetic P may equal R in unit fixtures.
// A tag this repository actually holds, so the packet's live ref binding is exercised against real
// repository state rather than an invented name.
const liveTagRef = execFileSync("git", ["for-each-ref", "--count=1", "--format=%(refname)", "refs/tags"], { cwd: repoRoot, encoding: "utf8" }).trim();
const syntheticRetainedVerifier = async ({ manifest }) => {
  const candidate = JSON.parse(await readFile(manifest, "utf8"));
  const packageIdentity = { name: candidate.package.name, version: candidate.version };
  return {
    package: `${packageIdentity.name}@${packageIdentity.version}`,
    identity: { identity: { package: packageIdentity } },
  };
};

/**
 * Build a REAL `git bundle` from this repository's own objects: main at the reviewed commit R, a
 * tag the repository actually holds, and a notes ref. Every transfer fixture in this file is
 * generator output, never hand-written bytes — a stub cannot exercise a pack validator.
 *
 * `mainCommit` lets a test transfer the approved ref NAMES over other content, and `extraTags`
 * lets one add a tag the reviewed allowlist does not carry.
 */
async function buildTransferBundle(bundleFile, { mainCommit = head, tagCommit, extraTags = [] } = {}) {
  const source = path.join(path.dirname(bundleFile), `transfer-repo-${path.basename(bundleFile)}`);
  await rm(source, { recursive: true, force: true });
  execFileSync("git", ["init", "--quiet", "--bare", "--template=", source], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "fetch", "--quiet", "--no-tags", repoRoot, `${mainCommit}:refs/heads/main`], { stdio: "pipe" });
  const refs = ["refs/heads/main"];
  if (tagCommit === undefined) {
    execFileSync("git", ["-C", source, "fetch", "--quiet", "--no-tags", repoRoot, `${liveTagRef}:${liveTagRef}`], { stdio: "pipe" });
    refs.push(liveTagRef);
  } else {
    execFileSync("git", ["-C", source, "update-ref", liveTagRef, tagCommit], { stdio: "pipe" });
    refs.push(liveTagRef);
  }
  for (const tag of extraTags) {
    execFileSync("git", ["-C", source, "update-ref", `refs/tags/${tag}`, "refs/heads/main"], { stdio: "pipe" });
    refs.push(`refs/tags/${tag}`);
  }
  execFileSync("git", [...gitAuthorArgs, "-C", source, "notes", "--ref", "review", "add", "-m", "transfer review", "refs/heads/main"], { stdio: "pipe" });
  refs.push("refs/notes/review");
  await rm(bundleFile, { force: true });
  execFileSync("git", ["-C", source, "bundle", "create", path.resolve(bundleFile), ...refs], { stdio: "pipe" });
  await rm(source, { recursive: true, force: true });
  return bundleHeads(bundleFile);
}

// One real bundle of this repository's history, built once and copied into each fixture: the pack
// is large, and every packet test needs valid transfer evidence rather than its own variant.
const sharedBundleDir = await mkdtemp(path.join(tmpdir(), "superbee-packet-bundle-"));
process.on("exit", () => rmSync(sharedBundleDir, { recursive: true, force: true }));

function bundleHeads(bundleFile) {
  const listed = execFileSync("git", ["bundle", "list-heads", bundleFile], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const heads = {};
  for (const line of listed.split("\n").filter(Boolean)) {
    const [, sha, ref] = /^([a-f0-9]{40})\s+(\S+)$/.exec(line);
    heads[ref] = sha;
  }
  return Object.fromEntries(Object.keys(heads).sort().map((ref) => [ref, heads[ref]]));
}

const sharedBundle = path.join(sharedBundleDir, "transfer-bundle");
const sharedBundleHeads = await buildTransferBundle(sharedBundle);

async function rewritePacket(out, mutate) {
  const packetPath = path.join(out, "release-packet.json");
  const packet = JSON.parse(await readFile(packetPath, "utf8"));
  mutate(packet);
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const sha = await fileSha256(packetPath);
  await writeFile(path.join(out, "release-packet.sha256"), `${sha.slice("sha256:".length)}  release-packet.json\n`);
}

function sortedRefMap(entries) {
  return Object.fromEntries(Object.keys(entries).sort().map((ref) => [ref, entries[ref]]));
}

function refs(schema, allowedRefs = sharedBundleHeads, extras = {}) {
  return {
    schema,
    public_main: parent,
    public_ancestor_P: parent,
    private_R: head,
    held_board_ref: "refs/heads/board",
    allowed_refs: allowedRefs,
    required_categories: ["main", "notes", "tags"],
    ...(schema === REF_ASSERTIONS_SCHEMA ? { observed_refs: allowedRefs } : {}),
    ...extras,
  };
}

async function writeRefEvidence(evidence, allowedRefs) {
  await writeFile(evidence["refs-baseline"], JSON.stringify(refs(REF_ASSERTIONS_SCHEMA, allowedRefs)));
  await writeFile(evidence["refs-recheck"], JSON.stringify(refs(REF_ASSERTIONS_SCHEMA, allowedRefs)));
  await writeFile(evidence["transfer-allowlist"], JSON.stringify(refs(TRANSFER_ALLOWLIST_SCHEMA, allowedRefs)));
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
  await writeFile(evidence["settings-baseline"], JSON.stringify({ schema: "superbee.release-settings.v1", visibility: "private", npm: { provenance: true } }));
  await writeFile(evidence["settings-recheck"], JSON.stringify({ schema: "superbee.release-settings.v1", visibility: "private", npm: { provenance: true } }));
  await cp(sharedBundle, evidence["transfer-bundle"]);
  await writeRefEvidence(evidence, sharedBundleHeads);
  await writeFile(evidence["cutover-script"], "#!/bin/sh\n# operator-owned, non-executing artifact\n");
  return { candidates, evidence };
}

// A real checkout of exactly the files the packet manifest claims, indexed by real git, so the
// derivation can be exercised against mutated workflows without touching the working repository.
async function manifestFixture(root) {
  const committed = JSON.parse(await readFile(path.join(repoRoot, "release", "review-packet-inputs.json"), "utf8"));
  const workflows = (await readdir(path.join(repoRoot, ".github", "workflows")))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `.github/workflows/${name}`);
  const workspaceManifests = (await readdir(path.join(repoRoot, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`);
  const scriptModules = (await readdir(path.join(repoRoot, "scripts")))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .map((name) => `scripts/${name}`);
  for (const relative of [...new Set([...committed.paths, ...workflows, ...workspaceManifests, ...scriptModules])]) {
    const from = path.join(repoRoot, relative);
    if (!existsSync(from)) continue;
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await cp(from, path.join(root, relative));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  return { manifestPath: path.join(root, "release", "review-packet-inputs.json") };
}

async function appendWorkflowStep(root, workflow, run) {
  const file = path.join(root, ".github", "workflows", workflow);
  await writeFile(file, `${await readFile(file, "utf8")}\n      - name: added by the test\n        run: ${run}\n`);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
}

async function ignoredCheckout(root) {
  await writeFile(path.join(root, ".gitignore"), await readFile(path.join(repoRoot, ".gitignore"), "utf8"));
  await writeFile(path.join(root, "tracked.txt"), "tracked\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root, stdio: "pipe" });
  execFileSync("git", [...gitAuthorArgs, "commit", "--quiet", "-m", "fixture"], { cwd: root, stdio: "pipe" });
}

test("the committed packet-input manifest is the exact static closure plus explicit inputs", async () => {
  const result = await validatePacketInputManifest();
  assert.ok(result.paths.includes("scripts/release-packet.mjs"));
  assert.ok(result.paths.includes("packages/cli/scripts/prepare-bundle-inputs.mjs"));
  assert.ok(result.paths.includes("scripts/prepublish-guard.mjs"), "manifest must retain the publish lifecycle guard");
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

test("observed checkout allows the deterministic outputs from the normal npm run check path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-ignored-"));
  try {
    await ignoredCheckout(root);
    for (const prefix of [
      "packages/ui/playwright-report/",
      "packages/ui/blob-report/",
      "packages/ui/test-results/",
      "packages/mcp-app/test-results/",
    ]) {
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

// F4: the allowed-ignored set is whatever the repository's own tracked .gitignore files declare —
// the class, not an enumerated prefix list. A checkout that has run `npm ci && npm run check` and
// then hosted a normal agent session carries all of these, and every one of them is declared.
test("observed checkout accepts the full ignored surface a real gate plus agent session leaves behind", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-ignored-surface-"));
  try {
    await ignoredCheckout(root);
    for (const relative of [
      ".DS_Store",
      ".claude/settings.local.json",
      ".agentstate-lite/docs/note.md",
      "docs/architecture.md",
      "dist/bundle.mjs",
      "node_modules/.package-lock.json",
      "packages/core/reports/mutation/mutation.json",
      "packages/cli/.stryker-tmp/sandbox/file.mjs",
      "packages/cli/dist/superbee.mjs",
      "packages/worker/dist/worker.mjs",
      "packages/ui/playwright-report/index.html",
      "release-candidate/superbee-0.1.0.tgz",
      "stray-pack.tgz",
    ]) {
      await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
      await writeFile(path.join(root, relative), "generated\n");
    }
    assert.deepEqual(await observedCheckout(root), {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observed checkout rejects ignored content hidden by rules outside the tracked .gitignore set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-smuggle-"));
  const globalExcludes = `${root}-global-excludes`;
  try {
    await ignoredCheckout(root);
    await writeFile(path.join(root, ".git", "info", "exclude"), "locally-hidden\n");
    await writeFile(path.join(root, "locally-hidden"), "smuggled through .git/info/exclude\n");
    await assert.rejects(
      observedCheckout(root),
      /ignored paths no tracked \.gitignore declares: locally-hidden \(\.git\/info\/exclude:1\)/,
    );
    await rm(path.join(root, "locally-hidden"));

    await writeFile(path.join(root, ".git", "info", "exclude"), "");
    await writeFile(globalExcludes, "globally-hidden\n");
    execFileSync("git", ["config", "core.excludesFile", globalExcludes], { cwd: root, stdio: "pipe" });
    await writeFile(path.join(root, "globally-hidden"), "smuggled through a global excludes file\n");
    await assert.rejects(
      observedCheckout(root),
      /ignored paths no tracked \.gitignore declares: globally-hidden \(/,
    );
    await rm(path.join(root, "globally-hidden"));

    // An untracked nested .gitignore cannot launder content either: the file itself is an
    // unreviewed working-tree change before its rules are ever consulted.
    execFileSync("git", ["config", "--unset", "core.excludesFile"], { cwd: root, stdio: "pipe" });
    await mkdir(path.join(root, "nested"), { recursive: true });
    await writeFile(path.join(root, "nested", ".gitignore"), "hidden-by-nested\n");
    await writeFile(path.join(root, "nested", "hidden-by-nested"), "smuggled through an untracked rule file\n");
    await assert.rejects(observedCheckout(root), /non-ignored changes: \?\? nested\/\.gitignore/);
  } finally {
    await rm(globalExcludes, { force: true });
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

// F5: the reachable-entrypoint set is parsed out of the workflow files, across every workflow in
// the directory — not a frozen constant that stops describing them the moment one is edited.
test("the manifest closure follows every workflow file, package script hop, and command substitution", async () => {
  const cases = [
    ["a node invocation added to a non-release workflow", async (root) => {
      await appendWorkflowStep(root, "ci-tests.yml", "node scripts/release-inspect.mjs");
    }, /missing: [^;]*scripts\/release-inspect\.mjs/],
    ["a node invocation added inside a command substitution", async (root) => {
      await appendWorkflowStep(root, "release-audit.yml", 'FACTS="$(node scripts/release-reconcile.mjs --json)"');
    }, /missing: [^;]*scripts\/release-reconcile\.mjs/],
    ["a node invocation added through an entirely new workflow file", async (root) => {
      await writeFile(path.join(root, ".github", "workflows", "extra.yml"),
        "name: extra\non:\n  workflow_dispatch:\njobs:\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/release-inspect-recovery.mjs\n");
      execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
    }, /missing: [^;]*scripts\/release-inspect-recovery\.mjs/],
    ["a node invocation added to a package script a workflow runs", async (root) => {
      const file = path.join(root, "package.json");
      const manifest = JSON.parse(await readFile(file, "utf8"));
      manifest.scripts["mutation:survivors"] = "node scripts/rename-literal-inventory.mjs";
      await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
      execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
    }, /missing: [^;]*scripts\/rename-literal-inventory\.mjs/],
    ["a node invocation whose script path is not statically resolvable", async (root) => {
      await appendWorkflowStep(root, "release-staged.yml", 'node "$UNPINNED_SCRIPT"');
    }, /unresolvable script path|unresolvable argument/],
    ["a node invocation of a path that is neither tracked nor ignored", async (root) => {
      await appendWorkflowStep(root, "release-finalize.yml", "node scripts/not-in-the-index.mjs");
    }, /neither a tracked source file nor an ignored build output/],
  ];
  for (const [name, mutate, expected] of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-topology-"));
    try {
      const { manifestPath } = await manifestFixture(root);
      await validatePacketInputManifest({ root, manifestPath });
      await mutate(root);
      await assert.rejects(validatePacketInputManifest({ root, manifestPath }), expected, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    assert.equal(result.packet.schema, REVIEW_PACKET_SCHEMA);
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
      isolatedPacket.verifyReleasePacket({ packet: path.join(out, "release-packet.json"), root: sourceRoot, retainedVerifier: syntheticRetainedVerifier }),
      /checkout has non-ignored changes: \?\? ambient-untracked/,
    );
    await assert.rejects(
      verifyReleasePacket({ packet: path.join(out, "release-packet.json"), root: sourceRoot, retainedVerifier: syntheticRetainedVerifier }),
      /same checkout as --root|foreign checkout/i,
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
    allowlist.allowed_refs = sortedRefMap({ ...allowlist.allowed_refs, "refs/heads/board": head });
    await writeFile(input.evidence["transfer-allowlist"], JSON.stringify(allowlist));
    await assert.rejects(
      createReleasePacket({ commit: head, publicAncestor: parent, out: path.join(root, "packet"), ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier }),
      /must not be transferable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation rejects a retained transfer bundle whose actual heads differ from the reviewed allowlist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-bundle-heads-"));
  try {
    const input = await fixture(root);
    await buildTransferBundle(input.evidence["transfer-bundle"], { extraTags: ["v0.0.0-smuggled"] });
    await assert.rejects(
      createReleasePacket({ commit: head, publicAncestor: parent, out: path.join(root, "packet"), ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier }),
      /transfer bundle heads differ from the reviewed allowlist/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// F3: the review reproduced a bundle whose refs carry the approved NAMES over other content, and a
// bundle truncated to its header. `git bundle list-heads` accepts both; so did the packet.
test("packet creation rejects a transfer bundle whose head commits or pack bytes are not the reviewed ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-bundle-integrity-"));
  const create = async (input, suffix) => createReleasePacket({
    commit: head, publicAncestor: parent, out: path.join(root, suffix), ...input,
    observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
  });
  try {
    // Approved ref names over unreviewed content: main carries a commit that is not R.
    const substituted = await fixture(path.join(root, "substituted"));
    const otherCommit = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const smuggledHeads = await buildTransferBundle(substituted.evidence["transfer-bundle"], { mainCommit: otherCommit });
    assert.deepEqual(Object.keys(smuggledHeads), Object.keys(sharedBundleHeads), "the smuggled bundle carries the approved ref names");
    assert.notEqual(smuggledHeads["refs/heads/main"], sharedBundleHeads["refs/heads/main"]);
    await assert.rejects(create(substituted, "packet-substituted"), /transfer bundle heads differ from the reviewed allowlist/);

    // The same substitution with envelopes rewritten to match it: main is still not the reviewed R.
    const consistent = await fixture(path.join(root, "consistent"));
    await buildTransferBundle(consistent.evidence["transfer-bundle"], { mainCommit: otherCommit });
    await writeRefEvidence(consistent.evidence, smuggledHeads);
    await assert.rejects(create(consistent, "packet-consistent"), /transferable refs\/heads\/main must carry the reviewed commit/);

    // A bundle truncated to its header still lists the approved heads.
    const truncated = await fixture(path.join(root, "truncated"));
    const whole = await readFile(truncated.evidence["transfer-bundle"]);
    await writeFile(truncated.evidence["transfer-bundle"], whole.subarray(0, 200));
    assert.deepEqual(bundleHeads(truncated.evidence["transfer-bundle"]), sharedBundleHeads, "list-heads accepts the truncated bundle");
    await assert.rejects(create(truncated, "packet-truncated"), /transfer bundle pack is incomplete, corrupt, or not self-contained/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// F11: the packet enumerates the refs the creating repository actually holds and binds them to the
// operator-supplied envelopes, so stale evidence and a post-cutover repository are both rejected.
test("packet creation binds transfer evidence to the refs the creating repository actually holds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-live-refs-"));
  const create = async (input, suffix) => createReleasePacket({
    commit: head, publicAncestor: parent, out: path.join(root, suffix), ...input,
    observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
  });
  try {
    // Internally consistent evidence — bundle and envelopes agree — whose tag is not the commit
    // this repository holds under that name. Only a live enumeration can catch it.
    const stale = await fixture(path.join(root, "stale"));
    const staleTagCommit = execFileSync("git", ["rev-parse", "HEAD~2"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const staleHeads = await buildTransferBundle(stale.evidence["transfer-bundle"], { tagCommit: staleTagCommit });
    await writeRefEvidence(stale.evidence, staleHeads);
    await assert.rejects(
      create(stale, "packet-stale"),
      new RegExp(`transfer evidence asserts ${liveTagRef}@${staleTagCommit} but the creating repository holds`),
    );

    const cutover = await fixture(path.join(root, "cutover"));
    const reservedTag = targetManifest.allowed_tuples["successor-stable"].tag;
    execFileSync("git", ["tag", reservedTag, head], { cwd: repoRoot, stdio: "pipe" });
    try {
      await assert.rejects(
        create(cutover, "packet-cutover"),
        new RegExp(`protected release tag refs/tags/${reservedTag.replaceAll(".", "\\.")} already exists in the creating repository`),
      );
    } finally {
      execFileSync("git", ["tag", "-d", reservedTag], { cwd: repoRoot, stdio: "pipe" });
    }

    const recorded = await fixture(path.join(root, "recorded"));
    const { packet } = await create(recorded, "packet-recorded");
    const liveRefs = execFileSync("git", ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags", "refs/notes"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n").filter(Boolean)
      .map((line) => ({ ref: line.split(" ")[1], sha: line.split(" ")[0] }))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1));
    assert.deepEqual(packet.lifecycle.creation_repository_refs, liveRefs, "the packet records the enumeration it checked");
    assert.deepEqual(packet.lifecycle.transfer_refs_confirmed_at_create, [liveTagRef]);
    assert.deepEqual(packet.lifecycle.transfer_refs_unobserved_at_create, ["refs/heads/main", "refs/notes/review"]);
    assert.match(packet.lifecycle.claim, /held 1 of 3 allowlisted refs/);
    assert.match(packet.lifecycle.claim, /Nothing here proves the state of any remote repository/);

    // The recorded enumeration is what verification re-runs the same rules against.
    const out = path.join(root, "packet-recorded");
    await rewritePacket(out, (value) => { value.lifecycle.transfer_refs_confirmed_at_create = []; });
    await assert.rejects(
      verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } }),
      /packet lifecycle differs from the release targets and the retained transfer evidence/,
    );
    await rewritePacket(out, (value) => {
      value.lifecycle = packet.lifecycle;
      value.lifecycle.creation_repository_refs = [...packet.lifecycle.creation_repository_refs, { ref: `refs/tags/${targetManifest.allowed_tuples.bridge.tag}`, sha: head }]
        .sort((a, b) => (a.ref < b.ref ? -1 : 1));
    });
    await assert.rejects(
      verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } }),
      /already exists in the repository state this packet recorded at creation/,
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
        const { [liveTagRef]: dropped, ...rest } = value.allowed_refs;
        value.allowed_refs = sortedRefMap({ ...rest, "refs/tags/v0.0.0-absent": dropped });
        value.observed_refs = value.allowed_refs;
        await writeFile(input.evidence["refs-baseline"], JSON.stringify(value));
      }, /allowed refs differ/],
      ["drift", async (input) => {
        const value = JSON.parse(await readFile(input.evidence["refs-recheck"], "utf8"));
        value.allowed_refs = sortedRefMap({ ...value.allowed_refs, "refs/tags/v0.0.0-drifted": head });
        value.observed_refs = value.allowed_refs;
        await writeFile(input.evidence["refs-recheck"], JSON.stringify(value));
      }, /allowed refs differ/],
      ["future-tag", async (input) => {
        const protectedTag = targetManifest.allowed_tuples["successor-stable"].tag;
        const heads = await buildTransferBundle(input.evidence["transfer-bundle"], { extraTags: [protectedTag] });
        await writeRefEvidence(input.evidence, heads);
      }, /protected release tag refs\/tags\/v0\.1\.0 is not transferable|transfer bundle heads differ/i],
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
        changed.allowed_refs = sortedRefMap({ ...changed.allowed_refs, "refs/heads/board": head });
        changed.observed_refs = changed.allowed_refs;
        await writeFile(input.evidence[id], JSON.stringify(changed));
      },
    });
    const retained = JSON.parse(await readFile(path.join(root, "packet", "evidence", "refs-baseline.json"), "utf8"));
    assert.ok(!Object.hasOwn(retained.allowed_refs, "refs/heads/board"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation records pre-cutover lifecycle semantics while verification remains a retained-packet audit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-post-cutover-"));
  try {
    const input = await fixture(root);
    const out = path.join(root, "packet");
    const created = await createReleasePacket({ commit: head, publicAncestor: parent, out, ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier });
    assert.deepEqual(
      created.packet.lifecycle.protected_release_tag_refs,
      [...new Set(Object.values(targetManifest.allowed_tuples).map((tuple) => `refs/tags/${tuple.tag}`))].sort(),
    );
    await verifyReleasePacket({ packet: path.join(out, "release-packet.json"), retainedVerifier: syntheticRetainedVerifier, observedSource: { commit: head, dirty: false } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation rejects settings drift even when both settings files are internally valid JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-settings-"));
  try {
    const input = await fixture(root);
    await writeFile(input.evidence["settings-recheck"], JSON.stringify({ schema: "superbee.release-settings.v1", visibility: "public", npm: { provenance: true } }));
    await assert.rejects(
      createReleasePacket({ commit: head, publicAncestor: parent, out: path.join(root, "packet"), ...input, observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier }),
      /settings baseline.*recheck differ|settings drift/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ref assertions reject board lookalikes, control characters, and unbound heads", () => {
  const envelope = (allowedRefs) => refs(TRANSFER_ALLOWLIST_SCHEMA, sortedRefMap(allowedRefs));
  const check = (allowedRefs) => validateRefAssertionsEnvelope(envelope(allowedRefs), { publicAncestor: parent, privateCommit: head, allowlist: true });
  const base = { "refs/heads/main": head, "refs/notes/review": head, "refs/tags/v0.1.0-pre.11": head };
  assert.throws(() => check({ ...base, "refs/heads/board ": head }), /invalid allowed refs/);
  assert.throws(() => check({ ...base, "refs/heads/board": head }), /must not be transferable/);
  assert.throws(() => check({ ...base, "refs/heads/main": `${"0".repeat(39)}1` }), /must carry the reviewed commit/);
  assert.throws(() => check({ ...base, "refs/tags/v0.1.0-pre.11": "not-a-commit" }), /invalid allowed refs refs\/tags\/v0\.1\.0-pre\.11 commit/);
  assert.throws(
    () => validateRefAssertionsEnvelope(refs(TRANSFER_ALLOWLIST_SCHEMA, { "refs/tags/z": head, "refs/heads/main": head }), { publicAncestor: parent, privateCommit: head, allowlist: true }),
    /must be sorted and unique/,
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

test("packet argument parsing rejects unknown flags", () => {
  assert.throws(
    () => parsePacketArgs(["verify", "--packet", "release-packet.json", "--bogus"]),
    /unknown argument|usage/i,
  );
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
