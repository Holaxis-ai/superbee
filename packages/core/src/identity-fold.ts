/**
 * The per-segment form of {@link foldPath} that the filesystem adapter locks and compares path
 * segments by. Kept apart from `filesystem-identity.ts` (which needs Node) so storage-neutral
 * planners can predict which ids a case- or normalization-insensitive filesystem would treat as one.
 */
import { foldPath } from "./path-fold.js";

/**
 * {@link foldPath}, in its decomposed (NFD) spelling. NFD maps each canonical spelling to exactly
 * one decomposed spelling, so two segments get one key exactly when `foldPath` joins them. A lock
 * key should join every pair the filesystem joins: two spellings a filesystem joins but the key
 * separates take different locks, so the backend's exact-spelling checks are then the only thing
 * that refuses the second writer. The key covers case and canonical equivalence. It does not
 * cover the code points case-insensitive HFS+ ignores in a name (U+200C, U+200D, U+FEFF,
 * U+206A and their kind).
 *
 * A build that folded with NFKD produces the same segment key for every segment without
 * compatibility characters. The identity key also folds the bundle's absolute path, so a bundle
 * whose path holds a compatibility character (no-break space, `…`, `™`, `²`, halfwidth
 * katakana) gets different keys from such a build and this one; do not run both against it at
 * the same time.
 */
export function foldSegment(segment: string): string {
  return foldPath(segment).normalize("NFD");
}
