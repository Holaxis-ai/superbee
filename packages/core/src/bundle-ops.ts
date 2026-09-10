/**
 * Runtime-neutral bundle-shaped delegation.
 *
 * Every function here forwards a `{ root, backend? }` bundle to the portable engine and touches
 * no filesystem, so the document mutation path can bundle for the browser. The filesystem
 * default for a bare `{ root }` is installed by `bundle.ts` (the Node entry) through
 * {@link setDefaultBackendFactory}; a runtime that never loads it must supply `bundle.backend`.
 */

import * as engine from "./engine.js";
import { InvalidInputError } from "./errors.js";
import type {
  BlobKey,
  Bundle,
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

export type { QueryOptions, SkippedDoc, WriteResult } from "./engine.js";

/** Builds the backend a bare `{ root }` bundle resolves to in this runtime. */
export type DefaultBackendFactory = (root: string) => StorageBackend;

let defaultBackendFactory: DefaultBackendFactory | undefined;

/**
 * Install the runtime's default backend for bundles that carry only a root. The Node entry
 * registers the filesystem adapter; a browser host either registers its own store or always
 * passes `bundle.backend` explicitly.
 */
export function setDefaultBackendFactory(factory: DefaultBackendFactory | undefined): void {
  defaultBackendFactory = factory;
}

/** Resolve the backend a legacy bundle operation should use. */
export function backendFor(bundle: Bundle): StorageBackend {
  if (bundle.backend) return bundle.backend;
  if (defaultBackendFactory === undefined) {
    throw new InvalidInputError(
      `Bundle '${bundle.root}' has no backend and this runtime installs no default: ` +
        "pass bundle.backend explicitly or register one with setDefaultBackendFactory.",
    );
  }
  return defaultBackendFactory(bundle.root);
}

export async function readBundleOkfVersion(bundle: Bundle): Promise<string | undefined> {
  return engine.readBundleOkfVersion(backendFor(bundle));
}

export async function writeDocVersioned(
  bundle: Bundle,
  doc: OkfDocument,
  options?: WriteOptions,
): Promise<engine.WriteResult> {
  return engine.writeDocVersioned(backendFor(bundle), doc, options);
}

export async function writeDocVersionedForEdition(
  bundle: Bundle,
  doc: OkfDocument,
  okfVersion: string,
  options?: WriteOptions,
): Promise<engine.WriteResult> {
  return engine.writeDocVersionedForEdition(backendFor(bundle), doc, okfVersion, options);
}

export async function writeDoc(
  bundle: Bundle,
  doc: OkfDocument,
  options?: WriteOptions,
): Promise<OkfDocument> {
  return engine.writeDoc(backendFor(bundle), doc, options);
}

export async function readDocVersioned(bundle: Bundle, id: ConceptId): Promise<ReadResult> {
  return engine.readDocVersioned(backendFor(bundle), id);
}

export async function readDoc(bundle: Bundle, id: ConceptId): Promise<OkfDocument> {
  return engine.readDoc(backendFor(bundle), id);
}

export async function existsDoc(bundle: Bundle, id: ConceptId): Promise<boolean> {
  return engine.existsDoc(backendFor(bundle), id);
}

export async function docVersions(bundle: Bundle, id: ConceptId): Promise<VersionInfo[]> {
  return engine.docVersions(backendFor(bundle), id);
}

export async function deleteDoc(bundle: Bundle, id: ConceptId, options?: DeleteOptions): Promise<boolean> {
  return engine.deleteDoc(backendFor(bundle), id, options);
}

export async function query(
  bundle: Bundle,
  filter: QueryFilter = {},
  options: engine.QueryOptions = {},
): Promise<OkfDocument[]> {
  return engine.query(backendFor(bundle), filter, options);
}

export const list = query;

export async function queryHeads(
  bundle: Bundle,
  filter: QueryFilter = {},
  options: engine.QueryOptions = {},
): Promise<HeadResult[]> {
  return engine.queryHeads(backendFor(bundle), filter, options);
}

export function parseLinks(_bundle: Bundle, doc: OkfDocument): Link[] {
  return engine.parseLinks(doc);
}

export async function queryEdges(bundle: Bundle, filter: EdgeFilter = {}): Promise<Link[]> {
  return engine.queryEdges(backendFor(bundle), filter);
}

export async function backlinks(bundle: Bundle, target: ConceptId): Promise<Link[]> {
  return engine.backlinks(backendFor(bundle), target);
}

export async function readBlob(bundle: Bundle, key: BlobKey): Promise<ReadBlobResult | null> {
  return engine.readBlob(backendFor(bundle), key);
}

export async function writeBlob(
  bundle: Bundle,
  key: BlobKey,
  bytes: Uint8Array,
  contentType?: string,
  options?: WriteOptions,
): Promise<Version> {
  return engine.writeBlob(backendFor(bundle), key, bytes, contentType, options);
}

export async function existsBlob(bundle: Bundle, key: BlobKey): Promise<boolean> {
  return engine.existsBlob(backendFor(bundle), key);
}

export async function listBlobs(bundle: Bundle, prefix?: string): Promise<BlobKey[]> {
  return engine.listBlobs(backendFor(bundle), prefix);
}

export async function deleteBlob(bundle: Bundle, key: BlobKey, options?: DeleteOptions): Promise<boolean> {
  return engine.deleteBlob(backendFor(bundle), key, options);
}
