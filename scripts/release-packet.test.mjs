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
  observedCheckout,
  parsePacketArgs,
  preparePacketOutputDir,
  staticPacketClosure,
  trackedSourceFiles,
  validatePacketInputManifest,
  validateRefAssertionsEnvelope,
} from "./release-packet.mjs";
import { fileSha256 } from "./verify-npm-package.mjs";
import { captureRepositorySettings } from "./release-settings-capture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetManifest = JSON.parse(await readFile(path.join(repoRoot, "release", "targets.json"), "utf8"));
const gitAuthorArgs = ["-c", "user.name=packet-test", "-c", "user.email=packet-test@example.invalid"];
// Git derives a commit's SHA from its timestamps, so an unpinned date makes every rebuilt notes
// commit a different object and any comparison against an earlier bundle a coin flip.
const gitDateEnv = { ...process.env, GIT_AUTHOR_DATE: "2026-08-15T00:00:00Z", GIT_COMMITTER_DATE: "2026-08-15T00:00:00Z" };

/**
 * A complete repository for the packet to run against, built from this checkout's working tree.
 *
 * The packet's central claim is that the retained bundle carries a COMPLETE history rooted at the
 * reviewed commit, and it proves that by unbundling the pack and walking every reachable object.
 * CI checks out at depth one, where the checked-out commit's parents do not exist locally: no
 * bundle containing that commit can be complete, and the validator correctly refuses one. (`git
 * bundle create` still succeeds there, and `git bundle verify` still reports "The bundle records a
 * complete history" — only a real unbundle catches it. That is the same class of hole as the
 * truncated bundle this file already covers.)
 *
 * So the fixture stops borrowing the checkout's ancestry and builds its own: a root commit whose
 * history is complete by construction, carrying the working tree under test. Every packet
 * operation runs against this repository, through the packet module loaded FROM it, which is what
 * `assertExecutionRoot` requires. That makes the suite behave identically at depth one and in a
 * deep clone, and it stops the tests from creating and deleting refs in the developer's own
 * repository to satisfy the live-ref enumeration.
 */
async function createFixtureRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-source-"));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const relative of tracked) {
    const from = path.join(repoRoot, relative);
    if (!existsSync(from)) continue; // a staged deletion is not part of the tree under test
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await cp(from, path.join(root, relative));
  }
  // A real directory, so the repository's own `node_modules/` ignore rule covers it; the packet
  // module resolves its dependencies through the entries linked inside.
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  for (const entry of await readdir(path.join(repoRoot, "node_modules"))) {
    await symlink(path.join(repoRoot, "node_modules", entry), path.join(root, "node_modules", entry));
  }
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root, stdio: "pipe" });
  // Give the reviewed commit a real parent, so ancestry is an ordinary relation in this repository
  // rather than a case the fixture cannot express.
  const rootCommit = commitUnreviewedContent(root, {
    message: "packet fixture root",
    file: ".packet-fixture-root",
    body: "the commit the reviewed source is built on\n",
  });
  execFileSync("git", ["update-ref", "refs/heads/main", rootCommit], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  execFileSync("git", [...gitAuthorArgs, "commit", "--quiet", "-m", "packet fixture source"], { cwd: root, stdio: "pipe" });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", FIXTURE_TAG_REF, commit], { cwd: root, stdio: "pipe" });
  // The held branch, genuinely present and never transferable: the content the allowlist exists to
  // exclude, so the tests can prove it stays excluded instead of assuming it.
  const board = commitUnreviewedContent(root, {
    message: "held board state",
    file: "PRIVATE-BOARD-CONTENT.md",
    body: "PRIVATE BOARD CONTENT\n",
  });
  execFileSync("git", ["update-ref", HELD_BOARD_REF, board], { cwd: root, stdio: "pipe" });
  const loaded = await import(`${pathToFileURL(path.join(root, "scripts", "release-packet.mjs")).href}?fixture=${Date.now()}`);
  return { root, commit, rootCommit, board, module: loaded };
}

/**
 * A real commit carrying content the reviewer never saw. Written with plumbing so the fixture
 * repository's HEAD, index and working tree stay exactly as the packet requires them, and so the
 * commit's own history is complete — a bundle carrying it must be rejected for what it is, not for
 * a defect in the pack.
 */
function commitUnreviewedContent(root, { message, file, body, parent: parentCommit }) {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: body, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["mktree"], { cwd: root, input: `100644 blob ${blob}\t${file}\n`, encoding: "utf8" }).trim();
  const parentage = parentCommit ? ["-p", parentCommit] : [];
  return execFileSync("git", [...gitAuthorArgs, "commit-tree", tree, ...parentage, "-m", message], { cwd: root, encoding: "utf8", env: gitDateEnv }).trim();
}

/** Delete one advertised ref from a bundle's header, leaving its pack byte-for-byte intact. */
async function stripBundleHeaderRow(bundleFile, ref, sha) {
  const bytes = await readFile(bundleFile);
  const row = Buffer.from(`${sha} ${ref}\n`, "latin1");
  const at = bytes.indexOf(row);
  assert.notEqual(at, -1, `bundle header row for ${ref} not found`);
  await writeFile(bundleFile, Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + row.length)]));
}

const FIXTURE_TAG_REF = "refs/tags/v0.1.0-pre.10";
const HELD_BOARD_REF = "refs/heads/board";
const fixtureRepository = await createFixtureRepository();
const sourceRoot = fixtureRepository.root;
const { createReleasePacket, verifyReleasePacket } = fixtureRepository.module;
const head = fixtureRepository.commit;
const parent = head; // P and R coincide in unit fixtures; the ancestor relation is proven either way.
const liveTagRef = FIXTURE_TAG_REF;
process.on("exit", () => rmSync(sourceRoot, { recursive: true, force: true }));

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
 * `mainCommit` lets a test transfer the approved ref NAMES over other content, `extraTags` adds a
 * tag the reviewed allowlist does not carry, and `extraRefs` puts a named ref at a chosen commit —
 * including the held board branch, so a test can build the bundle an operator must never ship.
 */
async function buildTransferBundle(bundleFile, { mainCommit = head, tagCommit, extraTags = [], extraRefs = {} } = {}) {
  const source = path.join(path.dirname(bundleFile), `transfer-repo-${path.basename(bundleFile)}`);
  await rm(source, { recursive: true, force: true });
  // Clone rather than init+fetch: fetching FROM a repository is rejected when that repository is
  // shallow ("shallow roots are not allowed to be updated" — a warning that exits 0, so the ref is
  // silently never created and the failure surfaces lines later). A bare clone copies the objects
  // and every ref. The source is the fixture repository, whose history is complete, so the bundle
  // this produces can satisfy the packet's pack validator.
  execFileSync("git", ["clone", "--quiet", "--bare", sourceRoot, source], { stdio: "pipe" });
  execFileSync("git", ["-C", source, "update-ref", "refs/heads/main", mainCommit], { stdio: "pipe" });
  const refs = ["refs/heads/main"];
  if (tagCommit === undefined) {
    // The clone already carries the repository's tags; naming it here is what puts it in the bundle.
    refs.push(liveTagRef);
  } else {
    execFileSync("git", ["-C", source, "update-ref", liveTagRef, tagCommit], { stdio: "pipe" });
    refs.push(liveTagRef);
  }
  for (const tag of extraTags) {
    execFileSync("git", ["-C", source, "update-ref", `refs/tags/${tag}`, "refs/heads/main"], { stdio: "pipe" });
    refs.push(`refs/tags/${tag}`);
  }
  for (const [ref, commit] of Object.entries(extraRefs)) {
    execFileSync("git", ["-C", source, "update-ref", ref, commit], { stdio: "pipe" });
    refs.push(ref);
  }
  execFileSync("git", [...gitAuthorArgs, "-C", source, "notes", "--ref", "review", "add", "-m", "transfer review", "refs/heads/main"], { stdio: "pipe", env: gitDateEnv });
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

/**
 * Swap a retained evidence file and re-record every digest that covers it, so a verification run
 * reaches the evidence's own validators instead of stopping at a byte-level mismatch.
 */
async function replaceRetainedEvidence(out, category, file, bytes) {
  const retained = path.join(out, "evidence", file);
  await writeFile(retained, bytes);
  const sha256 = await fileSha256(retained);
  await rewritePacket(out, (packet) => {
    const row = packet.external_evidence.find((entry) => entry.category === category);
    row.sha256 = sha256;
    row.bytes = bytes.length;
    const inventoried = packet.inventory.find((entry) => entry.path === `evidence/${file}`);
    inventoried.sha256 = sha256;
    inventoried.bytes = bytes.length;
  });
}

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

// Settings evidence is always this repository's real producer output. The API payload it projects
// carries the volatile fields a live `gh api repos/...` response carries, so a fixture that leaked
// one of them into the evidence would fail here rather than in production.
const SETTINGS_REPOSITORY = "packet-test-org/packet-test-repo";
const SETTINGS_BASELINE_AT = "2026-08-15T04:00:00.000Z";
const SETTINGS_RECHECK_AT = "2026-08-15T04:11:00.000Z";

function repositoryApiPayload(overrides = {}) {
  return {
    full_name: SETTINGS_REPOSITORY,
    id: 1234567,
    node_id: "R_kgDOPacketTest",
    pushed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    size: 12345,
    stargazers_count: 3,
    open_issues_count: 7,
    allow_forking: false,
    archived: false,
    default_branch: "main",
    delete_branch_on_merge: false,
    disabled: false,
    fork: false,
    has_discussions: false,
    has_downloads: false,
    has_issues: false,
    has_pages: false,
    has_projects: true,
    has_wiki: false,
    is_template: false,
    private: true,
    visibility: "private",
    web_commit_signoff_required: false,
    ...overrides,
  };
}

async function settingsCapture(capturedAt, overrides) {
  return captureRepositorySettings({
    repository: SETTINGS_REPOSITORY,
    api: async () => repositoryApiPayload(overrides),
    now: () => new Date(capturedAt),
  });
}

async function writeSettingsEvidence(evidence, { baselineAt = SETTINGS_BASELINE_AT, recheckAt = SETTINGS_RECHECK_AT, recheckOverrides } = {}) {
  await writeFile(evidence["settings-baseline"], `${JSON.stringify(await settingsCapture(baselineAt), null, 2)}\n`);
  await writeFile(evidence["settings-recheck"], `${JSON.stringify(await settingsCapture(recheckAt, recheckOverrides), null, 2)}\n`);
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
  await writeSettingsEvidence(evidence);
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
  // Every case that expects a path to become newly REQUIRED names it here, and the loop refuses to
  // run a case whose target the committed manifest already pins. Without that guard a case silently
  // becomes vacuous the moment someone pins its target for an unrelated reason, and the suite
  // reports a fixed derivation it never exercised.
  const cases = [
    ["a node invocation added to a non-release workflow", "scripts/release-inspect.mjs", async (root) => {
      await appendWorkflowStep(root, "ci-tests.yml", "node scripts/release-inspect.mjs");
    }],
    ["a node invocation added inside a command substitution", "scripts/release-reconcile.mjs", async (root) => {
      await appendWorkflowStep(root, "release-audit.yml", 'FACTS="$(node scripts/release-reconcile.mjs --json)"');
    }],
    ["a node invocation added through an entirely new workflow file", "scripts/release-inspect-recovery.mjs", async (root) => {
      await writeFile(path.join(root, ".github", "workflows", "extra.yml"),
        "name: extra\non:\n  workflow_dispatch:\njobs:\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/release-inspect-recovery.mjs\n");
      execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
    }],
    ["a node invocation added to a package script a workflow runs", "scripts/rename-literal-inventory.mjs", async (root) => {
      const file = path.join(root, "package.json");
      const manifest = JSON.parse(await readFile(file, "utf8"));
      manifest.scripts["mutation:survivors"] = "node scripts/rename-literal-inventory.mjs";
      await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
      execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
    }],
    // One new script plus one new step in an existing release workflow, with no edit to the
    // packet's own code: the shape every landing work package has. The name is deliberately one
    // this repository does not carry, so the case cannot go vacuous when a real script lands.
    ["a new script invoked by a new step in an existing release workflow", "scripts/release-landing-probe.mjs", async (root) => {
      await writeFile(
        path.join(root, "scripts", "release-landing-probe.mjs"),
        'import { isMainModule } from "./is-main-module.mjs";\n\nexport function probeLanding() {\n  return isMainModule(import.meta.url);\n}\n',
      );
      await appendWorkflowStep(root, "release-finalize.yml", "node scripts/release-landing-probe.mjs");
    }],
    // Release-governing DATA is never imported, so no closure walk can find it; the release/
    // directory is what makes it derivable.
    ["a new governing data file committed under release/", "release/landing-probe-contract.json", async (root) => {
      await writeFile(path.join(root, "release", "landing-probe-contract.json"), '{"schema":"superbee.landing-probe.v1"}\n');
      execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
    }],
    ["a node invocation whose script path is not statically resolvable", null, async (root) => {
      await appendWorkflowStep(root, "release-staged.yml", 'node "$UNPINNED_SCRIPT"');
    }, /unresolvable script path|unresolvable argument/],
    ["a node invocation of a path that is neither tracked nor ignored", null, async (root) => {
      await appendWorkflowStep(root, "release-finalize.yml", "node scripts/not-in-the-index.mjs");
    }, /neither a tracked source file nor an ignored build output/],
  ];
  const committed = JSON.parse(await readFile(path.join(repoRoot, "release", "review-packet-inputs.json"), "utf8"));
  for (const [name, newlyRequired, mutate, expected] of cases) {
    assert.equal(
      committed.paths.includes(newlyRequired), false,
      `${name}: ${newlyRequired} is already pinned, so this case would pass without proving anything`,
    );
    const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-topology-"));
    try {
      const { manifestPath } = await manifestFixture(root);
      await validatePacketInputManifest({ root, manifestPath });
      await mutate(root);
      await assert.rejects(
        validatePacketInputManifest({ root, manifestPath }),
        expected ?? new RegExp(`missing: [^;]*${newlyRequired.replaceAll(".", "\\.").replaceAll("/", "\\/")}`),
        name,
      );
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

// This ran only when the developer's own tree happened to be clean. It now runs always, because
// the checkout it detaches from is the fixture repository, which the suite controls.
test("packet creation and verification accept a clean detached source checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-detached-"));
  const detachedRoot = path.join(root, "source");
  try {
    execFileSync("git", ["worktree", "add", "--detach", detachedRoot, head], { cwd: sourceRoot, stdio: "pipe" });
    await mkdir(path.join(detachedRoot, "node_modules"), { recursive: true });
    await symlink(path.join(repoRoot, "node_modules", "es-module-lexer"), path.join(detachedRoot, "node_modules", "es-module-lexer"));
    const isolatedPacket = await import(`${pathToFileURL(path.join(detachedRoot, "scripts", "release-packet.mjs")).href}?fixture=${Date.now()}`);
    const input = await fixture(root);
    const out = path.join(root, "packet");
    await isolatedPacket.createReleasePacket({ commit: head, publicAncestor: parent, out, ...input, root: detachedRoot, retainedVerifier: syntheticRetainedVerifier });
    await isolatedPacket.verifyReleasePacket({ packet: path.join(out, "release-packet.json"), root: detachedRoot, retainedVerifier: syntheticRetainedVerifier });
    await writeFile(path.join(detachedRoot, "ambient-untracked"), "must reject\n");
    await assert.rejects(
      isolatedPacket.verifyReleasePacket({ packet: path.join(out, "release-packet.json"), root: detachedRoot, retainedVerifier: syntheticRetainedVerifier }),
      /checkout has non-ignored changes: \?\? ambient-untracked/,
    );
    await assert.rejects(
      verifyReleasePacket({ packet: path.join(out, "release-packet.json"), root: detachedRoot, retainedVerifier: syntheticRetainedVerifier }),
      /same checkout as --root|foreign checkout/i,
    );
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", detachedRoot], { cwd: sourceRoot, stdio: "pipe" });
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
test("packet creation and verification reject a transfer bundle whose head commits or pack bytes are not the reviewed ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-bundle-integrity-"));
  const create = async (input, suffix) => createReleasePacket({
    commit: head, publicAncestor: parent, out: path.join(root, suffix), ...input,
    observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
  });
  try {
    // The review's own reproduction: a bundle whose refs carry the approved NAMES while main points
    // at a tree the reviewer never saw. The commit is real and parentless, so the pack is complete
    // and connected — the rejection has to come from the SHA binding, not from a broken bundle.
    const substituted = await fixture(path.join(root, "substituted"));
    const otherCommit = commitUnreviewedContent(sourceRoot, {
      message: "private board content",
      file: "PRIVATE-BOARD-CONTENT.md",
      body: "# held board state\n\nthis tree was never reviewed\n",
    });
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

    // Verification is an independent audit of retained bytes, not a replay of creation's verdict:
    // both reproductions must be rejected again when they are swapped into a valid packet.
    const retained = await fixture(path.join(root, "retained"));
    const out = path.join(root, "packet-retained");
    await createReleasePacket({
      commit: head, publicAncestor: parent, out, ...retained,
      observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
    });
    const verify = () => verifyReleasePacket({
      packet: path.join(out, "release-packet.json"),
      retainedVerifier: syntheticRetainedVerifier,
      observedSource: { commit: head, dirty: false },
    });
    await verify();

    const substitutedBundle = path.join(root, "substituted-for-verify");
    await buildTransferBundle(substitutedBundle, { mainCommit: otherCommit });
    await replaceRetainedEvidence(out, "transfer-bundle", "transfer-bundle", await readFile(substitutedBundle));
    await assert.rejects(verify(), /transfer bundle heads differ from the reviewed allowlist/);

    await replaceRetainedEvidence(out, "transfer-bundle", "transfer-bundle", whole.subarray(0, 200));
    await assert.rejects(verify(), /transfer bundle pack is incomplete, corrupt, or not self-contained/);

    await replaceRetainedEvidence(out, "transfer-bundle", "transfer-bundle", whole);
    await verify();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// F3, third face: the bundle HEADER is a claim and the PACK is the artifact. Deleting one header
// row leaves the pack untouched, so the withheld objects still import while list-heads advertises
// only what remains — and a head that merely DESCENDS from the held board carries its whole tree.
// Header equality and reachability-from-advertised-heads pass in both cases.
test("packet creation and verification reject a bundle whose pack carries objects no allowlisted ref reaches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-unadvertised-"));
  const boardHead = execFileSync("git", ["rev-parse", HELD_BOARD_REF], { cwd: sourceRoot, encoding: "utf8" }).trim();
  try {
    // The pack carries the board; only its header row is gone.
    const smuggled = await fixture(path.join(root, "smuggled"));
    const bundleFile = smuggled.evidence["transfer-bundle"];
    const withBoard = await buildTransferBundle(bundleFile, { extraRefs: { [HELD_BOARD_REF]: boardHead } });
    assert.equal(withBoard[HELD_BOARD_REF], boardHead, "the bundle really carries the board ref before stripping");
    await stripBundleHeaderRow(bundleFile, HELD_BOARD_REF, boardHead);
    assert.deepEqual(bundleHeads(bundleFile), sharedBundleHeads, "the stripped bundle advertises exactly the approved refs");
    await assert.rejects(
      createReleasePacket({
        commit: head, publicAncestor: parent, out: path.join(root, "packet-smuggled"), ...smuggled,
        observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
      }),
      /carries 3 object\(s\) no allowlisted ref reaches/,
    );

    // The same bundle swapped into a VALID packet: verification is an independent audit of the
    // retained bytes rather than a replay of creation's verdict.
    const retained = await fixture(path.join(root, "retained"));
    const out = path.join(root, "packet-retained");
    await createReleasePacket({
      commit: head, publicAncestor: parent, out, ...retained,
      observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
    });
    const verify = () => verifyReleasePacket({
      packet: path.join(out, "release-packet.json"),
      retainedVerifier: syntheticRetainedVerifier,
      observedSource: { commit: head, dirty: false },
    });
    await verify();
    await replaceRetainedEvidence(out, "transfer-bundle", "transfer-bundle", await readFile(bundleFile));
    await assert.rejects(verify(), /carries 3 object\(s\) no allowlisted ref reaches/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet creation and verification reject a transferable head that descends from the held board ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-descendant-"));
  const boardHead = execFileSync("git", ["rev-parse", HELD_BOARD_REF], { cwd: sourceRoot, encoding: "utf8" }).trim();
  const descendantRef = "refs/tags/v0.0.0-board-descendant";
  try {
    // Every object here IS reachable from an advertised ref, so the object-set rule is satisfied
    // and only an ancestry rule can catch it: a child commit carries its parent's whole tree.
    const descendant = commitUnreviewedContent(sourceRoot, {
      message: "release note built on the board",
      file: "NOTES.md",
      body: "carries the board history behind it\n",
      parent: boardHead,
    });
    execFileSync("git", ["update-ref", descendantRef, descendant], { cwd: sourceRoot, stdio: "pipe" });
    const descended = await fixture(path.join(root, "descended"));
    const heads = await buildTransferBundle(descended.evidence["transfer-bundle"], { extraRefs: { [descendantRef]: descendant } });
    await writeRefEvidence(descended.evidence, heads);
    await assert.rejects(
      createReleasePacket({
        commit: head, publicAncestor: parent, out: path.join(root, "packet-descended"), ...descended,
        observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
      }),
      new RegExp(`transferable ref ${descendantRef}@${descendant} descends from withheld commit ${boardHead}`),
    );
    execFileSync("git", ["update-ref", "-d", descendantRef], { cwd: sourceRoot, stdio: "pipe" });

    // At verify the rule runs against the enumeration the packet RECORDED, which is operator-
    // supplied bytes and therefore exactly what must not be taken on trust.
    const valid = await fixture(path.join(root, "valid"));
    const out = path.join(root, "packet-valid");
    await createReleasePacket({
      commit: head, publicAncestor: parent, out, ...valid,
      observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
    });
    const verify = () => verifyReleasePacket({
      packet: path.join(out, "release-packet.json"),
      retainedVerifier: syntheticRetainedVerifier,
      observedSource: { commit: head, dirty: false },
    });
    await verify();
    await rewritePacket(out, (packet) => {
      packet.lifecycle.creation_repository_refs.find((entry) => entry.ref === HELD_BOARD_REF).sha = fixtureRepository.rootCommit;
    });
    await assert.rejects(verify(), new RegExp(`descends from withheld commit ${fixtureRepository.rootCommit}`));
  } finally {
    try { execFileSync("git", ["update-ref", "-d", descendantRef], { cwd: sourceRoot, stdio: "pipe" }); } catch {}
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
    // A real commit the repository does not hold under that tag name: the bundle and the envelopes
    // agree with each other perfectly, and only the live enumeration can tell that they are stale.
    const staleTagCommit = commitUnreviewedContent(sourceRoot, {
      message: "superseded tag target",
      file: "SUPERSEDED.md",
      body: "# an earlier tag target\n\nthe repository has since moved this tag\n",
    });
    const staleHeads = await buildTransferBundle(stale.evidence["transfer-bundle"], { tagCommit: staleTagCommit });
    await writeRefEvidence(stale.evidence, staleHeads);
    await assert.rejects(
      create(stale, "packet-stale"),
      new RegExp(`transfer evidence asserts ${liveTagRef}@${staleTagCommit} but the creating repository holds`),
    );

    const cutover = await fixture(path.join(root, "cutover"));
    const reservedTag = targetManifest.allowed_tuples["successor-stable"].tag;
    execFileSync("git", ["tag", reservedTag, head], { cwd: sourceRoot, stdio: "pipe" });
    try {
      await assert.rejects(
        create(cutover, "packet-cutover"),
        new RegExp(`protected release tag refs/tags/${reservedTag.replaceAll(".", "\\.")} already exists in the creating repository`),
      );
    } finally {
      execFileSync("git", ["tag", "-d", reservedTag], { cwd: sourceRoot, stdio: "pipe" });
    }

    const recorded = await fixture(path.join(root, "recorded"));
    const { packet } = await create(recorded, "packet-recorded");
    const liveRefs = execFileSync("git", ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags", "refs/notes"], { cwd: sourceRoot, encoding: "utf8" })
      .split("\n").filter(Boolean)
      .map((line) => ({ ref: line.split(" ")[1], sha: line.split(" ")[0] }))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1));
    assert.deepEqual(packet.lifecycle.creation_repository_refs, liveRefs, "the packet records the enumeration it checked");
    // The creating repository holds main at R and holds the tag; it has never held the notes ref.
    // Both sides of the partition are exercised, and the claim reports what was actually confirmed.
    assert.deepEqual(packet.lifecycle.transfer_refs_confirmed_at_create, ["refs/heads/main", liveTagRef].sort());
    assert.deepEqual(packet.lifecycle.transfer_refs_unobserved_at_create, ["refs/notes/review"]);
    assert.match(packet.lifecycle.claim, /held 2 of 3 allowlisted refs/);
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
        // Derived from the manifest, exactly like protectedTag above. Hardcoding the tag made this
        // go red on every tuple retarget, which is churn rather than signal.
      }, new RegExp(`protected release tag refs/tags/${targetManifest.allowed_tuples["successor-stable"].tag.replace(/\./g, "\\.")} is not transferable|transfer bundle heads differ`, "i")],
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

// F9: the settings slot now has a producer and a schema, so it can fail for the reasons a
// settings-drift gate is supposed to fail for — including the one the review named, where the
// operator supplies the same capture twice and calls it a recheck.
test("packet creation rejects settings evidence that drifts, repeats a capture, or is not producer output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-packet-settings-"));
  const create = async (input, suffix) => createReleasePacket({
    commit: head, publicAncestor: parent, out: path.join(root, suffix), ...input,
    observedSource: { commit: head, dirty: false }, retainedVerifier: syntheticRetainedVerifier,
  });
  try {
    for (const [name, mutate, expected] of [
      ["a drifted setting", async (input) => {
        await writeSettingsEvidence(input.evidence, { recheckOverrides: { visibility: "public" } });
      }, /settings baseline and recheck differ/],
      ["the same capture supplied twice", async (input) => {
        await cp(input.evidence["settings-baseline"], input.evidence["settings-recheck"], { force: true });
      }, /settings recheck must be captured after the baseline/],
      ["a recheck of a different repository", async (input) => {
        const other = await captureRepositorySettings({
          repository: "packet-test-org/other-repo",
          api: async () => repositoryApiPayload({ full_name: "packet-test-org/other-repo" }),
          now: () => new Date(SETTINGS_RECHECK_AT),
        });
        await writeFile(input.evidence["settings-recheck"], `${JSON.stringify(other, null, 2)}\n`);
      }, /settings baseline captured .* but the recheck captured/],
      ["a hand-authored blob that is not producer output", async (input) => {
        await writeFile(input.evidence["settings-recheck"], JSON.stringify({ schema: "superbee.release-settings.v1", visibility: "private", npm: { provenance: true } }));
      }, /evidence settings-recheck keys differ/],
      ["a capture missing a pinned setting", async (input) => {
        const capture = JSON.parse(await readFile(input.evidence["settings-recheck"], "utf8"));
        delete capture.settings.allow_forking;
        await writeFile(input.evidence["settings-recheck"], `${JSON.stringify(capture, null, 2)}\n`);
      }, /repository settings is missing or malformed: allow_forking/],
      ["a capture carrying a volatile API field", async (input) => {
        const capture = JSON.parse(await readFile(input.evidence["settings-recheck"], "utf8"));
        capture.settings.pushed_at = new Date().toISOString();
        await writeFile(input.evidence["settings-recheck"], `${JSON.stringify(capture, null, 2)}\n`);
      }, /is not this producer's normalized output/],
    ]) {
      const input = await fixture(path.join(root, name.replaceAll(" ", "-")));
      await mutate(input);
      await assert.rejects(create(input, `packet-${name.replaceAll(" ", "-")}`), expected, name);
    }
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
  const dirtyFile = path.join(sourceRoot, ".packet-test-dirty");
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
