import { parseSiteManifestDoc, SITE_TYPE, SITES_PREFIX, type SiteManifestError, type SiteManifestParseResult } from "@superbee/core/site-manifest";
import type { PublicationSnapshotV1 } from "./types.js";

/** Resolve only declarations and references in the frozen publication. This never resolves code. */
export function readPublicationSiteManifest(
  snapshot: Pick<PublicationSnapshotV1, "documents" | "views" | "blobs">,
  site: string,
): SiteManifestParseResult {
  const declarations = snapshot.documents.filter(doc => doc.frontmatter.type === SITE_TYPE);
  if (declarations.length !== 1 || declarations[0]!.id !== `${SITES_PREFIX}${site}`)
    return { ok: false, errors: [{ code: "SITE_MANIFEST_INVALID", path: "/id", message: "the publication requires exactly one Site at sites/<site>" }] };
  const parsed = parseSiteManifestDoc(declarations[0]!);
  if (!parsed.ok) return parsed;
  const { manifest } = parsed;
  const views = new Set(snapshot.views.map(view => view.id));
  const documents = new Set(snapshot.documents.map(doc => doc.id));
  const blobs = new Set(snapshot.blobs.map(blob => blob.key));
  const errors: SiteManifestError[] = [];
  const fail = (path: string, message: string): void => { errors.push({ code: "SITE_MANIFEST_INVALID", path, message }); };
  if (manifest.views.some(id => !views.has(id))) fail("/views", "every declared View must be registered in this publication");
  if (manifest.landing !== undefined && !documents.has(manifest.landing)) fail("/landing", "landing must name a document or View in this publication");
  if (manifest.landing !== undefined && views.has(manifest.landing) && !manifest.views.includes(manifest.landing)) fail("/landing", "a landing View must be declared by this Site");
  if (manifest.brand?.logo !== undefined && !blobs.has(manifest.brand.logo)) fail("/brand/logo", "the logo must be a blob in this publication");
  if (manifest.brand?.fonts?.some(key => !blobs.has(key))) fail("/brand/fonts", "every font must be a blob in this publication");
  return errors.length ? { ok: false, errors } : parsed;
}
