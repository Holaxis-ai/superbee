/**
 * Runtime-neutral Superbee engine operations.
 *
 * Every operation receives its {@link StorageBackend} explicitly. Node filesystem defaults live
 * only in the legacy root adapter (`bundle.ts`); Worker and browser consumers import this module.
 */

import {
  normalizeV01DocumentForWrite,
  normalizeV02DocumentForWrite,
} from "./document-write-policy.js";
import { InvalidInputError } from "./errors.js";
import { isUsableTimestamp, MalformedDocumentError, parseMarkdown } from "./frontmatter.js";
import { parseLinksFromDoc } from "./links.js";
import { assertSafeConceptId, isReservedFile, pathFromConceptId } from "./paths.js";
import { matchesFilter } from "./query-filter.js";
import type {
  BlobKey,
  ConceptId,
  DeleteOptions,
  EdgeFilter,
  HeadResult,
  Link,
  OkfDocument,
  QueryFilter,
  ReadBlobResult,
  ReadResult,
  StorageBackend,
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

/** A normalized written document together with the backend version recorded for it. */
export interface WriteResult {
  doc: OkfDocument;
  version: Version;
}

/** A document a resilient scan skipped because it was malformed. */
export interface SkippedDoc {
  id: ConceptId;
  reason: string;
}

/** Options for document and head scans. */
export interface QueryOptions {
  onSkip?: (skip: SkippedDoc) => void;
}

/** Read the bundle-root OKF edition through an explicit backend. */
export async function readBundleOkfVersion(backend: StorageBackend): Promise<string | undefined> {
  const index = await backend.readReserved("", "index.md");
  if (!index) return undefined;
  const value = parseMarkdown(index.content, "index.md").frontmatter.okf_version;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function assertWritableConceptDocument(doc: OkfDocument): string {
  assertSafeConceptId(doc.id);
  const rel = pathFromConceptId(doc.id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(
      `'${doc.id}' maps to a reserved file (${rel}); use the index/log accessors, not writeDoc.`,
    );
  }
  const type = doc.frontmatter?.type;
  if (typeof type !== "string" || type.trim() === "") {
    throw new InvalidInputError(
      `OKF conformance: frontmatter.type is required and must be non-empty (concept '${doc.id}').`,
    );
  }
  return type;
}

async function persistDocForEdition(
  backend: StorageBackend,
  doc: OkfDocument,
  type: string,
  okfVersion: string,
  options?: WriteOptions,
): Promise<WriteResult> {
  let saved: OkfDocument;
  if (okfVersion === "0.1") {
    const existingTimestamp = doc.frontmatter.timestamp;
    const timestamp = isUsableTimestamp(existingTimestamp)
      ? { preserveExisting: true as const, existingTimestamp }
      : { preserveExisting: false as const, fallbackTimestamp: new Date().toISOString() };
    saved = normalizeV01DocumentForWrite(doc, type, timestamp);
  } else {
    saved = normalizeV02DocumentForWrite(doc, type);
  }
  const version = await backend.write(doc.id, saved, options);
  return { doc: saved, version };
}

/** Validate, normalize for the backend's bundle edition, and atomically persist a document. */
export async function writeDocVersioned(
  backend: StorageBackend,
  doc: OkfDocument,
  options?: WriteOptions,
): Promise<WriteResult> {
  const type = assertWritableConceptDocument(doc);
  const okfVersion = (await readBundleOkfVersion(backend)) ?? "0.1";
  return persistDocForEdition(backend, doc, type, okfVersion, options);
}

/** Edition-pinned sibling for mutation policy after it has read the root once. */
export async function writeDocVersionedForEdition(
  backend: StorageBackend,
  doc: OkfDocument,
  okfVersion: string,
  options?: WriteOptions,
): Promise<WriteResult> {
  return persistDocForEdition(backend, doc, assertWritableConceptDocument(doc), okfVersion, options);
}

/** Persist a document while keeping the historical document-only result. */
export async function writeDoc(
  backend: StorageBackend,
  doc: OkfDocument,
  options?: WriteOptions,
): Promise<OkfDocument> {
  return (await writeDocVersioned(backend, doc, options)).doc;
}

function assertReadableConceptId(id: ConceptId): void {
  assertSafeConceptId(id);
  const rel = pathFromConceptId(id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(`'${id}' is a reserved file (index.md / log.md), not a concept document.`);
  }
}

export async function readDocVersioned(backend: StorageBackend, id: ConceptId): Promise<ReadResult> {
  assertReadableConceptId(id);
  return backend.read(id);
}

export async function readDoc(backend: StorageBackend, id: ConceptId): Promise<OkfDocument> {
  return (await readDocVersioned(backend, id)).doc;
}

export async function existsDoc(backend: StorageBackend, id: ConceptId): Promise<boolean> {
  assertReadableConceptId(id);
  return backend.exists(id);
}

export async function docVersions(backend: StorageBackend, id: ConceptId): Promise<VersionInfo[]> {
  assertReadableConceptId(id);
  return backend.versions(id);
}

export async function deleteDoc(
  backend: StorageBackend,
  id: ConceptId,
  options?: DeleteOptions,
): Promise<boolean> {
  assertSafeConceptId(id);
  const rel = pathFromConceptId(id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(`'${id}' is a reserved file (${rel}); reserved files cannot be deleted.`);
  }
  return backend.delete(id, options);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

async function readManyExisting(
  backend: StorageBackend,
  ids: ConceptId[],
  onMalformed?: (skip: SkippedDoc) => void,
): Promise<ReadResult[]> {
  try {
    return await backend.readMany(ids);
  } catch (err) {
    const malformed = err instanceof MalformedDocumentError;
    if (!isEnoent(err) && !(malformed && onMalformed)) throw err;
    const out: ReadResult[] = [];
    for (const id of ids) {
      try {
        out.push(await backend.read(id));
      } catch (candidate) {
        if (isEnoent(candidate)) continue;
        if (candidate instanceof MalformedDocumentError && onMalformed) {
          onMalformed({ id, reason: candidate.detail });
          continue;
        }
        throw candidate;
      }
    }
    return out;
  }
}

async function scanMatching(
  backend: StorageBackend,
  filter: QueryFilter,
  onSkip?: (skip: SkippedDoc) => void,
): Promise<ReadResult[]> {
  const ids = await backend.list(filter.prefix);
  const results: ReadResult[] = [];
  for (const result of await readManyExisting(backend, ids, onSkip)) {
    if (matchesFilter(result.doc, filter)) results.push(result);
  }
  results.sort((a, b) => a.doc.id.localeCompare(b.doc.id));
  return results;
}

export async function query(
  backend: StorageBackend,
  filter: QueryFilter = {},
  options: QueryOptions = {},
): Promise<OkfDocument[]> {
  return (await scanMatching(backend, filter, options.onSkip)).map((result) => result.doc);
}

export const list = query;

export async function queryHeads(
  backend: StorageBackend,
  filter: QueryFilter = {},
  options: QueryOptions = {},
): Promise<HeadResult[]> {
  if (backend.queryHeads) {
    const rows = (await backend.queryHeads(filter)).filter((row) => matchesFilter(row, filter));
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
  }
  return (await scanMatching(backend, filter, options.onSkip)).map(({ doc, version }) => ({
    id: doc.id,
    frontmatter: doc.frontmatter,
    version,
  }));
}

export function parseLinks(doc: OkfDocument): Link[] {
  return parseLinksFromDoc(doc);
}

function normalizeEdgeSelector(raw: string): string {
  if (raw.endsWith("/")) {
    const stem = raw.slice(0, -1);
    assertSafeConceptId(stem);
    return `${stem}/`;
  }
  assertSafeConceptId(raw);
  return raw;
}

function matchesEdgeSelector(value: ConceptId, selectors: string[] | undefined): boolean {
  if (selectors === undefined) return true;
  return selectors.some((selector) =>
    selector.endsWith("/") ? value.startsWith(selector) : value === selector,
  );
}

function toSelectorList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export async function queryEdges(backend: StorageBackend, filter: EdgeFilter = {}): Promise<Link[]> {
  const fromSelectors = toSelectorList(filter.from)?.map(normalizeEdgeSelector);
  const toSelectors = toSelectorList(filter.to)?.map(normalizeEdgeSelector);
  const edges: Link[] = [];
  for (const doc of await query(backend)) {
    for (const link of parseLinksFromDoc(doc)) {
      if (!matchesEdgeSelector(link.from, fromSelectors)) continue;
      if (!matchesEdgeSelector(link.to, toSelectors)) continue;
      if (filter.text !== undefined && link.text !== filter.text) continue;
      edges.push(link);
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.text.localeCompare(b.text));
  return edges;
}

export async function backlinks(backend: StorageBackend, target: ConceptId): Promise<Link[]> {
  if (target.endsWith("/")) return [];
  return queryEdges(backend, { to: target });
}

export async function readBlob(backend: StorageBackend, key: BlobKey): Promise<ReadBlobResult | null> {
  return backend.readBlob(key);
}

export async function writeBlob(
  backend: StorageBackend,
  key: BlobKey,
  bytes: Uint8Array,
  contentType?: string,
  options?: WriteOptions,
): Promise<Version> {
  return backend.writeBlob(key, bytes, contentType, options);
}

export async function existsBlob(backend: StorageBackend, key: BlobKey): Promise<boolean> {
  return backend.existsBlob(key);
}

export async function listBlobs(backend: StorageBackend, prefix?: string): Promise<BlobKey[]> {
  return backend.listBlobs(prefix);
}

export async function deleteBlob(
  backend: StorageBackend,
  key: BlobKey,
  options?: DeleteOptions,
): Promise<boolean> {
  return backend.deleteBlob(key, options);
}
