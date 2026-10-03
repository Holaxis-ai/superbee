/** Browser-safe, storage-free query predicate shared by every head-projection consumer. */
import type { ConceptId, Frontmatter, QueryFilter, SourceIdentity } from "./types.js";

/**
 * THE canonical {@link QueryFilter} predicate — every facet (`prefix`, `type`, `tags`, `fields`,
 * `sources`),
 * ANDed. Kept in a storage-free module so both Node consumers and the browser View bridge can use
 * the same scalar/array/string-coercion semantics without importing the filesystem-backed engine.
 */
export function matchesFilter(
  doc: { id: ConceptId; frontmatter: Frontmatter },
  filter: QueryFilter,
): boolean {
  if (filter.prefix && !doc.id.startsWith(filter.prefix)) return false;
  if (filter.type && doc.frontmatter.type !== filter.type) return false;
  if (filter.tags && filter.tags.length > 0) {
    const tags = Array.isArray(doc.frontmatter.tags) ? doc.frontmatter.tags : [];
    if (!filter.tags.every((tag) => tags.includes(tag))) return false;
  }
  if (filter.fields) {
    const frontmatter = doc.frontmatter as Record<string, unknown>;
    for (const [key, expected] of Object.entries(filter.fields)) {
      const raw = frontmatter[key];
      const actual =
        raw === undefined || raw === null
          ? []
          : (Array.isArray(raw) ? raw : [raw]).map((value) => String(value));
      if (!actual.includes(expected)) return false;
    }
  }
  if (filter.sources && (filter.sources.resource !== undefined || filter.sources.id !== undefined)) {
    if (!hasSourceIdentity(doc.frontmatter.sources, filter.sources)) return false;
  }
  return true;
}

/** THE `sources[]` identity predicate for one entry; see {@link SourceIdentity} for the rule. */
export function matchesSourceIdentity(entry: unknown, identity: SourceIdentity): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const row = entry as Record<string, unknown>;
  for (const key of ["resource", "id"] as const) {
    const expected = identity[key];
    if (expected === undefined) continue;
    if (!Object.hasOwn(row, key) || typeof row[key] !== "string" || row[key] !== expected) return false;
  }
  return true;
}

/** True when a frontmatter `sources` value is a list holding an entry with this identity. */
export function hasSourceIdentity(sources: unknown, identity: SourceIdentity): boolean {
  return Array.isArray(sources) && sources.some((entry) => matchesSourceIdentity(entry, identity));
}
