import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUNDLE_SECTIONS,
  OWNED_LOCATIONS,
  SUPERBEE_RESERVED_ROOT_PREFIX,
  isGraphDefinitionDocument,
  isSystemDocument,
  sectionOf,
  type OwnedLocation,
} from "../src/system-documents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = (id: string, type?: unknown) => ({ id, frontmatter: type === undefined ? {} : { type } as Record<string, unknown> });

test("sectionOf: location AND marker; anything unclaimed is a document", () => {
  const cases: Array<[string, unknown, string]> = [
    ["conventions/task", "Convention", "conventions"],
    ["conventions/notes", "Task", "documents"], // a person's document under conventions/
    ["notes/kind", "Convention", "documents"],
    ["views-registry/board", "View", "views"],
    ["views-registry/Not A Valid Name", "View", "views"], // malformed Views are not documents
    ["pages-registry/board", "View", "views"],
    ["pages-registry/old", "Page", "views"],
    ["views-registry/readme", "Task", "documents"],
    ["notes/misplaced", "View", "views"], // a View type claims its section anywhere
    ["notes/old", "Page", "views"],
    ["connectors/github", "Connector", "superbee"],
    ["connectors/notes", "Task", "documents"],
    ["sites/www", "Site", "superbee"],
    ["promotions/x-1", "Promotion", "superbee"],
    ["references/site-authoring", "Reference", "conventions"], // a recipe's guides sit with its definitions
    ["docs/authoring", "Reference", "documents"],
    ["recipes/site/manifest", "Recipe", "superbee"],
    ["recipes/site/notes", undefined, "superbee"],
    ["docs/bundle", "Bundle Name", "superbee"],
    ["docs/bundle", "Task", "documents"], // the bundle's name only under its marker
    ["docs/bundle", " Bundle Name", "documents"], // exact marker, as SQL compares it
    ["docs/dependencies", "Bundle Dependencies", "superbee"],
    ["docs/dependencies", "Note", "documents"],
    ["docs/bundle-notes", "Bundle Name", "documents"], // an id, not a prefix
    ["_superbee/anything/new", "Whatever", "superbee"],
    ["computations/c", "Attested Computation", "documents"],
    ["Conventions/task", "Convention", "documents"], // case-sensitive
    ["tasks/t", "Task", "documents"],
    ["tasks/t", 7, "documents"],
  ];
  for (const [id, type, section] of cases) assert.equal(sectionOf(doc(id, type)), section, `${id} ${String(type)}`);
});

test("isGraphDefinitionDocument and isSystemDocument keep their answers and read the same entries", () => {
  // Graph definitions before this change: unchanged.
  for (const [id, type] of [
    ["conventions/x", "Convention"], ["anywhere/x", "Convention"], ["views-registry/v", "View"], ["notes/v", "View"],
    ["notes/p", "Page"], ["references/r", "Reference"], ["docs/bundle", "Bundle Name"], ["docs/dependencies", "Bundle Dependencies"],
  ] as const) {
    assert.ok(isGraphDefinitionDocument(doc(id, type)) && isSystemDocument(doc(id, type)), `${id} ${type}`);
  }
  // Superbee's own records at their location are never orphans (they were before).
  for (const [id, type] of [["connectors/c", "Connector"], ["sites/s", "Site"], ["promotions/p", "Promotion"]] as const) {
    assert.ok(isGraphDefinitionDocument(doc(id, type)), id);
  }
  // Types reserved from Kinds anywhere, but ordinary documents outside their location.
  for (const [id, type] of [["notes/c", "Connector"], ["notes/s", "Site"], ["notes/p", "Promotion"], ["c/x", "Attested Computation"]] as const) {
    assert.ok(isSystemDocument(doc(id, type)) && !isGraphDefinitionDocument(doc(id, type)), `${id} ${type}`);
  }
  // Ordinary documents.
  for (const [id, type] of [["notes/r", "Reference"], ["docs/bundle", "Task"], ["tasks/t", "Task"], ["x", undefined]] as const) {
    assert.ok(!isSystemDocument(doc(id, type)) && !isGraphDefinitionDocument(doc(id, type)), `${id} ${String(type)}`);
  }
});

test("ownedLocationOf tells kinds apart inside one section", async () => {
  const { ownedLocationOf } = await import("../src/system-documents.js");
  assert.equal(ownedLocationOf(doc("conventions/task", "Convention"))?.name, "convention");
  assert.equal(ownedLocationOf(doc("references/guide", "Reference"))?.name, "reference");
  assert.equal(ownedLocationOf(doc("notes/x", "Task")), undefined);
  assert.equal(ownedLocationOf(doc("c/x", "Attested Computation")), undefined, "a type reserved from Kinds is still a person's document");
});

test("OWNED_BLOB_ROOTS: every owned folder and View blob folder, never a folder that only holds an owned id", async () => {
  const { OWNED_BLOB_ROOTS } = await import("../src/system-documents.js");
  const { isOrdinaryBlobKey } = await import("../src/blob-journal.js");
  assert.deepEqual([...OWNED_BLOB_ROOTS].sort(), [
    "_superbee", "connectors", "conventions", "pages", "pages-registry", "promotions", "recipes", "references", "sites", "views", "views-registry",
  ]);
  for (const key of ["connectors/x.json", "Sites/logo.png", "promotions/a.bin", "views/v.html", "_superbee/x.bin"]) assert.equal(isOrdinaryBlobKey(key), false, key);
  for (const key of ["docs/logo.png", "assets/site/logo.png", "superbee/x.bin"]) assert.equal(isOrdinaryBlobKey(key), true, key);
});

test("OWNED_LOCATIONS is plain, frozen, serializable data another runtime can render", () => {
  assert.ok(Object.isFrozen(OWNED_LOCATIONS));
  assert.deepEqual(JSON.parse(JSON.stringify(OWNED_LOCATIONS)), OWNED_LOCATIONS, "no functions or undefined-only fields");
  const names = new Set<string>();
  for (const owned of OWNED_LOCATIONS) {
    assert.ok(Object.isFrozen(owned), owned.name);
    assert.ok(!names.has(owned.name), `duplicate name ${owned.name}`);
    names.add(owned.name);
    assert.ok(BUNDLE_SECTIONS.includes(owned.section), owned.name);
    assert.ok(!(owned.id !== undefined && owned.prefix !== undefined), `${owned.name}: an id or a prefix, not both`);
    if (owned.prefix !== undefined) assert.ok(owned.prefix.endsWith("/") && owned.prefix.length > 1, owned.name);
    if (owned.id === undefined && owned.prefix === undefined) {
      assert.ok(owned.type !== undefined && owned.typeReach !== undefined, `${owned.name}: a type-only entry reserves its type`);
      assert.equal(owned.section, "documents", `${owned.name}: a type-only entry claims no section`);
    }
    for (const value of Object.values(owned)) assert.equal(typeof value, "string", owned.name);
  }
});

// ── The CI check: every exported location or marker constant is classified ─────────────────────

type Constants = Readonly<Record<string, string>>;

/** Constants that name no place a document lives, each with the reason. */
const NOT_A_BUNDLE_LOCATION: Readonly<Record<string, string>> = {
  ACTIVE_VIEW_CONTENT_TYPE: "a media type, not a document type",
  DEFAULT_BLOB_CONTENT_TYPE: "a media type, not a document type",
  DOCUMENT_REFRESH_TOKEN_PREFIX: "a transfer token prefix, not an id",
  QUALIFIED_HREF_PREFIX: "a link scheme, not an id",
  RESERVED_TOOL_PREFIX: "a Site tool-name prefix, not an id",
};

const LOCATION_CONSTANT = /_(PREFIX|DOC_ID|TYPE)$/;

/** Names of location or marker constants no entry covers and no exclusion explains. */
function unclassifiedConstants(constants: Constants, entries: readonly OwnedLocation[], excluded: Readonly<Record<string, string>>): string[] {
  return Object.entries(constants)
    .filter(([name]) => LOCATION_CONSTANT.test(name) && !Object.hasOwn(excluded, name))
    .filter(([name, value]) => name.endsWith("_TYPE")
      ? !entries.some((owned) => owned.type === value)
      : !entries.some((owned) => owned.id === value || [owned.prefix, owned.blobPrefix].some((prefix) => prefix !== undefined && value.startsWith(prefix))))
    .map(([name]) => name)
    .sort();
}

/**
 * The closed set of locations that predate the reserved root. A new kind of Superbee-owned data
 * lives under {@link SUPERBEE_RESERVED_ROOT_PREFIX}; this list does not grow.
 */
const GRANDFATHERED: Readonly<Record<string, string>> = {
  "convention": "conventions/",
  "view": "views-registry/",
  "legacy-view-location": "pages-registry/",
  "legacy-page": "pages-registry/",
  "connector": "connectors/",
  "site": "sites/",
  "promotion": "promotions/",
  "reference": "references/",
  "recipe-source": "recipes/",
  "bundle-name": "docs/bundle",
  "bundle-dependencies": "docs/dependencies",
  "attested-computation": "", // type-only
};

/** Entries that are neither under the reserved root nor a grandfathered location. */
function entriesOutsideReservedRoot(entries: readonly OwnedLocation[]): string[] {
  return entries
    .filter((owned) => {
      const where = owned.prefix ?? owned.id ?? "";
      if (where.startsWith(SUPERBEE_RESERVED_ROOT_PREFIX)) return false;
      return !(Object.hasOwn(GRANDFATHERED, owned.name) && GRANDFATHERED[owned.name] === where);
    })
    .map((owned) => owned.name);
}

/** Every string constant exported through core's package entry points. */
async function exportedConstants(): Promise<Constants> {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")) as { exports: Record<string, { default: string }> };
  const constants: Record<string, string> = {};
  for (const target of Object.values(manifest.exports)) {
    const source = path.join(here, "..", target.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"));
    const mod = await import(pathToFileURL(source).href) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) if (typeof value === "string") constants[name] = value;
  }
  return constants;
}

test("CI check: every exported location and marker constant is covered by an entry or explained", async () => {
  const constants = await exportedConstants();
  for (const name of ["CONVENTIONS_PREFIX", "VIEW_REGISTRY_PREFIX", "BUNDLE_NAME_DOC_ID", "CONNECTOR_TYPE", "SITES_PREFIX", "PROMOTION_TYPE"]) {
    assert.ok(Object.hasOwn(constants, name), `the walk reaches ${name}`);
  }
  assert.deepEqual(unclassifiedConstants(constants, OWNED_LOCATIONS, NOT_A_BUNDLE_LOCATION), []);
  for (const name of Object.keys(NOT_A_BUNDLE_LOCATION)) assert.ok(Object.hasOwn(constants, name), `stale exclusion ${name}`);
});

test("CI check: the grandfathered set is closed; anything new lives under the reserved root", () => {
  assert.deepEqual(entriesOutsideReservedRoot(OWNED_LOCATIONS), []);
  assert.deepEqual(Object.keys(GRANDFATHERED).sort(), OWNED_LOCATIONS.map((owned) => owned.name).filter((name) => name !== "reserved-root").sort());

  // A new owned folder outside the reserved root fails both ways: unclassified without an entry, refused with one.
  const withNewConstant = { CONVENTIONS_PREFIX: "conventions/", AGENT_NOTES_PREFIX: "agent-notes/" };
  assert.deepEqual(unclassifiedConstants(withNewConstant, OWNED_LOCATIONS, NOT_A_BUNDLE_LOCATION), ["AGENT_NOTES_PREFIX"]);
  const withNewEntry = [...OWNED_LOCATIONS, { name: "agent-notes", section: "superbee", prefix: "agent-notes/" } as const];
  assert.deepEqual(unclassifiedConstants(withNewConstant, withNewEntry, NOT_A_BUNDLE_LOCATION), []);
  assert.deepEqual(entriesOutsideReservedRoot(withNewEntry), ["agent-notes"]);
  // Moving a grandfathered entry counts as new.
  const moved = OWNED_LOCATIONS.map((owned) => owned.name === "site" ? { ...owned, prefix: "websites/" } : owned);
  assert.deepEqual(entriesOutsideReservedRoot(moved), ["site"]);
  // Under the reserved root it needs no entry and no exception.
  const reservedConstant = { AGENT_NOTES_PREFIX: `${SUPERBEE_RESERVED_ROOT_PREFIX}agent-notes/` };
  assert.deepEqual(unclassifiedConstants(reservedConstant, OWNED_LOCATIONS, NOT_A_BUNDLE_LOCATION), []);
  assert.equal(sectionOf(doc(`${SUPERBEE_RESERVED_ROOT_PREFIX}agent-notes/n`, "Agent Note")), "superbee");
});

test("entries agree with their owners' constants (the Site entry spells them as literals)", async () => {
  const { CONNECTOR_TYPE, CONNECTORS_PREFIX } = await import("../src/connectors.js");
  const { SITE_TYPE, SITES_PREFIX } = await import("../src/site-manifest.js");
  const { PROMOTION_TYPE, PROMOTIONS_PREFIX } = await import("../src/document-transfer.js");
  const { CONVENTIONS_PREFIX, CONVENTION_TYPE } = await import("../src/convention-record.js");
  const byName = new Map(OWNED_LOCATIONS.map((owned) => [owned.name, owned]));
  assert.deepEqual([byName.get("connector")?.prefix, byName.get("connector")?.type], [CONNECTORS_PREFIX, CONNECTOR_TYPE]);
  assert.deepEqual([byName.get("site")?.prefix, byName.get("site")?.type], [SITES_PREFIX, SITE_TYPE]);
  assert.deepEqual([byName.get("promotion")?.prefix, byName.get("promotion")?.type], [PROMOTIONS_PREFIX, PROMOTION_TYPE]);
  assert.deepEqual([byName.get("convention")?.prefix, byName.get("convention")?.type], [CONVENTIONS_PREFIX, CONVENTION_TYPE]);
});
