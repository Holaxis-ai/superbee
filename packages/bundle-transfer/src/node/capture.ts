import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  blobVersion,
  parseMarkdown,
  resolveContentType,
  versionOfBytes,
} from "@superbee/core";
import {
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  conceptIdFromPath,
  isReservedFile,
  pathFromConceptId,
  type ReservedFilename,
} from "@superbee/core/storage";

import { BundleTransferError } from "../errors.js";
import { createBundleTransferArtifact } from "../manifest.js";
import type {
  BundleTransferArtifactV1,
  BundleTransferSnapshotV1,
  RawBlobV1,
  RawDocumentV1,
  RawReservedV1,
  SourceAuthorityId,
} from "../types.js";
import { BUNDLE_TRANSFER_LIMITS_V1 } from "../types.js";

const execFileAsync = promisify(execFile);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const authorityPattern = /^src_[0-9a-f]{32}$/u;
const gitObjectPattern = /^[0-9a-f]{40}$/u;

interface CapturedFile {
  relative: string;
  bytes: Uint8Array;
  identity: string;
  digest: string;
}

function sourceChanged(message: string, cause?: unknown): BundleTransferError {
  return new BundleTransferError("SOURCE_CHANGED", message, { retryable: true, cause });
}

function assertSourceAuthorityId(value: string): asserts value is SourceAuthorityId {
  if (!authorityPattern.test(value)) {
    throw new BundleTransferError("INVALID_SOURCE", "source authority id must be src_ plus 32 lowercase hexadecimal characters");
  }
}

function utf8(bytes: Uint8Array, subject: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new BundleTransferError("INVALID_BUNDLE", "document and reserved bytes must be strict UTF-8", { subject, cause: error });
  }
}

function classify(files: readonly CapturedFile[], source: BundleTransferSnapshotV1["source"]): BundleTransferSnapshotV1 {
  const documents: RawDocumentV1[] = [];
  const reserved: RawReservedV1[] = [];
  const blobs: RawBlobV1[] = [];
  let okfEdition: string | undefined;

  for (const file of files) {
    if (file.relative.toLowerCase().endsWith(".md")) {
      const raw = utf8(file.bytes, file.relative);
      const version = versionOfBytes(raw);
      if (isReservedFile(file.relative)) {
        const slash = file.relative.lastIndexOf("/");
        const dir = slash === -1 ? "" : file.relative.slice(0, slash);
        const name = file.relative.slice(slash + 1) as ReservedFilename;
        assertSafeReservedDir(dir);
        const parsed = parseMarkdown(raw, file.relative);
        if (dir === "" && name === "index.md") {
          const value = parsed.frontmatter.okf_version;
          if (typeof value !== "string" || value.trim() === "") {
            throw new BundleTransferError("INVALID_BUNDLE", "root index.md must declare a non-empty okf_version");
          }
          okfEdition = value;
        }
        reserved.push({ dir, name, version, bytes: file.bytes });
      } else {
        const id = conceptIdFromPath(file.relative);
        assertSafeConceptId(id);
        if (pathFromConceptId(id) !== file.relative) {
          throw new BundleTransferError("INVALID_BUNDLE", "document path does not round-trip through its canonical id", { subject: file.relative });
        }
        const parsed = parseMarkdown(raw, file.relative);
        if (typeof parsed.frontmatter.type !== "string" || parsed.frontmatter.type.trim() === "") {
          throw new BundleTransferError("INVALID_BUNDLE", "concept documents require non-empty frontmatter.type", { subject: file.relative });
        }
        documents.push({ id, version, bytes: file.bytes });
      }
    } else {
      assertSafeBlobKey(file.relative);
      blobs.push({
        key: file.relative,
        version: blobVersion(file.bytes),
        content_type: resolveContentType(file.relative),
        bytes: file.bytes,
      });
    }
  }
  if (!okfEdition) throw new BundleTransferError("INVALID_BUNDLE", "root index.md is required");
  return { source, okf_edition: okfEdition, documents, reserved, blobs };
}

interface FilesystemRootIdentity {
  canonical: string;
  key: string;
}

async function rootIdentity(root: string): Promise<FilesystemRootIdentity> {
  let entry;
  try { entry = await lstat(root); } catch (error) { throw sourceChanged("source root is unavailable", error); }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new BundleTransferError("INVALID_SOURCE", "filesystem source root must be a real directory");
  }
  const canonical = await realpath(root);
  const current = await stat(root);
  return { canonical, key: `${canonical}\0${current.dev}\0${current.ino}` };
}

async function scanFilesystem(root: string, retainBytes: boolean): Promise<CapturedFile[]> {
  const output: CapturedFile[] = [];
  const unique = new Map<string, { size: number; bytes?: Uint8Array }>();
  let uniqueBytes = 0;

  const walk = async (relative = ""): Promise<void> => {
    const directory = relative ? path.join(root, ...relative.split("/")) : root;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { throw sourceChanged("source inventory changed while reading", error); }
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(root, ...child.split("/"));
      const before = await lstat(target).catch((error) => { throw sourceChanged("source entry disappeared during inventory", error); });
      if (before.isSymbolicLink()) throw new BundleTransferError("INVALID_SOURCE", "source symlinks are not permitted", { subject: child });
      if (before.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!before.isFile()) throw new BundleTransferError("INVALID_SOURCE", "source special files are not permitted", { subject: child });
      if (before.nlink !== 1) throw new BundleTransferError("INVALID_SOURCE", "source hard links are not permitted", { subject: child });
      if (before.size > BUNDLE_TRANSFER_LIMITS_V1.maxObjectBytes) throw new BundleTransferError("LIMIT_EXCEEDED", "a source object exceeds the per-object limit", { subject: child });
      if (output.length >= BUNDLE_TRANSFER_LIMITS_V1.maxRows) throw new BundleTransferError("LIMIT_EXCEEDED", "the source contains too many rows");
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const handle = await open(target, constants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== BigInt(before.dev) || opened.ino !== BigInt(before.ino)) {
          throw sourceChanged("source entry identity changed before read");
        }
        if (opened.size > BigInt(BUNDLE_TRANSFER_LIMITS_V1.maxObjectBytes)) {
          throw new BundleTransferError("LIMIT_EXCEEDED", "a source object exceeds the per-object limit", { subject: child });
        }
        const expectedSize = Number(opened.size);
        const bounded = Buffer.alloc(expectedSize + 1);
        let bytesRead = 0;
        while (bytesRead < bounded.length) {
          const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        if (bytesRead !== expectedSize) throw sourceChanged("source entry size changed during bounded read");
        let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(bounded.buffer, bounded.byteOffset, bytesRead).slice();
        const after = await handle.stat({ bigint: true });
        if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs || opened.nlink !== after.nlink) {
          throw sourceChanged("source entry changed during read");
        }
        const objectDigest = blobVersion(bytes);
        const existing = unique.get(objectDigest);
        if (existing) {
          if (existing.size !== bytes.byteLength || (existing.bytes && !existing.bytes.every((byte, index) => byte === bytes[index]))) {
            throw new BundleTransferError("OBJECT_MISMATCH", "equal source digests carried different bytes", { subject: child });
          }
          if (retainBytes && existing.bytes) bytes = existing.bytes;
        } else {
          uniqueBytes += bytes.byteLength;
          if (uniqueBytes > BUNDLE_TRANSFER_LIMITS_V1.maxUniqueBytes) throw new BundleTransferError("LIMIT_EXCEEDED", "unique source bytes exceed the artifact limit");
          unique.set(objectDigest, { size: bytes.byteLength, ...(retainBytes ? { bytes } : {}) });
        }
        output.push({
          relative: child,
          bytes: retainBytes ? bytes : new Uint8Array(),
          identity: `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}:${after.nlink}`,
          digest: objectDigest,
        });
      } finally {
        await handle.close();
      }
    }
  };
  await walk();
  return output;
}

function inventoryIdentity(files: readonly CapturedFile[]): string {
  return files.map((file) => `${file.relative}\0${file.identity}\0${file.digest}`).join("\0");
}

function sameFileBytes(left: readonly CapturedFile[], right: readonly CapturedFile[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return other !== undefined && file.relative === other.relative && file.identity === other.identity && file.digest === other.digest;
  });
}

export interface CaptureFilesystemBundleOptionsV1 {
  root: string;
  sourceAuthorityId: string;
  maxAttempts?: number;
}

export async function captureFilesystemBundle(options: CaptureFilesystemBundleOptionsV1): Promise<BundleTransferArtifactV1> {
  assertSourceAuthorityId(options.sourceAuthorityId);
  if (!path.isAbsolute(options.root)) throw new BundleTransferError("INVALID_SOURCE", "filesystem source root must be absolute");
  const attempts = options.maxAttempts ?? 2;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new BundleTransferError("INVALID_SOURCE", "maxAttempts must be between 1 and 3");
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const beforeRoot = await rootIdentity(options.root);
      const first = await scanFilesystem(beforeRoot.canonical, false);
      const firstIdentity = inventoryIdentity(first);
      const second = await scanFilesystem(beforeRoot.canonical, true);
      const afterRoot = await rootIdentity(options.root);
      if (beforeRoot.key !== afterRoot.key || firstIdentity !== inventoryIdentity(second) || !sameFileBytes(first, second)) {
        throw sourceChanged("filesystem source changed between bounded inventories");
      }
      return createBundleTransferArtifact(classify(second, {
        authority_id: options.sourceAuthorityId,
        kind: "filesystem",
        revision: { kind: "filesystem" },
      }));
    } catch (error) {
      last = error;
      if (!(error instanceof BundleTransferError) || error.code !== "SOURCE_CHANGED" || attempt + 1 >= attempts) throw error;
    }
  }
  throw last;
}

async function git(repository: string, args: readonly string[], encoding: "utf8" | "buffer" = "utf8"): Promise<string | Buffer> {
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key) || /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/u.test(key)) {
        delete env[key];
      }
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    const result = await execFileAsync("git", ["-C", repository, ...args], {
      encoding: encoding === "buffer" ? "buffer" : "utf8",
      env,
      maxBuffer: 40 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    throw new BundleTransferError("INVALID_SOURCE", "Git object capture failed", { cause: error });
  }
}

async function gitRefIdentity(repository: string): Promise<{ commit: string; tree: string }> {
  const commit = String(await git(repository, ["rev-parse", "--verify", "refs/heads/board^{commit}"])).trim();
  const tree = String(await git(repository, ["rev-parse", "--verify", `${commit}^{tree}`])).trim();
  if (!gitObjectPattern.test(commit) || !gitObjectPattern.test(tree)) throw new BundleTransferError("INVALID_SOURCE", "Git SHA-1 object ids must be canonical lowercase hexadecimal");
  return { commit, tree };
}

async function captureGitFiles(repository: string, commit: string, retainBytes: boolean): Promise<CapturedFile[]> {
  const listing = await git(repository, ["ls-tree", "-r", "-z", "--full-tree", commit], "buffer") as Buffer;
  const rows = listing.toString("utf8").split("\0").filter(Boolean);
  const files: CapturedFile[] = [];
  const unique = new Map<string, { size: number; bytes?: Uint8Array }>();
  let uniqueBytes = 0;
  for (const row of rows) {
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(row);
    if (!match) throw new BundleTransferError("INVALID_SOURCE", "Git tree inventory is malformed");
    const [, mode, type, objectId, relative] = match;
    if (relative!.split("/").some((segment) => segment.startsWith("."))) continue;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new BundleTransferError("INVALID_SOURCE", "Git source contains a symlink, submodule, or special entry", { subject: relative });
    }
    if (files.length >= BUNDLE_TRANSFER_LIMITS_V1.maxRows) throw new BundleTransferError("LIMIT_EXCEEDED", "the Git source contains too many rows");
    const sizeText = String(await git(repository, ["cat-file", "-s", objectId!])).trim();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > BUNDLE_TRANSFER_LIMITS_V1.maxObjectBytes) {
      throw new BundleTransferError("LIMIT_EXCEEDED", "a Git source object exceeds the per-object limit", { subject: relative });
    }
    let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(await git(repository, ["cat-file", "blob", objectId!], "buffer") as Buffer);
    if (bytes.byteLength !== size) throw sourceChanged("Git object size changed during capture");
    const objectDigest = blobVersion(bytes);
    const existing = unique.get(objectDigest);
    if (existing) {
      if (existing.size !== bytes.byteLength || (existing.bytes && !existing.bytes.every((byte, index) => byte === bytes[index]))) {
        throw new BundleTransferError("OBJECT_MISMATCH", "equal Git object digests carried different bytes", { subject: relative });
      }
      if (retainBytes && existing.bytes) bytes = existing.bytes;
    } else {
      uniqueBytes += bytes.byteLength;
      if (uniqueBytes > BUNDLE_TRANSFER_LIMITS_V1.maxUniqueBytes) throw new BundleTransferError("LIMIT_EXCEEDED", "unique Git source bytes exceed the artifact limit");
      unique.set(objectDigest, { size: bytes.byteLength, ...(retainBytes ? { bytes } : {}) });
    }
    files.push({ relative: relative!, bytes: retainBytes ? bytes : new Uint8Array(), identity: `${mode}:${objectId}`, digest: objectDigest });
  }
  files.sort((left, right) => Buffer.from(left.relative).compare(Buffer.from(right.relative)));
  return files;
}

export interface CaptureGitBundleOptionsV1 {
  repository: string;
  sourceAuthorityId: string;
  expectedCommit?: string;
  maxAttempts?: number;
}

export async function captureGitBundle(options: CaptureGitBundleOptionsV1): Promise<BundleTransferArtifactV1> {
  assertSourceAuthorityId(options.sourceAuthorityId);
  if (!path.isAbsolute(options.repository)) throw new BundleTransferError("INVALID_SOURCE", "Git repository locator must be absolute and remains local-only");
  if (options.expectedCommit !== undefined && !gitObjectPattern.test(options.expectedCommit)) throw new BundleTransferError("INVALID_SOURCE", "expected Git commit must be 40 lowercase hexadecimal characters");
  const attempts = options.maxAttempts ?? 2;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw new BundleTransferError("INVALID_SOURCE", "maxAttempts must be between 1 and 3");
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const first = await gitRefIdentity(options.repository);
      if (options.expectedCommit !== undefined && first.commit !== options.expectedCommit) throw sourceChanged("Git authority ref does not equal the expected commit");
      const firstFiles = await captureGitFiles(options.repository, first.commit, false);
      const secondFiles = await captureGitFiles(options.repository, first.commit, true);
      const second = await gitRefIdentity(options.repository);
      if (first.commit !== second.commit || first.tree !== second.tree || !sameFileBytes(firstFiles, secondFiles)) {
        throw sourceChanged("Git source changed between bounded inventories");
      }
      return createBundleTransferArtifact(classify(secondFiles, {
        authority_id: options.sourceAuthorityId,
        kind: "git",
        revision: {
          kind: "git",
          provider: "github",
          requested_ref: "refs/heads/board",
          commit: first.commit,
          tree: first.tree,
          root: "",
        },
      }));
    } catch (error) {
      last = error;
      if (!(error instanceof BundleTransferError) || error.code !== "SOURCE_CHANGED" || attempt + 1 >= attempts) throw error;
    }
  }
  throw last;
}
