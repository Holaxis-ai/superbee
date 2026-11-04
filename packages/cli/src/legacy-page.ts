// The CLI's authoring hint for the retired `Page` kind name, which the runtime no longer
// registers. The literal and its predicate live in `@superbee/core/bundle-health`.
import { isLegacyPageDoc, LEGACY_PAGE_MIGRATION_HELP } from "@superbee/core/bundle-health";

export { isLegacyPageDoc };

/**
 * The ONE write-time hint line (receipt `hint` field, matching `init`/`sync`'s hint idiom).
 * Fired only by doc-authoring verbs on a SUCCESS receipt whose produced doc is Page-typed.
 */
export const LEGACY_PAGE_TYPE_HINT =
  "type 'Page' is the retired name for the 'View' kind and no longer registers; the ui launcher ignores Page-typed docs. " +
  `Author dashboards with --type View; ${LEGACY_PAGE_MIGRATION_HELP}`;
