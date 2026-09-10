/**
 * Pure View registry/entry path grammar shared by every producer and consumer.
 *
 * `View` is the ONLY accepted kind name: the legacy `Page` spelling is no longer read
 * (the repo's `migrate-legacy-view-names` script renames legacy content in place). Registry ids
 * are concept ids under `views-registry/` (legacy `pages-registry/` LOCATIONS stay recognized;
 * relocation is a separate open decision); entries are opaque blob keys under
 * `views/` (legacy `pages/`). Both retain exact, case-preserving nested paths while
 * rejecting spellings that discovery or storage cannot safely round-trip. ONE segment
 * grammar, parameterized by prefix — never a parallel module per name.
 */

import { assertSafeBlobKey, assertSafeConceptId } from "./paths.js";
import { isContentVersion } from "./version-transport.js";

/** Legacy registry-id prefix — the LOCATION stays recognized (only the legacy kind NAME is retired). */
export const PAGE_REGISTRY_PREFIX = "pages-registry/";
/** Legacy blob-key prefix for View entries — the LOCATION stays recognized. */
export const PAGE_ENTRY_PREFIX = "pages/";
/** Current registry-id prefix for `type: View` docs. */
export const VIEW_REGISTRY_PREFIX = "views-registry/";
/** Current blob-key prefix for View entries. */
export const VIEW_ENTRY_PREFIX = "views/";

/**
 * The kind names the launcher/registry surfaces accept: exactly `View`. Exact, case-sensitive
 * match. The legacy `Page` name is deliberately NOT here — a Page-typed doc no longer registers
 * anywhere (the CLI's `status` legacy_naming finding is the loud diagnostic for leftover stock,
 * and `migrate-legacy-view-names` is the remedy).
 */
export const PAGE_TYPE_NAMES = ["View"] as const;
export type PageTypeName = (typeof PAGE_TYPE_NAMES)[number];

/**
 * The shell-enforced capability requested by a registered View. `bundle-propose` includes the
 * read surface but grants no direct write authority: it may only propose a narrow action for the
 * trusted shell and human to confirm. Unknown values fail closed to `none`.
 */
export type BridgeCapability = "none" | "bundle-read" | "bundle-propose";

/** One capability resolver shared by registry parsing and the loopback server's security gates. */
export function resolveBridgeCapability(value: unknown): BridgeCapability {
  return value === "bundle-read" || value === "bundle-propose" ? value : "none";
}

/**
 * THE one reader of the registry-doc capability FIELD: `access`, and ONLY `access`. The legacy
 * `bridge` spelling is no longer read — a doc declaring only `bridge` resolves to `undefined`
 * here and fails closed to `none` downstream (the `migrate-legacy-view-names` script renames
 * existing stock in place; the CLI's `status` legacy_naming finding flags leftover `bridge`
 * fields loudly).
 */
export function declaredAccessValue(frontmatter: Record<string, unknown>): unknown {
  // Own-property-gated: an INHERITED field (a crafted prototype, or a polluted
  // Object.prototype) must never grant capability — only a field the doc itself declares counts.
  return Object.hasOwn(frontmatter, "access") ? frontmatter.access : undefined;
}

/** Resolve a registry doc's declared capability: {@link declaredAccessValue} through the fail-closed {@link resolveBridgeCapability} — an absent or unrecognized `access` yields `none`. */
export function resolveDeclaredAccess(frontmatter: Record<string, unknown>): BridgeCapability {
  return resolveBridgeCapability(declaredAccessValue(frontmatter));
}

/** True iff `value` is exactly the accepted kind name (`View`). The legacy `Page` name is rejected. */
export function isPageTypeName(value: unknown): value is PageTypeName {
  return value === "View";
}

const PAGE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * `.md` (checked case-insensitively) is rejected on EVERY segment, not just the last: a mid-path
 * segment like `x.md` in `pages-registry/x.md/y` would create an on-disk DIRECTORY literally named
 * `x.md`, blocking a future concept-doc write to id `pages-registry/x` (the exact
 * doc/dir collision {@link assertSafeBlobKey} already documents on the entry-key side). ONE
 * shared check for both the registry-id and
 * entry-key grammars, so the two paths can't drift again the way they did before this fix (the
 * entry-key side already inherited this via `assertSafeBlobKey`; the registry-id side did not).
 */
function hasSafePageSegments(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix) || value.length === prefix.length) return false;
  if (value.startsWith("/") || /[\\%?#]/.test(value)) return false;
  const segments = value.slice(prefix.length).split("/");
  return segments.every(
    (segment) => !segment.startsWith(".") && PAGE_SEGMENT.test(segment) && !segment.toLowerCase().endsWith(".md"),
  );
}

function isRegistryIdUnder(id: unknown, prefix: string): id is string {
  if (typeof id !== "string" || !hasSafePageSegments(id, prefix)) {
    return false;
  }
  try {
    assertSafeConceptId(id);
    return true;
  } catch {
    return false;
  }
}

function isEntryKeyUnder(entry: unknown, prefix: string): entry is string {
  if (typeof entry !== "string" || !hasSafePageSegments(entry, prefix)) return false;
  try {
    assertSafeBlobKey(entry);
    return true;
  } catch {
    return false;
  }
}

/** Strict concept-id grammar for registry documents at the legacy LOCATION (`pages-registry/…`). Nested ids and ordinary dots are valid. */
export function isPageRegistryId(id: unknown): id is string {
  return isRegistryIdUnder(id, PAGE_REGISTRY_PREFIX);
}

/** Strict concept-id grammar for View registry documents (`views-registry/…`) — the SAME segment rules as {@link isPageRegistryId}. */
export function isViewRegistryId(id: unknown): id is string {
  return isRegistryIdUnder(id, VIEW_REGISTRY_PREFIX);
}

/** True iff `id` is a valid registry id under EITHER accepted prefix (`views-registry/` or legacy `pages-registry/`). */
export function isAnyRegistryId(id: unknown): id is string {
  return isPageRegistryId(id) || isViewRegistryId(id);
}

/** Strict blob-key grammar for executable View entries at the legacy LOCATION (`pages/…`). */
export function isPageEntryKey(entry: unknown): entry is string {
  return isEntryKeyUnder(entry, PAGE_ENTRY_PREFIX);
}

/** Strict blob-key grammar for executable View entries (`views/…`) — the SAME segment rules as {@link isPageEntryKey}. */
export function isViewEntryKey(entry: unknown): entry is string {
  return isEntryKeyUnder(entry, VIEW_ENTRY_PREFIX);
}

/** True iff `entry` is a valid entry key under EITHER accepted prefix (`views/` or legacy `pages/`). */
export function isAnyEntryKey(entry: unknown): entry is string {
  return isPageEntryKey(entry) || isViewEntryKey(entry);
}

/** True only for the content-addressed version tokens allowed to pin executable View bytes. */
export function isViewEntryVersion(value: unknown): value is string {
  return isContentVersion(value);
}

/** A complete, valid View registration — one identity, entry, and optional exact-byte pin. */
export interface PageRegistration {
  /** The registry doc's concept id (under an accepted registry prefix). */
  id: string;
  /** The accepted kind name the doc declares — exactly `View`. */
  type: PageTypeName;
  /** The declared executable entry blob key (under an accepted entry prefix). */
  entry: string;
  /** Optional exact blob-version pin. When present, every host must refuse other bytes. */
  entryVersion?: string;
}

/**
 * THE one registration predicate: a doc is a usable View registration iff its id satisfies
 * an accepted registry-id grammar ({@link isAnyRegistryId}), its `type` is exactly an accepted
 * kind name ({@link isPageTypeName}), AND its `entry` satisfies an accepted entry-key grammar
 * ({@link isAnyEntryKey}). An explicitly declared `entry_version` must be a canonical
 * content-addressed token. Returns the validated registration, or `null`.
 *
 * This is a SECURITY boundary shared by every surface that decides what counts as a registered
 * page — the launcher/`open-page` parse (ui `parseRegisteredPage`), the `ui` command's
 * nonce-mint allowlist, and its serve-time re-verification. All of them MUST consume this one
 * function: a doc any surface rejects must be un-mintable and un-servable everywhere, never
 * "rejected by the launcher but still served by the nonce route".
 */
export function parseRegistration(id: unknown, frontmatter: Record<string, unknown>): PageRegistration | null {
  if (!isAnyRegistryId(id) || !isPageTypeName(frontmatter.type) || !isAnyEntryKey(frontmatter.entry)) return null;
  const rawEntryVersion = Object.hasOwn(frontmatter, "entry_version")
    ? frontmatter.entry_version
    : undefined;
  if (
    rawEntryVersion !== undefined &&
    !isViewEntryVersion(rawEntryVersion)
  ) {
    return null;
  }
  return {
    id,
    type: frontmatter.type,
    entry: frontmatter.entry,
    ...(rawEntryVersion ? { entryVersion: rawEntryVersion } : {}),
  };
}
