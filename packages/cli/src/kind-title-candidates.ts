import type { KindRegistry } from "@superbee/core";

const MAX_CANDIDATES = 20;

/** Discovery only: a display title never resolves a document type or widens a query. */
export function kindTitleCandidates(registry: KindRegistry, requested: string) {
  if (registry.kinds.has(requested) || requested.includes("/")) return undefined;
  const matches = [...registry.kinds.values()]
    .filter((kind) => kind.governs.includes("/") && kind.title === requested)
    .sort((a, b) => a.governs < b.governs ? -1 : a.governs > b.governs ? 1 : 0);
  if (matches.length === 0) return undefined;
  return {
    requested,
    total: matches.length,
    shown: Math.min(matches.length, MAX_CANDIDATES),
    candidates: matches.slice(0, MAX_CANDIDATES).map((kind) => ({
      governs: kind.governs,
      title: kind.title,
      ...(kind.path ? { path: kind.path } : {}),
    })),
  };
}
