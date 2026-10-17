// The CLI's authoring policy for the retired `Page` kind name. The runtime no longer recognizes it:
// Page-typed docs do not register, and bridge-only docs resolve to `access: none`. Legacy folder
// locations remain valid, and the migration script rewrites the retired names in place.
//
// The frozen literal and its predicate live with the health report that diagnoses them
// (`@superbee/core/bundle-health`, which `status` renders); authoring commands use them here for a
// non-blocking success hint, and `new` refuses to scaffold from the known shipped convention.
import { LEGACY_PAGE_TYPE_NAME, isLegacyPageDoc } from "@superbee/core/bundle-health";

export { LEGACY_PAGE_TYPE_NAME, isLegacyPageDoc };

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
 * The ONE write-time hint line (receipt `hint` field, matching `init`/`sync`'s hint idiom).
 * Fired only by doc-authoring verbs on a SUCCESS receipt whose produced doc is legacy-typed.
 */
export const LEGACY_PAGE_TYPE_HINT =
  "type 'Page' is the legacy name for the 'View' kind and is no longer registered — the ui launcher ignores Page-typed docs. Author dashboards with --type View; migrate existing legacy content in place with the repo's scripts/migrate-legacy-view-names.mjs.";
