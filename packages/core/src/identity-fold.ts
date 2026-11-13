/**
 * The per-segment form of {@link foldPath} that the filesystem adapter locks and compares path
 * segments by. Kept apart from `filesystem-identity.ts` (which needs Node) so storage-neutral
 * planners can predict which ids a case- or normalization-insensitive filesystem would treat as one.
 */
import { foldPath } from "./path-fold.js";

/**
 * {@link foldPath}, in its decomposed (NFD) spelling. NFD maps each canonical spelling to exactly
 * one decomposed spelling, so two segments get one key exactly when `foldPath` joins them; the
 * fold stays at least as wide as every supported filesystem, which a lock key needs: two
 * spellings a filesystem joins but the key separates would let both first-creation writers
 * realize ABSENT, and the second rename would silently replace the first document. Earlier
 * builds digest the same decomposed spelling, so a process still running one agrees on the key
 * for every name without compatibility characters.
 */
export function foldSegment(segment: string): string {
  return foldPath(segment).normalize("NFD");
}
