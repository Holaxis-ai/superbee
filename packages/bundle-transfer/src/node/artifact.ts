import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { canonicalTransferJsonBytes } from "../canonical-json.js";
import { BundleTransferError } from "../errors.js";
import { validateBundleTransferManifest, verifyBundleTransferArtifact } from "../manifest.js";
import { BUNDLE_TRANSFER_LIMITS_V1, type BundleTransferArtifactV1, type Sha256Digest } from "../types.js";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function objectPath(root: string, digest: Sha256Digest): string {
  const hex = digest.slice("sha256:".length);
  return path.join(root, "objects", "sha256", hex.slice(0, 2), hex.slice(2));
}

function snapshotWriterInput(artifact: BundleTransferArtifactV1): { manifest: unknown; objects: Map<Sha256Digest, Uint8Array> } {
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
    throw new BundleTransferError("INVALID_ARTIFACT", "writer input must be an object");
  }
  const prototype = Object.getPrototypeOf(artifact);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BundleTransferError("INVALID_ARTIFACT", "writer input must be a plain object");
  }
  if (Object.getOwnPropertySymbols(artifact).length !== 0) {
    throw new BundleTransferError("INVALID_ARTIFACT", "writer input has unknown symbol fields");
  }
  const descriptors = Object.getOwnPropertyDescriptors(artifact);
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== 2 || keys[0] !== "manifest" || keys[1] !== "objects") {
    throw new BundleTransferError("INVALID_ARTIFACT", "writer input has missing or unknown fields");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new BundleTransferError("INVALID_ARTIFACT", "writer input may not use hidden fields or accessors");
    }
  }

  // Canonicalization is also a synchronous, closed deep copy. Nothing caller-owned remains live
  // across the first asynchronous digest or filesystem operation.
  const manifestBytes = canonicalTransferJsonBytes(descriptors.manifest!.value);
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes)) as unknown;
  const sourceObjects = descriptors.objects!.value as unknown;
  if (!(sourceObjects instanceof Map) || Object.getPrototypeOf(sourceObjects) !== Map.prototype
    || Reflect.ownKeys(sourceObjects).length !== 0) {
    throw new BundleTransferError("INVALID_ARTIFACT", "writer objects must be an exact Map");
  }
  const objects = new Map<Sha256Digest, Uint8Array>();
  for (const [key, value] of Map.prototype.entries.call(sourceObjects) as IterableIterator<[unknown, unknown]>) {
    if (typeof key !== "string" || !digestPattern.test(key)) {
      throw new BundleTransferError("INVALID_ARTIFACT", "writer object key is not a canonical SHA-256 digest");
    }
    if (!(value instanceof Uint8Array)
      || (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer)) {
      throw new BundleTransferError("INVALID_ARTIFACT", "writer object bytes must be an owned Uint8Array", { subject: key });
    }
    const owned = new Uint8Array(value.byteLength);
    owned.set(value);
    objects.set(key as Sha256Digest, owned);
  }
  return { manifest, objects };
}

async function assertDirectory(target: string, ownerOnly = true): Promise<void> {
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new BundleTransferError("INVALID_ARTIFACT", "artifact directory inventory is invalid", { subject: target });
  const mode = entry.mode & 0o777;
  if (ownerOnly && (mode & 0o077) !== 0) {
    throw new BundleTransferError("INVALID_ARTIFACT", "artifact directories must be owner-only", { subject: target });
  }
}

async function readSafeFile(target: string, maxBytes: number): Promise<Uint8Array> {
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600 || entry.size > maxBytes) {
    throw new BundleTransferError("INVALID_ARTIFACT", "artifact file identity, mode, links, or size is invalid", { subject: target });
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(target, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino || (opened.mode & 0o777) !== 0o600 || opened.size > maxBytes) {
      throw new BundleTransferError("INVALID_ARTIFACT", "artifact file changed before read", { subject: target });
    }
    const bounded = Buffer.alloc(entry.size + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== entry.size) throw new BundleTransferError("INVALID_ARTIFACT", "artifact file size changed during bounded read", { subject: target });
    const bytes = new Uint8Array(bounded.buffer, bounded.byteOffset, bytesRead).slice();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new BundleTransferError("INVALID_ARTIFACT", "artifact file changed during read", { subject: target });
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function exactNames(directory: string, expected: readonly string[]): Promise<void> {
  const actual = (await readdir(directory)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    throw new BundleTransferError("INVALID_ARTIFACT", "artifact directory contains a missing or extra entry", { subject: directory });
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(target: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requirePosix(): void {
  if (process.platform === "win32") throw new BundleTransferError("UNSUPPORTED_HOST", "physical transfer artifact v1 requires a POSIX host");
}

export async function readBundleTransferArtifactDirectory(root: string): Promise<BundleTransferArtifactV1> {
  requirePosix();
  if (!path.isAbsolute(root)) throw new BundleTransferError("INVALID_ARTIFACT", "artifact root must be absolute");
  await assertDirectory(root);
  const artifactRoot = await realpath(root);
  await assertDirectory(artifactRoot);
  await exactNames(artifactRoot, ["manifest.json", "objects"]);
  await assertDirectory(path.join(artifactRoot, "objects"));
  await exactNames(path.join(artifactRoot, "objects"), ["sha256"]);
  await assertDirectory(path.join(artifactRoot, "objects", "sha256"));

  const manifestBytes = await readSafeFile(path.join(artifactRoot, "manifest.json"), BUNDLE_TRANSFER_LIMITS_V1.maxManifestBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes)); }
  catch (error) { throw new BundleTransferError("INVALID_ARTIFACT", "manifest.json must be strict UTF-8 JSON", { cause: error }); }
  const manifest = await validateBundleTransferManifest(parsed);
  const canonical = canonicalTransferJsonBytes(manifest);
  if (canonical.byteLength !== manifestBytes.byteLength || !canonical.every((byte, index) => byte === manifestBytes[index])) {
    throw new BundleTransferError("INVALID_ARTIFACT", "manifest.json must contain the exact canonical bytes");
  }

  const expected = new Map<string, Sha256Digest>();
  for (const row of [...manifest.documents, ...manifest.reserved, ...manifest.blobs]) {
    const hex = row.object.digest.slice("sha256:".length);
    expected.set(`${hex.slice(0, 2)}/${hex.slice(2)}`, row.object.digest);
  }
  const shaRoot = path.join(artifactRoot, "objects", "sha256");
  const fanouts = await readdir(shaRoot);
  for (const fanout of fanouts) {
    if (!/^[0-9a-f]{2}$/u.test(fanout)) throw new BundleTransferError("INVALID_ARTIFACT", "artifact fanout directory is invalid", { subject: fanout });
    if (![...expected.keys()].some((relative) => relative.startsWith(`${fanout}/`))) {
      throw new BundleTransferError("INVALID_ARTIFACT", "artifact object inventory contains an extra fanout directory", { subject: fanout });
    }
    const fanoutPath = path.join(shaRoot, fanout);
    await assertDirectory(fanoutPath);
    for (const leaf of await readdir(fanoutPath)) {
      if (!/^[0-9a-f]{62}$/u.test(leaf) || !expected.has(`${fanout}/${leaf}`)) {
        throw new BundleTransferError("INVALID_ARTIFACT", "artifact object inventory contains an invalid or extra object", { subject: `${fanout}/${leaf}` });
      }
    }
  }
  for (const relative of expected.keys()) {
    const [fanout, leaf] = relative.split("/") as [string, string];
    if (!fanouts.includes(fanout) || !(await readdir(path.join(shaRoot, fanout))).includes(leaf)) {
      throw new BundleTransferError("INVALID_ARTIFACT", "artifact object inventory is incomplete", { subject: relative });
    }
  }

  const objects = new Map<Sha256Digest, Uint8Array>();
  await verifyBundleTransferArtifact(manifest, async (digest) => {
    const bytes = await readSafeFile(objectPath(artifactRoot, digest), BUNDLE_TRANSFER_LIMITS_V1.maxObjectBytes);
    objects.set(digest, bytes);
    return bytes;
  });
  return { manifest, objects };
}

export async function writeBundleTransferArtifactDirectory(destination: string, artifact: BundleTransferArtifactV1): Promise<void> {
  requirePosix();
  if (!path.isAbsolute(destination)) throw new BundleTransferError("INVALID_ARTIFACT", "artifact destination must be absolute");
  const snapshot = snapshotWriterInput(artifact);
  const manifest = await verifyBundleTransferArtifact(snapshot.manifest, async (digest) => {
    const bytes = snapshot.objects.get(digest);
    if (!bytes) throw new BundleTransferError("OBJECT_MISMATCH", "artifact object is missing from the writer input", { subject: digest });
    return bytes;
  });
  const expected = new Set<Sha256Digest>();
  for (const row of [...manifest.documents, ...manifest.reserved, ...manifest.blobs]) expected.add(row.object.digest);
  if (snapshot.objects.size !== expected.size || [...snapshot.objects.keys()].some((digest) => !expected.has(digest))) {
    throw new BundleTransferError("OBJECT_MISMATCH", "writer object inventory must equal the manifest digest set exactly");
  }
  const parent = path.dirname(destination);
  await assertDirectory(parent, false);
  const canonicalParent = await realpath(parent);
  const finalPath = path.join(canonicalParent, path.basename(destination));
  try { await lstat(finalPath); throw new BundleTransferError("INVALID_ARTIFACT", "artifact destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const suffix = randomBytes(16).toString("hex");
  const partial = path.join(canonicalParent, `.${path.basename(destination)}.partial-${suffix}`);
  await mkdir(partial, { mode: 0o700 });
  let renamed = false;
  try {
    await mkdir(path.join(partial, "objects"), { mode: 0o700 });
    await mkdir(path.join(partial, "objects", "sha256"), { mode: 0o700 });
    const fanouts = new Set<string>();
    for (const digest of expected) {
      const bytes = snapshot.objects.get(digest)!;
      const hex = digest.slice("sha256:".length);
      const fanout = hex.slice(0, 2);
      if (!fanouts.has(fanout)) {
        await mkdir(path.join(partial, "objects", "sha256", fanout), { mode: 0o700 });
        fanouts.add(fanout);
      }
      await writeExclusive(objectPath(partial, digest), bytes);
    }
    await writeExclusive(path.join(partial, "manifest.json"), canonicalTransferJsonBytes(manifest));
    for (const fanout of fanouts) await fsyncDirectory(path.join(partial, "objects", "sha256", fanout));
    await fsyncDirectory(path.join(partial, "objects", "sha256"));
    await fsyncDirectory(path.join(partial, "objects"));
    await fsyncDirectory(partial);
    await readBundleTransferArtifactDirectory(partial);
    try { await lstat(finalPath); throw new BundleTransferError("INVALID_ARTIFACT", "artifact destination appeared before commit"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(partial, finalPath);
    renamed = true;
    await fsyncDirectory(canonicalParent);
  } finally {
    if (!renamed) await rm(partial, { recursive: true, force: true });
  }
}
