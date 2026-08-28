import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  FilesystemBackend,
  parseLinksFromDoc,
  parseMarkdown,
  type Frontmatter,
  type OkfDocument,
} from "@superbee/core";
import {
  listFilesystemReservedObjects,
  readRawFilesystemDocument,
  readRawFilesystemReserved,
} from "@superbee/core/publication-filesystem";
import { parseRegistration, resolveDeclaredAccess } from "@superbee/core/page";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import { admitActiveView } from "@superbee/view-runtime";

import { canonicalJson } from "./canonical-json.js";
import { PublicationError } from "./errors.js";
import {
  PUBLICATION_SNAPSHOT_V1,
  PUBLICATION_BRIDGE_V0,
  type CapturePublicationSnapshotOptionsV1,
  type PublicationJsonValue,
  type PublicationObjectRefV1,
  type PublicationSnapshotHandleV1,
  type PublicationSnapshotV1,
} from "./types.js";

const DEFAULT_LIMITS = {
  maxObjects: 20_000,
  maxObjectBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
} as const;

const CAPABILITIES = [
  "documents.semantic.v1",
  "documents.source-exact.v1",
  "documents.rendered-html-inert.v1",
  "relationships.explicit.v1",
  "reserved.source-exact.v1",
  "blobs.source-exact.v1",
  "views.registered-entry-exact.v1",
  "view-bridge.readonly.v0",
] as const;

type RawDocument = { id: string; version: string; bytes: Uint8Array };
type RawReserved = { dir: string; name: "index.md" | "log.md"; version: string; bytes: Uint8Array };
type RawBlob = { key: string; version: string; contentType: string; bytes: Uint8Array };
interface RawInventory {
  documents: RawDocument[];
  reserved: RawReserved[];
  blobs: RawBlob[];
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function jsonValue(value: unknown, subject: string): PublicationJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new PublicationError("UNSERIALIZABLE_VALUE", "frontmatter contains a non-finite number", { subject });
  }
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, subject));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PublicationError("UNSERIALIZABLE_VALUE", "frontmatter contains a non-plain value", { subject });
    }
    const out: Record<string, PublicationJsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonValue(entry, subject);
    }
    return out;
  }
  throw new PublicationError("UNSERIALIZABLE_VALUE", "frontmatter contains a non-JSON value", { subject });
}

function frontmatterValue(frontmatter: Frontmatter, subject: string): Record<string, PublicationJsonValue> {
  return jsonValue(frontmatter, subject) as Record<string, PublicationJsonValue>;
}

function compareInventory(a: RawInventory, b: RawInventory): boolean {
  const rows = (inventory: RawInventory): string[] => [
    ...inventory.documents.map((row) => `document\0${row.id}\0${row.version}`),
    ...inventory.reserved.map((row) => `reserved\0${row.dir}\0${row.name}\0${row.version}`),
    ...inventory.blobs.map((row) => `blob\0${row.key}\0${row.version}\0${row.contentType}`),
  ].sort();
  const left = rows(a);
  const right = rows(b);
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

async function readInventory(
  backend: FilesystemBackend,
  limits: Required<NonNullable<CapturePublicationSnapshotOptionsV1["limits"]>>,
): Promise<RawInventory> {
  const [documentIds, reservedIds, blobKeys] = await Promise.all([
    backend.list(),
    listFilesystemReservedObjects(backend),
    backend.listBlobs(),
  ]);
  const objectCount = documentIds.length + reservedIds.length + blobKeys.length;
  if (objectCount > limits.maxObjects) {
    throw new PublicationError("LIMIT_EXCEEDED", "the bundle contains too many publication objects", {
      actual: objectCount,
      expected: limits.maxObjects,
    });
  }

  let totalBytes = 0;
  const admitBytes = (bytes: Uint8Array, subject: string): Uint8Array => {
    if (bytes.byteLength > limits.maxObjectBytes) {
      throw new PublicationError("LIMIT_EXCEEDED", "a publication object exceeds the per-object byte limit", { subject });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      throw new PublicationError("LIMIT_EXCEEDED", "the bundle exceeds the total publication byte limit");
    }
    return bytes;
  };

  const documents: RawDocument[] = [];
  for (const id of documentIds) {
    const row = await readRawFilesystemDocument(backend, id);
    documents.push({ id, version: row.version, bytes: admitBytes(row.bytes, id) });
  }
  const reserved: RawReserved[] = [];
  for (const identity of reservedIds) {
    const row = await readRawFilesystemReserved(backend, identity.dir, identity.name);
    if (!row) throw new PublicationError("SOURCE_CHANGED", "a reserved object changed during capture", { retryable: true });
    const subject = identity.dir ? `${identity.dir}/${identity.name}` : identity.name;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(row.bytes);
    } catch (error) {
      throw new PublicationError("INVALID_BUNDLE", "a reserved publication object is not UTF-8", {
        subject,
        cause: error,
      });
    }
    reserved.push({ ...identity, version: row.version, bytes: admitBytes(row.bytes, subject) });
  }
  const blobs: RawBlob[] = [];
  for (const key of blobKeys) {
    const row = await backend.readBlob(key);
    if (!row) throw new PublicationError("SOURCE_CHANGED", "a blob changed during capture", { retryable: true });
    blobs.push({ key, version: row.version, contentType: row.contentType, bytes: admitBytes(row.bytes, key) });
  }
  return { documents, reserved, blobs };
}

class SnapshotHandle implements PublicationSnapshotHandleV1 {
  private closed = false;
  private readonly refs: Set<string>;

  constructor(
    readonly manifest: PublicationSnapshotV1,
    private readonly objects: Map<string, Uint8Array>,
  ) {
    this.refs = new Set<string>();
    const add = (ref: PublicationObjectRefV1): void => {
      this.refs.add(canonicalJson(ref));
    };
    for (const doc of manifest.documents) {
      add(doc.source);
      add(doc.rendered.html);
    }
    for (const row of manifest.reserved) add(row.object);
    for (const row of manifest.blobs) add(row.object);
    for (const row of manifest.views) add(row.entryObject);
  }

  async readObject(ref: PublicationObjectRefV1): Promise<Uint8Array> {
    if (this.closed) throw new PublicationError("HANDLE_CLOSED", "the publication snapshot handle is closed");
    if (!this.refs.has(canonicalJson(ref))) {
      throw new PublicationError("INVALID_SNAPSHOT", "the object reference is not part of this snapshot");
    }
    const bytes = this.objects.get(ref.digest);
    if (!bytes) throw new PublicationError("OBJECT_MISSING", "the snapshot object is missing", { subject: ref.digest });
    if (bytes.byteLength !== ref.size || sha256(bytes) !== ref.digest) {
      throw new PublicationError("OBJECT_DIGEST_MISMATCH", "the snapshot object no longer matches its reference", { subject: ref.digest });
    }
    return bytes.slice();
  }

  serializeManifest(): Uint8Array {
    if (this.closed) throw new PublicationError("HANDLE_CLOSED", "the publication snapshot handle is closed");
    return utf8(canonicalJson(this.manifest));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.objects.clear();
  }
}

function mapCaptureError(error: unknown): PublicationError {
  if (error instanceof PublicationError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new PublicationError("SOURCE_CHANGED", "a publication object changed during capture", {
      retryable: true,
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM" || code === "EIO") {
    return new PublicationError("IO_ERROR", "the publication source could not be read", { cause: error });
  }
  return new PublicationError("INVALID_BUNDLE", error instanceof Error ? error.message : "the bundle is invalid", { cause: error });
}

function addObject(
  objects: Map<string, Uint8Array>,
  bytes: Uint8Array,
  mediaType: string,
  representation: "exact" | "canonical",
): PublicationObjectRefV1 {
  const digest = sha256(bytes);
  if (!objects.has(digest)) objects.set(digest, bytes.slice());
  return { digest, size: bytes.byteLength, mediaType, representation };
}

function buildSnapshot(first: RawInventory): SnapshotHandle {
  const objects = new Map<string, Uint8Array>();
  const parsedDocs = new Map<string, { doc: OkfDocument; version: string }>();
  const documents: PublicationSnapshotV1["documents"] = [];
  const relationships: PublicationSnapshotV1["relationships"] = [];

  for (const row of first.documents) {
    let parsed: ReturnType<typeof parseMarkdown>;
    try {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(row.bytes);
      parsed = parseMarkdown(raw, `${row.id}.md`);
    } catch (error) {
      throw new PublicationError("MALFORMED_DOCUMENT", "a publication document is malformed", {
        subject: row.id,
        cause: error,
      });
    }
    const doc: OkfDocument = { id: row.id, frontmatter: parsed.frontmatter, body: parsed.body };
    parsedDocs.set(row.id, { doc, version: row.version });
    let rendered: ReturnType<typeof renderDocumentToStaticHtml>;
    try {
      rendered = renderDocumentToStaticHtml(doc);
    } catch (error) {
      throw new PublicationError("RENDER_FAILED", "a publication document could not be rendered", {
        subject: row.id,
        cause: error,
      });
    }
    documents.push({
      id: row.id,
      version: row.version,
      frontmatter: frontmatterValue(doc.frontmatter, row.id),
      body: doc.body,
      source: addObject(objects, row.bytes, "text/markdown; charset=utf-8", "exact"),
      rendered: {
        html: addObject(objects, utf8(rendered.html), "text/html; charset=utf-8", "canonical"),
        bounded: rendered.bounded,
      },
    });
    relationships.push(...parseLinksFromDoc(doc).map((link) => ({ ...link })));
  }
  documents.sort((a, b) => a.id.localeCompare(b.id));
  relationships.sort((a, b) =>
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to) ||
    a.text.localeCompare(b.text) || a.href.localeCompare(b.href));

  const reserved: PublicationSnapshotV1["reserved"] = first.reserved.map((row) => ({
    dir: row.dir,
    name: row.name,
    version: row.version,
    object: addObject(objects, row.bytes, "text/markdown; charset=utf-8", "exact"),
  }));
  reserved.sort((a, b) => `${a.dir}/${a.name}`.localeCompare(`${b.dir}/${b.name}`));

  const blobs: PublicationSnapshotV1["blobs"] = first.blobs.map((row) => ({
    key: row.key,
    version: row.version,
    contentType: row.contentType,
    object: addObject(objects, row.bytes, row.contentType, "exact"),
  }));
  blobs.sort((a, b) => a.key.localeCompare(b.key));
  const blobsByKey = new Map(blobs.map((row) => [row.key, row]));

  const views: PublicationSnapshotV1["views"] = [];
  for (const { doc, version } of parsedDocs.values()) {
    if (doc.frontmatter.type !== "View") continue;
    const registration = parseRegistration(doc.id, doc.frontmatter);
    if (!registration) {
      throw new PublicationError("INVALID_VIEW_REGISTRATION", "a View registration is invalid", { subject: doc.id });
    }
    const blob = blobsByKey.get(registration.entry);
    if (!blob) {
      throw new PublicationError("VIEW_ENTRY_MISSING", "a registered View entry is missing", { subject: doc.id });
    }
    if (registration.entryVersion && registration.entryVersion !== blob.version) {
      throw new PublicationError("VIEW_ENTRY_VERSION_MISMATCH", "a registered View entry no longer matches its pin", {
        subject: doc.id,
        expected: registration.entryVersion,
        actual: blob.version,
      });
    }
    const rawBlob = first.blobs.find((candidate) => candidate.key === registration.entry)!;
    try {
      admitActiveView(rawBlob.bytes, rawBlob.contentType);
    } catch (error) {
      throw new PublicationError("INVALID_VIEW_REGISTRATION", "a registered View entry is not admissible HTML", {
        subject: doc.id,
        cause: error,
      });
    }
    const presentation = doc.frontmatter.presentation;
    views.push({
      id: registration.id,
      registrationVersion: version,
      title: typeof doc.frontmatter.title === "string" && doc.frontmatter.title.trim()
        ? doc.frontmatter.title.trim()
        : registration.id,
      ...(typeof doc.frontmatter.description === "string" ? { description: doc.frontmatter.description } : {}),
      ...(presentation === "workspace" || presentation === "inline" || presentation === "adaptive"
        ? { presentation }
        : {}),
      access: resolveDeclaredAccess(doc.frontmatter),
      entry: registration.entry,
      entryVersion: blob.version,
      entryObject: blob.object,
    });
  }
  views.sort((a, b) => a.id.localeCompare(b.id));

  const rootIndex = first.reserved.find((row) => row.dir === "" && row.name === "index.md");
  let okfEdition = "0.1";
  if (rootIndex) {
    try {
      const parsed = parseMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(rootIndex.bytes), "index.md");
      if (typeof parsed.frontmatter.okf_version === "string" && parsed.frontmatter.okf_version.trim()) {
        okfEdition = parsed.frontmatter.okf_version.trim();
      }
    } catch (error) {
      throw new PublicationError("INVALID_BUNDLE", "the bundle root index is malformed", { cause: error });
    }
  }

  const withoutDigest = {
    schema: PUBLICATION_SNAPSHOT_V1,
    schemaVersion: 1 as const,
    source: { okfEdition, rootDocumentVersion: rootIndex?.version ?? null },
    semantics: { rendererProfile: "inert-v1", viewBridgeProtocol: PUBLICATION_BRIDGE_V0 },
    capabilities: [...CAPABILITIES],
    documents,
    reserved,
    blobs,
    relationships,
    views,
    warnings: [],
  };
  const snapshotDigest = sha256(utf8(canonicalJson(withoutDigest)));
  return new SnapshotHandle({ ...withoutDigest, snapshotDigest }, objects);
}

/** Capture one coherent immutable filesystem publication snapshot. */
export async function capturePublicationSnapshot(
  options: CapturePublicationSnapshotOptionsV1,
): Promise<PublicationSnapshotHandleV1> {
  if (options.schema !== PUBLICATION_SNAPSHOT_V1) {
    throw new PublicationError("CAPABILITY_UNAVAILABLE", "the requested publication snapshot schema is unsupported");
  }
  if (options.source.kind !== "filesystem") {
    throw new PublicationError("UNSUPPORTED_SOURCE", "the requested publication source is unsupported");
  }
  if (!path.isAbsolute(options.source.root)) {
    throw new PublicationError("INVALID_OBJECT_IDENTITY", "the filesystem publication root must be absolute");
  }
  const requestedRoot = path.resolve(options.source.root);
  let root: string;
  try {
    root = await realpath(requestedRoot);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) throw new PublicationError("SOURCE_NOT_FOUND", "the publication source is not a directory");
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    throw new PublicationError("SOURCE_NOT_FOUND", "the publication source does not exist", { cause: error });
  }
  if (root !== requestedRoot) {
    throw new PublicationError("INVALID_OBJECT_IDENTITY", "the filesystem publication root must not be a symlink");
  }

  const limits = {
    maxObjects: options.limits?.maxObjects ?? DEFAULT_LIMITS.maxObjects,
    maxObjectBytes: options.limits?.maxObjectBytes ?? DEFAULT_LIMITS.maxObjectBytes,
    maxTotalBytes: options.limits?.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PublicationError("LIMIT_EXCEEDED", `capture limit '${name}' must be a positive safe integer`);
    }
  }
  const maxAttempts = options.maxAttempts ?? 2;
  const backend = new FilesystemBackend(root);
  let lastError: PublicationError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const first = await readInventory(backend, limits);
      const handle = buildSnapshot(first);
      const second = await readInventory(backend, limits);
      if (!compareInventory(first, second)) {
        await handle.close();
        throw new PublicationError("SOURCE_CHANGED", "the publication source changed during capture", { retryable: true });
      }
      return handle;
    } catch (error) {
      lastError = mapCaptureError(error);
      if (!lastError.retryable || attempt === maxAttempts) throw lastError;
    }
  }
  throw lastError ?? new PublicationError("INTERNAL_ERROR", "publication capture failed");
}
