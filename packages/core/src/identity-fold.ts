/**
 * The pure identity fold the filesystem adapter locks and compares path segments by. Kept apart
 * from `filesystem-identity.ts` (which needs Node) so storage-neutral planners can predict which
 * ids a case- or normalization-insensitive filesystem would treat as one.
 */

/**
 * NFKD, then Unicode FULL case folding applied as lower-upper-lower (locale-independent). A plain
 * lower-case fold misses the pairs a case-insensitive host equates through full case mapping
 * (ß/ss, ẞ/SS, final sigma ς/σ, iota-subscript ᾈ/ἀι and its family): two such spellings would get
 * different keys, both first-creation writers would realize ABSENT, and the second rename would
 * silently replace the first document. The round trip through upper case expands every such
 * pair to a common form, so the fold is a superset of every supported host's equivalence;
 * over-folding (dotless ı with i) only adds serialization, never removes exclusion.
 */
export function foldSegment(segment: string): string {
  return segment.normalize("NFKD").toLowerCase().toUpperCase().toLowerCase();
}

/** {@link foldSegment} applied to every `/`-separated segment of a bundle-relative path. */
export function foldPath(rel: string): string {
  return rel.split("/").map(foldSegment).join("/");
}
