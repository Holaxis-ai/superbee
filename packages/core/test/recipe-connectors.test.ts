// Recipe carriage of Connectors (designs/recipe-connectors-2026-10-17, sections 5.1 to 5.4): the
// manifest's `connectors:` list, install with stamps and the target-Kind preflight, the optional
// `connectors` stamp key and its readers, and the evolve rows that replace only a Connector this
// recipe wrote and nobody changed since. Nothing here makes a network call.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle } from "../src/bundle.js";
import { readDoc } from "../src/bundle-ops.js";
import { parseMarkdown, stringifyDoc } from "../src/frontmatter.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { parseRecipeFiles, recipeConnectors, type LoadedRecipe, type RecipeConnector, type RecipeFile } from "../src/recipes.js";
import type { Bundle, ConceptId, OkfDocument, Version, WriteOptions } from "../src/types.js";
import {
  applyRecipeEvolution,
  ConnectorTargetUnsatisfied,
  DEFINITION_DIGEST_RULES,
  definitionDigest,
  installedConnectorDocs,
  installedConventionDocs,
  installedRecipes,
  installRecipe,
  planRecipeEvolution,
  readRecipeStamp,
  RECIPE_STAMP_KEY,
  RecipeEvolutionBlocked,
  RecipeInputError,
  recipeSourceDigest,
} from "../src/recipe-lifecycle/index.js";
import * as oldReader from "./fixtures/recipe-stamp-reader-b0ab4fcf.js";
import { CONNECTOR_ID, CONNECTOR_MD, EVENT_CONVENTION_MD, RECIPE_FILES, recipeManifest } from "./fixtures/connectors/example-calendar.js";

const NOW = "2026-10-18T09:00:00.000Z";
const CONVENTION_ID = "conventions/event";

/** The example connector with a second, partial source: what version 2 of the recipe adds. */
const TWO_SOURCES_MD = CONNECTOR_MD.replace(
  "actions: []\n",
  `  - name: listings
    profile: ics
    target_kind: Event
    mode: overlay
    identity:
      resource: "https://calendar.example.org/listings/{feed}.ics"
      id: "{uid}"
    fields:
      title: summary
      start: dtstart
    completeness: partial
actions: []
`,
);

/**
 * MemoryBackend that counts the lifecycle's write attempts (a create-only CAS that loses counts) and
 * the writes that landed; `rawWrite` is another writer, never counted.
 */
class CountingBackend extends MemoryBackend {
  attempts = 0;
  writes = 0;

  async rawWrite(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    return super.write(id, doc, options);
  }

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    this.attempts += 1;
    const version = await super.write(id, doc, options);
    this.writes += 1;
    return version;
  }

  reset(): void {
    this.attempts = 0;
    this.writes = 0;
  }
}

async function memoryBundle(name: string, okfVersion: "0.1" | "0.2" = "0.2"): Promise<{ bundle: Bundle; backend: CountingBackend }> {
  const backend = new CountingBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${okfVersion}'\n---\n# Recipe connectors\n`);
  return { bundle: { root: `mem://${name}`, backend }, backend };
}

function parsed(files: RecipeFile[], okfVersion = "0.2"): LoadedRecipe {
  const loaded = parseRecipeFiles(files, "test:recipe-connectors", { okfVersion });
  assert.ok(loaded.ok, loaded.ok ? "" : JSON.stringify(loaded.error));
  return loaded.recipe;
}

/** The example recipe at `version`, carrying `connector` (the example's own by default). */
function calendar(version = "1", connector = CONNECTOR_MD, okfVersion = "0.2"): LoadedRecipe {
  return parsed([
    { path: "recipe.md", bytes: recipeManifest(version) },
    { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD },
    { path: "connectors/example-calendar.md", bytes: connector },
  ], okfVersion);
}

/** Rewrite one stored document as another writer would, bypassing the lifecycle. */
async function edit(backend: CountingBackend, id: ConceptId, change: (doc: OkfDocument) => OkfDocument): Promise<void> {
  const current = await backend.read(id);
  await backend.rawWrite(id, change(structuredClone(current.doc)), { expectedVersion: current.version });
}

const stampOf = (doc: OkfDocument): Record<string, unknown> => doc.frontmatter[RECIPE_STAMP_KEY] as Record<string, unknown>;
const withStamp = (doc: OkfDocument, stamp: unknown): OkfDocument => ({ ...doc, frontmatter: { ...doc.frontmatter, [RECIPE_STAMP_KEY]: stamp } });
const withoutStamp = (doc: OkfDocument): OkfDocument => {
  const { [RECIPE_STAMP_KEY]: _stamp, ...frontmatter } = doc.frontmatter;
  return { ...doc, frontmatter: frontmatter as OkfDocument["frontmatter"] };
};

async function report(bundle: Bundle, known: readonly LoadedRecipe[] = []) {
  const docs = [...(await installedConventionDocs(bundle)).values(), ...(await installedConnectorDocs(bundle)).values()];
  return installedRecipes(docs, known);
}

/** Fail the test if anything reaches for the network while `run` runs. */
async function offline<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("a network call was made");
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ------------------------------------------------------------------------------------------ parse

test("parse: a recipe carries its Connector through the manifest; a recipe without one parses as before", () => {
  const recipe = parsed(RECIPE_FILES);
  assert.deepEqual(recipeConnectors(recipe).map(({ doc, connector }) => [doc.id, connector.id, connector.sources.map((s) => s.name)]), [
    [CONNECTOR_ID, CONNECTOR_ID, ["events"]],
  ]);
  assert.deepEqual(recipe.warnings, []);
  assert.deepEqual(recipe.governs, ["Event"]);
  const without = parsed(RECIPE_FILES.filter((file) => !file.path.startsWith("connectors/")).map((file) =>
    file.path === "recipe.md" ? { ...file, bytes: file.bytes.replace("connectors:\n  - connectors/example-calendar.md\n", "") } : file));
  assert.equal(Object.hasOwn(without, "connectors"), false, "no connectors key, so the value is what it always was");
  assert.deepEqual(recipeConnectors(without), []);
  const declaredEmpty = parsed([
    { path: "recipe.md", bytes: recipeManifest().replace("connectors:\n  - connectors/example-calendar.md\n", "connectors: []\n") },
    { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD },
  ]);
  assert.equal(Object.hasOwn(declaredEmpty, "connectors"), false);
});

test("parse: the connectors: grammar refuses with typed codes before any connector is read", () => {
  const manifest = (list: string, policy = "content_policy: definitions-only\n") =>
    `---\ntype: Recipe\nid: grammar\ntitle: Grammar\nversion: "1"\nsummary: Grammar cases.\n${policy}${list}---\n`;
  const event = { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD };
  const file = (p: string) => ({ path: p, bytes: CONNECTOR_MD });
  const cases: Array<[string, RecipeFile[], string, RegExp]> = [
    ["no definitions-only policy", [{ path: "recipe.md", bytes: manifest("connectors: [connectors/a.md]\n", "") }, event, file("connectors/a.md")], "RECIPE_MALFORMED", /content_policy: definitions-only/],
    ["not a list", [{ path: "recipe.md", bytes: manifest("connectors: connectors/a.md\n") }, event], "RECIPE_MALFORMED", /'connectors' must be a list/],
    ["an empty entry", [{ path: "recipe.md", bytes: manifest('connectors: [""]\n') }, event], "RECIPE_MALFORMED", /connectors\[0\] must be a non-empty path/],
    ["outside connectors/", [{ path: "recipe.md", bytes: manifest("connectors: [references/a.md]\n") }, event], "RECIPE_UNSAFE_PATH", /under 'connectors\/'/],
    ["a traversal", [{ path: "recipe.md", bytes: manifest("connectors: [connectors/../conventions/event.md]\n") }, event], "RECIPE_UNSAFE_PATH", /under 'connectors\/'/],
    ["not markdown", [{ path: "recipe.md", bytes: manifest("connectors: [connectors/a.yaml]\n") }, event], "RECIPE_UNSAFE_PATH", /must be a \.md file/],
    ["a reserved filename", [{ path: "recipe.md", bytes: manifest("connectors: [connectors/index.md]\n") }, event, file("connectors/index.md")], "RECIPE_UNSAFE_PATH", /reserved filename/],
    ["a case-folded duplicate", [{ path: "recipe.md", bytes: manifest("connectors: [connectors/a.md, connectors/A.md]\n") }, event, file("connectors/a.md"), file("connectors/A.md")], "RECIPE_MALFORMED", /duplicate Connector/],
    ["a declared file missing", [{ path: "recipe.md", bytes: manifest("connectors: [connectors/a.md]\n") }, event], "RECIPE_MALFORMED", /missing declared Connector file 'connectors\/a\.md'/],
    ["an undeclared connector file", [{ path: "recipe.md", bytes: manifest("") }, event, file("connectors/a.md")], "RECIPE_UNSAFE_PATH", /undeclared file 'connectors\/a\.md'/],
  ];
  for (const [name, files, code, message] of cases) {
    const result = parseRecipeFiles(files, "test:grammar");
    assert.equal(result.ok, false, name);
    if (result.ok) continue;
    assert.equal(result.error.code, code, `${name}: ${result.error.message}`);
    assert.match(result.error.message, message, name);
    assert.equal(result.error.connector, undefined, name);
  }
});

test("parse: RECIPE_CONNECTOR_INVALID names the connector's first refusal and counts them all, never echoing a secret", () => {
  const invalid = (connector: string, at = "connectors/example-calendar.md") => {
    const result = parseRecipeFiles([
      { path: "recipe.md", bytes: recipeManifest().replace("connectors/example-calendar.md", at) },
      { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD },
      { path: at, bytes: connector },
    ], "test:invalid");
    assert.equal(result.ok, false);
    return result.ok ? assert.fail("parsed") : result.error;
  };
  const two = invalid(CONNECTOR_MD.replace("    mode: overlay\n", "    mode: mirror\n").replace("  - calendar.example.org\n", "  - Calendar.Example.org\n"));
  assert.equal(two.code, "RECIPE_CONNECTOR_INVALID");
  assert.deepEqual(two.connector, { id: CONNECTOR_ID, code: "CONNECTOR_DOMAIN_INVALID", path: "/domains/0", count: 2 });
  assert.match(two.message, /invalid Connector 'connectors\/example-calendar\.md': CONNECTOR_DOMAIN_INVALID at '\/domains\/0': .* \(and 1 more\)$/);

  const secret = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
  const leaked = invalid(CONNECTOR_MD.replace("auth:\n  kind: none\n", `auth:\n  kind: none\nx_note: "${secret}"\n`));
  assert.equal(leaked.connector?.code, "CONNECTOR_SECRET_PRESENT");
  assert.doesNotMatch(JSON.stringify(leaked), new RegExp(secret));

  // The one parser owns the location rule: a nested path is a safe file but not a Connector id.
  const nested = invalid(CONNECTOR_MD, "connectors/team/example.md");
  assert.deepEqual([nested.connector?.code, nested.connector?.path], ["CONNECTOR_MALFORMED", ""]);
});

test("parse: the recipe's own Kinds check its connector now; a Kind from elsewhere waits for the bundle", () => {
  const undeclared = parseRecipeFiles([
    ...RECIPE_FILES.filter((file) => !file.path.startsWith("connectors/")),
    { path: "connectors/example-calendar.md", bytes: CONNECTOR_MD.replace("      event_url: url\n", "      event_url: url\n      venue: location\n") },
  ], "test:own-kind");
  assert.equal(undeclared.ok, false);
  if (!undeclared.ok) assert.deepEqual([undeclared.error.code, undeclared.error.connector?.code, undeclared.error.connector?.path], ["RECIPE_CONNECTOR_INVALID", "CONNECTOR_FIELD_UNDECLARED", "/record_sources/0/fields/venue"]);

  const elsewhere = parsed([
    { path: "recipe.md", bytes: recipeManifest() },
    { path: "conventions/shelf.md", bytes: "---\ntype: Convention\ntitle: Shelf\ngoverns: Shelf\n---\n# Shelf\n" },
    { path: "connectors/example-calendar.md", bytes: CONNECTOR_MD },
  ]);
  assert.equal(recipeConnectors(elsewhere).length, 1);
  assert.deepEqual(elsewhere.warnings, [], "a deferred Kind is no recipe warning, which evolve would turn into a blocker");
});

test("parse: a recipe convention governing Connector is malformed", () => {
  const result = parseRecipeFiles([
    { path: "recipe.md", bytes: recipeManifest() },
    { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD },
    { path: "conventions/connector.md", bytes: "---\ntype: Convention\ntitle: Connector\ngoverns: Connector\n---\n# Connector\n" },
    { path: "connectors/example-calendar.md", bytes: CONNECTOR_MD },
  ], "test:governs");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "RECIPE_MALFORMED");
    assert.match(result.error.message, /governs 'Connector'/);
  }
});

// ----------------------------------------------------------------------------------------- stamps

// The stamped conventions origin/main b0ab4fcf wrote for this recipe, before connectors existed.
const LOGBOOK: RecipeFile[] = [
  { path: "recipe.md", bytes: '---\ntype: Recipe\nid: logbook\ntitle: Logbook\nversion: "3"\nsummary: Log entries and their shelves.\n---\n# Logbook\n' },
  { path: "conventions/entry.md", bytes: "---\ntype: Convention\ntitle: Entry\ngoverns: Entry\npath: entries/\nfields:\n  required: [title, progress_status]\n  optional: [shelf]\n  values:\n    progress_status: [open, done]\n---\n# Entry\n\nOne log entry. {{superbee:progress_status}} tracks it.\n" },
  { path: "conventions/shelf.md", bytes: "---\ntype: Convention\ntitle: Shelf\ngoverns: Shelf\n---\n# Shelf\n" },
];
const LOGBOOK_SOURCE_DIGEST = "sha256:5fb50ce6e808cacc1ba37d257599e1f77683496369438e0bdeb5f577ae92338d";
const LOGBOOK_GOLDEN: Record<string, string> = {
  "0.1 conventions/entry": "---\ntype: Convention\ntitle: Entry\ngoverns: Entry\npath: entries/\nfields:\n  required:\n    - title\n    - status\n  optional:\n    - shelf\n  values:\n    status:\n      - open\n      - done\nx_recipe:\n  id: logbook\n  version: '3'\n  of: 2\n  source_digest: 'sha256:5fb50ce6e808cacc1ba37d257599e1f77683496369438e0bdeb5f577ae92338d'\n  definition: 'sha256:c091b8eba3dd9c69bac80c2c304fa9004a88944e7824c8662f6bc70fe5f0aae9'\n  digest_rules: 1\ntimestamp: '2026-10-18T09:00:00.000Z'\n---\n# Entry\n\nOne log entry. status tracks it.\n",
  "0.1 conventions/shelf": "---\ntype: Convention\ntitle: Shelf\ngoverns: Shelf\nx_recipe:\n  id: logbook\n  version: '3'\n  of: 2\n  source_digest: 'sha256:5fb50ce6e808cacc1ba37d257599e1f77683496369438e0bdeb5f577ae92338d'\n  definition: 'sha256:87d76d2c25f373f1a53ca09610bd857f8047cc3bbc85bd2c4a374f4e6fd00f53'\n  digest_rules: 1\ntimestamp: '2026-10-18T09:00:00.000Z'\n---\n# Shelf\n",
  "0.2 conventions/entry": "---\ntype: Convention\ntitle: Entry\ngoverns: Entry\npath: entries/\nfields:\n  required:\n    - title\n    - superbee_progress_status\n  optional:\n    - shelf\n  values:\n    superbee_progress_status:\n      - open\n      - done\nx_recipe:\n  id: logbook\n  version: '3'\n  of: 2\n  source_digest: 'sha256:5fb50ce6e808cacc1ba37d257599e1f77683496369438e0bdeb5f577ae92338d'\n  definition: 'sha256:1ceae1cd45929e3d16c1657d4c94d0364358f94af6790dbeae7f46678b18838b'\n  digest_rules: 1\n---\n# Entry\n\nOne log entry. superbee_progress_status tracks it.\n",
  "0.2 conventions/shelf": "---\ntype: Convention\ntitle: Shelf\ngoverns: Shelf\nx_recipe:\n  id: logbook\n  version: '3'\n  of: 2\n  source_digest: 'sha256:5fb50ce6e808cacc1ba37d257599e1f77683496369438e0bdeb5f577ae92338d'\n  definition: 'sha256:87d76d2c25f373f1a53ca09610bd857f8047cc3bbc85bd2c4a374f4e6fd00f53'\n  digest_rules: 1\n---\n# Shelf\n",
};

test("T10 (connectors): a recipe without connectors writes the bytes b0ab4fcf wrote, stamp and source digest included", async () => {
  const dirs: string[] = [];
  try {
    for (const okfVersion of ["0.1", "0.2"] as const) {
      const recipe = parsed(LOGBOOK, okfVersion);
      assert.equal(recipeSourceDigest(recipe), LOGBOOK_SOURCE_DIGEST);
      assert.equal(recipeSourceDigest({ ...recipe, connectors: [] }), LOGBOOK_SOURCE_DIGEST, "an empty list digests as no list");
      const dir = await mkdtemp(path.join(tmpdir(), "superbee-connector-golden-"));
      dirs.push(dir);
      const bundle = await initBundle(dir, { okfVersion });
      await installRecipe(bundle, recipe, { now: NOW });
      for (const id of ["conventions/entry", "conventions/shelf"]) {
        assert.equal(await readFile(path.join(dir, `${id}.md`), "utf8"), LOGBOOK_GOLDEN[`${okfVersion} ${id}`], `${okfVersion} ${id}`);
      }
    }
  } finally {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("T10 (connectors): connectors enter the source digest only when present, sorted by id, CRLF read as LF", () => {
  const recipe = calendar();
  const one: RecipeConnector = recipeConnectors(recipe)[0]!;
  const kindOnly: LoadedRecipe = { ...recipe };
  delete kindOnly.connectors;
  assert.notEqual(recipeSourceDigest(recipe), recipeSourceDigest(kindOnly));
  const second = { ...one, doc: { ...one.doc, id: "connectors/another" } };
  const both = recipeSourceDigest({ ...recipe, connectors: [one, second] });
  assert.equal(recipeSourceDigest({ ...recipe, connectors: [second, one] }), both);
  assert.equal(recipeSourceDigest({ ...recipe, connectors: [{ ...one, doc: { ...one.doc, body: one.doc.body.replaceAll("\n", "\r\n") } }] }), recipeSourceDigest(recipe));
  assert.notEqual(recipeSourceDigest({ ...recipe, connectors: [{ ...one, doc: { ...one.doc, body: `${one.doc.body}.` } }] }), recipeSourceDigest(recipe));
});

test("install stamps the Connector and every convention with connectors: 1, of unchanged, in the document's own create", async () => {
  const { bundle, backend } = await memoryBundle("install");
  const recipe = calendar();
  const result = await installRecipe(bundle, recipe, { now: NOW });
  assert.deepEqual(result.connectors, [{ id: CONNECTOR_ID, changed: true }]);
  assert.deepEqual(result.counts, { created: 2, existing: 0, legacy_present: 0, migration_required: 0 });
  assert.equal(result.stamp, "current");
  assert.equal(backend.writes, 2, "one create per document, the stamp inside it");
  const connector = await readDoc(bundle, CONNECTOR_ID);
  const convention = await readDoc(bundle, CONVENTION_ID);
  assert.deepEqual(Object.keys(stampOf(connector)), ["id", "version", "of", "connectors", "source_digest", "definition", "digest_rules"]);
  assert.deepEqual(stampOf(connector), {
    id: "example-calendar",
    version: "1",
    of: 1,
    connectors: 1,
    source_digest: recipeSourceDigest(recipe),
    definition: definitionDigest(connector),
    digest_rules: DEFINITION_DIGEST_RULES,
  });
  assert.equal(stampOf(convention).connectors, 1);
  assert.equal(stampOf(convention).of, 1);
  assert.deepEqual(readRecipeStamp(connector), stampOf(connector));
  // The installed body and declarations are the recipe's, byte for byte.
  assert.equal(connector.body, recipeConnectors(recipe)[0]!.doc.body);
  assert.deepEqual((await report(bundle)).rows, [{
    id: "example-calendar", state: "installed", version: "1", source_digest: recipeSourceDigest(recipe),
    conventions: 1, of: 1, convention_ids: [CONVENTION_ID], connectors: 1, connectors_of: 1, connector_ids: [CONNECTOR_ID],
  }]);
});

test("P2' (older reader): the reader b0ab4fcf shipped reads a connector recipe's stamps as installed", async () => {
  const { bundle } = await memoryBundle("older-reader");
  const recipe = calendar();
  await installRecipe(bundle, recipe, { now: NOW });
  const docs = [await readDoc(bundle, CONVENTION_ID), await readDoc(bundle, CONNECTOR_ID)];
  for (const doc of docs) {
    assert.deepEqual(Object.keys(oldReader.readRecipeStamp(doc)!), ["id", "version", "of", "source_digest", "definition", "digest_rules"]);
    assert.equal(oldReader.conventionStampState(doc), "current", doc.id);
    assert.equal(oldReader.recipeStampState(doc, { id: recipe.id, version: "1", of: 1, source_digest: recipeSourceDigest(recipe) }), "current", doc.id);
  }
  assert.deepEqual(oldReader.installedRecipes(docs), {
    rows: [{ id: "example-calendar", state: "installed", version: "1", source_digest: recipeSourceDigest(recipe), conventions: 1, of: 1, convention_ids: [CONVENTION_ID] }],
    unstamped: [],
  });
});

test("install checks every connector's target Kind before its first write, and a recipe bringing the Kind installs into an empty bundle", async () => {
  const shelf = { path: "conventions/shelf.md", bytes: "---\ntype: Convention\ntitle: Shelf\ngoverns: Shelf\n---\n# Shelf\n" };
  const feedOnly = parsed([{ path: "recipe.md", bytes: recipeManifest() }, shelf, { path: "connectors/example-calendar.md", bytes: CONNECTOR_MD }]);

  const empty = await memoryBundle("preflight-empty");
  const missingKind = await installRecipe(empty.bundle, feedOnly, { now: NOW }).then(() => assert.fail("installed"), (error: unknown) => error);
  assert.ok(missingKind instanceof ConnectorTargetUnsatisfied);
  assert.deepEqual([missingKind.recipe, missingKind.connector, missingKind.source, missingKind.kind, missingKind.code, missingKind.fields], [
    "example-calendar", CONNECTOR_ID, "events", "Event", "CONNECTOR_TARGET_KIND_INVALID", [],
  ]);
  assert.match(missingKind.message, /nothing was written/);
  assert.equal(empty.backend.attempts, 0, "not even the recipe's own Shelf convention");

  const narrow = await memoryBundle("preflight-narrow");
  const narrowEvent = EVENT_CONVENTION_MD.replace("  optional: [end, event_url, note, revision]\n", "  optional: [end, note, revision]\n").replace("    event_url: https-url\n", "");
  await narrow.backend.rawWrite(CONVENTION_ID, { id: CONVENTION_ID, ...parseMarkdown(narrowEvent) }, { expectedVersion: null });
  const undeclared = await installRecipe(narrow.bundle, feedOnly, { now: NOW }).then(() => assert.fail("installed"), (error: unknown) => error);
  assert.ok(undeclared instanceof ConnectorTargetUnsatisfied);
  assert.deepEqual([undeclared.code, undeclared.fields], ["CONNECTOR_FIELD_UNDECLARED", ["event_url"]]);
  assert.equal(narrow.backend.attempts, 0);

  // The bundle's own convention at the recipe's id is what the check reads: install never rewrites it.
  const shadowed = await memoryBundle("preflight-shadowed");
  await shadowed.backend.rawWrite(CONVENTION_ID, { id: CONVENTION_ID, ...parseMarkdown(narrowEvent) }, { expectedVersion: null });
  await assert.rejects(installRecipe(shadowed.bundle, calendar(), { now: NOW }), ConnectorTargetUnsatisfied);
  assert.equal(shadowed.backend.attempts, 0);

  const fresh = await memoryBundle("preflight-fresh");
  assert.equal((await installRecipe(fresh.bundle, calendar(), { now: NOW })).changed, true);
});

test("install is create-only for a Connector: a re-add is a no-op, and an edited one is left untouched and reported", async () => {
  const { bundle, backend } = await memoryBundle("readd");
  await installRecipe(bundle, calendar(), { now: NOW });
  const again = await installRecipe(bundle, calendar(), { now: NOW });
  assert.deepEqual(again.connectors, [{ id: CONNECTOR_ID, changed: false }]);
  assert.deepEqual([again.changed, again.stamp, again.counts.existing], [false, "current", 2]);

  await edit(backend, CONNECTOR_ID, (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, title: "Our calendar" } }));
  const before = await backend.read(CONNECTOR_ID);
  backend.reset();
  const differs = await installRecipe(bundle, calendar(), { now: NOW });
  assert.deepEqual(differs.connectors, [{ id: CONNECTOR_ID, changed: false, source_differs: true }]);
  assert.equal(differs.counts.source_differs, 1);
  assert.ok(differs.warnings.some((warning) => warning.code === "RECIPE_SOURCE_DIFFERS" && warning.message.includes(`'${CONNECTOR_ID}.md'`)));
  assert.equal(backend.writes, 0);
  assert.equal((await backend.read(CONNECTOR_ID)).version, before.version);
});

test("install refuses a Connector the bundle's edition would refuse at its create, before any write attempt", async () => {
  const cases: Array<[string, string]> = [["tags: 7", "tags: 7\n"], ["verified: yes", "verified: yes\n"], ["a leftover sources list", "sources:\n  - name: events\n"]];
  for (const [name, extra] of cases) {
    const connector = CONNECTOR_MD.replace("auth:\n  kind: none\n", `auth:\n  kind: none\n${extra}`);
    const { bundle, backend } = await memoryBundle(`authoring-${name}`);
    const error = await installRecipe(bundle, calendar("1", connector), { now: NOW }).then(() => assert.fail(`${name} installed`), (caught: unknown) => caught);
    assert.ok(error instanceof RecipeInputError, name);
    assert.match(error.message, /^recipe 'example-calendar' cannot install Connector 'connectors\/example-calendar': OKF v0\.2 .*; nothing was written$/, name);
    assert.equal(backend.attempts, 0, `${name}: not even the convention`);
    // OKF v0.1 has no such rule, and its engine writes the same Connector.
    const legacy = await memoryBundle(`authoring-${name}-v01`, "0.1");
    assert.equal((await installRecipe(legacy.bundle, calendar("1", connector, "0.1"), { now: NOW })).changed, true, name);
  }
});

// ----------------------------------------------------------------------------------------- evolve

for (const okfVersion of ["0.1", "0.2"] as const) {
  test(`evolve (${okfVersion}): a version that adds a source replaces the Connector this recipe wrote, conventions first, and converges`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "superbee-connector-evolve-"));
    try {
      const bundle = await initBundle(dir, { okfVersion });
      await installRecipe(bundle, calendar("1", CONNECTOR_MD, okfVersion), { now: NOW });
      const v2 = calendar("2", TWO_SOURCES_MD, okfVersion);
      const plan = await planRecipeEvolution(bundle, v2);
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
      assert.deepEqual(plan.definitions.map(({ id, governs, action, stamp }) => ({ id, governs, action, stamp })), [
        { id: CONVENTION_ID, governs: "Event", action: "unchanged", stamp: "stale" },
        { id: CONNECTOR_ID, governs: "Connector", action: "update", stamp: "stale" },
      ]);
      assert.deepEqual([plan.changed, plan.writes, plan.counts.updates, plan.counts.stamp_writes], [true, 2, 1, 1]);
      const applied = await applyRecipeEvolution(bundle, v2, plan.plan_token, { actor: "process:connector-test" });
      assert.equal(applied.recipe, "evolved");
      assert.deepEqual(applied.definitions.map(({ id, changed, stamped }) => [id, changed, stamped]), [[CONVENTION_ID, false, true], [CONNECTOR_ID, true, true]]);
      const connector = await readDoc(bundle, CONNECTOR_ID);
      assert.deepEqual((connector.frontmatter.record_sources as Array<{ name: string }>).map((source) => source.name), ["events", "listings"]);
      assert.deepEqual([stampOf(connector).version, stampOf(connector).connectors, stampOf(connector).definition], ["2", 1, definitionDigest(connector)]);
      const row = (await report(bundle)).rows[0]!;
      assert.deepEqual([row.state, row.version, row.connectors, row.connectors_of], ["installed", "2", 1, 1]);
      assert.equal((await planRecipeEvolution(bundle, v2)).writes, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const okfVersion of ["0.1", "0.2"] as const) {
  test(`evolve (${okfVersion}): a replacement keeps the installed document's metadata and its bundle-local order`, async () => {
    const { bundle, backend } = await memoryBundle(`metadata-${okfVersion}`, okfVersion);
    await installRecipe(bundle, calendar("1", CONNECTOR_MD, okfVersion), { now: NOW });
    const verified = [{ by: "human:mike", at: "2026-10-18T10:00:00Z" }];
    // None of these is part of the definition, so the Connector is still the one this recipe wrote.
    await edit(backend, CONNECTOR_ID, (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, actor: "human:mike", order: 3, verified } }));
    const v2 = calendar("2", TWO_SOURCES_MD, okfVersion);
    const plan = await planRecipeEvolution(bundle, v2);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    assert.equal(plan.definitions.find((definition) => definition.id === CONNECTOR_ID)?.action, "update");
    await applyRecipeEvolution(bundle, v2, plan.plan_token);
    const after = await readDoc(bundle, CONNECTOR_ID);
    assert.equal((after.frontmatter.record_sources as unknown[]).length, 2, "the content was replaced");
    assert.deepEqual([after.frontmatter.actor, after.frontmatter.order, after.frontmatter.verified], ["human:mike", 3, verified]);
  });
}

test("evolve: an unchanged Connector under a new version gets a stamp-only write", async () => {
  const { bundle } = await memoryBundle("stamp-only");
  await installRecipe(bundle, calendar("1"), { now: NOW });
  const plan = await planRecipeEvolution(bundle, calendar("2"));
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const row = plan.definitions.find((definition) => definition.id === CONNECTOR_ID)!;
  assert.deepEqual([row.governs, row.action, row.stamp, row.added_paths], ["Connector", "unchanged", "stale", []]);
  assert.equal(row.expected_version, (await bundle.backend.read(CONNECTOR_ID)).version);
  const before = await readDoc(bundle, CONNECTOR_ID);
  const applied = await applyRecipeEvolution(bundle, calendar("2"), plan.plan_token);
  assert.equal(applied.recipe, "stamped");
  const after = await readDoc(bundle, CONNECTOR_ID);
  assert.deepEqual(withoutStamp(after), withoutStamp(before), "content untouched");
  assert.equal(stampOf(after).version, "2");
});

/**
 * Each state evolve must never write: the plan blocks, the apply refuses, and the stored Connector
 * keeps its version. `prepare` puts the bundle in the state after a v1 install.
 */
const NEVER_WRITTEN: Array<{ name: string; to: () => LoadedRecipe; prepare: (backend: CountingBackend) => Promise<void>; code: string }> = [
  {
    name: "a person's edit, under a version that changes the Connector",
    to: () => calendar("2", TWO_SOURCES_MD),
    prepare: (backend) => edit(backend, CONNECTOR_ID, (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, title: "Our calendar" } })),
    code: "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
  },
  {
    name: "a person's edit that equals the next version's content (no stamp-only repair)",
    to: () => calendar("2", TWO_SOURCES_MD),
    prepare: async (backend) => {
      const v2 = recipeConnectors(calendar("2", TWO_SOURCES_MD))[0]!.doc;
      await edit(backend, CONNECTOR_ID, (doc) => ({ ...doc, frontmatter: { ...v2.frontmatter, [RECIPE_STAMP_KEY]: doc.frontmatter[RECIPE_STAMP_KEY] }, body: v2.body }));
    },
    code: "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
  },
  {
    name: "a person's edit under the same version",
    to: () => calendar("1"),
    prepare: (backend) => edit(backend, CONNECTOR_ID, (doc) => ({ ...doc, body: `${doc.body}Local note.\n` })),
    code: "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
  },
  {
    name: "an unstamped Connector that differs",
    to: () => calendar("2", TWO_SOURCES_MD),
    prepare: (backend) => edit(backend, CONNECTOR_ID, withoutStamp),
    code: "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
  },
  {
    name: "another recipe's Connector with the same content",
    to: () => calendar("2"),
    prepare: (backend) => edit(backend, CONNECTOR_ID, (doc) => withStamp(doc, { ...stampOf(doc), id: "other-recipe" })),
    code: "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
  },
  {
    name: "another recipe's Connector with different content",
    to: () => calendar("2", TWO_SOURCES_MD),
    prepare: (backend) => edit(backend, CONNECTOR_ID, (doc) => withStamp(doc, { ...stampOf(doc), id: "other-recipe" })),
    code: "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
  },
  {
    name: "a stamp whose digest rules this release does not read",
    to: () => calendar("2", TWO_SOURCES_MD),
    prepare: (backend) => edit(backend, CONNECTOR_ID, (doc) => withStamp(doc, { ...stampOf(doc), digest_rules: 2 })),
    code: "RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED",
  },
  {
    name: "a document of another type at the Connector's id",
    to: () => calendar("2", TWO_SOURCES_MD),
    prepare: (backend) => edit(backend, CONNECTOR_ID, () => ({ id: CONNECTOR_ID, frontmatter: { type: "Note", title: "Not a connector" }, body: "Mine.\n" })),
    code: "RECIPE_EVOLUTION_IDENTITY_CONFLICT",
  },
];

for (const { name, to, prepare, code } of NEVER_WRITTEN) {
  test(`evolve never writes ${name}`, async () => {
    const { bundle, backend } = await memoryBundle(`never-${name}`);
    await installRecipe(bundle, calendar("1"), { now: NOW });
    await prepare(backend);
    const before = await backend.read(CONNECTOR_ID);
    backend.reset();
    const recipe = to();
    const plan = await planRecipeEvolution(bundle, recipe);
    assert.equal(plan.ready, false);
    assert.deepEqual(plan.blockers.filter((blocker) => blocker.id === CONNECTOR_ID).map((blocker) => [blocker.code, blocker.field]), [[code, "/"]]);
    await assert.rejects(applyRecipeEvolution(bundle, recipe, plan.plan_token), RecipeEvolutionBlocked);
    assert.equal(backend.attempts, 0);
    const after = await backend.read(CONNECTOR_ID);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.doc, before.doc);
  });
}

test("evolve: an unstamped Connector equal to the recipe's is adopted with a stamp-only write; a missing one blocks with the install help", async () => {
  const { bundle, backend } = await memoryBundle("unstamped-same");
  await installRecipe(bundle, calendar("1"), { now: NOW });
  await edit(backend, CONNECTOR_ID, withoutStamp);
  const plan = await planRecipeEvolution(bundle, calendar("1"));
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.definitions.filter((definition) => definition.id === CONNECTOR_ID).map(({ action, stamp }) => [action, stamp]), [["unchanged", "missing"]]);
  assert.equal(plan.writes, 1);
  await applyRecipeEvolution(bundle, calendar("1"), plan.plan_token);
  assert.equal(stampOf(await readDoc(bundle, CONNECTOR_ID)).id, "example-calendar");

  const current = await backend.read(CONNECTOR_ID);
  await backend.delete(CONNECTOR_ID, { expectedVersion: current.version });
  backend.reset();
  const missing = await planRecipeEvolution(bundle, calendar("2"));
  assert.deepEqual(missing.definitions.filter((definition) => definition.id === CONNECTOR_ID).map(({ action, stamp, expected_version }) => [action, stamp, expected_version]), [["missing", "missing", null]]);
  const blocker = missing.blockers.find((entry) => entry.id === CONNECTOR_ID)!;
  assert.equal(blocker.code, "RECIPE_EVOLUTION_ASSET_MISSING");
  assert.match(blocker.message, /install the complete recipe with 'recipe add' first/);
  assert.equal(missing.counts.missing, 1);
  assert.equal(backend.attempts, 0);
});

test("evolve: a target Kind that no longer fits the Connector is a plan blocker, never a write-time failure", async () => {
  const kindRecipe = parsed([
    { path: "recipe.md", bytes: '---\ntype: Recipe\nid: events\ntitle: Events\nversion: "1"\nsummary: The Event Kind.\n---\n' },
    { path: "conventions/event.md", bytes: EVENT_CONVENTION_MD },
  ]);
  const feed = parsed([
    { path: "recipe.md", bytes: recipeManifest() },
    { path: "conventions/shelf.md", bytes: "---\ntype: Convention\ntitle: Shelf\ngoverns: Shelf\n---\n# Shelf\n" },
    { path: "connectors/example-calendar.md", bytes: CONNECTOR_MD },
  ]);
  const { bundle, backend } = await memoryBundle("target-blocker");
  await installRecipe(bundle, kindRecipe, { now: NOW });
  await installRecipe(bundle, feed, { now: NOW });
  await edit(backend, CONVENTION_ID, (doc) => {
    const fields = doc.frontmatter.fields as { optional: string[]; types: Record<string, string> };
    const { event_url: _url, ...types } = fields.types;
    return { ...doc, frontmatter: { ...doc.frontmatter, fields: { ...fields, optional: fields.optional.filter((field) => field !== "event_url"), types } } };
  });
  backend.reset();
  const plan = await planRecipeEvolution(bundle, feed);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.blockers.map(({ code, id, field }) => [code, id, field]), [["RECIPE_EVOLUTION_CONNECTOR_TARGET", CONNECTOR_ID, "/record_sources/0/fields/event_url"]]);
  assert.match(plan.blockers[0]!.message, /^CONNECTOR_FIELD_UNDECLARED: /);
  assert.equal(backend.attempts, 0);
});

test("stamp state: the connectors key is compared only for a recipe that carries connectors", async () => {
  const { bundle, backend } = await memoryBundle("stamp-key");
  await installRecipe(bundle, calendar("1"), { now: NOW });
  for (const tamper of [(stamp: Record<string, unknown>) => { const { connectors: _c, ...rest } = stamp; return rest; }, (stamp: Record<string, unknown>) => ({ ...stamp, connectors: 4 })]) {
    const original = stampOf(await readDoc(bundle, CONNECTOR_ID));
    await edit(backend, CONNECTOR_ID, (doc) => withStamp(doc, tamper(stampOf(doc))));
    const plan = await planRecipeEvolution(bundle, calendar("1"));
    assert.deepEqual(plan.definitions.filter((definition) => definition.id === CONNECTOR_ID).map(({ action, stamp }) => [action, stamp]), [["unchanged", "stale"]]);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    assert.equal((await report(bundle)).rows[0]!.state, "partial");
    await applyRecipeEvolution(bundle, calendar("1"), plan.plan_token);
    assert.deepEqual(stampOf(await readDoc(bundle, CONNECTOR_ID)), original, "the evolve restores the stamp");
  }

  // No release writes the key for a recipe without connectors, so on one it is a stray edit: the
  // reader reads it partial and the plan re-stamps it, as for any other tampered count.
  const logbook = await memoryBundle("stray-key");
  await installRecipe(logbook.bundle, parsed(LOGBOOK), { now: NOW });
  const shelfStamp = stampOf(await readDoc(logbook.bundle, "conventions/shelf"));
  await edit(logbook.backend, "conventions/shelf", (doc) => withStamp(doc, { ...stampOf(doc), connectors: 2 }));
  assert.equal((await report(logbook.bundle)).rows[0]!.state, "partial", "the stamps disagree on the connector count");
  const plan = await planRecipeEvolution(logbook.bundle, parsed(LOGBOOK));
  assert.deepEqual(plan.definitions.map(({ id, stamp }) => [id, stamp]), [["conventions/entry", "current"], ["conventions/shelf", "stale"]]);
  await applyRecipeEvolution(logbook.bundle, parsed(LOGBOOK), plan.plan_token);
  assert.deepEqual(stampOf(await readDoc(logbook.bundle, "conventions/shelf")), shelfStamp);
  assert.deepEqual((await report(logbook.bundle)).rows.map(({ state, connectors }) => [state, connectors]), [["installed", undefined]]);
  assert.equal(readRecipeStamp(await readDoc(logbook.bundle, "conventions/entry"))!.connectors, undefined);
  for (const malformed of [-1, 1.5, "1", null]) {
    assert.equal(readRecipeStamp({ frontmatter: { [RECIPE_STAMP_KEY]: { ...stampOf(await readDoc(logbook.bundle, "conventions/entry")), connectors: malformed } } } as OkfDocument)!.connectors, undefined, String(malformed));
  }
});

test("installedRecipes counts Connectors apart: missing, unstamped, diverged and stray documents", async () => {
  const recipe = calendar("1");
  const { bundle, backend } = await memoryBundle("report");
  await installRecipe(bundle, recipe, { now: NOW });

  await edit(backend, CONNECTOR_ID, (doc) => ({ ...doc, frontmatter: { ...doc.frontmatter, title: "Our calendar" } }));
  let row = (await report(bundle)).rows[0]!;
  assert.deepEqual([row.state, row.diverged], ["diverged", [CONNECTOR_ID]]);

  await edit(backend, CONNECTOR_ID, withoutStamp);
  let read = await report(bundle, [recipe]);
  assert.deepEqual(read.unstamped, [CONNECTOR_ID]);
  assert.deepEqual(read.rows.map(({ state, connectors, connectors_of, missing_ids }) => ({ state, connectors, connectors_of, missing_ids })), [
    { state: "partial", connectors: 0, connectors_of: 1, missing_ids: [CONNECTOR_ID] },
  ]);
  row = (await report(bundle)).rows[0]!;
  assert.deepEqual([row.state, row.missing], ["partial", 1], "without the recipe, the stamped count is short");

  const current = await backend.read(CONNECTOR_ID);
  await backend.delete(CONNECTOR_ID, { expectedVersion: current.version });
  read = await report(bundle, [recipe]);
  assert.deepEqual(read.unstamped, []);
  assert.deepEqual(read.rows.map(({ state, missing, missing_ids }) => ({ state, missing, missing_ids })), [{ state: "partial", missing: 1, missing_ids: [CONNECTOR_ID] }]);

  // Only a Connector at connectors/ counts; nothing else there or elsewhere does.
  const stray = installedRecipes([
    { id: "connectors/readme", frontmatter: { type: "Note", title: "About" }, body: "" },
    { id: "notes/connector", frontmatter: { type: "Connector", title: "Misplaced" }, body: "" },
  ]);
  assert.deepEqual(stray, { rows: [], unstamped: [] });
});

test("end to end: install, stamps, a report, an evolve that adds a source, then a refusal on a locally edited Connector", async () => {
  await offline(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "superbee-connector-e2e-"));
    try {
      const bundle = await initBundle(dir, { okfVersion: "0.2" });
      const v1 = calendar("1");
      const installed = await installRecipe(bundle, v1, { now: NOW });
      assert.deepEqual(installed.connectors, [{ id: CONNECTOR_ID, changed: true }]);

      const file = path.join(dir, `${CONNECTOR_ID}.md`);
      const stamped = parseMarkdown(await readFile(file, "utf8"));
      assert.deepEqual([stampOf({ id: CONNECTOR_ID, ...stamped }).of, stampOf({ id: CONNECTOR_ID, ...stamped }).connectors], [1, 1]);
      assert.deepEqual((await report(bundle, [v1])).rows.map(({ state, conventions, connectors }) => [state, conventions, connectors]), [["installed", 1, 1]]);

      const v2 = calendar("2", TWO_SOURCES_MD);
      const plan = await planRecipeEvolution(bundle, v2);
      assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
      assert.equal((await applyRecipeEvolution(bundle, v2, plan.plan_token)).recipe, "evolved");
      assert.deepEqual((await report(bundle, [v2])).rows.map(({ state, version }) => [state, version]), [["installed", "2"]]);

      // A person edits the Connector file by hand.
      const local = parseMarkdown(await readFile(file, "utf8"));
      await writeFile(file, stringifyDoc({ ...local.frontmatter, description: "Ours now." }, local.body));
      const edited = await readFile(file, "utf8");
      const v3 = calendar("3", TWO_SOURCES_MD.replace("completeness: partial", "completeness: complete"));
      const blocked = await planRecipeEvolution(bundle, v3);
      assert.equal(blocked.ready, false);
      assert.deepEqual(blocked.blockers.map(({ code, id }) => [code, id]), [["RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED", CONNECTOR_ID]]);
      await assert.rejects(applyRecipeEvolution(bundle, v3, blocked.plan_token), RecipeEvolutionBlocked);
      assert.equal(await readFile(file, "utf8"), edited, "the person's edit stands, byte for byte");
      assert.equal((await report(bundle, [v3])).rows[0]!.state, "diverged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("evolve: mixed convention, Connector and Reference targets retain definition counts and aggregate total writes", async () => {
  const { bundle } = await memoryBundle("mixed-reference");
  const v1 = calendar("1");
  v1.references = [{ doc: { id: "references/calendar-guide", frontmatter: { type: "Reference", title: "Calendar guide" }, body: "Original guide.\n" } }];
  await installRecipe(bundle, v1);
  const v2 = calendar("2");
  v2.references = [{ doc: { ...v1.references[0]!.doc, body: "Updated guide.\n" } }];
  const plan = await planRecipeEvolution(bundle, v2);
  assert.equal(plan.ready, true);
  assert.equal(plan.changed, true);
  assert.equal(plan.writes, 3);
  assert.equal(plan.definitions.length, 2);
  assert.equal(plan.counts.updates, 0);
  assert.equal(plan.counts.stamp_writes, 2);
  assert.equal(plan.reference_assets!.counts.updates, 1);
  const applied = await applyRecipeEvolution(bundle, v2, plan.plan_token);
  assert.equal(applied.recipe, "evolved");
  assert.deepEqual(applied.counts, { updated: 0, stamped: 2, unchanged: 0 });
  assert.deepEqual(applied.reference_assets!.counts, { updated: 1, stamped: 0, unchanged: 0 });
  assert.equal((await planRecipeEvolution(bundle, v2)).writes, 0);
});
