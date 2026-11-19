/**
 * The one answer to "which data in a bundle is Superbee's own?". A bundle holds people's documents
 * and Superbee's own records side by side; {@link OWNED_LOCATIONS} is the only list of the latter.
 * Every document belongs to exactly one {@link BundleSection}, answered by {@link sectionOf}.
 *
 * Each entry names where a kind of record lives (an exact id or a folder prefix) and its marker
 * type. A record is Superbee's when it sits at its location AND carries its marker, so a person's
 * `docs/bundle` of another type, or a non-Convention under `conventions/`, stays a document. Only
 * a View (or retired Page) type claims its section wherever it appears: a misplaced View is a
 * broken registration, not a person's document. Anything no entry claims is a document: a miss may
 * show something, but it never hides a person's content.
 *
 * Two older questions read the same entries:
 *
 *   - {@link isGraphDefinitionDocument}: a missing inbound link is intended, so `status` never
 *     calls the document an orphan.
 *   - {@link isSystemDocument}: no bundle Kind governs the document, so writing one never suggests
 *     a missing or misspelled Kind.
 *
 * Where a question reaches past an entry's location, the entry says so in `typeReach`.
 *
 * The format rule: existing locations are grandfathered; any NEW kind of Superbee-owned data lives
 * under {@link SUPERBEE_RESERVED_ROOT_PREFIX}, which one entry already covers. A test walks core's
 * exported location and marker constants and fails on any that no entry covers.
 *
 * This module stays small and browser-safe: entries are plain, serializable data, so another
 * runtime (a database filter, for one) can render the same rule and test that it agrees. Large
 * owners (connectors, document transfer) take their constants from here and re-export them; small
 * owners are imported. The Site entry spells `site-manifest`'s constants as literals, pinned by a
 * test: that module's typings ship alone in the publication package, and it builds a TextEncoder
 * when loaded, which the global-free recipe bundles must not pull in.
 */
import { LEGACY_PAGE_TYPE_NAME } from "./bundle-health/legacy-page.js";
import { CONVENTION_TYPE, CONVENTIONS_PREFIX } from "./convention-record.js";
import { BUNDLE_NAME_DOC_ID, BUNDLE_NAME_DOC_TYPE, DEPENDENCIES_DOC_ID, DEPENDENCIES_DOC_TYPE } from "./dependencies.js";
import { PAGE_ENTRY_PREFIX, PAGE_REGISTRY_PREFIX, PAGE_TYPE_NAMES, VIEW_ENTRY_PREFIX, VIEW_REGISTRY_PREFIX } from "./page.js";
import type { ConceptId, Frontmatter } from "./types.js";

/** The marker type of a Connector declaration; re-exported by `connectors`. */
export const CONNECTOR_TYPE = "Connector";
/** Where Connector declarations live; re-exported by `connectors`. */
export const CONNECTORS_PREFIX = "connectors/";
/** The `type` of the record each document transfer writes; re-exported by `document-transfer`. */
export const PROMOTION_TYPE = "Promotion";
/** Where document transfer writes its records; re-exported by `document-transfer`. */
export const PROMOTIONS_PREFIX = "promotions/";
/** The marker type of an authoring reference a recipe installs. */
export const REFERENCE_TYPE = "Reference";
/** Where recipes install authoring references. */
export const REFERENCES_PREFIX = "references/";
/** Recipe sources, in a bundle that publishes recipes. */
export const RECIPES_PREFIX = "recipes/";
/**
 * The reserved root for every NEW kind of Superbee-owned data. Nothing lives here yet. A leading
 * underscore keeps it apart from folders people name (`superbee/` is a plausible folder of notes
 * about Superbee); a leading dot would hide it from the filesystem walk, so it could hold no
 * documents.
 */
export const SUPERBEE_RESERVED_ROOT_PREFIX = "_superbee/";

/** An OKF standard type. It is a person's document; no bundle Kind governs it. */
const ATTESTED_COMPUTATION_TYPE = "Attested Computation";

/**
 * Where a document belongs. `documents` is people's content; `conventions` and `views` are the
 * bundle's Kind declarations and View registrations; `superbee` is Superbee's other own records.
 */
export type BundleSection = "documents" | "conventions" | "views" | "superbee";

/** Every section, in display order. */
export const BUNDLE_SECTIONS: readonly BundleSection[] = Object.freeze(["documents", "conventions", "views", "superbee"]);

/**
 * One kind of Superbee-owned record. Plain data with no functions, so it serializes as-is.
 *
 * - `id` or `prefix` (exactly one, or neither for a type-only entry): where the record lives.
 *   Exact, case-sensitive; a prefix ends with `/`.
 * - `type`: the marker type the record must carry there. Omitted means any document at the
 *   location is the record.
 * - `section`: the section a matching record belongs to.
 * - `blobPrefix`: a blob folder that holds this kind's files (View pages), if any.
 * - `typeReach`: how far the marker type reaches past the location, each step including the ones
 *   before it. `"kinds"`: a document of that type anywhere is never governed by a bundle Kind.
 *   `"links"`: it is never an orphan either. `"section"`: it belongs to this entry's section
 *   wherever it lives. Omitted: the type means nothing outside the location.
 */
export interface OwnedLocation {
  readonly name: string;
  readonly section: BundleSection;
  readonly id?: string;
  readonly prefix?: string;
  readonly type?: string;
  readonly blobPrefix?: string;
  readonly typeReach?: TypeReach;
}

/** How far an entry's marker type reaches past its location; see {@link OwnedLocation}. */
export type TypeReach = "kinds" | "links" | "section";

const REACH_ORDER: readonly TypeReach[] = ["kinds", "links", "section"];

const entry = (value: OwnedLocation): OwnedLocation => Object.freeze(value);

/**
 * Superbee's own records, first match wins. The only list: every surface that separates people's
 * documents from Superbee's own reads this, or a rendering of it checked to agree.
 */
export const OWNED_LOCATIONS: readonly OwnedLocation[] = Object.freeze([
  entry({ name: "convention", section: "conventions", prefix: CONVENTIONS_PREFIX, type: CONVENTION_TYPE, typeReach: "links" }),
  entry({ name: "view", section: "views", prefix: VIEW_REGISTRY_PREFIX, type: PAGE_TYPE_NAMES[0], blobPrefix: VIEW_ENTRY_PREFIX, typeReach: "section" }),
  entry({ name: "legacy-view-location", section: "views", prefix: PAGE_REGISTRY_PREFIX, type: PAGE_TYPE_NAMES[0], blobPrefix: PAGE_ENTRY_PREFIX }),
  entry({ name: "legacy-page", section: "views", prefix: PAGE_REGISTRY_PREFIX, type: LEGACY_PAGE_TYPE_NAME, typeReach: "section" }),
  entry({ name: "connector", section: "superbee", prefix: CONNECTORS_PREFIX, type: CONNECTOR_TYPE, typeReach: "kinds" }),
  entry({ name: "site", section: "superbee", prefix: "sites/", type: "Site", typeReach: "kinds" }),
  entry({ name: "promotion", section: "superbee", prefix: PROMOTIONS_PREFIX, type: PROMOTION_TYPE, typeReach: "kinds" }),
  // A recipe's authoring guides sit with its definitions; a Reference anywhere else is a person's document.
  entry({ name: "reference", section: "conventions", prefix: REFERENCES_PREFIX, type: REFERENCE_TYPE }),
  entry({ name: "recipe-source", section: "superbee", prefix: RECIPES_PREFIX }),
  entry({ name: "bundle-name", section: "superbee", id: BUNDLE_NAME_DOC_ID, type: BUNDLE_NAME_DOC_TYPE }),
  entry({ name: "bundle-dependencies", section: "superbee", id: DEPENDENCIES_DOC_ID, type: DEPENDENCIES_DOC_TYPE }),
  entry({ name: "reserved-root", section: "superbee", prefix: SUPERBEE_RESERVED_ROOT_PREFIX }),
  // Not Superbee's data: listed only because no bundle Kind governs this OKF standard type.
  entry({ name: "attested-computation", section: "documents", type: ATTESTED_COMPUTATION_TYPE, typeReach: "kinds" }),
]);

/**
 * The top-level folders that hold only Superbee's own files, so an ordinary blob write never
 * changes them: the first segment of every entry's folder and blob folder. An entry at an exact id
 * (`docs/bundle`) claims no folder.
 */
export const OWNED_BLOB_ROOTS: readonly string[] = Object.freeze([...new Set(OWNED_LOCATIONS.flatMap((owned) =>
  [owned.prefix, owned.blobPrefix].flatMap((prefix) => prefix === undefined ? [] : [prefix.split("/")[0]!])))]);

type DocumentIdentity = { id: ConceptId; frontmatter: Frontmatter };

function typeOf(doc: DocumentIdentity): string | undefined {
  return typeof doc.frontmatter.type === "string" ? doc.frontmatter.type : undefined;
}

/** True when the document sits at the entry's location and carries its marker. Type-only entries have no location. */
function atLocation(owned: OwnedLocation, doc: DocumentIdentity): boolean {
  const placed = owned.id !== undefined ? doc.id === owned.id : owned.prefix !== undefined && doc.id.startsWith(owned.prefix);
  return placed && (owned.type === undefined || typeOf(doc) === owned.type);
}

/** True when the entry's marker type reaches the document wherever it lives, at least as far as `reach`. */
function reaches(owned: OwnedLocation, doc: DocumentIdentity, reach: TypeReach): boolean {
  return owned.typeReach !== undefined && owned.type === typeOf(doc) &&
    REACH_ORDER.indexOf(owned.typeReach) >= REACH_ORDER.indexOf(reach);
}

function claimedAs(doc: DocumentIdentity, reach: TypeReach): OwnedLocation | undefined {
  return OWNED_LOCATIONS.find((owned) => atLocation(owned, doc) || reaches(owned, doc, reach));
}

/**
 * The entry that places a document in its section, or undefined for a person's document. Its
 * `name` tells kinds apart inside one section (a Convention from a Reference, say).
 */
export function ownedLocationOf(doc: DocumentIdentity): OwnedLocation | undefined {
  const owned = claimedAs(doc, "section");
  return owned?.section === "documents" ? undefined : owned;
}

/** The one section a document belongs to; anything no entry claims is `documents`. */
export function sectionOf(doc: DocumentIdentity): BundleSection {
  return ownedLocationOf(doc)?.section ?? "documents";
}

/** A document whose missing inbound link is intended: any owned record at its location, or a type that reaches links. */
export function isGraphDefinitionDocument(doc: DocumentIdentity): boolean {
  return claimedAs(doc, "links") !== undefined;
}

/** A document no bundle Kind governs: a graph definition, or a type reserved from Kinds. */
export function isSystemDocument(doc: DocumentIdentity): boolean {
  return claimedAs(doc, "kinds") !== undefined;
}
