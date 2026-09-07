/**
 * Legacy bundle-shaped core API.
 *
 * Portable semantics live in `engine.ts` and receive a backend explicitly. This adapter preserves
 * the historical `{ root, backend? }` signatures and filesystem fallback used by Node consumers.
 */

import path from "node:path";

import { FilesystemBackend } from "./backend.js";
import * as engine from "./engine.js";
import { InvalidInputError } from "./errors.js";
import { stringifyWithData } from "./frontmatter.js";
import { GENERATED_INDEX_MARKER } from "./index-marker.js";
import { VersionConflict } from "./versioning.js";
import type {
  BlobKey,
  Bundle,
  ConceptId,
  DeleteOptions,
  EdgeFilter,
  HeadResult,
  InitBundleOptions,
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

export { matchesFilter } from "./query-filter.js";
export type { QueryOptions, SkippedDoc, WriteResult } from "./engine.js";

/** Resolve the backend a legacy bundle operation should use. */
export function backendFor(bundle: Bundle): StorageBackend {
  return bundle.backend ?? new FilesystemBackend(bundle.root);
}

export async function readBundleOkfVersion(bundle: Bundle): Promise<string | undefined> {
  return engine.readBundleOkfVersion(backendFor(bundle));
}

export const SUPPORTED_OKF_AUTHORING_VERSIONS = ["0.1", "0.2"] as const;
export const DEFAULT_OKF_AUTHORING_VERSION = "0.2";

export function resolveOkfAuthoringVersion(requested?: string): string {
  const version = requested ?? DEFAULT_OKF_AUTHORING_VERSION;
  if (!(SUPPORTED_OKF_AUTHORING_VERSIONS as readonly string[]).includes(version)) {
    throw new InvalidInputError(
      `Unsupported OKF authoring version '${version}'. This build can author ${SUPPORTED_OKF_AUTHORING_VERSIONS.join(" and ")}; ` +
        "bundles declaring other versions can still be read or transported.",
    );
  }
  return version;
}

/** Initialize or open a filesystem-backed bundle. */
export async function initBundle(root: string, options: InitBundleOptions = {}): Promise<Bundle> {
  const okfVersion = resolveOkfAuthoringVersion(options.okfVersion);
  const resolved = path.resolve(root);
  const backend = new FilesystemBackend(resolved);
  if (options.expectNew || (await backend.readReserved("", "index.md")) === null) {
    const name = path.basename(resolved);
    const body = `${GENERATED_INDEX_MARKER}\n# ${name}\n\nAn Open Knowledge Format bundle.\n`;
    try {
      await backend.writeReserved("", "index.md", stringifyWithData({ okf_version: okfVersion }, body), {
        expectedVersion: null,
      });
    } catch (err) {
      if (options.expectNew || !(err instanceof VersionConflict)) throw err;
    }
  }
  return { root: resolved };
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
