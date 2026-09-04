import {
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  type ReservedFilename,
  type Version,
} from "@superbee/core/storage";

import { canonicalTransferJsonBytes, compareUnsignedUtf8 } from "./canonical-json.js";
import { BundleTransferError } from "./errors.js";
import {
  BUNDLE_TRANSFER_LIMITS_V1,
  BUNDLE_TRANSFER_MANIFEST_V1,
  type BundleTransferArtifactV1,
  type BundleTransferManifestV1,
  type BundleTransferSnapshotV1,
  type BundleTransferSourceV1,
  type Sha256Digest,
  type TransferBlobRowV1,
  type TransferDocumentRowV1,
  type TransferObjectReaderV1,
  type TransferObjectRefV1,
  type TransferReservedRowV1,
} from "./types.js";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sourceAuthorityPattern = /^src_[0-9a-f]{32}$/u;
const gitObjectPattern = /^[0-9a-f]{40}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(message: string, subject?: string): never {
  throw new BundleTransferError("INVALID_ARTIFACT", message, { subject });
}

function plainRecord(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${name} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${name} has unknown symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort(compareUnsignedUtf8);
  const expected = [...keys].sort(compareUnsignedUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} has missing or unknown fields`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set) fail(`${name} may not use hidden fields or accessors`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) fail(`${name} is invalid`);
  return value;
}

function safeInteger(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail(`${name} is out of range`);
  return value as number;
}

function digest(value: unknown, name: string): Sha256Digest {
  return exactString(value, name, digestPattern) as Sha256Digest;
}

function version(value: unknown, name: string): Version {
  return digest(value, name) as Version;
}

function source(value: unknown): BundleTransferSourceV1 {
  const row = plainRecord(value, "source", ["authority_id", "kind", "revision"]);
  const authority = exactString(row.authority_id, "source.authority_id", sourceAuthorityPattern);
  if (row.kind === "filesystem") {
    const revision = plainRecord(row.revision, "source.revision", ["kind"]);
    if (revision.kind !== "filesystem") fail("filesystem revision kind is invalid");
    return { authority_id: authority as BundleTransferSourceV1["authority_id"], kind: "filesystem", revision: { kind: "filesystem" } };
  }
  if (row.kind === "git") {
    const revision = plainRecord(row.revision, "source.revision", ["kind", "provider", "requested_ref", "commit", "tree", "root"]);
    if (revision.kind !== "git" || revision.provider !== "github" || revision.requested_ref !== "refs/heads/board" || revision.root !== "") {
      fail("git revision tuple is outside the v1 contract");
    }
    return {
      authority_id: authority as BundleTransferSourceV1["authority_id"],
      kind: "git",
      revision: {
        kind: "git",
        provider: "github",
        requested_ref: "refs/heads/board",
        commit: exactString(revision.commit, "source.revision.commit", gitObjectPattern),
        tree: exactString(revision.tree, "source.revision.tree", gitObjectPattern),
        root: "",
      },
    };
  }
  return fail("source.kind is outside the v1 contract");
}

function objectRef(value: unknown, name: string): TransferObjectRefV1 {
  const row = plainRecord(value, name, ["digest", "size"]);
  return {
    digest: digest(row.digest, `${name}.digest`),
    size: safeInteger(row.size, `${name}.size`, BUNDLE_TRANSFER_LIMITS_V1.maxObjectBytes),
  };
}

function validateDocument(value: unknown, index: number): TransferDocumentRowV1 {
  const name = `documents[${index}]`;
  const row = plainRecord(value, name, ["id", "version", "object"]);
  const id = exactString(row.id, `${name}.id`);
  try { assertSafeConceptId(id); } catch (error) { throw new BundleTransferError("INVALID_ARTIFACT", "document id is unsafe", { subject: id, cause: error }); }
  return { id, version: version(row.version, `${name}.version`), object: objectRef(row.object, `${name}.object`) };
}

function validateReserved(value: unknown, index: number): TransferReservedRowV1 {
  const name = `reserved[${index}]`;
  const row = plainRecord(value, name, ["dir", "name", "version", "object"]);
  const dir = exactString(row.dir, `${name}.dir`);
  try { assertSafeReservedDir(dir); } catch (error) { throw new BundleTransferError("INVALID_ARTIFACT", "reserved directory is unsafe", { subject: dir, cause: error }); }
  if (row.name !== "index.md" && row.name !== "log.md") fail(`${name}.name is invalid`);
  return { dir, name: row.name as ReservedFilename, version: version(row.version, `${name}.version`), object: objectRef(row.object, `${name}.object`) };
}

function validateBlob(value: unknown, index: number): TransferBlobRowV1 {
  const name = `blobs[${index}]`;
  const row = plainRecord(value, name, ["key", "version", "content_type", "object"]);
  const key = exactString(row.key, `${name}.key`);
  try { assertSafeBlobKey(key); } catch (error) { throw new BundleTransferError("INVALID_ARTIFACT", "blob key is unsafe", { subject: key, cause: error }); }
  const contentType = exactString(row.content_type, `${name}.content_type`);
  if (contentType.length > 256 || contentType.length === 0) fail(`${name}.content_type is invalid`);
  return { key, version: version(row.version, `${name}.version`), content_type: contentType, object: objectRef(row.object, `${name}.object`) };
}

function tupleCompare(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareUnsignedUtf8(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function assertSortedUnique<T>(rows: readonly T[], identity: (row: T) => readonly string[], name: string): void {
  for (let index = 1; index < rows.length; index += 1) {
    if (tupleCompare(identity(rows[index - 1]!), identity(rows[index]!)) >= 0) {
      fail(`${name} must be strictly sorted by unsigned UTF-8 identity bytes`);
    }
  }
}

async function sha256(bytes: Uint8Array): Promise<Sha256Digest> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new BundleTransferError("UNSUPPORTED_HOST", "Web Crypto SHA-256 is required");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function manifestWithoutDigest(manifest: BundleTransferManifestV1): Omit<BundleTransferManifestV1, "manifest_digest"> {
  const { manifest_digest: _discarded, ...body } = manifest;
  return body;
}

function contentProjection(manifest: Pick<BundleTransferManifestV1, "documents" | "reserved" | "blobs">): unknown {
  return { documents: manifest.documents, reserved: manifest.reserved, blobs: manifest.blobs };
}

export async function digestTransferBytes(bytes: Uint8Array): Promise<Sha256Digest> {
  return sha256(bytes);
}

export async function createBundleTransferArtifact(snapshot: BundleTransferSnapshotV1): Promise<BundleTransferArtifactV1> {
  const sourceValue = source(snapshot.source);
  if (typeof snapshot.okf_edition !== "string" || snapshot.okf_edition.length === 0 || snapshot.okf_edition.length > 32) {
    fail("OKF edition is invalid");
  }
  const rowCount = snapshot.documents.length + snapshot.reserved.length + snapshot.blobs.length;
  if (rowCount > BUNDLE_TRANSFER_LIMITS_V1.maxRows) throw new BundleTransferError("LIMIT_EXCEEDED", "the bundle has too many rows");

  const objects = new Map<Sha256Digest, Uint8Array>();
  let uniqueBytes = 0;
  const admit = async (bytes: Uint8Array, suppliedVersion: Version, subject: string, textual: boolean): Promise<TransferObjectRefV1> => {
    if (!(bytes instanceof Uint8Array)) fail("object bytes must be Uint8Array", subject);
    if (bytes.byteLength > BUNDLE_TRANSFER_LIMITS_V1.maxObjectBytes) throw new BundleTransferError("LIMIT_EXCEEDED", "an object exceeds the per-object limit", { subject });
    if (textual) {
      try { decoder.decode(bytes); } catch (error) { throw new BundleTransferError("INVALID_BUNDLE", "document and reserved bytes must be strict UTF-8", { subject, cause: error }); }
    }
    const objectDigest = await sha256(bytes);
    if (suppliedVersion !== objectDigest) throw new BundleTransferError("OBJECT_MISMATCH", "the source version does not equal the raw-byte digest", { subject });
    const existing = objects.get(objectDigest);
    if (existing) {
      if (!equalBytes(existing, bytes)) throw new BundleTransferError("OBJECT_MISMATCH", "equal digests carried different bytes", { subject });
    } else {
      uniqueBytes += bytes.byteLength;
      if (uniqueBytes > BUNDLE_TRANSFER_LIMITS_V1.maxUniqueBytes) throw new BundleTransferError("LIMIT_EXCEEDED", "unique object bytes exceed the artifact limit");
      objects.set(objectDigest, bytes.slice());
    }
    return { digest: objectDigest, size: bytes.byteLength };
  };

  const documents: TransferDocumentRowV1[] = [];
  for (const row of snapshot.documents) {
    try { assertSafeConceptId(row.id); } catch (error) { throw new BundleTransferError("INVALID_BUNDLE", "document id is unsafe", { subject: row.id, cause: error }); }
    documents.push({ id: row.id, version: row.version, object: await admit(row.bytes, row.version, row.id, true) });
  }
  documents.sort((a, b) => tupleCompare([a.id], [b.id]));
  assertSortedUnique(documents, (row) => [row.id], "documents");

  const reserved: TransferReservedRowV1[] = [];
  for (const row of snapshot.reserved) {
    try { assertSafeReservedDir(row.dir); } catch (error) { throw new BundleTransferError("INVALID_BUNDLE", "reserved directory is unsafe", { subject: row.dir, cause: error }); }
    if (row.name !== "index.md" && row.name !== "log.md") fail("reserved name is invalid");
    reserved.push({ dir: row.dir, name: row.name, version: row.version, object: await admit(row.bytes, row.version, `${row.dir}/${row.name}`, true) });
  }
  reserved.sort((a, b) => tupleCompare([a.dir, a.name], [b.dir, b.name]));
  assertSortedUnique(reserved, (row) => [row.dir, row.name], "reserved");

  const blobs: TransferBlobRowV1[] = [];
  for (const row of snapshot.blobs) {
    try { assertSafeBlobKey(row.key); } catch (error) { throw new BundleTransferError("INVALID_BUNDLE", "blob key is unsafe", { subject: row.key, cause: error }); }
    if (typeof row.content_type !== "string" || row.content_type.length === 0 || row.content_type.length > 256) fail("blob content type is invalid", row.key);
    blobs.push({ key: row.key, version: row.version, content_type: row.content_type, object: await admit(row.bytes, row.version, row.key, false) });
  }
  blobs.sort((a, b) => tupleCompare([a.key], [b.key]));
  assertSortedUnique(blobs, (row) => [row.key], "blobs");

  const root = reserved.find((row) => row.dir === "" && row.name === "index.md");
  if (!root) throw new BundleTransferError("INVALID_BUNDLE", "the bundle root index.md is required");
  const partial = {
    schema: BUNDLE_TRANSFER_MANIFEST_V1,
    schema_version: 1 as const,
    source: sourceValue,
    okf: { edition: snapshot.okf_edition, root_index_version: root.version },
    documents,
    reserved,
    blobs,
    counts: {
      documents: documents.length,
      reserved: reserved.length,
      blobs: blobs.length,
      unique_objects: objects.size,
      unique_bytes: uniqueBytes,
    },
    content_digest: await sha256(canonicalTransferJsonBytes({ documents, reserved, blobs })),
  };
  const manifest: BundleTransferManifestV1 = {
    ...partial,
    manifest_digest: await sha256(canonicalTransferJsonBytes(partial)),
  };
  const manifestBytes = canonicalTransferJsonBytes(manifest);
  if (manifestBytes.byteLength > BUNDLE_TRANSFER_LIMITS_V1.maxManifestBytes) throw new BundleTransferError("LIMIT_EXCEEDED", "canonical manifest exceeds the artifact limit");
  return { manifest, objects };
}

export async function validateBundleTransferManifest(value: unknown): Promise<BundleTransferManifestV1> {
  const record = plainRecord(value, "manifest", ["schema", "schema_version", "source", "okf", "documents", "reserved", "blobs", "counts", "content_digest", "manifest_digest"]);
  if (record.schema !== BUNDLE_TRANSFER_MANIFEST_V1 || record.schema_version !== 1) fail("manifest schema identity is invalid");
  const sourceValue = source(record.source);
  const okf = plainRecord(record.okf, "okf", ["edition", "root_index_version"]);
  const edition = exactString(okf.edition, "okf.edition");
  if (edition.length === 0 || edition.length > 32) fail("okf.edition is invalid");
  if (!Array.isArray(record.documents) || !Array.isArray(record.reserved) || !Array.isArray(record.blobs)) fail("manifest inventories must be arrays");
  const documents = record.documents.map(validateDocument);
  const reserved = record.reserved.map(validateReserved);
  const blobs = record.blobs.map(validateBlob);
  if (documents.length + reserved.length + blobs.length > BUNDLE_TRANSFER_LIMITS_V1.maxRows) fail("manifest has too many rows");
  assertSortedUnique(documents, (row) => [row.id], "documents");
  assertSortedUnique(reserved, (row) => [row.dir, row.name], "reserved");
  assertSortedUnique(blobs, (row) => [row.key], "blobs");
  const countsRecord = plainRecord(record.counts, "counts", ["documents", "reserved", "blobs", "unique_objects", "unique_bytes"]);
  const counts = {
    documents: safeInteger(countsRecord.documents, "counts.documents", BUNDLE_TRANSFER_LIMITS_V1.maxRows),
    reserved: safeInteger(countsRecord.reserved, "counts.reserved", BUNDLE_TRANSFER_LIMITS_V1.maxRows),
    blobs: safeInteger(countsRecord.blobs, "counts.blobs", BUNDLE_TRANSFER_LIMITS_V1.maxRows),
    unique_objects: safeInteger(countsRecord.unique_objects, "counts.unique_objects", BUNDLE_TRANSFER_LIMITS_V1.maxRows),
    unique_bytes: safeInteger(countsRecord.unique_bytes, "counts.unique_bytes", BUNDLE_TRANSFER_LIMITS_V1.maxUniqueBytes),
  };
  const manifest: BundleTransferManifestV1 = {
    schema: BUNDLE_TRANSFER_MANIFEST_V1,
    schema_version: 1,
    source: sourceValue,
    okf: { edition, root_index_version: version(okf.root_index_version, "okf.root_index_version") },
    documents,
    reserved,
    blobs,
    counts,
    content_digest: digest(record.content_digest, "content_digest"),
    manifest_digest: digest(record.manifest_digest, "manifest_digest"),
  };
  if (counts.documents !== documents.length || counts.reserved !== reserved.length || counts.blobs !== blobs.length) fail("manifest row counts disagree");
  const unique = new Map<Sha256Digest, number>();
  for (const row of [...documents, ...reserved, ...blobs]) {
    const known = unique.get(row.object.digest);
    if (known !== undefined && known !== row.object.size) fail("one digest declares different sizes");
    unique.set(row.object.digest, row.object.size);
    if (row.version !== row.object.digest) fail("row version and raw object digest disagree");
  }
  const uniqueBytes = [...unique.values()].reduce((sum, size) => sum + size, 0);
  if (!Number.isSafeInteger(uniqueBytes) || counts.unique_objects !== unique.size || counts.unique_bytes !== uniqueBytes) fail("manifest unique-object counts disagree");
  const root = reserved.find((row) => row.dir === "" && row.name === "index.md");
  if (!root || root.version !== manifest.okf.root_index_version) fail("root index version disagrees");
  if (manifest.content_digest !== await sha256(canonicalTransferJsonBytes(contentProjection(manifest)))) fail("content digest disagrees");
  if (manifest.manifest_digest !== await sha256(canonicalTransferJsonBytes(manifestWithoutDigest(manifest)))) fail("manifest digest disagrees");
  if (canonicalTransferJsonBytes(manifest).byteLength > BUNDLE_TRANSFER_LIMITS_V1.maxManifestBytes) fail("canonical manifest exceeds the artifact limit");
  return manifest;
}

export async function verifyBundleTransferArtifact(
  manifestValue: unknown,
  readObject: TransferObjectReaderV1,
): Promise<BundleTransferManifestV1> {
  const manifest = await validateBundleTransferManifest(manifestValue);
  const refs = new Map<Sha256Digest, number>();
  for (const row of [...manifest.documents, ...manifest.reserved, ...manifest.blobs]) refs.set(row.object.digest, row.object.size);
  for (const [objectDigest, size] of refs) {
    const bytes = await readObject(objectDigest);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size || await sha256(bytes) !== objectDigest) {
      throw new BundleTransferError("OBJECT_MISMATCH", "artifact object bytes disagree with the manifest", { subject: objectDigest });
    }
  }
  return manifest;
}
