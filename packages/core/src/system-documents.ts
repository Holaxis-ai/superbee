/**
 * The one answer to "is this a document Superbee itself defines?", as opposed to a concept
 * instance a bundle Kind would govern. Two questions share it:
 *
 *   - {@link isGraphDefinitionDocument}: documents that define the bundle's operating model or
 *     identity. Their lack of inbound links is intentional, so `status` never calls them orphans.
 *   - {@link isSystemDocument}: those, plus the other document types Superbee or OKF owns. No
 *     bundle Kind governs them, so writing one never suggests a missing or misspelled Kind.
 *
 * Literal type names below are pinned to their owning constants by tests; importing those owners
 * here would pull large modules into this small one.
 */
import { isLegacyPageDoc } from "./bundle-health/legacy-page.js";
import { BUNDLE_NAME_DOC_ID, BUNDLE_NAME_DOC_TYPE, DEPENDENCIES_DOC_ID, DEPENDENCIES_DOC_TYPE } from "./dependencies.js";
import { CONVENTION_TYPE } from "./kinds.js";
import { isPageTypeName } from "./page.js";
import type { ConceptId, Frontmatter } from "./types.js";

/** Document types Superbee or OKF owns that are not graph definitions. */
const OWNED_INSTANCE_TYPES: ReadonlySet<string> = new Set([
  "Connector",
  "Site",
  "Promotion",
  // An OKF standard type, validated by `okf-standard-fields.ts`.
  "Attested Computation",
]);

type DocumentIdentity = { id: ConceptId; frontmatter: Frontmatter };

function typeOf(doc: DocumentIdentity): string {
  return typeof doc.frontmatter.type === "string" ? doc.frontmatter.type : "";
}

/** A document that defines the bundle's operating model or identity rather than being a concept. */
export function isGraphDefinitionDocument(doc: DocumentIdentity): boolean {
  const type = typeOf(doc);
  return type === CONVENTION_TYPE ||
    isPageTypeName(type) ||
    isLegacyPageDoc(doc.frontmatter) ||
    (type === "Reference" && doc.id.startsWith("references/")) ||
    (type === BUNDLE_NAME_DOC_TYPE && doc.id === BUNDLE_NAME_DOC_ID) ||
    (type === DEPENDENCIES_DOC_TYPE && doc.id === DEPENDENCIES_DOC_ID);
}

/** A graph definition, or a document of another type Superbee or OKF owns. */
export function isSystemDocument(doc: DocumentIdentity): boolean {
  return isGraphDefinitionDocument(doc) || OWNED_INSTANCE_TYPES.has(typeOf(doc));
}

/** @internal The literal owned type names, for the pinning test. */
export const OWNED_INSTANCE_TYPE_NAMES: readonly string[] = [...OWNED_INSTANCE_TYPES];
