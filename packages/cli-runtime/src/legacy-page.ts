// One home for the retired `Page` kind name and `bridge` access-field spelling. The runtime no
// longer recognizes either name: Page-typed docs do not register, and bridge-only docs resolve to
// `access: none`. Legacy folder locations remain valid, and the migration script rewrites the
// retired names in place.
//
// These literals cannot come from the live core grammar because diagnostics must recognize stock
// that the runtime deliberately rejects. Authoring commands use them for a non-blocking success
// hint; `status` uses them for the `legacy_naming` report. Keep the predicates centralized here so
// those surfaces cannot drift.

/** The retired legacy kind name, frozen as a historical fact (see the module comment). */
export const LEGACY_PAGE_TYPE_NAME = "Page";

/**
 * True when this frontmatter declares the LEGACY kind name: `type` exactly `"Page"` — the same
 * EXACT-match strictness core's grammar applies (`isPageTypeName`, `core/src/page.ts`). No
 * trimming: YAML plain scalars are whitespace-trimmed by the YAML parser itself, so a value that
 * reaches consumers with surrounding whitespace was deliberately QUOTED (`type: " Page "`) —
 * that was never a registration, and this predicate agrees it is not legacy.
 */
export function isLegacyPageDoc(frontmatter: Record<string, unknown>): boolean {
  return frontmatter["type"] === LEGACY_PAGE_TYPE_NAME;
}

/**
 * True when this frontmatter carries an OWN legacy `bridge` field on a View-kind doc (current
 * `View` or legacy `Page` spelling). Scope mirrors the migration script's `planDocChange`:
 * `bridge` is only the View kind's legacy capability spelling, not a reserved word — a doc of any
 * OTHER type carrying `bridge` is ordinary user data and is never flagged. Own-property-gated for
 * the same reason core's `declaredAccessValue` is.
 */
export function hasLegacyBridgeField(frontmatter: Record<string, unknown>): boolean {
  const viewKind = frontmatter["type"] === LEGACY_PAGE_TYPE_NAME || frontmatter["type"] === "View";
  return viewKind && Object.hasOwn(frontmatter, "bridge");
}

/**
 * True when this frontmatter IS a convention declaring the retired legacy kind name (`type:
 * Convention` governing exactly `Page` — the same exact match the migration script's
 * Page-convention deletion applies). A stale one is silent scaffolding: `kinds` advertises the
 * dead name and kind-aware authoring would produce runtime-ignored docs, so `status` flags it
 * loudly and `new` refuses to scaffold from the KNOWN SHIPPED form (see
 * {@link isKnownShippedLegacyPageConvention}).
 */
export function isLegacyPageConvention(frontmatter: Record<string, unknown>): boolean {
  return frontmatter["type"] === "Convention" && frontmatter["governs"] === LEGACY_PAGE_TYPE_NAME;
}

/**
 * The SHIPPED legacy Page-convention field signature(s), frozen as historical facts (the form
 * the pre-rename recipe editions installed; vendored byte-for-byte at
 * `test/fixtures/review-workflow-legacy-v1/conventions/page.md`, which pins these literals by
 * assertion). Deliberately frozen literals, not imports from live grammar — a LEGACY constant
 * can never change by definition. Matching is by the migration script's classification
 * DISCIPLINE (equality on the declared shape, timestamps/bodies ignored — bodies normalize on
 * engine writes): a convention that matches is the known shipped artifact and safe to refuse
 * scaffolding from; a genuinely-custom kind someone happened to name `Page` (a different
 * declared shape) is NOT matched and keeps behaving as their own kind.
 */
export const KNOWN_SHIPPED_LEGACY_PAGE_CONVENTION_FORMS = [
  {
    path: "pages-registry/",
    required: ["title", "entry", "bridge"],
    optional: ["description"],
    bridgeValues: ["none", "bundle-read"],
  },
] as const;

/** See {@link KNOWN_SHIPPED_LEGACY_PAGE_CONVENTION_FORMS} — the matcher, shaped for `loadKinds`' registry entries. */
export function isKnownShippedLegacyPageConvention(kind: {
  governs: string;
  path?: string;
  fields: { required: string[]; optional: string[]; values: Record<string, string[]> };
}): boolean {
  if (kind.governs !== LEGACY_PAGE_TYPE_NAME) return false;
  const sameList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  return KNOWN_SHIPPED_LEGACY_PAGE_CONVENTION_FORMS.some(
    (form) =>
      kind.path === form.path &&
      sameList(kind.fields.required, form.required) &&
      sameList(kind.fields.optional, form.optional) &&
      sameList(kind.fields.values["bridge"] ?? [], form.bridgeValues),
  );
}

/**
 * The legacy id prefixes, frozen as historical facts (they mirror the legacy-location values
 * core's grammar still accepts; a LEGACY constant can never change by definition, so this is
 * deliberately not an import from the live grammar — `legacy-constants-tripwire.test.ts` pins
 * the two sides equal by assertion instead).
 */
export const LEGACY_PAGE_REGISTRY_PREFIX = "pages-registry/";
export const LEGACY_PAGE_BLOB_PREFIX = "pages/";

/**
 * INFORMATIONAL, STORE-AWARE classifiers: registry docs live in the CONCEPT-DOC store and are
 * legacy only under `pages-registry/`; entries live in the BLOB store and are legacy only under
 * `pages/`. The split matters — an unrelated concept doc at e.g. `pages/manual` is NOT a legacy
 * item (the legacy doc prefix is the registry one), so a cross-store check would over-count.
 * Old-prefix LOCATIONS remain fully recognized — a `true` here is REPORTED (the `status`
 * legacy_naming section), never warned about or acted on.
 */
export function isLegacyRegistryDocId(id: string): boolean {
  return id.startsWith(LEGACY_PAGE_REGISTRY_PREFIX);
}

/** See {@link isLegacyRegistryDocId} — the blob-store half. */
export function isLegacyEntryBlobKey(key: string): boolean {
  return key.startsWith(LEGACY_PAGE_BLOB_PREFIX);
}

/**
 * The ONE write-time hint line (receipt `hint` field, matching `init`/`sync`'s hint idiom).
 * Fired only by doc-authoring verbs on a SUCCESS receipt whose produced doc is legacy-typed.
 */
export const LEGACY_PAGE_TYPE_HINT =
  "type 'Page' is the legacy name for the 'View' kind and is no longer registered — the ui launcher ignores Page-typed docs. Author dashboards with --type View; migrate existing legacy content in place with the repo's scripts/migrate-legacy-view-names.mjs.";
