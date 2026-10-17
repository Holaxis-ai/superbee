// ── Legacy-alias awareness (plans/rename-page-kind-to-view, Option C+) ────────────────────────
// A renamed recipe keeps its id/version but renames its artifact ids (views-registry//views/ over
// the legacy pages-registry//pages/). Idempotency here is per-artifact expect-absent CAS, so
// REAPPLYING the renamed recipe onto a bundle that installed the legacy edition would otherwise
// create a complete SECOND set — two identical launcher cards once that bundle is migrated in
// place (migration keeps legacy LOCATIONS; only names change). The legacy install SATISFIES the
// requirement: before creating an artifact, probe its legacy-alias counterpart — the location
// half derived from CORE's legacy prefix constants, the retired kind name from legacy-page.ts's
// frozen literal (post-removal it is deliberately absent from the live grammar) — and skip
// creation when the counterpart exists, reporting `legacy_present` in the receipt. An UNMIGRATED
// legacy install also satisfies the probe: its docs no longer register, but the remedy is the
// migration script (which fixes them in place, flagged loudly by `status`), never a duplicate
// install. General by construction: any recipe whose artifacts ride the renamed prefixes or
// govern the View kind benefits; for every other recipe each probe derives null and nothing
// changes.

/** Core's one accepted kind name (`View`); the retired legacy name comes from legacy-page.ts. */
const [VIEW_KIND_NAME] = PAGE_TYPE_NAMES;
const LEGACY_VIEW_KIND_NAME = LEGACY_PAGE_TYPE_NAME;

function legacyRegistryAlias(id: ConceptId): ConceptId | null {
  return id.startsWith(VIEW_REGISTRY_PREFIX)
    ? `${PAGE_REGISTRY_PREFIX}${id.slice(VIEW_REGISTRY_PREFIX.length)}`
    : null;
}

function legacyEntryAlias(key: string): string | null {
  return key.startsWith(VIEW_ENTRY_PREFIX)
    ? `${PAGE_ENTRY_PREFIX}${key.slice(VIEW_ENTRY_PREFIX.length)}`
    : null;
}

function governsKind(doc: OkfDocument, kindName: string): boolean {
  const governs = doc.frontmatter["governs"];
  return typeof governs === "string" && governs.trim() === kindName;
}

/** The id of an existing convention doc governing the LEGACY kind name, or null. Called at most
 * once per apply, and only when the recipe carries a convention governing the current name. */
async function findLegacyViewConvention(bundle: Bundle): Promise<ConceptId | null> {
  const conventions = await query(bundle, { prefix: CONVENTIONS_PREFIX, type: "Convention" });
  for (const doc of conventions) {
    if (governsKind(doc, LEGACY_VIEW_KIND_NAME)) return doc.id;
  }
  return null;
}
