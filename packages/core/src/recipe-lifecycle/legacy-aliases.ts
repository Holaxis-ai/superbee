// ── Legacy-alias awareness (plans/rename-page-kind-to-view, Option C+) ────────────────────────
// A renamed recipe keeps its id/version but renames its artifact ids (views-registry//views/ over
// the legacy pages-registry//pages/). Idempotency here is per-artifact expect-absent CAS, so
// REAPPLYING the renamed recipe onto a bundle that installed the legacy edition would otherwise
// create a complete SECOND set — two identical launcher cards once that bundle is migrated in
// place (migration keeps legacy LOCATIONS; only names change). The legacy install SATISFIES the
// requirement: before creating an artifact, probe its legacy-alias counterpart — the location
// half derived from CORE's legacy prefix constants, the retired kind name from the frozen literal
// below (post-removal it is deliberately absent from the live grammar) — and skip
// creation when the counterpart exists, reporting `legacy_present` in the receipt. An UNMIGRATED
// legacy install also satisfies the probe: its docs no longer register, but the remedy is the
// migration script (which fixes them in place, flagged loudly by `status`), never a duplicate
// install. General by construction: any recipe whose artifacts ride the renamed prefixes or
// govern the View kind benefits; for every other recipe each probe derives null and nothing
// changes.
import { query } from "../bundle-ops.js";
import { CONVENTIONS_PREFIX } from "../kinds.js";
import {
  PAGE_ENTRY_PREFIX,
  PAGE_REGISTRY_PREFIX,
  PAGE_TYPE_NAMES,
  VIEW_ENTRY_PREFIX,
  VIEW_REGISTRY_PREFIX,
} from "../page.js";
import type { Bundle, ConceptId, OkfDocument } from "../types.js";

/**
 * The retired legacy kind name, frozen as a historical fact. Internal to the recipe lifecycle and
 * not part of its public API; the CLI's diagnostics keep their own frozen copy, and
 * `legacy-constants-tripwire.test.ts` pins the two equal.
 */
export const RETIRED_PAGE_TYPE_NAME = "Page";

/** Core's one accepted kind name (`View`). */
export const [VIEW_KIND_NAME] = PAGE_TYPE_NAMES;

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

export function governsKind(doc: OkfDocument, kindName: string): boolean {
  const governs = doc.frontmatter["governs"];
  return typeof governs === "string" && governs.trim() === kindName;
}

/** The id of an existing convention doc governing the LEGACY kind name, or null. Called at most
 * once per apply, and only when the recipe carries a convention governing the current name. */
export async function findLegacyViewConvention(bundle: Bundle): Promise<ConceptId | null> {
  const conventions = await query(bundle, { prefix: CONVENTIONS_PREFIX, type: "Convention" });
  for (const doc of conventions) {
    if (governsKind(doc, RETIRED_PAGE_TYPE_NAME)) return doc.id;
  }
  return null;
}
