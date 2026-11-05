/**
 * Which external links become anchors. This file stays free of imports because `superbee/publication`
 * ships its declaration on its own, without the private renderer package or React types.
 *
 * - `"none"` keeps every external target as inert text. Absent and unknown values mean the same.
 * - `"https"` admits any `https:` URL with no userinfo.
 * - `{ hosts }` also requires the default port and an exact match on one listed bare host name.
 *
 * The page owner's code sets this. Never read it from a document, Kind, recipe, View manifest,
 * bundle record or tool argument. The one exception is a host's sealed room, whose host list comes
 * from content that host validated and sealed.
 */
export type ExternalLinkPolicy = "none" | "https" | { readonly hosts: readonly string[] };
