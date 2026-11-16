// Shared typed-edge vocabulary derivation: flattens a loaded `KindRegistry`'s per-kind `links`
// declarations into one `link-type text -> declaring kind(s)` index. Consumed by link findings
// (`link-findings.ts`, the write-time lint every surface renders) and `status` (bundle-wide
// `link_type_violations` sweep),
// and by recipe evolution's link-type addition check, so every consumer shares ONE derivation
// instead of each carrying its own copy (one registry, no parallel logic).
import { parseQualifiedKindTarget } from "./qualified-links.js";
import type { KindRegistry } from "./kinds.js";

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
 * declares, or none. A label declared by another source Kind imposes no constraint.
 */
function declarationFor(declared: readonly LinkTypeDeclaration[], sourceType: string): LinkTypeDeclaration | undefined {
  return declared.find((d) => d.governs === sourceType);
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
  if (!matched) return null;
  return parseQualifiedKindTarget(matched.target) === null ? null : matched;
}

/**
 * A LOCAL edge whose source Kind declares its text: the declaration it violates when the
 * resolved target is another kind, else null. `targetType` undefined means the target has no
 * document, so no target check applies; an empty string is an untyped target. The caller
 * checks {@link localEdgeQualifiedDeclaration} first; this compares kinds only.
 */
export function localEdgeViolation(
  declared: readonly LinkTypeDeclaration[] | undefined,
  sourceType: string,
  targetType: string | undefined,
): LinkTypeDeclaration | null {
  if (!declared || declared.length === 0) return null;
  const matched = declarationFor(declared, sourceType);
  if (!matched) return null;
  const targetOk = targetType === undefined || targetType === matched.target;
  return targetOk ? null : matched;
}

/**
 * A qualified edge (`okf://<alias>/...`) whose source Kind declares its text: the declaration it violates
 * when the target is local or names another alias, else null. The target's
 * kind is checked only when the caller supplies the type of an admitted resolved document.
 * Omitting actualTargetType preserves metadata-only lint; an empty type is a known mismatch.
 */
export function qualifiedEdgeViolation(
  declared: readonly LinkTypeDeclaration[] | undefined,
  sourceType: string,
  alias: string,
  actualTargetType?: string,
): LinkTypeDeclaration | null {
  if (!declared || declared.length === 0) return null;
  const matched = declarationFor(declared, sourceType);
  if (!matched) return null;
  const target = parseQualifiedKindTarget(matched.target);
  const targetOk = target !== null && target.alias === alias &&
    (actualTargetType === undefined || actualTargetType === target.kind);
  return targetOk ? null : matched;
}
