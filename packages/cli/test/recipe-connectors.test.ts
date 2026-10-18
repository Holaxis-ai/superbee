// `recipe add`, `recipes` and `recipe evolve` over a recipe that carries a Connector
// (designs/recipe-connectors-2026-10-17, sections 5.2 to 5.4), on a local bundle and on a bundle
// inside a Git work tree. Nothing here makes a network call.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseMarkdown, stringifyDoc } from "@superbee/core";

import { CliError } from "../src/errors.js";
import { init } from "../src/commands/init.js";
import { recipe, RECIPE_USAGE } from "../src/commands/recipe.js";
import { recipes, RECIPES_USAGE } from "../src/commands/recipes.js";

const run = promisify(execFile);
const CONNECTOR_ID = "connectors/example-calendar";

const EVENT_KIND = `---
type: Convention
title: Event
governs: Event
path: events/
fields:
  required: [title, start, event_status]
  optional: [end, event_url, note]
  values:
    event_status: [scheduled, canceled, postponed]
  types:
    start: datetime
    end: datetime
    event_url: https-url
---
# Event
`;

const CONNECTOR = `---
type: Connector
title: Example calendar (synthetic)
description: A keyless iCalendar source.
version: "1"
auth:
  kind: none
domains:
  - calendar.example.org
record_sources:
  - name: events
    profile: ics
    target_kind: Event
    mode: overlay
    identity:
      resource: "https://calendar.example.org/{feed}.ics"
      id: "{uid}"
    fields:
      title: summary
      start: dtstart
      end: dtend
      event_url: url
      event_status:
        from: status
        values: { CONFIRMED: scheduled, CANCELLED: canceled }
    completeness: complete
actions: []
events: []
---
# Example calendar

No real provider publishes it.
`;

/** Version 2 adds a second, partial source. */
const TWO_SOURCES = CONNECTOR.replace("actions: []\n", `  - name: listings
    profile: ics
    target_kind: Event
    mode: overlay
    identity:
      resource: "https://calendar.example.org/listings/{feed}.ics"
      id: "{uid}"
    fields:
      title: summary
    completeness: partial
actions: []
`);

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `superbee-connector-${prefix}-`));
}

/** A recipe folder at `version` carrying `connector`, and the Event Kind unless `kind` is false. */
async function recipeFolder(version: string, connector = CONNECTOR, kind = true): Promise<string> {
  const dir = await tempDir("recipe");
  await mkdir(path.join(dir, "conventions"), { recursive: true });
  await mkdir(path.join(dir, "connectors"), { recursive: true });
  await writeFile(path.join(dir, "recipe.md"), `---\ntype: Recipe\nid: example-calendar\ntitle: Example calendar\nversion: "${version}"\nsummary: The Event Kind and a connector onto it.\ncontent_policy: definitions-only\nconnectors:\n  - connectors/example-calendar.md\n---\n`);
  if (kind) await writeFile(path.join(dir, "conventions/event.md"), EVENT_KIND);
  else await writeFile(path.join(dir, "conventions/shelf.md"), "---\ntype: Convention\ntitle: Shelf\ngoverns: Shelf\n---\n# Shelf\n");
  await writeFile(path.join(dir, "connectors/example-calendar.md"), connector);
  return dir;
}

async function runJson(cmd: (argv: string[], deps: { stdout: (s: string) => void }) => Promise<void>, argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await cmd([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Fail the test if anything reaches for the network while `body` runs. */
async function offline<T>(body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("a network call was made");
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** Install, report, evolve with a new source, then refuse a locally edited Connector, in `bundle`. */
async function journey(bundle: string): Promise<void> {
  const folders: string[] = [];
  try {
    const v1 = await recipeFolder("1");
    folders.push(v1);
    const added = await runJson(recipe, ["add", v1, "--dir", bundle]);
    assert.deepEqual([added.recipe, added.changed, added.stamp], ["added", true, "current"]);
    assert.deepEqual(added.connectors, [{ id: CONNECTOR_ID, changed: true }]);
    assert.deepEqual(added.counts, { created: 2, existing: 0, legacy_present: 0, migration_required: 0 });
    const stamp = parseMarkdown(await readFile(path.join(bundle, `${CONNECTOR_ID}.md`), "utf8")).frontmatter.x_recipe as Record<string, unknown>;
    assert.deepEqual([stamp.id, stamp.version, stamp.of, stamp.connectors], ["example-calendar", "1", 1, 1]);

    const again = await runJson(recipe, ["add", v1, "--dir", bundle]);
    assert.deepEqual([again.recipe, again.connectors], ["already applied", [{ id: CONNECTOR_ID, changed: false }]]);

    const listed = await runJson(recipes, ["--dir", bundle]);
    const row = (listed.installed as Array<Record<string, unknown>>).find((entry) => entry.id === "example-calendar");
    assert.deepEqual(row, {
      id: "example-calendar", state: "installed", version: "1", source_digest: row?.source_digest,
      conventions: 1, of: 1, connectors: 1, connectors_of: 1,
    });
    assert.equal(listed.stamp_help, undefined);

    const v2 = await recipeFolder("2", TWO_SOURCES);
    folders.push(v2);
    const plan = await runJson(recipe, ["evolve", v2, "--dir", bundle]);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    assert.deepEqual((plan.definitions as Array<Record<string, unknown>>).map(({ id, governs, action, stamp: state }) => [id, governs, action, state]), [
      ["conventions/event", "Event", "unchanged", "stale"],
      [CONNECTOR_ID, "Connector", "update", "stale"],
    ]);
    assert.equal(plan.writes, 2);
    const applied = await runJson(recipe, ["evolve", v2, "--dir", bundle, "--apply", String(plan.plan_token)]);
    assert.equal(applied.recipe, "evolved");
    const evolved = parseMarkdown(await readFile(path.join(bundle, `${CONNECTOR_ID}.md`), "utf8")).frontmatter;
    assert.deepEqual((evolved.record_sources as Array<{ name: string }>).map((source) => source.name), ["events", "listings"]);

    // A person edits the Connector by hand; the next version's plan refuses to replace it.
    const file = path.join(bundle, `${CONNECTOR_ID}.md`);
    const local = parseMarkdown(await readFile(file, "utf8"));
    await writeFile(file, stringifyDoc({ ...local.frontmatter, description: "Ours now." }, local.body));
    const edited = await readFile(file, "utf8");
    const v3 = await recipeFolder("3", TWO_SOURCES.replace("completeness: partial", "completeness: complete"));
    folders.push(v3);
    const blocked = await runJson(recipe, ["evolve", v3, "--dir", bundle]);
    assert.equal(blocked.ready, false);
    assert.equal((blocked.commands as Record<string, unknown> | undefined)?.apply, undefined);
    assert.deepEqual((blocked.blockers as Array<Record<string, unknown>>).map(({ code, id, field }) => [code, id, field]), [["RECIPE_EVOLUTION_REPLACEMENT_UNSUPPORTED", CONNECTOR_ID, "/"]]);
    await assert.rejects(runJson(recipe, ["evolve", v3, "--dir", bundle, "--apply", String(blocked.plan_token)]), (error: unknown) => error instanceof CliError && error.code === "CONFLICT");
    assert.equal(await readFile(file, "utf8"), edited, "the person's edit stands, byte for byte");
    const after = await runJson(recipes, ["--dir", bundle]);
    const diverged = (after.installed as Array<Record<string, unknown>>).find((entry) => entry.id === "example-calendar")!;
    assert.deepEqual([diverged.state, diverged.diverged], ["diverged", [CONNECTOR_ID]]);
    assert.match(String(after.stamp_help), /a Connector a person changed reads diverged/);
  } finally {
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
  }
}

test("a local bundle: recipe add, recipes, recipe evolve and the refusal to replace an edited Connector", async () => {
  const dir = await tempDir("local");
  try {
    await init(["--dir", dir, "--recipe", "none"], { stdout: () => {} });
    await offline(() => journey(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bundle in a Git work tree takes the same path", async () => {
  const repo = await tempDir("git");
  try {
    await run("git", ["init", "-q", repo]);
    const bundle = path.join(repo, ".superbee");
    await init(["--dir", bundle, "--recipe", "none"], { stdout: () => {} });
    await offline(() => journey(bundle));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("recipe add refuses a Connector whose target Kind the bundle lacks, naming the Kind, before any write", async () => {
  const dir = await tempDir("missing-kind");
  const source = await recipeFolder("1", CONNECTOR, false);
  try {
    await init(["--dir", dir, "--recipe", "none"], { stdout: () => {} });
    const error = await runJson(recipe, ["add", source, "--dir", dir]).then(() => assert.fail("added"), (caught: unknown) => caught as CliError);
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "USAGE");
    assert.deepEqual(error.details, { recipe: "example-calendar", connector: CONNECTOR_ID, source: "events", kind: "Event", code: "CONNECTOR_TARGET_KIND_INVALID" });
    assert.match(String(error.help), /declare the Event Kind/);
    await assert.rejects(readFile(path.join(dir, "conventions/shelf.md"), "utf8"), "the recipe's own convention was not written");
    await assert.rejects(readFile(path.join(dir, `${CONNECTOR_ID}.md`), "utf8"), "nor its Connector");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a malformed Connector fails the recipe before any bundle is touched, naming its first refusal", async () => {
  const dir = await tempDir("invalid");
  const source = await recipeFolder("1", CONNECTOR.replace("    mode: overlay\n", "    mode: mirror\n"));
  try {
    await init(["--dir", dir, "--recipe", "none"], { stdout: () => {} });
    for (const sub of ["add", "evolve"]) {
      const error = await runJson(recipe, [sub, source, "--dir", dir]).then(() => assert.fail("accepted"), (caught: unknown) => caught as CliError);
      assert.equal(error.code, "USAGE");
      assert.deepEqual(error.details, { connector: { id: CONNECTOR_ID, code: "CONNECTOR_MODE_UNSUPPORTED", path: "/record_sources/0/mode", count: 1 } });
      assert.match(error.message, /invalid Connector 'connectors\/example-calendar\.md': CONNECTOR_MODE_UNSUPPORTED/);
    }
    await assert.rejects(readFile(path.join(dir, "conventions/event.md"), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("help names Connectors for recipe and recipes", () => {
  assert.match(RECIPE_USAGE, /'type: Connector' declarations under\n'connectors\/'/);
  assert.match(RECIPE_USAGE, /A Connector\nhas no additive merge/);
  assert.match(RECIPES_USAGE, /'connectors_of'/);
});
