/**
 * The retired `Page` kind name. The runtime no longer recognizes it: Page-typed documents do not
 * register. The literal cannot come from the live grammar in `page.ts`, because a retired name must
 * never track a live export. This module imports nothing.
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
 * The recovery for retired `Page` content: the migration script exists only at this tag, and it
 * imports the built core of the same checkout, so it runs from a built checkout of the tag.
 */
export const LEGACY_PAGE_MIGRATION_SCRIPT_URL =
  "https://github.com/Holaxis-ai/superbee/blob/v0.4.3/scripts/migrate-legacy-view-names.mjs";

/** The remedy sentence shared by every surface that names the recovery. */
export const LEGACY_PAGE_MIGRATION_HELP =
  "to migrate existing content in place, check out tag v0.4.3, run `npm ci && npm run build` there, then run " +
  "`node scripts/migrate-legacy-view-names.mjs --dir <bundle-root>` from that checkout: " +
  LEGACY_PAGE_MIGRATION_SCRIPT_URL;
