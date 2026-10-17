// Shared typed-edge vocabulary derivation for the graph-lints unit: flattens a loaded
// `KindRegistry`'s per-kind `links` declarations into one `link-type text -> declaring kind(s)`
// index. Consumed by BOTH `link.ts` (write-time lint on a just-added edge) and `status.ts`
// (bundle-wide `link_type_violations` sweep) — kept here so the two commands share ONE
// derivation instead of each carrying its own copy (one registry, no parallel logic).
import { parseQualifiedKindTarget, type KindRegistry } from "@superbee/core";

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

/**
 * The declaration a typed edge from `sourceType` is checked against: the one its source kind
 * declares, else the first. Shared by the local and qualified checks so both pick the same one.
 */
function declarationFor(declared: readonly LinkTypeDeclaration[], sourceType: string): LinkTypeDeclaration {
  return declared.find((d) => d.governs === sourceType) ?? declared[0]!;
}

/**
 * A LOCAL edge under a qualified declaration (`links: {pours: "beers:Beer"}` and a link to a doc in
 * this bundle): the declaration it violates, else null. Qualified targets are parsed here, at use;
 * `KindConvention.links` stays raw strings.
 */
export function localEdgeQualifiedDeclaration(
  declared: readonly LinkTypeDeclaration[] | undefined,
  sourceType: string,
): LinkTypeDeclaration | null {
  if (!declared || declared.length === 0) return null;
  const matched = declarationFor(declared, sourceType);
  return parseQualifiedKindTarget(matched.target) === null ? null : matched;
}

/**
 * A qualified edge (`okf://<alias>/...`) whose text is a declared type: the declaration it violates
 * (wrong source kind, or a target that is local or names another alias), else null. The target's
 * kind in the other bundle is not checked.
 */
export function qualifiedEdgeViolation(
  declared: readonly LinkTypeDeclaration[] | undefined,
  sourceType: string,
  alias: string,
): LinkTypeDeclaration | null {
  if (!declared || declared.length === 0) return null;
  const matched = declarationFor(declared, sourceType);
  const sourceOk = declared.some((d) => d.governs === sourceType);
  const target = parseQualifiedKindTarget(matched.target);
  return sourceOk && target !== null && target.alias === alias ? null : matched;
}
