/**
 * The retired `Page` kind name and `bridge` access-field spelling, for the `legacyNaming` section of
 * the bundle health report. The runtime no longer recognizes either name: Page-typed documents do
 * not register, and a bridge-only document resolves to `access: none`. Legacy folder locations
 * remain valid.
 *
 * These literals cannot come from the live grammar in `page.ts`: diagnostics must recognize stock
 * the runtime deliberately rejects, and a retired name must never track a live export. This module
 * imports nothing; `legacy-constants-tripwire.test.ts` in the CLI pins its literals equal to
 * core's legacy prefixes and to the recipe lifecycle's retired name by assertion.
 */

/** The retired legacy kind name, frozen as a historical fact. */
export const LEGACY_PAGE_TYPE_NAME = "Page";

/**
 * True when this frontmatter declares the legacy kind name: `type` exactly `"Page"`, the same exact
 * match core's grammar applies (`isPageTypeName`). No trimming: a value that reaches a consumer with
 * surrounding whitespace was deliberately quoted and was never a registration.
 */
export function isLegacyPageDoc(frontmatter: Record<string, unknown>): boolean {
  return frontmatter["type"] === LEGACY_PAGE_TYPE_NAME;
}

/**
 * True when a View-kind document (current `View` or legacy `Page` spelling) carries its own legacy
 * `bridge` field. `bridge` is only the View kind's legacy capability spelling, so a document of any
 * other type carrying it is ordinary data and is never flagged.
 */
export function hasLegacyBridgeField(frontmatter: Record<string, unknown>): boolean {
  const viewKind = frontmatter["type"] === LEGACY_PAGE_TYPE_NAME || frontmatter["type"] === "View";
  return viewKind && Object.hasOwn(frontmatter, "bridge");
}

/** True when this frontmatter is a Convention governing exactly the retired `Page` name. */
export function isLegacyPageConvention(frontmatter: Record<string, unknown>): boolean {
  return frontmatter["type"] === "Convention" && frontmatter["governs"] === LEGACY_PAGE_TYPE_NAME;
}

/** The legacy id prefixes, frozen as historical facts (they mirror the legacy locations core still accepts). */
export const LEGACY_PAGE_REGISTRY_PREFIX = "pages-registry/";
export const LEGACY_PAGE_BLOB_PREFIX = "pages/";

/**
 * Store-aware classifiers: a registry document is legacy only under `pages-registry/` in the
 * document store, an entry only under `pages/` in the blob store. A concept document at `pages/x`
 * is not a legacy item. A `true` here is reported as information, never acted on.
 */
export function isLegacyRegistryDocId(id: string): boolean {
  return id.startsWith(LEGACY_PAGE_REGISTRY_PREFIX);
}

/** See {@link isLegacyRegistryDocId}: the blob-store half. */
export function isLegacyEntryBlobKey(key: string): boolean {
  return key.startsWith(LEGACY_PAGE_BLOB_PREFIX);
}
