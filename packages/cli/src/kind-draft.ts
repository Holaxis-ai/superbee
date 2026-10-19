// Compatibility surface; inference and authoring policy live in core.
export {
  ENUM_MIN_INSTANCES, ENUM_MIN_DISTINCT, ENUM_MAX_DISTINCT, SECTION_PROMOTION_FLOOR,
  kindDeclaresAnything, conventionSlugForType, collectInstanceStats,
  draftPromotions, warningsAfterApply, draftPlanToken,
} from "@superbee/core/kind-authoring";
export type { DraftInstanceStats, DraftPromotion } from "@superbee/core/kind-authoring";

import { inferKindCandidate as inferCore } from "@superbee/core/kind-authoring";
import type { DraftInstanceStats } from "@superbee/core/kind-authoring";
import type { OkfDocument } from "@superbee/core";
/** Compatibility provenance wording stays with the CLI; inference itself is core-owned. */
export function inferKindCandidate(type: string, instances: readonly OkfDocument[], stats?: DraftInstanceStats) {
  const count = stats?.count ?? instances.length;
  return inferCore(type, instances, stats, `Drafted by 'kind draft' from ${count} existing instance${count === 1 ? "" : "s"}.`);
}
