/**
 * Versioning + attribution primitives shared by every {@link StorageBackend}.
 *
 * These make the seam's "hardest case" (content-addressed versions, compare-and-swap
 * writes, actor attribution) implementable uniformly across adapters:
 *   - {@link contentVersion} defines the opaque {@link Version} token as a SHA-256 over
 *     the canonically serialized document, so identical content yields the same token
 *     REGARDLESS of backend. The filesystem adapter hashes the on-disk bytes; the
 *     in-memory adapter hashes the same serialization — an engine-written document
 *     therefore carries the same version token in either store.
 *   - {@link blobVersion} is the SAME idea for opaque blob bytes, but hashes the raw
 *     `Uint8Array` directly with no string/UTF-8 step — a doc-shaped hash would corrupt
 *     binary content, so blobs get their own primitive rather than reusing `contentVersion`
 *     or `versionOfBytes`.
 *   - {@link defaultActor} supplies a local identity when a write is unattributed.
 *   - {@link VersionConflict} is the typed error a compare-and-swap write throws when
 *     the caller's `expectedVersion` no longer matches the backend's current version.
 *
 * Nothing here touches the filesystem — hashing and attribution are backend-neutral,
 * which is precisely why the memory adapter can reuse them.
 */

import { createHash } from "node:crypto";

import { stringifyDoc } from "./frontmatter.js";
import type { OkfDocument, Version } from "./types.js";

export { VersionConflict, stripETagWrapper } from "./version-transport.js";

/** Lowercase hex SHA-256 of a UTF-8 string. The version tokens' underlying digest. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The content-addressed {@link Version} of a concept document: the SHA-256 of its
 * OKF-serialized bytes (`sha256:<hex>`). Deterministic and backend-independent — two
 * backends holding byte-identical serializations report the same version.
 */
export function contentVersion(doc: OkfDocument): Version {
  return `sha256:${sha256Hex(stringifyDoc(doc.frontmatter, doc.body ?? ""))}`;
}

/** The version of already-serialized document bytes (the filesystem adapter's on-disk form). */
export function versionOfBytes(raw: string): Version {
  return `sha256:${sha256Hex(raw)}`;
}

/**
 * The content-addressed {@link Version} of raw blob bytes: the SHA-256 of `bytes`
 * directly, with NO string/UTF-8 encoding step. This is deliberately a SEPARATE
 * primitive from {@link contentVersion} (doc-shaped, serializes frontmatter+body first)
 * and {@link versionOfBytes} (hashes a STRING as UTF-8) — routing binary blob content
 * through either would corrupt any byte sequence that is not valid UTF-8 (e.g. a lone
 * continuation byte decodes to U+FFFD before hashing), silently breaking the
 * byte-identical round-trip a blob promises. Every {@link StorageBackend}'s blob
 * methods must hash bytes through THIS function so the token is identical regardless
 * of adapter, exactly as {@link contentVersion} is for documents.
 */
export function blobVersion(bytes: Uint8Array): Version {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A local identity for unattributed writes: `$USER`/`$USERNAME`/`$LOGNAME`, else `"local"`. */
export function defaultActor(): string {
  return (
    process.env.USER?.trim() ||
    process.env.USERNAME?.trim() ||
    process.env.LOGNAME?.trim() ||
    "local"
  );
}
