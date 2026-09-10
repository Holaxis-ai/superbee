/**
 * Legacy bundle-shaped core API, Node entry.
 *
 * Portable semantics live in `engine.ts` and receive a backend explicitly; the bundle-shaped
 * `{ root, backend? }` wrappers live in `bundle-ops.ts` so they bundle for the browser. This
 * module owns what only a Node host can: the filesystem default for a bare `{ root }` and
 * on-disk bundle initialization. Loading it installs that default, which is why `index.ts`
 * imports it and why the package manifest marks it side-effectful.
 */

import path from "node:path";

import { FilesystemBackend } from "./backend.js";
import { setDefaultBackendFactory } from "./bundle-ops.js";
import { InvalidInputError } from "./errors.js";
import { stringifyWithData } from "./frontmatter.js";
import { GENERATED_INDEX_MARKER } from "./index-marker.js";
import { VersionConflict } from "./versioning.js";
import type { Bundle, InitBundleOptions } from "./types.js";

export { matchesFilter } from "./query-filter.js";
export type { QueryOptions, SkippedDoc, WriteResult } from "./engine.js";
export {
  backendFor,
  backlinks,
  deleteBlob,
  deleteDoc,
  docVersions,
  existsBlob,
  existsDoc,
  list,
  listBlobs,
  parseLinks,
  query,
  queryEdges,
  queryHeads,
  readBlob,
  readBundleOkfVersion,
  readDoc,
  readDocVersioned,
  writeBlob,
  writeDoc,
  writeDocVersioned,
  writeDocVersionedForEdition,
} from "./bundle-ops.js";

setDefaultBackendFactory((root) => new FilesystemBackend(root));

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
