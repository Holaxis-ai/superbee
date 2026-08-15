/** Browser-side parsing for a usable registered bundle View. */

import {
  parseRegistration,
  resolveDeclaredAccess,
  type BridgeCapability,
  type PageTypeName,
} from "@superbee/core/page";
import { meaningfulChangeTimeValue } from "@superbee/core/meaningful-change-time";
import { mutationActorFromFrontmatter } from "@superbee/core/mutation-attribution";

export {
  declaredAccessValue,
  isAnyEntryKey,
  isAnyRegistryId,
  isPageEntryKey,
  isPageRegistryId,
  isPageTypeName,
  isViewEntryKey,
  isViewRegistryId,
  PAGE_TYPE_NAMES,
  parseRegistration,
  resolveBridgeCapability,
  resolveDeclaredAccess,
  type BridgeCapability,
  type PageRegistration,
  type PageTypeName,
} from "@superbee/core/page";

export interface RegisteredPage {
  id: string;
  entry: string;
  bridge: BridgeCapability;
  /** The accepted kind name that matched — exactly `View` (the legacy `Page` name no longer registers). */
  type: PageTypeName;
  title: string;
  description?: string;
  actor?: string;
  timestamp?: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Parse a usable registered View without exposing document contents or executable bytes. Validity is decided ENTIRELY by core's {@link parseRegistration} — the one predicate the server's mint/serve allowlist shares — so this surface can never accept a doc the server rejects (or vice versa). */
export function parseRegisteredPage(
  id: unknown,
  frontmatter: Record<string, unknown>,
): RegisteredPage | null {
  const registration = parseRegistration(id, frontmatter);
  if (!registration) return null;
  return {
    id: registration.id,
    entry: registration.entry,
    bridge: resolveDeclaredAccess(frontmatter),
    type: registration.type,
    title: stringValue(frontmatter.title) ?? registration.id,
    description: stringValue(frontmatter.description),
    actor: mutationActorFromFrontmatter(frontmatter),
    timestamp: stringValue(meaningfulChangeTimeValue(frontmatter)),
  };
}
