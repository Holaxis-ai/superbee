/** Portable Site declaration grammar. Parsing grants no build, install or publication authority. */
import { assertSafeBlobKey, assertSafeConceptId, nonCanonicalDocumentId } from "./paths.js";
import { isJsonData } from "./json-data.js";
import { isOkfStandardField } from "./okf-standard-fields.js";
import { isManagedDocumentMetadataField } from "./managed-document-metadata.js";

export const SITE_TYPE = "Site";
export const SITES_PREFIX = "sites/";
/** One site label leaves room for its workspace label in a combined DNS name. */
export const SITE_LABEL = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const isSiteLabel = (value: unknown): value is string =>
  typeof value === "string" && SITE_LABEL.test(value) && !value.includes("--");
export const SITE_DOCUMENT_KEYS = ["type", "title", "description", "presentation", "landing", "views", "audience", "capabilities", "options", "brand"] as const;

export type SitePresentationReference =
  | { readonly kind: "package"; readonly name: string; readonly version: string }
  | { readonly kind: "repository"; readonly repository: string };
export interface SiteManifest {
  readonly id: string;
  readonly site: string;
  readonly title: string;
  readonly description?: string;
  readonly presentation: SitePresentationReference;
  readonly landing?: string;
  readonly views: readonly string[];
  readonly audience: "restricted";
  readonly capabilities: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
  readonly brand?: { readonly logo?: string; readonly fonts?: readonly string[] };
}
export interface SiteManifestError {
  readonly code: "SITE_MANIFEST_INVALID";
  readonly path: string;
  readonly message: string;
}
export type SiteManifestParseResult = { readonly ok: true; readonly manifest: SiteManifest }
  | { readonly ok: false; readonly errors: readonly SiteManifestError[] };

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const encoder = new TextEncoder();
function presentationReference(raw: unknown): SitePresentationReference | undefined {
  if (typeof raw !== "string" || raw.length > 512) return undefined;
  if (raw.startsWith("repo:")) {
    const repository = raw.slice(5);
    return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repository) && !repository.endsWith(".git")
      ? { kind: "repository", repository } : undefined;
  }
  const at = raw.lastIndexOf("@");
  if (at < 1) return undefined;
  const name = raw.slice(0, at), version = raw.slice(at + 1), match = exactVersion.exec(version);
  if (name.length > 214 || !packageName.test(name) || !match ||
    !match.slice(1, 4).every(part => Number.isSafeInteger(Number(part))) ||
    match[4]?.split(".").some(part => /^\d+$/.test(part) && (part.length > 1 && part.startsWith("0") || !Number.isSafeInteger(Number(part))))) return undefined;
  return { kind: "package", name, version };
}
const concept = (raw: unknown): raw is string => {
  if (typeof raw !== "string") return false;
  try { assertSafeConceptId(raw); return nonCanonicalDocumentId(raw) === null; } catch { return false; }
};
const blob = (raw: unknown): raw is string => {
  if (typeof raw !== "string") return false;
  try { assertSafeBlobKey(raw); return true; } catch { return false; }
};

/** Standard OKF and managed metadata survive on the document; only Site fields enter this value.
 * Presentation owners validate option semantics. Builders separately admit trusted resolved code. */
export function parseSiteManifestDoc(doc: { readonly id: string; readonly frontmatter: Readonly<Record<string, unknown>> }): SiteManifestParseResult {
  const errors: SiteManifestError[] = [];
  const fail = (path: string, message: string): void => { errors.push({ code: "SITE_MANIFEST_INVALID", path, message }); };
  const fm = record(doc?.frontmatter) ? doc.frontmatter : {};
  const site = typeof doc?.id === "string" && doc.id.startsWith(SITES_PREFIX) ? doc.id.slice(SITES_PREFIX.length) : "";
  if (!isSiteLabel(site)) fail("/id", "a Site lives at sites/<site>, using one site label");
  if (fm.type !== SITE_TYPE) fail("/type", "type must be Site");
  if (Object.keys(fm).some(key => !(SITE_DOCUMENT_KEYS as readonly string[]).includes(key) && !isOkfStandardField(key) && !isManagedDocumentMetadataField(key)))
    fail("", "unrecognized Site fields");
  if (typeof fm.title !== "string" || fm.title.trim() === "" || encoder.encode(fm.title).byteLength > 512)
    fail("/title", "title must be a nonempty string of at most 512 bytes");
  if (fm.description !== undefined && (typeof fm.description !== "string" || encoder.encode(fm.description).byteLength > 8192))
    fail("/description", "description must be a string of at most 8192 bytes");
  const presentation = presentationReference(fm.presentation);
  if (!presentation) fail("/presentation", "presentation must name an exact npm version or repo:owner/name");
  if (fm.audience !== "restricted") fail("/audience", "only the restricted audience is supported");
  const list = (raw: unknown, path: string, maximum: number, valid: (v: unknown) => v is string): string[] => {
    if (!Array.isArray(raw) || raw.length > maximum || !raw.every(valid) || new Set(raw).size !== raw.length) {
      fail(path, "expected a bounded list of unique valid references"); return [];
    }
    return [...raw];
  };
  const views = list(fm.views, "/views", 64, concept);
  const capability = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(v);
  const capabilities = list(fm.capabilities ?? [], "/capabilities", 16, capability);
  if (fm.landing !== undefined && !concept(fm.landing)) fail("/landing", "landing must be a canonical document or View id");
  const options = fm.options ?? {};
  if (!record(options) || !isJsonData(options) || encoder.encode(JSON.stringify(options)).byteLength > 16384)
    fail("/options", "options must be JSON data of at most 16384 bytes");
  let brand: SiteManifest["brand"];
  if (fm.brand !== undefined) {
    if (!record(fm.brand) || Object.keys(fm.brand).some(key => key !== "logo" && key !== "fonts")) fail("/brand", "brand may only name a logo and fonts");
    else {
      if (fm.brand.logo !== undefined && !blob(fm.brand.logo)) fail("/brand/logo", "logo must be a bundle blob reference");
      const fonts = fm.brand.fonts === undefined ? undefined : list(fm.brand.fonts, "/brand/fonts", 16, blob);
      brand = { ...(typeof fm.brand.logo === "string" ? { logo: fm.brand.logo } : {}), ...(fonts ? { fonts } : {}) };
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: {
    id: doc.id, site, title: fm.title as string, presentation: presentation!, audience: "restricted", views, capabilities,
    options: JSON.parse(JSON.stringify(options)) as Record<string, unknown>,
    ...(fm.description === undefined ? {} : { description: fm.description as string }),
    ...(fm.landing === undefined ? {} : { landing: fm.landing as string }), ...(brand ? { brand } : {}),
  } };
}
