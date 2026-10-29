/** Portable declaration surface, with no filesystem capture or credential handling. */
export { parseSiteManifestDoc, isSiteLabel, SITE_LABEL, SITE_TYPE, SITES_PREFIX, SITE_DOCUMENT_KEYS } from "@superbee/core/site-manifest";
export type { SiteManifest, SiteManifestError, SiteManifestParseResult, SitePresentationReference } from "@superbee/core/site-manifest";
export { readPublicationSiteManifest } from "./site-manifest.js";
