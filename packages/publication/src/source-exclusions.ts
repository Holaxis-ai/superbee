import { PublicationError } from "./errors.js";

/** Source metadata sufficient for publication exposure checks; document bodies are not read. */
export interface PublicationSourceInventory {
  readonly documents: readonly { readonly id: string; readonly frontmatter: { readonly type?: unknown } }[];
  readonly reserved: readonly { readonly dir: string; readonly name: string }[];
  readonly blobs: readonly { readonly key: string }[];
}

export interface PublicationSourceExclusions {
  /** Excluded first directory segments, never root document names. */
  readonly directories?: readonly string[];
  /** Excluded document types, using the source engine's string coercion and list semantics. */
  readonly types?: readonly string[];
}

const fold = (value: string) => value.normalize("NFKC").toLowerCase();
const kind = (value: unknown) => fold(String(value)).trim().replace(/\s+/g, " ");

/**
 * Refuse an entire publication source containing excluded paths or types. This is an explicit
 * caller exposure policy, not authorization or redaction. Normalization accounts for equivalent
 * filesystem spellings; nested type lists are checked fail-closed as well as engine coercion.
 */
export function assertPublicationSourceExclusions(source: PublicationSourceInventory, exclusions: PublicationSourceExclusions): void {
  const directories = new Set((exclusions.directories ?? []).map(fold));
  const types = new Set((exclusions.types ?? []).map(kind));
  if ([...directories].some((directory) => !directory || directory.includes("/")) || types.has("")) {
    throw new PublicationError("INVALID_BUNDLE", "publication source exclusions are invalid");
  }
  const excludedPath = (path: string) => {
    const slash = path.indexOf("/");
    return slash > 0 && directories.has(fold(path.slice(0, slash)));
  };
  const excludedType = (type: unknown) => type !== undefined && type !== null &&
    (types.has(kind(type)) || (Array.isArray(type) && type.flat(Infinity).some((value) => types.has(kind(value)))));
  const count = source.documents.filter((document) => excludedPath(document.id) || excludedType(document.frontmatter.type)).length +
    source.reserved.filter((file) => excludedPath(`${file.dir}/${file.name}`)).length +
    source.blobs.filter((blob) => excludedPath(blob.key)).length;
  if (count > 0) throw new PublicationError("INVALID_BUNDLE", "the publication source contains excluded content", { details: { excludedEntries: count } });
}
