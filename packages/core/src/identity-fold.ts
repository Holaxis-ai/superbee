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
 * compatibility characters. For a segment with them the keys differ across such builds, and the
 * root mutation key, which every build that takes the root lock derives alike, is what excludes
 * their writers.
 */
export function foldSegment(segment: string): string {
  return foldPath(segment).normalize("NFD");
}
