// ── Legacy-alias awareness (plans/rename-page-kind-to-view, Option C+) ────────────────────────
// A renamed recipe keeps its id/version but renames its artifact ids (views-registry//views/ over
// the legacy pages-registry//pages/). Idempotency here is per-artifact expect-absent CAS, so
// REAPPLYING the renamed recipe onto a bundle that installed the legacy edition would otherwise
// create a complete SECOND set — two identical launcher cards once that bundle is migrated in
// place (migration keeps legacy LOCATIONS; only names change). The legacy install SATISFIES the
// requirement: before creating an artifact, probe its legacy-alias counterpart, derived from
// CORE's legacy prefix constants, and skip creation when the counterpart exists, reporting
// `legacy_present` in the receipt. General by construction: any recipe whose artifacts ride the
// renamed prefixes benefits; for every other recipe each probe derives null and nothing changes.
import { PAGE_ENTRY_PREFIX, PAGE_REGISTRY_PREFIX, VIEW_ENTRY_PREFIX, VIEW_REGISTRY_PREFIX } from "../page.js";
import type { ConceptId } from "../types.js";

export function legacyRegistryAlias(id: ConceptId): ConceptId | null {
  return id.startsWith(VIEW_REGISTRY_PREFIX)
    ? `${PAGE_REGISTRY_PREFIX}${id.slice(VIEW_REGISTRY_PREFIX.length)}`
    : null;
}

export function legacyEntryAlias(key: string): string | null {
  return key.startsWith(VIEW_ENTRY_PREFIX)
    ? `${PAGE_ENTRY_PREFIX}${key.slice(VIEW_ENTRY_PREFIX.length)}`
    : null;
}
