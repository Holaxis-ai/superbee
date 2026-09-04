import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { Version } from "@superbee/core/storage";

import {
  BUNDLE_TRANSFER_LIMITS_V1,
  BundleTransferError,
  canonicalTransferJson,
  compareUnsignedUtf8,
  createBundleTransferArtifact,
  digestTransferBytes,
  validateBundleTransferManifest,
  verifyBundleTransferArtifact,
  type BundleTransferSnapshotV1,
  type SourceAuthorityId,
} from "../src/index.js";
import {
  captureFilesystemBundle,
  captureGitBundle,
  readBundleTransferArtifactDirectory,
  writeBundleTransferArtifactDirectory,
} from "../src/node/index.js";

const execFileAsync = promisify(execFile);
const authority = "src_00112233445566778899aabbccddeeff" as SourceAuthorityId;
const encoder = new TextEncoder();

async function version(bytes: Uint8Array): Promise<Version> {
  return await digestTransferBytes(bytes) as Version;
}

async function snapshot(): Promise<BundleTransferSnapshotV1> {
  const root = encoder.encode("---\nokf_version: '0.2'\n---\n# Exact bytes\r\n");
  const zed = encoder.encode("---\ntype: Note\n---\n# Zed\r\n");
  const accented = encoder.encode("---\ntype: Note\n---\n# Accent\n");
  const binary = Uint8Array.from([0, 255, 1, 128]);
  return {
    source: { authority_id: authority, kind: "filesystem", revision: { kind: "filesystem" } },
    okf_edition: "0.2",
    documents: [
      { id: "é", bytes: accented, version: await version(accented) },
      { id: "z", bytes: zed, version: await version(zed) },
    ],
    reserved: [{ dir: "", name: "index.md", bytes: root, version: await version(root) }],
    blobs: [
      { key: "assets/a.bin", bytes: binary, version: await version(binary), content_type: "application/octet-stream" },
      { key: "assets/b.bin", bytes: binary.slice(), version: await version(binary), content_type: "application/octet-stream" },
    ],
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-transfer-source-"));
  await writeFile(path.join(root, "index.md"), "---\nokf_version: '0.2'\n---\n# Bundle\r\n");
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "note.md"), "---\ntype: Note\n---\n# Note\r\n");
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets", "raw.bin"), Uint8Array.from([0, 255, 7]));
  return root;
}

test("canonical transfer JSON sorts by unsigned UTF-8 bytes and rejects non-integers", () => {
  assert.ok(compareUnsignedUtf8("z", "é") < 0);
  assert.equal(canonicalTransferJson({ é: 1, z: 2 }), '{"z":2,"é":1}');
  assert.throws(() => canonicalTransferJson({ value: 1.5 }), /safe integers/);
  assert.throws(() => canonicalTransferJson({ value: "\ud800" }), /Unicode scalar/);
  assert.throws(() => canonicalTransferJson(Object.assign([1], { extra: true })), /dense arrays/);
  assert.throws(() => canonicalTransferJson({ [Symbol("hidden")]: true }), /symbol fields/);
});

test("artifact creation preserves raw text and binary bytes, canonical order, and duplicate objects", async () => {
  const input = await snapshot();
  const artifact = await createBundleTransferArtifact(input);
  assert.deepEqual(artifact.manifest.documents.map((row) => row.id), ["z", "é"]);
  assert.equal(artifact.manifest.blobs[0]!.object.digest, artifact.manifest.blobs[1]!.object.digest);
  assert.equal(artifact.objects.size, 4);
  assert.equal(artifact.manifest.counts.unique_objects, 4);
  assert.deepEqual(artifact.objects.get(artifact.manifest.blobs[0]!.object.digest), Uint8Array.from([0, 255, 1, 128]));
  assert.notEqual(artifact.manifest.documents[0]!.object.digest, await version(encoder.encode("---\ntype: Note\n---\n# Zed\n")));
  await verifyBundleTransferArtifact(artifact.manifest, async (digest) => artifact.objects.get(digest)!);
});

test("manifest validation is closed, canonical, count checked, and traversal safe", async () => {
  const artifact = await createBundleTransferArtifact(await snapshot());
  const extra = structuredClone(artifact.manifest) as unknown as Record<string, unknown>;
  extra.extra = true;
  await assert.rejects(() => validateBundleTransferManifest(extra), /missing or unknown/);

  const wrongCount = structuredClone(artifact.manifest);
  wrongCount.counts.documents += 1;
  await assert.rejects(() => validateBundleTransferManifest(wrongCount), /counts disagree/);

  const traversal = structuredClone(artifact.manifest);
  traversal.documents[0]!.id = "../escape";
  await assert.rejects(() => validateBundleTransferManifest(traversal), /unsafe/);

  const unknownSource = structuredClone(artifact.manifest) as unknown as { source: Record<string, unknown> };
  unknownSource.source.locator = "/private/secret";
  await assert.rejects(() => validateBundleTransferManifest(unknownSource), /missing or unknown/);
});

test("creation preserves BOM bytes and rejects invalid source versions, count, and object-size ceilings", async () => {
  const base = await snapshot();
  const bom = encoder.encode("\ufeff---\ntype: Note\n---\n# hidden delimiter\n");
  const withBom = { ...base, documents: [{ id: "bom", bytes: bom, version: await version(bom) }] };
  // The raw contract does not erase the BOM. Node capture below applies the public parser and rejects it.
  const rawArtifact = await createBundleTransferArtifact(withBom);
  assert.equal(rawArtifact.manifest.documents[0]!.object.digest, await version(bom));

  const wrongVersion = { ...base, documents: [{ ...base.documents[0]!, version: `sha256:${"0".repeat(64)}` as Version }] };
  await assert.rejects(() => createBundleTransferArtifact(wrongVersion), (error: unknown) => error instanceof BundleTransferError && error.code === "OBJECT_MISMATCH");

  const excessiveRows = { ...base, documents: Array.from({ length: BUNDLE_TRANSFER_LIMITS_V1.maxRows + 1 }, () => base.documents[0]!) };
  await assert.rejects(() => createBundleTransferArtifact(excessiveRows), (error: unknown) => error instanceof BundleTransferError && error.code === "LIMIT_EXCEEDED");

  const huge = new Uint8Array(BUNDLE_TRANSFER_LIMITS_V1.maxObjectBytes + 1);
  const excessiveObject = { ...base, blobs: [{ key: "huge.bin", bytes: huge, version: await version(huge), content_type: "application/octet-stream" }] };
  await assert.rejects(() => createBundleTransferArtifact(excessiveObject), (error: unknown) => error instanceof BundleTransferError && error.code === "LIMIT_EXCEEDED");
});

test("filesystem capture uses exact BOM bytes and rejects symlinks and hard links", { skip: process.platform === "win32" }, async () => {
  const root = await fixture();
  try {
    const artifact = await captureFilesystemBundle({ root, sourceAuthorityId: authority });
    const doc = artifact.manifest.documents.find((row) => row.id === "docs/note")!;
    assert.deepEqual(artifact.objects.get(doc.object.digest), encoder.encode("---\ntype: Note\n---\n# Note\r\n"));

    await symlink(path.join(root, "assets", "raw.bin"), path.join(root, "linked.bin"));
    await assert.rejects(() => captureFilesystemBundle({ root, sourceAuthorityId: authority, maxAttempts: 1 }), /symlinks/);
    await rm(path.join(root, "linked.bin"));

    await link(path.join(root, "assets", "raw.bin"), path.join(root, "hard.bin"));
    await assert.rejects(() => captureFilesystemBundle({ root, sourceAuthorityId: authority, maxAttempts: 1 }), /hard links/);
    await rm(path.join(root, "hard.bin"));
    await rm(path.join(root, "assets", "raw.bin"));
    await writeFile(path.join(root, "assets", "raw.bin"), Uint8Array.from([0, 255, 7]));

    await execFileAsync("mkfifo", [path.join(root, "special")]);
    await assert.rejects(() => captureFilesystemBundle({ root, sourceAuthorityId: authority, maxAttempts: 1 }), /special files/);
    await rm(path.join(root, "special"));

    await writeFile(path.join(root, "bom.md"), "\ufeff---\ntype: Note\n---\n# BOM\n");
    const withBom = await captureFilesystemBundle({ root, sourceAuthorityId: authority, maxAttempts: 1 });
    const bom = withBom.manifest.documents.find((row) => row.id === "bom")!;
    assert.deepEqual(withBom.objects.get(bom.object.digest), encoder.encode("\ufeff---\ntype: Note\n---\n# BOM\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem capture fails closed when the source remains unstable", { skip: process.platform === "win32" }, async () => {
  const root = await fixture();
  const target = path.join(root, "assets", "changing.bin");
  const a = new Uint8Array(8 * 1024 * 1024).fill(1);
  const b = new Uint8Array(8 * 1024 * 1024).fill(2);
  await writeFile(target, a);
  let running = true;
  const writer = (async () => {
    let value = b;
    while (running) {
      await writeFile(target, value);
      value = value === a ? b : a;
    }
  })();
  try {
    await assert.rejects(
      () => captureFilesystemBundle({ root, sourceAuthorityId: authority, maxAttempts: 1 }),
      (error: unknown) => error instanceof BundleTransferError && error.code === "SOURCE_CHANGED",
    );
  } finally {
    running = false;
    await writer;
    await rm(root, { recursive: true, force: true });
  }
});

test("Git capture reads the immutable board commit tree, not dirty checkout bytes", async () => {
  const root = await fixture();
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=board"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "proof@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "proof"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "exact"], { cwd: root });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const commit = stdout.trim();
    await writeFile(path.join(root, "docs", "note.md"), "---\ntype: Note\n---\n# Dirty checkout\n");
    const artifact = await captureGitBundle({ repository: root, sourceAuthorityId: authority, expectedCommit: commit });
    assert.equal(artifact.manifest.source.kind, "git");
    assert.equal(artifact.manifest.source.revision.commit, commit);
    const row = artifact.manifest.documents.find((entry) => entry.id === "docs/note")!;
    assert.deepEqual(artifact.objects.get(row.object.digest), encoder.encode("---\ntype: Note\n---\n# Note\r\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physical artifact writer and reader enforce exact closed POSIX layout and permissions", { skip: process.platform === "win32" }, async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "superbee-transfer-artifact-"));
  await chmod(parent, 0o700);
  const destination = path.join(parent, "artifact");
  try {
    const artifact = await createBundleTransferArtifact(await snapshot());
    await writeBundleTransferArtifactDirectory(destination, artifact);
    const manifestMode = (await lstat(path.join(destination, "manifest.json"))).mode & 0o777;
    assert.equal(manifestMode, 0o600);
    const read = await readBundleTransferArtifactDirectory(destination);
    assert.deepEqual(read.manifest, artifact.manifest);

    await writeFile(path.join(destination, "extra"), "no", { mode: 0o600 });
    await assert.rejects(() => readBundleTransferArtifactDirectory(destination), /missing or extra/);
    await rm(path.join(destination, "extra"));

    const usedFanouts = new Set([...artifact.objects.keys()].map((value) => value.slice("sha256:".length, "sha256:".length + 2)));
    const extraFanout = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0")).find((value) => !usedFanouts.has(value))!;
    await mkdir(path.join(destination, "objects", "sha256", extraFanout), { mode: 0o700 });
    await assert.rejects(() => readBundleTransferArtifactDirectory(destination), /extra fanout/);
    await rm(path.join(destination, "objects", "sha256", extraFanout), { recursive: true });

    const digest = artifact.manifest.documents[0]!.object.digest.slice("sha256:".length);
    const object = path.join(destination, "objects", "sha256", digest.slice(0, 2), digest.slice(2));
    const hard = path.join(destination, "objects", "sha256", digest.slice(0, 2), `${"0".repeat(62)}`);
    await link(object, hard);
    await assert.rejects(() => readBundleTransferArtifactDirectory(destination), /invalid or extra|links/);
    await rm(hard);
    await chmod(object, 0o644);
    await assert.rejects(() => readBundleTransferArtifactDirectory(destination), /mode/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("artifact verification catches missing and corrupted objects", async () => {
  const artifact = await createBundleTransferArtifact(await snapshot());
  const missing = artifact.manifest.documents[0]!.object.digest;
  await assert.rejects(
    () => verifyBundleTransferArtifact(artifact.manifest, async (digest) => digest === missing ? new Uint8Array() : artifact.objects.get(digest)!),
    (error: unknown) => error instanceof BundleTransferError && error.code === "OBJECT_MISMATCH",
  );
});
