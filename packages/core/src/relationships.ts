import { compareCodePoints } from "./code-point-order.js";
import { compareCodeUnits } from "./code-unit-order.js";
import type { ConceptId, Link, Version } from "./types.js";
import { versionOfBytes } from "./versioning.js";

/** Derived index generation. Advance when parsing or grouping changes the stored occurrences. */
export const RELATIONSHIP_PARSER_VERSION = "links/v2";

export interface RelationshipPosition {
  direction: "incoming" | "outgoing";
  documentId: ConceptId;
  labelKey: Version;
}

/** A label may be bounded for presentation. Use labelKey from the full authored label to seek. */
export type IndexedRelationshipPage =
  | { status: "uninstalled" | "pending" | "not_found" }
  | { status: "ready"; rows: (RelationshipPosition & { label: string; title: string | null })[]; more: boolean };

/**
 * Page the relationships of a document in an already selected bundle. Exclude self-links and
 * absent endpoints. Return one row per direction, neighbor and full label, ordered by
 * compareRelationshipPositions, starting strictly after the supplied position. The adapter
 * reports missing or incomplete index state before returning any partial rows.
 */
export type RelationshipPageReader = (
  documentId: ConceptId,
  limit: number,
  after?: RelationshipPosition,
) => Promise<IndexedRelationshipPage>;

/** Match UTF-8 binary ordering for canonical document IDs, including supplementary characters. */
export function compareRelationshipPositions(a: RelationshipPosition, b: RelationshipPosition): number {
  return compareCodeUnits(a.direction, b.direction) ||
    compareCodePoints(a.documentId, b.documentId) ||
    compareCodeUnits(a.labelKey, b.labelKey);
}

interface RelationshipOccurrenceGroup {
  target: ConceptId;
  label: string;
  labelKey: Version;
  occurrences: [ordinal: number, href: string][];
}

/** Group one document's local parser output while keeping each authored occurrence for a graph read. */
export function groupRelationshipOccurrences(
  links: readonly Pick<Link, "to" | "text" | "href">[],
): RelationshipOccurrenceGroup[] {
  const groups = new Map<string, RelationshipOccurrenceGroup>();
  for (const [ordinal, { to, text, href }] of links.entries()) {
    const key = JSON.stringify([to, text]);
    const group = groups.get(key) ?? { target: to, label: text, labelKey: versionOfBytes(text), occurrences: [] };
    groups.set(key, group);
    group.occurrences.push([ordinal, href]);
  }
  return [...groups.values()];
}
