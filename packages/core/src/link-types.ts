import {
  assertKindReference,
  assertKindAddress,
  assertQualifiedRecord,
  assertQualifiedRecordLocation,
  resolveQualifiedDocument,
  qualifiedFailure,
  referenceKey,
  kindAddressKey,
  type KindAddress,
  type KindReference,
} from "./qualified-kinds.js";
import { extractMarkdownLinks, resolveConceptId } from "./links.js";
import type { OkfDocument } from "./types.js";
// Shared typed-edge vocabulary derivation: flattens a loaded `KindRegistry`'s per-kind `links`
// declarations into one `link-type text -> declaring kind(s)` index. Consumed by the CLI's `link`
// (write-time lint on a just-added edge) and `status` (bundle-wide `link_type_violations` sweep),
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
export function collectLinkDeclarations(
  registry: KindRegistry,
): Map<string, LinkTypeDeclaration[]> {
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
function declarationFor(
  declared: readonly LinkTypeDeclaration[],
  sourceType: string,
): LinkTypeDeclaration {
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
  const sourceOk = declared.some((d) => d.governs === sourceType);
  const target = parseQualifiedKindTarget(matched.target);
  const targetOk =
    target !== null &&
    target.alias === alias &&
    (actualTargetType === undefined || actualTargetType === target.kind);
  return sourceOk && targetOk ? null : matched;
}

/** The qualified profile's closed declaration grammar shares the Convention parser's owner. */
export type QualifiedLinkMode =
  "recipe-source" | "local-source" | "local-authoring" | "materialized";
export type QualifiedLinkTarget =
  | { kind_id: string }
  | { ref: KindReference }
  | { selector: string }
  | { address: KindAddress };
export type QualifiedLinkDeclarations = Record<
  string,
  { targets: QualifiedLinkTarget[] }
>;
function linkObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseQualifiedLinkDeclarations(
  value: unknown,
  mode: QualifiedLinkMode,
): QualifiedLinkDeclarations {
  if (!linkObject(value)) qualifiedFailure("relationships must be a mapping");
  const declarations: QualifiedLinkDeclarations = Object.create(null);
  for (const [name, declaration] of Object.entries(value)) {
    if (
      !name ||
      name.trim() !== name ||
      !linkObject(declaration) ||
      Object.keys(declaration).join() !== "targets" ||
      !Array.isArray(declaration.targets) ||
      declaration.targets.length === 0 ||
      declaration.targets.length > 1000
    )
      qualifiedFailure(`invalid relationship '${name}' target set`);
    const targets = declaration.targets.map((target): QualifiedLinkTarget => {
      if (!linkObject(target) || Object.keys(target).length !== 1)
        qualifiedFailure(`invalid relationship '${name}' target`);
      if (
        mode === "recipe-source" &&
        typeof target.kind_id === "string" &&
        target.kind_id.length > 0
      )
        return { kind_id: target.kind_id };
      if (
        (mode === "local-source" || mode === "local-authoring") &&
        Object.hasOwn(target, "ref")
      ) {
        assertKindReference(target.ref);
        return { ref: target.ref };
      }
      if (
        mode === "local-authoring" &&
        typeof target.selector === "string" &&
        /^kind:[a-f0-9]{64}$/.test(target.selector)
      )
        return { selector: target.selector };
      if (mode === "materialized" && Object.hasOwn(target, "address")) {
        assertKindAddress(target.address);
        return { address: target.address };
      }
      return qualifiedFailure(
        `unsupported relationship '${name}' target form in ${mode}`,
      );
    });
    declarations[name] = { targets };
  }
  return declarations;
}

/** One immediate-edge check; target baseline validation never recursively follows target edges. */
export async function assertQualifiedRecordRelations(
  registry: KindRegistry,
  doc: OkfDocument,
  lookup: (id: string) => Promise<OkfDocument | undefined>,
): Promise<void> {
  assertQualifiedRecord(registry, doc);
  const kind = resolveQualifiedDocument(registry, doc)!;
  if (!kind.qualifiedLinks) return;
  const targets = new Map<string, OkfDocument>();
  for (const edge of extractMarkdownLinks(doc.body, { skipCode: true })) {
    const declaration = kind.qualifiedLinks[edge.text];
    if (!declaration) continue;
    const id = resolveConceptId(doc.id, edge.href, { strict: true });
    if (id === null)
      qualifiedFailure(
        `relationship '${edge.text}' has unsupported target '${edge.href}'`,
      );
    assertQualifiedRecordLocation(id);
    if (!targets.has(id)) {
      if (targets.size >= 1000)
        qualifiedFailure("relationship target count exceeds 1000");
      let target: OkfDocument | undefined;
      try {
        target = await lookup(id);
      } catch (error) {
        qualifiedFailure(
          `relationship '${edge.text}' target '${id}' is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!target || target.id !== id)
        qualifiedFailure(
          `relationship '${edge.text}' target '${id}' is missing or mismatched`,
        );
      assertQualifiedRecord(registry, target);
      targets.set(id, target);
    }
    const reference = targets.get(id)!.frontmatter.superbee_kind_ref;
    assertKindReference(reference);
    const accepted = declaration.targets.some((target) => {
      if (!("address" in target))
        return qualifiedFailure("unmaterialized relationship target");
      const expected = registry.qualified!.byAddress.get(
        kindAddressKey(target.address),
      );
      return (
        expected !== undefined &&
        referenceKey(expected.entry.ref) === referenceKey(reference)
      );
    });
    if (!accepted)
      qualifiedFailure(
        `relationship '${edge.text}' target '${id}' has the wrong exact Kind binding`,
      );
  }
}
