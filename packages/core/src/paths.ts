/**
 * Pure path helpers for OKF concept identity and reserved-file handling.
 *
 * A *Concept ID* is a bundle-relative path with the trailing `.md` removed
 * (`tables/users.md` -> `tables/users`); IDs use forward slashes. Two filenames
 * are RESERVED at any directory level — `index.md` (§6) and `log.md` (§7) — and
 * are NOT concept documents (they carry no `type` and are excluded from queries).
 *
 * Everything here is pure and dependency-free, hence directly unit-testable.
 */

import type { ConceptId } from "./types.js";
import { InvalidInputError } from "./errors.js";

/** The two OKF reserved filenames, valid at any directory level (§3.1). */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/** Keep locale ordering, but never let distinct spellings depend on insertion order. */
export function compareStorageKeys(a: string, b: string): number {
  const primary = a.localeCompare(b);
  if (primary !== 0 || a === b) return primary;
  const left = Array.from(a, (character) => character.codePointAt(0)!);
  const right = Array.from(b, (character) => character.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

/** Reject spellings that cannot remain the same key across storage and wire adapters. */
function assertPortablePath(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value) || /^[a-z]:/i.test(value)) {
    throw new InvalidInputError(`${label} must not contain controls or start with a drive prefix.`);
  }
  if (value.includes("\\") || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new InvalidInputError(`${label} must be canonical and bundle-relative.`);
  }
}

/** Runtime callers must obey the same finite reserved-name type as TypeScript callers. */
export function assertSafeReservedFilename(name: unknown): asserts name is typeof RESERVED_FILENAMES[number] {
  if (!(RESERVED_FILENAMES as readonly unknown[]).includes(name)) {
    throw new InvalidInputError("Reserved filename must be index.md or log.md.");
  }
}

/** Normalize any separators to forward slashes and collapse duplicate slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/**
 * True when the bundle-relative path's final segment is a reserved OKF filename
 * (`index.md` / `log.md`) at ANY directory level.
 */
export function isReservedFile(relPath: string): boolean {
  const base = toPosix(relPath).split("/").pop() ?? "";
  return (RESERVED_FILENAMES as readonly string[]).includes(base);
}

/**
 * Concept ID from a bundle-relative markdown file path: normalize separators,
 * drop a leading `./` or `/`, and strip the trailing `.md`.
 */
export function conceptIdFromPath(relPath: string): ConceptId {
  const norm = toPosix(relPath)
    .replace(/^\.?\//, "")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
  return norm.endsWith(".md") ? norm.slice(0, -3) : norm;
}

/**
 * Bundle-relative markdown file path for an ALREADY-CANONICAL concept ID.
 *
 * A concept ID is the file path with exactly its FINAL `.md` suffix removed. Therefore an
 * ordinary `x.md` file has id `x`, while a valid `x.md.md` file has id `x.md`. Do not strip a
 * suffix here: doing so aliases those two distinct concepts onto the same physical file. User
 * interfaces that accept file-like spellings normalize them through {@link conceptIdFromPath}
 * before entering the engine/storage seam.
 */
export function pathFromConceptId(id: ConceptId): string {
  assertSafeConceptId(id);
  return `${id}.md`;
}

/**
 * Guard the canonical concept-ID grammar before an id reaches storage. In addition to path
 * traversal / absolute escape, aliases that a filesystem would silently normalize (`./`, `//`,
 * `\\`, or an interior `.` segment) are rejected so every backend keys the SAME identity.
 * File-like user input is normalized before this boundary with {@link conceptIdFromPath}.
 */
export function assertSafeConceptId(id: ConceptId): void {
  if (typeof id !== "string" || id.trim() === "") {
    throw new InvalidInputError("Concept id must be a non-empty string.");
  }
  assertPortablePath(id, "Concept id");
  const segments = id.split("/");
  if (segments.slice(0, -1).some((seg) => seg.toLowerCase().endsWith(".md"))) {
    throw new InvalidInputError(
      `Concept id must not contain a non-final segment ending in '.md': '${id}' (it collides with a concept file at that path).`,
    );
  }
}

/**
 * Guard a blob key before it is joined onto the bundle root for a filesystem read or
 * write. Same traversal/absolute-escape shape as {@link assertSafeConceptId}, PLUS
 * three blob-specific rejections so the blob and concept-document namespaces stay
 * disjoint in both directions:
 *   - ANY segment ending in `.md`, checked CASE-INSENSITIVELY (`report.MD` would collide
 *     with `report.md` on a case-insensitive filesystem such as APFS, silently bypassing
 *     concept-doc CAS and getting ingested as a doc by the next bundle walk) — not just
 *     the FINAL segment: a key like `report.md/attachment.png` would otherwise pass (its
 *     final segment is `attachment.png`) while creating an on-disk DIRECTORY literally
 *     named `report.md`, which collides with — and blocks — any future concept doc write
 *     to id `report` (`pathFromConceptId("report")` targets that exact path as a FILE).
 *     This also covers the two reserved filenames (`index.md`/`log.md`), which always
 *     carry that extension, at any depth.
 *   - any dot-prefixed path segment (invisible to the concept walk by convention, and
 *     the exact shape `FilesystemBackend.atomicWrite`'s own temp files use — a blob key
 *     must never collide with that).
 *   - a trailing-slash / empty final segment (a blob key must name a file, not a dir).
 * Applies to EVERY blob operation — read and exists included, not just write — so a
 * probing `readBlob`/`existsBlob` can't be used to bypass the guard writes enforce.
 *
 * Note (raw-vs-normalized storage): like a {@link ConceptId}, the key's non-extension
 * segments are stored VERBATIM (case preserved, no other normalization) — this mirrors
 * the engine's pre-existing concept-id behavior (an id's casing/spelling is exactly what
 * the caller wrote) rather than introducing a NEW normalization rule just for blobs.
 */
export function assertSafeBlobKey(key: string): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new InvalidInputError("Blob key must be a non-empty string.");
  }
  assertPortablePath(key, "Blob key");
  const segments = key.split("/");
  if (segments.some((seg) => seg.startsWith("."))) {
    throw new InvalidInputError(`Blob key must not contain dot-prefixed segments: '${key}'.`);
  }
  if (segments.some((seg) => seg.toLowerCase().endsWith(".md"))) {
    throw new InvalidInputError(
      `Blob key '${key}' has a path segment ending in '.md' (checked case-insensitively, at ` +
        `any depth), which collides with the concept-document namespace — write it as a doc ` +
        `instead.`,
    );
  }
}

/**
 * Guard a reserved-file directory (the `dir` argument to `readReserved`/`writeReserved`,
 * where `""` denotes the bundle root) against path traversal / absolute escape before it
 * is joined onto the bundle root. Unlike {@link assertSafeConceptId}, an empty string IS
 * valid here (it means "the bundle root itself"). Other spellings must be canonical;
 * aliases are rejected rather than silently normalized.
 */
export function assertSafeReservedDir(dir: string): void {
  if (typeof dir !== "string") {
    throw new InvalidInputError("Reserved-file directory must be a string.");
  }
  if (dir !== "") assertPortablePath(dir, "Reserved-file directory");
}
