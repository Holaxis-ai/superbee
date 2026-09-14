// Shared typed-edge vocabulary derivation for the graph-lints unit: flattens a loaded
// `KindRegistry`'s per-kind `links` declarations into one `link-type text -> declaring kind(s)`
// index. Consumed by BOTH `link.ts` (write-time lint on a just-added edge) and `status.ts`
// (bundle-wide `link_type_violations` sweep) — kept here so the two commands share ONE
// derivation instead of each carrying its own copy (one registry, no parallel logic).
import type { KindRegistry } from "@superbee/core";

/** One kind's declared `links` entry for a given link-type text: the declaring kind + its required target kind. */
export interface LinkTypeDeclaration {
  governs: string;
  target: string;
}

/**
 * Flatten every declared kind's `links` map into `link-type text -> declaring kind(s)`, across the
 * WHOLE registry (a bundle may reuse a link-type name for more than one kind — e.g. both a Roadmap
 * Item and an Epic declaring `contains: Task`). Pure derivation over an already-loaded registry, no
 * I/O.
 */
export function collectLinkDeclarations(registry: KindRegistry): Map<string, LinkTypeDeclaration[]> {
  const byText = new Map<string, LinkTypeDeclaration[]>();
  for (const kind of registry.kinds.values()) {
    if (!kind.links) continue;
    for (const [text, target] of Object.entries(kind.links)) {
      const list = byText.get(text) ?? [];
      list.push({ governs: kind.governs, target });
      byText.set(text, list);
    }
  }
  return byText;
}
