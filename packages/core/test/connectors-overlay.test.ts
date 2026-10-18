/**
 * The generic example connector end to end, with no network: the real parser, `bindSourceFeed`,
 * `mapRecord`, `changeBetween` and `findingsFor`, then record-overlay's `planRecordOverlay`,
 * `planFindings` and `applyRecordOverlay` over MemoryBackend. The Source Feed and Signal Kinds come
 * from `examples/recipes/source-feeds`, installed through the recipe lifecycle. The diff between
 * observations below (which record changed and how) is test code standing in for I3's runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindSourceFeed,
  changeBetween,
  findingsFor,
  mapRecord,
  parseConnectorDoc,
  renderIdentity,
  type BoundFeed,
  type Connector,
  type MappingDiagnostic,
} from "../src/connectors.js";
import { mutateDocument } from "../src/document-mutation.js";
import { parseMarkdown } from "../src/frontmatter.js";
import { loadKinds } from "../src/kinds-load.js";
import { installRecipe } from "../src/recipe-lifecycle/index.js";
import { parseRecipeFiles, type LoadedRecipe } from "../src/recipes.js";
import {
  applyRecordOverlay,
  OverlayRefusal,
  planFindings,
  planRecordOverlay,
  type OverlayBundle,
  type OverlayPlan,
  type OverlayReceipt,
  type RecordChange,
} from "../src/record-overlay/index.js";
import type { Frontmatter, Version } from "../src/types.js";
import { buildKindRegistry, type KindRegistry } from "../src/kinds.js";
import {
  CONNECTOR_ID,
  CONNECTOR_MD,
  EVENT_CONVENTION_MD,
  parseExampleConnector,
  readObservations,
  RECIPE_FILES,
  STRICT_CONNECTOR_MD,
  toNormalized,
} from "./fixtures/connectors/example-calendar.js";
import { RecordingBackend } from "./record-overlay-helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = "2026-10-01T00:00:00.000Z";
const ACTOR = "process:connector-test";
const EDITOR = "human:editor";
const FEED_ID = "source-feeds/library";
const FEED_URL = "https://calendar.example.org/library.ics";
const FEED = {
  type: "Source Feed", title: "Library calendar (synthetic)", feed_kind: "connector", connector: CONNECTOR_ID, source: "events",
  url: FEED_URL, owned_fields: ["title", "start", "end", "event_status", "event_url"],
  auto_apply: ["changed", "canceled"], needs_review: ["new", "canceled", "disappeared"],
};
const STORY = "evt-story@calendar.example.org";
const MARKET = "evt-market@calendar.example.org";
const EDITOR_BODY = "Editor-written description. Not feed-owned.\n";

async function exampleRecipe(name: string): Promise<LoadedRecipe> {
  const root = path.resolve(here, "../../../examples/recipes", name);
  const files: Array<{ path: string; bytes: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push({ path: path.relative(root, full).split(path.sep).join("/"), bytes: await readFile(full, "utf8") });
    }
  };
  await walk(root);
  const loaded = parseRecipeFiles(files, `example:${name}`, { okfVersion: "0.2" });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.error.message);
  return loaded.recipe;
}

interface World {
  overlay: OverlayBundle;
  backend: RecordingBackend;
  connector: Connector;
  bound: BoundFeed;
  /** The last accepted `after` per record: the caller's store. */
  store: Map<string, Record<string, unknown>>;
  put(id: string, frontmatter: Record<string, unknown>, body?: string): Promise<Version>;
  edit(id: string, patch: Record<string, unknown>): Promise<Version>;
  read(id: string): Promise<{ frontmatter: Frontmatter; body: string; version: Version }>;
}

async function world(options: { connector?: string; overlays?: Array<{ uid: string; fields: Record<string, unknown> }> } = {}): Promise<World> {
  const backend = new RecordingBackend();
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Connectors\n");
  const bundle = { root: "mem://connectors", backend };
  await installRecipe(bundle, await exampleRecipe("source-feeds"), { now: NOW });
  const calendar = parseRecipeFiles(RECIPE_FILES, "fixture:example-calendar", { okfVersion: "0.2" });
  assert.ok(calendar.ok);
  await installRecipe(bundle, calendar.recipe, { now: NOW });
  const registry = await loadKinds(bundle);
  assert.deepEqual(registry.warnings, []);
  const overlay: OverlayBundle = { bundle, registry, okfVersion: "0.2" };
  const put = async (id: string, frontmatter: Record<string, unknown>, body = ""): Promise<Version> => (await mutateDocument({
    bundle, id, mode: "patch", onAbsent: "create", registry, strict: true, actor: EDITOR,
    buildCandidate: () => ({ frontmatter: structuredClone(frontmatter) as unknown as Frontmatter, body }),
  })).version;
  await put(FEED_ID, FEED, "Synthetic feed.\n");
  for (const o of options.overlays ?? []) {
    await put(`events/${o.uid.split("@")[0]!.replace(/^evt-/, "")}`, { type: "Event", ...o.fields, sources: [{ resource: FEED_URL, id: o.uid }] }, EDITOR_BODY);
  }
  const connector = parseExampleConnector(options.connector ?? CONNECTOR_MD);
  const feed = await backend.read(FEED_ID);
  backend.writes = [];
  return {
    overlay, backend, connector, bound: bindSourceFeed(connector, feed.doc, registry), store: new Map(), put,
    edit: async (id, patch) => (await mutateDocument({
      bundle, id, mode: "patch", registry, strict: false, actor: EDITOR,
      buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter, ...patch } as Frontmatter, body: existing!.body }),
    })).version,
    read: async (id) => {
      const { doc, version } = await backend.read(id);
      return { frontmatter: doc.frontmatter, body: doc.body, version };
    },
  };
}

/** Test-only diff: each mapped record against the store, with a change kind. */
function observe(w: World, records: ReadonlyArray<Record<string, unknown>>) {
  const changes: RecordChange[] = [];
  const diagnostics: MappingDiagnostic[] = [];
  const present: string[] = [];
  const refused: string[] = [];
  const lastModified = new Map<string, string>();
  for (const record of records) {
    const mapped = mapRecord(w.bound.source, record, w.bound.kind);
    diagnostics.push(...mapped.diagnostics);
    if (mapped.kind === "refused") {
      if (mapped.present) { present.push(mapped.external_id!); refused.push(mapped.external_id!); }
      continue;
    }
    present.push(mapped.external_id);
    if (typeof record.last_modified === "string") lastModified.set(mapped.external_id, record.last_modified);
    const previous = w.store.get(mapped.external_id) ?? null;
    const change = changeBetween(previous, mapped, { external_id: mapped.external_id, change_kind: "changed" });
    if (previous === null) change.change_kind = "new";
    else if (change.changed_fields.length === 0) { w.store.set(mapped.external_id, change.after!); continue; }
    else if (change.after?.event_status === "canceled" && previous.event_status !== "canceled") change.change_kind = "canceled";
    changes.push(change);
  }
  return { changes, diagnostics, present, refused, lastModified };
}

const AT = "2026-10-03T14:00:00Z";

async function run(w: World, records: ReadonlyArray<Record<string, unknown>>, observedAt = AT) {
  const seen = observe(w, records);
  const plan = await planRecordOverlay({
    content: w.overlay, ops: w.overlay, policy: w.bound.policy, changes: seen.changes, observedAt, sameBundle: true,
    hooks: { sourceProperties: (change) => (seen.lastModified.has(change.external_id) ? { revision: seen.lastModified.get(change.external_id)! } : undefined) },
  });
  const receipt = await applyRecordOverlay(plan, { content: w.overlay, ops: w.overlay, policy: w.bound.policy, actor: ACTOR });
  for (const change of seen.changes) w.store.set(change.external_id, change.after!);
  const findings = await runFindings(w, seen.diagnostics, observedAt);
  return { ...seen, plan, receipt, findings };
}

async function runFindings(w: World, diagnostics: readonly MappingDiagnostic[], observedAt = AT): Promise<{ plan: OverlayPlan; receipt: OverlayReceipt }> {
  const steps = await planFindings({
    ops: w.overlay, provider: w.bound.policy.provider, feed: FEED_ID, slug: "library-mapping",
    findings: findingsFor(diagnostics, { source: w.bound.source.name }), observedAt,
  });
  const plan: OverlayPlan = { feed: FEED_ID, provider: w.bound.policy.provider, observed_at: observedAt, steps, refusals: [] };
  return { plan, receipt: await applyRecordOverlay(plan, { content: w.overlay, ops: w.overlay, policy: w.bound.policy, actor: ACTOR }) };
}

async function signals(w: World) {
  const out = [];
  for (const id of await w.backend.list("signals/")) out.push((await w.backend.read(id)).doc.frontmatter);
  return out;
}

const OBS = readObservations();
const storyFields = { title: "Story Time", start: "2026-10-10T14:00:00Z", end: "2026-10-10T15:00:00Z", event_url: "https://calendar.example.org/events/story", event_status: "scheduled" };
const marketFields = { title: "Harvest Market", start: "2026-10-11T13:00:00Z", end: "2026-10-11T17:00:00Z", event_status: "scheduled" };
const storyRecord = toNormalized({ UID: STORY, SUMMARY: "Story Time", DTSTART: "20261010T140000Z", DTEND: "20261010T150000Z", URL: storyFields.event_url, STATUS: "CONFIRMED" });

/** A world holding the story overlay and its last accepted values. */
async function storyWorld(connector?: string): Promise<World> {
  const w = await world({ connector, overlays: [{ uid: STORY, fields: storyFields }] });
  w.store.set(STORY, { ...storyFields });
  return w;
}

// ------------------------------------------------------------------------------------------ binding

test("the example connector parses through parseConnectorDoc and binds the library feed: parameters, resource equal to url, the source's completeness", async () => {
  const w = await world();
  assert.equal(w.connector.id, CONNECTOR_ID);
  assert.deepEqual(w.bound.parameters, { feed: "library" });
  assert.equal(w.bound.resource, FEED_URL);
  assert.equal(w.bound.policy.provider, FEED_URL);
  assert.equal(w.bound.policy.completeness, "complete");
  assert.equal(w.bound.policy.target_kind, "Event", "the source's target Kind, though the feed names none");
  assert.deepEqual(w.bound.policy.owned_fields, FEED.owned_fields);
  assert.equal(w.bound.kind.governs, "Event");
  const identity = renderIdentity(w.bound.source, w.bound, storyRecord);
  assert.deepEqual(identity, { ok: true, resource: FEED_URL, id: STORY });
});

test("bindSourceFeed refuses each widening feed value with POLICY_INVALID naming the feed and the key", async () => {
  const w = await world();
  const partial = parseExampleConnector(CONNECTOR_MD.replace("completeness: complete", "completeness: partial"));
  const cases: Array<[string, Record<string, unknown>, string, Connector?]> = [
    ["dot-dot parameter", { url: "https://calendar.example.org/...ics" }, "url"],
    ["percent-encoded parameter", { url: "https://calendar.example.org/a%2Fb.ics" }, "url"],
    ["host case variant", { url: "https://Calendar.example.org/library.ics" }, "url"],
    ["query appended", { url: `${FEED_URL}?all=1` }, "url"],
    ["slash inside a parameter", { url: "https://calendar.example.org/a/b.ics" }, "url"],
    ["owned field outside the mapping", { owned_fields: ["title", "summary"] }, "owned_fields"],
    ["another target Kind", { target_kind: "Place" }, "target_kind"],
    ["a wider completeness", { completeness: "complete" }, "completeness", partial],
    ["another profile", { profile: "rss" }, "profile"],
    ["another connector", { connector: "connectors/other" }, "connector"],
    ["an undeclared source", { source: "tasks" }, "source"],
  ];
  for (const [label, patch, key, connector] of cases) {
    assert.throws(
      () => bindSourceFeed(connector ?? w.connector, { id: FEED_ID, frontmatter: { ...FEED, ...patch } as unknown as Frontmatter }, w.overlay.registry),
      (e: unknown) => e instanceof OverlayRefusal && e.code === "POLICY_INVALID" && e.details.feed === FEED_ID && e.details.key === key,
      label,
    );
  }
  const omit = (key: string) => Object.fromEntries(Object.entries(FEED).filter(([k]) => k !== key));
  const policyCases: Array<[string, Record<string, unknown>, string]> = [
    ["no owned_fields", omit("owned_fields"), "owned_fields"],
    ["a never-owned field", { ...FEED, owned_fields: ["title", "sources"] }, "owned_fields"],
    ["a bad missing_threshold", { ...FEED, missing_threshold: 0 }, "missing_threshold"],
    ["a bad exclude_pattern", { ...FEED, exclude_pattern: "(" }, "exclude_pattern"],
  ];
  for (const [label, frontmatter, key] of policyCases) {
    assert.throws(
      () => bindSourceFeed(w.connector, { id: FEED_ID, frontmatter: frontmatter as unknown as Frontmatter }, w.overlay.registry),
      (e: unknown) => e instanceof OverlayRefusal && e.code === "POLICY_INVALID" && e.details.feed === FEED_ID && e.details.key === key,
      label,
    );
  }
  const nested = (depth: number): unknown => (depth === 0 ? "x" : Array(9).fill(nested(depth - 1)));
  const shapeCases: Array<[string, Record<string, unknown>, string]> = [
    ["owned_fields expanding by alias", { ...FEED, owned_fields: nested(6) }, "owned_fields"],
    ["a nested auto_apply", { ...FEED, auto_apply: [["changed"]] }, "auto_apply"],
    ["a list needs_review entry", { ...FEED, needs_review: ["new", { kind: "canceled" }] }, "needs_review"],
    ["a list exclude_pattern", { ...FEED, exclude_pattern: nested(6) }, "exclude_pattern"],
    ["a list missing_threshold", { ...FEED, missing_threshold: [[3]] }, "missing_threshold"],
  ];
  for (const [label, frontmatter, key] of shapeCases) {
    assert.throws(
      () => bindSourceFeed(w.connector, { id: FEED_ID, frontmatter: frontmatter as unknown as Frontmatter }, w.overlay.registry),
      (e: unknown) => e instanceof OverlayRefusal && e.code === "POLICY_INVALID" && e.details.key === key,
      label,
    );
  }
  const yamlFeed = parseMarkdown(`---\ntype: Source Feed\ntitle: Bomb\nconnector: ${CONNECTOR_ID}\nsource: events\nurl: ${FEED_URL}\nx0: &a0 [title,title,title,title,title,title,title,title,title]\n${[1, 2, 3, 4, 5, 6].map((i) => `x${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(",")}]`).join("\n")}\nowned_fields: *a6\n---\n`);
  assert.throws(
    () => bindSourceFeed(w.connector, { id: FEED_ID, frontmatter: yamlFeed.frontmatter }, w.overlay.registry),
    (e: unknown) => e instanceof OverlayRefusal && e.code === "POLICY_INVALID" && e.details.key === "owned_fields",
    "a YAML alias expansion in a feed is a typed refusal, never a RangeError",
  );
  const same = bindSourceFeed(w.connector, { id: FEED_ID, frontmatter: { ...FEED, target_kind: "Event", completeness: "complete", profile: "ics" } as unknown as Frontmatter }, w.overlay.registry);
  const commaList = bindSourceFeed(w.connector, { id: FEED_ID, frontmatter: { ...FEED, owned_fields: "title, start" } as unknown as Frontmatter }, w.overlay.registry);
  assert.deepEqual(commaList.policy.owned_fields, ["title", "start"], "the reader's comma form still binds");
  assert.equal(same.resource, FEED_URL, "equal values are admitted");
});

test("bindSourceFeed checks the source against the bundle's Kind as it is now: list types, enum outputs and claim fields", () => {
  const connector = parseExampleConnector();
  const { frontmatter, body } = parseMarkdown(EVENT_CONVENTION_MD);
  const eventWith = (edit: (fm: Record<string, any>) => void) => {
    const fm = structuredClone(frontmatter) as Record<string, any>;
    edit(fm);
    return buildKindRegistry([{ id: "conventions/event", frontmatter: fm as Frontmatter, body }]);
  };
  const cases: Array<[string, KindRegistry, string[]]> = [
    ["event_status became a list, mapped through a values table", eventWith((fm) => { fm.fields.types.event_status = "string-list"; }), ["CONNECTOR_LIST_FIELD_UNSUPPORTED"]],
    ["canceled left the enum", eventWith((fm) => { fm.fields.values.event_status = ["scheduled", "postponed"]; }), ["CONNECTOR_VALUES_INVALID"]],
    ["end became the claim owner", eventWith((fm) => { fm.claim = { owner_field: "end", state_field: "event_status" }; }), ["CONNECTOR_FIELD_NEVER_OWNED", "CONNECTOR_FIELD_NEVER_OWNED"]],
  ];
  for (const [label, kinds, expected] of cases) {
    assert.throws(
      () => bindSourceFeed(connector, { id: FEED_ID, frontmatter: FEED as unknown as Frontmatter }, kinds),
      (e: unknown) => e instanceof OverlayRefusal && e.code === "POLICY_INVALID" && e.details.key === "connector" && JSON.stringify(e.details.codes) === JSON.stringify(expected),
      label,
    );
  }
  assert.equal(bindSourceFeed(connector, { id: FEED_ID, frontmatter: FEED as unknown as Frontmatter }, eventWith(() => {})).resource, FEED_URL);
  const urlList = eventWith((fm) => { fm.fields.types.event_url = "https-url-list"; });
  const listed = bindSourceFeed(connector, { id: FEED_ID, frontmatter: FEED as unknown as Frontmatter }, urlList, { okfVersion: "0.2" });
  assert.deepEqual(listed.policy.list_fields, ["event_url"], "a list field without a values table maps whole and reaches the policy as a set field");
});

test("bindSourceFeed refuses an owned list field on an OKF v0.1 bundle, naming the edition and the fields", () => {
  const connector = parseExampleConnector();
  const { frontmatter, body } = parseMarkdown(EVENT_CONVENTION_MD);
  const fm = structuredClone(frontmatter) as Record<string, any>;
  fm.fields.types.event_url = "https-url-list";
  const kinds = buildKindRegistry([{ id: "conventions/event", frontmatter: fm as Frontmatter, body }]);
  const owning = { id: FEED_ID, frontmatter: FEED as unknown as Frontmatter };
  for (const options of [{ okfVersion: "0.1" as const }, {}]) {
    assert.throws(
      () => bindSourceFeed(connector, owning, kinds, options),
      (e: unknown) => e instanceof OverlayRefusal && e.code === "POLICY_INVALID" && e.details.key === "owned_fields"
        && JSON.stringify(e.details.fields) === JSON.stringify(["event_url"]) && e.details.okf_version === "0.1" && /v0\.1/.test(e.message),
      `refused with ${JSON.stringify(options)}`,
    );
  }
  const scalarsOnly = { id: FEED_ID, frontmatter: { ...FEED, owned_fields: (FEED.owned_fields as string[]).filter((f) => f !== "event_url") } as unknown as Frontmatter };
  assert.deepEqual(bindSourceFeed(connector, scalarsOnly, kinds).policy.list_fields, ["event_url"], "a v0.1 feed that owns no list field still binds");
});

// --------------------------------------------------------------------------------- two observations

test("two observations map onto overlays through the real planner and apply", async () => {
  const w = await world({ overlays: [{ uid: STORY, fields: storyFields }, { uid: MARKET, fields: marketFields }] });
  const story0 = await w.read("events/story");

  const first = await run(w, OBS[0]!.records, OBS[0]!.observed_at);
  assert.equal(first.plan.steps.filter((s) => s.op === "apply-owned-fields").length, 0, "new records with overlays write nothing");
  const raised = await signals(w);
  assert.equal(raised.length, 4);
  const byRecord = Object.fromEntries(raised.map((s) => [s.external_id as string, s]));
  assert.equal(byRecord[STORY]!.priority, "normal", "new with an overlay needs review");
  assert.equal(byRecord[MARKET]!.priority, "normal");
  assert.equal(byRecord["evt-film@calendar.example.org"]!.priority, "low", "new without an overlay is low");
  assert.equal(byRecord["evt-talk@calendar.example.org"]!.priority, "low");
  assert.equal((await w.read("events/story")).version, story0.version);

  const second = await run(w, OBS[1]!.records, OBS[1]!.observed_at);
  const applies = second.plan.steps.filter((s) => s.op === "apply-owned-fields");
  const storyStep = applies.find((s) => s.external_id === STORY)!;
  assert.deepEqual(Object.keys(storyStep.fields), ["title"]);
  assert.deepEqual(storyStep.sources, { revision: "2026-10-03T18:00:00Z" }, "the grouped upsert carries the record's revision");
  const story = await w.read("events/story");
  assert.equal(story.frontmatter.title, "Story Time for Toddlers");
  assert.equal(story.body, EDITOR_BODY);
  assert.deepEqual(story.frontmatter.sources, [{ resource: FEED_URL, id: STORY, revision: "2026-10-03T18:00:00Z" }]);
  assert.equal(w.backend.writes.filter((id) => id === "events/story").length, 1, "one version for the title change");

  const market = await w.read("events/market");
  assert.equal(market.frontmatter.event_status, "canceled", "CANCELLED is emitted as canceled and applied");
  const marketSignal = (await signals(w)).find((s) => s.external_id === MARKET)!;
  assert.equal(marketSignal.priority, "urgent");
  assert.equal(marketSignal.change_kind, "canceled");
  assert.ok(second.receipt.results.every((r) => r.outcome !== "refused"), JSON.stringify(second.receipt.results));
});

// ------------------------------------------------------------------------------------- unmapped keep

test("keep: an unmapped value on a required field leaves the field unobserved, plans nothing for it and raises one low Signal", async () => {
  const w = await storyWorld();
  const before = await w.read("events/story");
  const withdrawn = { ...storyRecord, status: "WITHDRAWN" };
  const mapped = mapRecord(w.bound.source, withdrawn, w.bound.kind);
  assert.equal(mapped.kind, "mapped");
  if (mapped.kind !== "mapped") return;
  assert.deepEqual(mapped.unobserved, ["event_status"]);
  assert.deepEqual(mapped.diagnostics.map((d) => [d.code, d.field, d.native]), [["VALUE_UNMAPPED", "event_status", "WITHDRAWN"]]);
  const change = changeBetween(w.store.get(STORY)!, mapped, { external_id: STORY, change_kind: "changed" });
  assert.equal(change.after!.event_status, "scheduled", "carried from the last accepted value");
  assert.deepEqual(change.changed_fields, []);

  const out = await run(w, [withdrawn]);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.plan.steps, []);
  const after = await w.read("events/story");
  assert.equal(after.version, before.version, "the document is untouched");
  assert.deepEqual(after.frontmatter, before.frontmatter);
  const raised = await signals(w);
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.priority, "low");
  assert.equal(raised[0]!.change_kind, "status-check");
  assert.match(String(raised[0]!.diff_summary), /WITHDRAWN/);

  const replay = await runFindings(w, out.diagnostics);
  assert.deepEqual(replay.plan.steps.map((s) => s.op), ["signal-duplicate"]);
  assert.equal((await signals(w)).length, 1);
});

test("keep: the record's other fields still update and the required field is never removed (no KIND_REJECTED)", async () => {
  const w = await storyWorld();
  const out = await run(w, [{ ...storyRecord, summary: "Story Time (moved room)", status: "WITHDRAWN" }]);
  const step = out.plan.steps.find((s) => s.op === "apply-owned-fields");
  assert.ok(step && step.op === "apply-owned-fields");
  assert.deepEqual(Object.keys(step.fields), ["title"]);
  assert.ok(out.receipt.results.every((r) => r.code !== "KIND_REJECTED" && r.outcome !== "refused"), JSON.stringify(out.receipt.results));
  const story = await w.read("events/story");
  assert.equal(story.frontmatter.title, "Story Time (moved room)");
  assert.equal(story.frontmatter.event_status, "scheduled");
});

test("keep, keep, then a mapped value applies with no conflict (the carried value is the next baseline)", async () => {
  const w = await storyWorld();
  for (let i = 0; i < 2; i++) {
    const out = await run(w, [{ ...storyRecord, status: "WITHDRAWN" }]);
    assert.deepEqual(out.plan.refusals, []);
    assert.equal(w.store.get(STORY)!.event_status, "scheduled", "the stored after keeps the carried value");
  }
  const third = await run(w, [{ ...storyRecord, status: "CANCELLED" }]);
  assert.deepEqual(third.plan.refusals, [], "no OVERLAY_DOC_CONFLICT");
  const step = third.plan.steps.find((s) => s.op === "apply-owned-fields");
  assert.ok(step && step.op === "apply-owned-fields");
  assert.deepEqual(step.fields, { event_status: { from: "scheduled", to: "canceled" } });
  assert.equal((await w.read("events/story")).frontmatter.event_status, "canceled");
});

// ----------------------------------------------------------------------------------- unmapped refuse

test("refuse: the record is refused, reported present, the document unchanged, and one normal Signal raised", async () => {
  const w = await storyWorld(STRICT_CONNECTOR_MD);
  const before = await w.read("events/story");
  const record = { ...storyRecord, summary: "Retitled", status: "WITHDRAWN" };
  const mapped = mapRecord(w.bound.source, record, w.bound.kind);
  assert.equal(mapped.kind, "refused");
  if (mapped.kind !== "refused") return;
  assert.equal(mapped.present, true);
  assert.equal(mapped.external_id, STORY);
  assert.deepEqual(mapped.diagnostics.map((d) => d.code), ["RECORD_REFUSED"]);
  const out = await run(w, [record]);
  assert.deepEqual(out.present, [STORY], "a refused record counts as present");
  assert.equal(out.changes.length, 0, "no RecordChange");
  assert.equal((await w.read("events/story")).version, before.version);
  const raised = await signals(w);
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.priority, "normal");
});

// ----------------------------------------------------------------------------------- lookup coercion

test("table lookup coerces a number to its decimal string and a boolean to its word; lists and mappings are not scalar", async () => {
  const w = await storyWorld(CONNECTOR_MD.replace("values: { CONFIRMED: scheduled, TENTATIVE: scheduled, CANCELLED: canceled }", 'values: { "3": canceled, "false": scheduled }'));
  const map = (status: unknown) => mapRecord(w.bound.source, { ...storyRecord, status }, w.bound.kind);
  const three = map(3);
  assert.ok(three.kind === "mapped" && three.fields.event_status === "canceled");
  const no = map(false);
  assert.ok(no.kind === "mapped" && no.fields.event_status === "scheduled");
  const yes = map(true);
  assert.ok(yes.kind === "mapped" && yes.unobserved.includes("event_status"));
  assert.deepEqual(yes.diagnostics.map((d) => d.code), ["VALUE_UNMAPPED"]);
  const listed = map(["CONFIRMED"]);
  assert.ok(listed.kind === "mapped" && listed.unobserved.includes("event_status"));
  assert.deepEqual(listed.diagnostics.map((d) => d.code), ["VALUE_NOT_SCALAR"]);
  const nested = mapRecord(w.bound.source, { ...storyRecord, summary: { text: "x" } }, w.bound.kind);
  assert.ok(nested.kind === "mapped" && nested.unobserved.includes("title"), "an unmapped path holding a mapping is not scalar either");
});

test("values lookups read own rows only: prototype member names are unmapped, never an inherited member", async () => {
  const w = await storyWorld();
  for (const status of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    const mapped = mapRecord(w.bound.source, { ...storyRecord, status }, w.bound.kind);
    assert.ok(mapped.kind === "mapped", status);
    assert.equal(Object.hasOwn(mapped.fields, "event_status"), false, status);
    assert.ok(mapped.unobserved.includes("event_status"), status);
    assert.deepEqual(mapped.diagnostics.map((d) => [d.code, d.native]), [["VALUE_UNMAPPED", status]]);
  }
  const strict = await storyWorld(STRICT_CONNECTOR_MD);
  const refused = mapRecord(strict.bound.source, { ...storyRecord, status: "constructor" }, strict.bound.kind);
  assert.equal(refused.kind, "refused");
});

// --------------------------------------------------------------------------------------- identity

test("a record whose uid is empty or absent is IDENTITY_MISSING, not present, and raises one Signal", async () => {
  const w = await storyWorld();
  for (const record of [{ ...storyRecord, uid: "" }, (({ uid: _uid, ...rest }) => rest)(storyRecord)]) {
    const mapped = mapRecord(w.bound.source, record, w.bound.kind);
    assert.ok(mapped.kind === "refused" && mapped.present === false && mapped.external_id === null);
    assert.deepEqual(mapped.diagnostics.map((d) => d.code), ["IDENTITY_MISSING"]);
    assert.equal(renderIdentity(w.bound.source, w.bound, record).ok, false);
  }
  const out = await run(w, [{ ...storyRecord, uid: "" }, (({ uid: _uid, ...rest }) => rest)(storyRecord)]);
  assert.deepEqual(out.present, []);
  assert.equal((await signals(w)).length, 1, "one Signal per source for identity gaps");
});

test("prototype paths: the parser refuses them and mapRecord reads nothing through an own __proto__ key", async () => {
  const w = await storyWorld();
  for (const [from, id] of [["__proto__.x", "{uid}"], ["summary", "{constructor.name}"], ["prototype", "{uid}"]] as const) {
    const md = CONNECTOR_MD.replace("title: summary", `title: ${JSON.stringify(from)}`).replace('id: "{uid}"', `id: ${JSON.stringify(id)}`);
    const { frontmatter, body } = parseMarkdown(md);
    const parsed = parseConnectorDoc({ id: CONNECTOR_ID, frontmatter, body });
    assert.equal(parsed.ok, false, from + " " + id);
  }
  const handBuilt = structuredClone(w.bound.source);
  handBuilt.fields.title = { from: "__proto__.x" };
  handBuilt.fields.end = { from: "constructor" };
  const record = JSON.parse('{"uid":"evt-story@calendar.example.org","__proto__":{"x":"from the prototype key"},"dtstart":"2026-10-10T14:00:00Z","status":"CONFIRMED"}') as Record<string, unknown>;
  assert.ok(Object.hasOwn(record, "__proto__"));
  const mapped = mapRecord(handBuilt, record, w.bound.kind);
  assert.ok(mapped.kind === "mapped");
  assert.equal(Object.hasOwn(mapped.fields, "title"), false);
  assert.equal(Object.hasOwn(mapped.fields, "end"), false, "an inherited constructor is never read");
  assert.ok(mapped.unobserved.includes("title") && mapped.unobserved.includes("end"));
});

// --------------------------------------------------------------------------------- editor ownership

test("an editor's change since the last accepted value is an OVERLAY_DOC_CONFLICT with a Signal, and the editor's value stays", async () => {
  const w = await storyWorld();
  await w.edit("events/story", { start: "2026-10-10T15:00:00Z" });
  const out = await run(w, [{ ...storyRecord, dtstart: "2026-10-10T16:00:00Z" }]);
  assert.deepEqual(out.plan.refusals.map((r) => [r.code, r.field]), [["OVERLAY_DOC_CONFLICT", "start"]]);
  assert.equal((await w.read("events/story")).frontmatter.start, "2026-10-10T15:00:00Z");
  const raised = await signals(w);
  assert.equal(raised.length, 1);
  assert.match(String(raised[0]!.diff_summary), /CONFLICT start/);
});

// ------------------------------------------------------------------------------------ absent and null

test("an absent path leaves the field unobserved and carried: no removal", async () => {
  const w = await storyWorld();
  const { dtstart: _start, dtend: _end, ...rest } = storyRecord;
  const out = await run(w, [rest]);
  assert.equal(out.changes.length, 0);
  assert.deepEqual(out.plan.steps, []);
  const story = await w.read("events/story");
  assert.equal(story.frontmatter.start, storyFields.start);
  assert.equal(story.frontmatter.end, storyFields.end);
});

test("null on an optional field clears it: a removal through the three-value rule", async () => {
  const w = await storyWorld();
  const mapped = mapRecord(w.bound.source, { ...storyRecord, dtend: null }, w.bound.kind);
  assert.ok(mapped.kind === "mapped");
  assert.deepEqual([mapped.cleared, mapped.unobserved, mapped.diagnostics], [["end"], [], []]);
  const out = await run(w, [{ ...storyRecord, dtend: null }]);
  assert.deepEqual(out.changes[0]!.changed_fields, ["end"]);
  assert.equal(Object.hasOwn(out.changes[0]!.after!, "end"), false);
  const step = out.plan.steps.find((s) => s.op === "apply-owned-fields");
  assert.ok(step && step.op === "apply-owned-fields");
  assert.deepEqual(step.fields, { end: { from: storyFields.end, to: undefined } });
  assert.ok(out.receipt.results.every((r) => r.outcome !== "refused"), JSON.stringify(out.receipt.results));
  assert.equal(Object.hasOwn((await w.read("events/story")).frontmatter, "end"), false);
  assert.equal((await signals(w)).length, 0);
});

test("null on a required field keeps the stored value with one VALUE_MISSING finding while the other fields update", async () => {
  const w = await storyWorld();
  const out = await run(w, [{ ...storyRecord, summary: "Story Time Again", dtstart: null }]);
  assert.deepEqual(out.diagnostics.map((d) => [d.code, d.field]), [["VALUE_MISSING", "start"]]);
  assert.deepEqual(out.changes[0]!.changed_fields, ["title"]);
  assert.ok(out.receipt.results.every((r) => r.code !== "KIND_REJECTED" && r.outcome !== "refused"), JSON.stringify(out.receipt.results));
  const story = await w.read("events/story");
  assert.equal(story.frontmatter.title, "Story Time Again");
  assert.equal(story.frontmatter.start, storyFields.start);
  const raised = await signals(w);
  assert.equal(raised.length, 1);
  assert.equal(raised[0]!.priority, "low");
});

// -------------------------------------------------------------------------------------- one finding

test("distinct list values on one field raise one Signal, and null, empty and blank on one required field raise one", async () => {
  const w = await storyWorld();
  const findingSignals = async () => (await signals(w)).filter((s) => s.change_kind === "status-check");
  const lists = await run(w, [["x0"], ["x1", "x2"], ["x3"]].map((summary) => ({ ...storyRecord, summary })));
  assert.deepEqual(lists.diagnostics.map((d) => d.code), ["VALUE_NOT_SCALAR", "VALUE_NOT_SCALAR", "VALUE_NOT_SCALAR"]);
  assert.equal((await findingSignals()).length, 1);
  const empties = await run(w, [null, "", "  "].map((dtstart) => ({ ...storyRecord, dtstart })));
  assert.deepEqual(empties.diagnostics.map((d) => d.code), ["VALUE_MISSING", "VALUE_MISSING", "VALUE_MISSING"]);
  assert.equal((await findingSignals()).length, 2);
  const replay = await run(w, [{ ...storyRecord, summary: ["x9"] }, { ...storyRecord, dtstart: "" }]);
  assert.deepEqual(replay.findings.plan.steps.map((s) => s.op), ["signal-duplicate", "signal-duplicate"], "the next run's facts are the same");
  assert.equal((await findingSignals()).length, 2);
  assert.equal((await w.read("events/story")).frontmatter.start, storyFields.start);
});

test("the same unknown value across many records raises one Signal; another value raises a second", async () => {
  const w = await storyWorld();
  const records = ["a", "b", "c"].map((n) => ({ ...storyRecord, uid: `evt-${n}@calendar.example.org`, status: "WITHDRAWN" }));
  const first = await run(w, records);
  assert.equal(first.diagnostics.length, 3);
  assert.equal(findingsFor(first.diagnostics, { source: "events" }).length, 1);
  const findingSignals = async () => (await signals(w)).filter((s) => s.change_kind === "status-check");
  const raised = await findingSignals();
  assert.equal(raised.length, 1, "one finding Signal beside the three new-record Signals");
  assert.match(String(raised[0]!.diff_summary), /3 records/);
  await run(w, [{ ...records[0]!, status: "POSTPONED" }]);
  assert.equal((await findingSignals()).length, 2);
});
