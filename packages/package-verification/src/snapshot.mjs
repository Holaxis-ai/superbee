import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PACKAGE = "packages/package-verification";
const REPOSITORY = "https://github.com/Holaxis-ai/superbee";
export const SNAPSHOT_FILES = Object.freeze(["package.json", "README.md", "LICENSE", "NOTICE", "src/harness.mjs", "src/no-network.mjs", "src/preflight.mjs", "src/snapshot.mjs"]);
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const git = async (root, args) => (await exec("git", ["-C", root, ...args], { maxBuffer: 2 * 1024 * 1024 })).stdout;

async function regular(file) {
  assert.ok((await lstat(file)).isFile(), "snapshot input must be a regular file");
}
async function noSymlinks(target) {
  let cursor = path.resolve(target);
  while (true) {
    const entry = await lstat(cursor).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    assert.ok(!entry?.isSymbolicLink(), "snapshot paths must not contain symlinks");
    if (path.dirname(cursor) === cursor) break;
    cursor = path.dirname(cursor);
  }
}
async function files(root, prefix = "") {
  const rows = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...await files(root, relative));
    else { assert.ok(entry.isFile(), "snapshot tree contains an unsupported entry"); rows.push(relative); }
  }
  return rows.sort();
}

export async function verifySnapshotIntegrity(target) {
  await noSymlinks(target);
  await regular(path.join(target, "snapshot.json"));
  const manifest = JSON.parse(await readFile(path.join(target, "snapshot.json"), "utf8"));
  assert.equal(manifest.schema, "superbee.package-verification-snapshot.v1");
  assert.equal(manifest.repository, REPOSITORY);
  assert.match(manifest.commit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(manifest.directory, PACKAGE);
  assert.deepEqual(Object.keys(manifest.files).sort(), [...SNAPSHOT_FILES].sort());
  assert.deepEqual(await files(target), [...SNAPSHOT_FILES, "snapshot.json"].sort());
  for (const file of SNAPSHOT_FILES) {
    await regular(path.join(target, file));
    assert.equal(digest(await readFile(path.join(target, file))), manifest.files[file], "snapshot byte integrity differs");
  }
  return { status: "integrity-checked", commit: manifest.commit, files: SNAPSHOT_FILES.length,
    provenance: "not-checked; compare with the exact producer Git objects" };
}

async function producerBytes(source, commit) {
  assert.match(commit ?? "", /^[a-f0-9]{40}$/);
  const remote = (await git(source, ["remote", "get-url", "origin"])).trim();
  assert.ok([`${REPOSITORY}.git`, REPOSITORY, "git@github.com:Holaxis-ai/superbee.git"].includes(remote), "snapshot producer must be the canonical repository");
  assert.equal((await git(source, ["rev-parse", `${commit}^{commit}`])).trim(), commit);
  const bytes = {};
  for (const file of SNAPSHOT_FILES) {
    const mode = (await git(source, ["ls-tree", commit, `${PACKAGE}/${file}`])).split(" ")[0];
    assert.equal(mode, "100644", "snapshot source must be a committed regular file");
    bytes[file] = Buffer.from(await git(source, ["show", `${commit}:${PACKAGE}/${file}`]));
  }
  return bytes;
}

export async function verifySnapshotProvenance({ source, target }) {
  const checked = await verifySnapshotIntegrity(target);
  const bytes = await producerBytes(source, checked.commit);
  for (const file of SNAPSHOT_FILES) assert.ok(bytes[file].equals(await readFile(path.join(target, file))), "snapshot differs from exact producer source");
  return { ...checked, status: "provenance-checked", provenance: "exact committed producer bytes compared" };
}

export async function exportSnapshot({ source, target, commit, expected }) {
  // Export only clean exact source. Verification may compare immutable objects in any checkout.
  assert.equal((await git(source, ["rev-parse", "HEAD"])).trim(), commit, "export requires exact producer checkout");
  assert.equal((await git(source, ["status", "--porcelain"])).trim(), "", "export requires clean producer checkout");
  const bytes = await producerBytes(source, commit);
  const producerRoot = await realpath((await git(source, ["rev-parse", "--show-toplevel"])).trim());
  await noSymlinks(target);
  const absolute = path.resolve(target), parent = path.dirname(absolute);
  assert.ok(absolute !== producerRoot && !absolute.startsWith(`${producerRoot}${path.sep}`), "snapshot cannot overwrite producer content");
  await mkdir(parent, { recursive: true });
  const lock = `${absolute}.export-lock`;
  await mkdir(lock);
  const staged = path.join(parent, `.package-verification-${randomUUID()}`);
  const backup = `${staged}.previous`;
  let moved = false, installed = false;
  try {
    const present = await lstat(absolute).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (present) {
      const prior = await verifySnapshotProvenance({ source, target: absolute });
      assert.ok(expected && prior.commit === expected, "existing snapshot requires its exact expected producer commit");
    } else assert.equal(expected, undefined, "expected snapshot target is missing");
    await mkdir(staged);
    for (const [file, content] of Object.entries(bytes)) {
      await mkdir(path.dirname(path.join(staged, file)), { recursive: true });
      await writeFile(path.join(staged, file), content);
    }
    await writeFile(path.join(staged, "snapshot.json"), `${JSON.stringify({ schema: "superbee.package-verification-snapshot.v1", repository: REPOSITORY, commit, directory: PACKAGE,
      files: Object.fromEntries(Object.entries(bytes).map(([file, content]) => [file, digest(content)])) }, null, 2)}\n`);
    await verifySnapshotIntegrity(staged);
    if (present) { await rename(absolute, backup); moved = true; }
    await rename(staged, absolute); installed = true;
    await rm(backup, { recursive: true, force: true });
    return await verifySnapshotProvenance({ source, target: absolute });
  } finally {
    if (moved && !installed) await rename(backup, absolute);
    await rm(staged, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
