/**
 * `sources[]` identity: the `sources` query facet and the grouped field-action write.
 *
 * 1. LOOKUP: one predicate (`matchesSourceIdentity`) decides identity for queries and upserts;
 *    `query`/`queryHeads` honour the facet over filesystem, memory and remote (push-down
 *    over-returns, the engine re-filters) backends.
 * 2. WRITE: `field-actions` applies scalar sets and a sources upsert to one fresh read and
 *    commits one CAS write with one attribution pass, or nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRouter } from "@superbee/server";
import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";

import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { query, queryHeads, readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import { matchesFilter, matchesSourceIdentity, hasSourceIdentity } from "../src/query-filter.js";
import { FieldActionError, prepareDocumentFieldAction, type FieldAction } from "../src/document-field-actions.js";
import { KindConformanceError, mutateDocument } from "../src/document-mutation.js";
import { VersionConflict } from "../src/versioning.js";
import type { KindConvention, KindRegistry } from "../src/kinds.js";
import type { Bundle, OkfDocument, QueryFilter, WriteOptions, Version } from "../src/types.js";

const FEED = "https://calendar.example.org/feed.ics";
const OTHER = "https://other.example.org/feed.ics";
const T1 = "2026-10-03T10:00:00.000Z";
const T2 = "2026-10-03T11:00:00.000Z";

// ── 1. identity predicate ─────────────────────────────────────────────────────

test("identity is exact string equality on each supplied key; malformed entries never match", () => {
  const row = { resource: FEED, id: "evt-1", title: "x" };
  assert.equal(matchesSourceIdentity(row, { resource: FEED, id: "evt-1" }), true);
  assert.equal(matchesSourceIdentity(row, { resource: FEED }), true);
  assert.equal(matchesSourceIdentity(row, { id: "evt-1" }), true);
  for (const identity of [
    { resource: FEED.toUpperCase(), id: "evt-1" },
    { resource: `${FEED}/`, id: "evt-1" },
    { resource: ` ${FEED}`, id: "evt-1" },
    { resource: FEED, id: "EVT-1" },
    { resource: FEED, id: "evt-1 " },
    { resource: OTHER, id: "evt-1" },
  ]) assert.equal(matchesSourceIdentity(row, identity), false, JSON.stringify(identity));
  // No coercion: a numeric id is not the string "1"; missing, null and inherited keys never match.
  assert.equal(matchesSourceIdentity({ resource: FEED, id: 1 }, { resource: FEED, id: "1" }), false);
  assert.equal(matchesSourceIdentity({ resource: FEED }, { resource: FEED, id: "evt-1" }), false);
  assert.equal(matchesSourceIdentity({ resource: FEED, id: null }, { id: "null" }), false);
  assert.equal(matchesSourceIdentity(Object.create({ resource: FEED, id: "evt-1" }), { resource: FEED, id: "evt-1" }), false);
  for (const entry of [null, undefined, "evt-1", 1, [FEED, "evt-1"]]) assert.equal(matchesSourceIdentity(entry, { id: "evt-1" }), false);
  // Only a list of entries carries identities; a bare mapping or string does not.
  assert.equal(hasSourceIdentity([null, "x", row], { resource: FEED, id: "evt-1" }), true);
  assert.equal(hasSourceIdentity(row, { resource: FEED, id: "evt-1" }), false);
  assert.equal(hasSourceIdentity(FEED, { resource: FEED }), false);
  assert.equal(hasSourceIdentity(undefined, { resource: FEED }), false);
});

test("the sources facet ANDs with other facets; an empty selector imposes no constraint", () => {
  const doc = { id: "events/a", frontmatter: { type: "Event", sources: [{ resource: FEED, id: "evt-1" }] } };
  const bare = { id: "notes/b", frontmatter: { type: "Note" } };
  assert.equal(matchesFilter(doc, { sources: { resource: FEED, id: "evt-1" } }), true);
  assert.equal(matchesFilter(doc, { type: "Event", sources: { id: "evt-1" } }), true);
  assert.equal(matchesFilter(doc, { type: "Note", sources: { id: "evt-1" } }), false);
  assert.equal(matchesFilter(doc, { sources: { resource: OTHER, id: "evt-1" } }), false);
  assert.equal(matchesFilter(bare, { sources: { resource: FEED } }), false);
  assert.equal(matchesFilter(bare, { sources: {} }), true);
  assert.equal(matchesFilter(bare, { sources: { resource: undefined } }), true);
});

// ── backends ──────────────────────────────────────────────────────────────────

async function withFs<T>(fn: (bundle: Bundle) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "core-source-identity-"));
  try {
    return await fn({ root, backend: new FilesystemBackend(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function withMem<T>(fn: (bundle: Bundle) => Promise<T>): Promise<T> {
  return fn({ root: "mem://source-identity", backend: new MemoryBackend() });
}
async function withRemote<T>(fn: (bundle: Bundle) => Promise<T>): Promise<T> {
  const router = createRouter({ root: "mem://wire-source-identity", backend: new ServerMemoryBackend() });
  const backend = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: (req: Request) => router(req) });
  return fn({ root: "wire://source-identity", backend });
}
const RUNNERS = [["filesystem", withFs], ["memory", withMem], ["remote", withRemote]] as const;

async function root(bundle: Bundle, edition: "0.1" | "0.2"): Promise<void> {
  await bundle.backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n# Bundle\n`);
}

const LOOKUP_DOCS: OkfDocument[] = [
  { id: "events/a", frontmatter: { type: "Event", title: "A", sources: [{ resource: FEED, id: "evt-1" }] }, body: "a\n" },
  // The same record id in another provider namespace is a different identity.
  { id: "events/b", frontmatter: { type: "Event", title: "B", sources: [{ resource: OTHER, id: "evt-1" }] }, body: "b\n" },
  { id: "events/c", frontmatter: { type: "Event", title: "C", sources: [{ resource: "Other text" }, { resource: FEED, id: "evt-2", title: "two" }] }, body: "c\n" },
  { id: "notes/d", frontmatter: { type: "Note", title: "D", sources: [{ resource: FEED, id: "evt-1" }] }, body: "d\n" },
  { id: "events/e", frontmatter: { type: "Event", title: "E", sources: { resource: FEED, id: "evt-1" } }, body: "e\n" },
  { id: "events/f", frontmatter: { type: "Event", title: "F", sources: [{ resource: FEED, id: 1 }] }, body: "f\n" },
];
const LOOKUPS: Array<[QueryFilter, string[]]> = [
  [{ sources: { resource: FEED, id: "evt-1" } }, ["events/a", "notes/d"]],
  [{ type: "Event", sources: { resource: FEED, id: "evt-1" } }, ["events/a"]],
  [{ type: "Event", sources: { resource: OTHER, id: "evt-1" } }, ["events/b"]],
  [{ sources: { id: "evt-1" } }, ["events/a", "events/b", "notes/d"]],
  [{ sources: { resource: FEED } }, ["events/a", "events/c", "events/f", "notes/d"]],
  [{ sources: { resource: FEED, id: "1" } }, []],
  [{ prefix: "events/", sources: { id: "evt-2" } }, ["events/c"]],
];

for (const [name, run] of RUNNERS) {
  for (const edition of ["0.1", "0.2"] as const) {
    test(`${name} OKF ${edition}: query and queryHeads select by sources identity with one predicate`, async () => {
      await run(async (bundle) => {
        await root(bundle, edition);
        const versions = new Map<string, Version>();
        for (const doc of LOOKUP_DOCS) versions.set(doc.id, (await writeDocVersioned(bundle, doc)).version);
        for (const [filter, expected] of LOOKUPS) {
          const heads = await queryHeads(bundle, filter);
          assert.deepEqual(heads.map((row) => row.id), expected, JSON.stringify(filter));
          assert.deepEqual((await query(bundle, filter)).map((doc) => doc.id), expected, JSON.stringify(filter));
          // A head's version is the CAS basis for the grouped write below.
          for (const row of heads) assert.equal(row.version, versions.get(row.id));
        }
      });
    });
  }
}

// ── 2. grouped write ──────────────────────────────────────────────────────────

const EVENT: KindConvention = {
  id: "conventions/event", title: "Event", governs: "Event",
  fields: { required: ["title"], optional: ["start", "location", "event_status", "superbee_progress_status"], values: { event_status: ["scheduled", "canceled"] }, terminal: {}, descriptions: {} },
} as KindConvention;
const REGISTRY: KindRegistry = { kinds: new Map([["Event", EVENT]]), warnings: [] };

const overlay = (fm: Record<string, unknown> = {}): OkfDocument => ({
  id: "events/a",
  frontmatter: { type: "Event", title: "Concert", start: "2026-10-10T19:00:00-04:00", sources: [{ resource: FEED, id: "evt-1", title: "Calendar" }], ...fm },
  body: "Editor prose.\n",
});
const feedWrite = (start: string, revision: string): FieldAction[] => [
  { action: "set", field: "start", value: start },
  { action: "set", field: "location", value: "Main St" },
  { action: "upsert", field: "sources", value: { resource: FEED, id: "evt-1", revision } },
];
const attribution = { actor: "process:hm-bridge", producer: "process:hm-bridge" };

class RaceBackend extends MemoryBackend {
  race?: OkfDocument;
  writes = 0;
  override async write(id: string, next: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (this.race) { const other = this.race; this.race = undefined; await super.write(id, other, options); }
    this.writes += 1;
    return super.write(id, next, options);
  }
}

for (const [name, run] of RUNNERS.filter(([n]) => n !== "remote")) {
  test(`${name}: scalar sets and a sources upsert commit as one attributed CAS write, then replay as a no-op`, async () => {
    await run(async (bundle) => {
      await root(bundle, "0.2");
      const created = await writeDocVersioned(bundle, overlay());
      let writes = 0;
      const write = bundle.backend.write.bind(bundle.backend);
      bundle.backend.write = (...args) => { writes += 1; return write(...args); };
      const base = { bundle, id: "events/a", mode: "patch" as const, registry: REGISTRY, strict: true, ...attribution };
      const result = await mutateDocument({ ...base, now: () => T1, expectedVersion: created.version,
        input: { kind: "field-actions", actions: feedWrite("2026-10-10T20:00:00-04:00", "r2") } });
      assert.equal(result.changed, true);
      assert.deepEqual(result.scopes?.map((s) => s.outcome), ["edited", "edited", "edited"]);
      assert.deepEqual(result.scopes?.[2]?.affectedSourceIds, ["evt-1"]);
      assert.equal(result.scope, undefined);
      const fm = result.doc.frontmatter;
      assert.equal(fm.start, "2026-10-10T20:00:00-04:00");
      assert.equal(fm.location, "Main St");
      // Merge keeps the editor's title on the entry; identity keys are unchanged.
      assert.deepEqual(fm.sources, [{ resource: FEED, id: "evt-1", title: "Calendar", revision: "r2" }]);
      assert.deepEqual(fm.generated, { by: "process:hm-bridge", at: T1 });
      assert.equal(result.doc.body, "Editor prose.\n");
      assert.equal(writes, 1, "one write for the whole group");

      const replay = await mutateDocument({ ...base, now: () => T2, expectedVersion: result.version,
        input: { kind: "field-actions", actions: feedWrite("2026-10-10T20:00:00-04:00", "r2") } });
      assert.equal(replay.changed, false);
      assert.equal(replay.version, result.version);
      assert.deepEqual(replay.scopes?.map((s) => s.outcome), ["unchanged", "unchanged", "unchanged"]);
      assert.equal(writes, 1);
      assert.deepEqual((await readDocVersioned(bundle, "events/a")).doc.frontmatter.generated, { by: "process:hm-bridge", at: T1 });
    });
  });
}

async function memSetup(fm: Record<string, unknown> = {}, edition: "0.1" | "0.2" = "0.2") {
  const backend = new RaceBackend();
  const bundle: Bundle = { root: "/unused", backend };
  await root(bundle, edition);
  const written = await writeDocVersioned(bundle, overlay(fm));
  backend.writes = 0;
  const base = { bundle, id: "events/a", mode: "patch" as const, registry: REGISTRY, strict: true, ...attribution, now: () => T1 };
  return { backend, bundle, written, base };
}

test("a stale expectedVersion refuses the whole group and keeps the concurrent edit", async () => {
  const { backend, bundle, written, base } = await memSetup();
  backend.race = overlay({ location: "Editor's hall" });
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: written.version,
    input: { kind: "field-actions", actions: feedWrite("2026-10-10T20:00:00-04:00", "r2") } }), VersionConflict);
  const after = (await readDocVersioned(bundle, "events/a")).doc.frontmatter;
  assert.equal(after.location, "Editor's hall");
  assert.equal(after.start, "2026-10-10T19:00:00-04:00");
  assert.deepEqual(after.sources, [{ resource: FEED, id: "evt-1", title: "Calendar" }]);
});

test("without expectedVersion the group is re-decided on the fresh read, and assertCandidate sees the whole group", async () => {
  const { backend, bundle, base } = await memSetup();
  backend.race = overlay({ sources: [{ resource: FEED, id: "evt-1", title: "Calendar" }, { resource: OTHER, id: "x" }] });
  const seen: unknown[] = [];
  const result = await mutateDocument({ ...base,
    assertCandidate: (_existing, candidate) => { seen.push(candidate.frontmatter.sources); },
    input: { kind: "field-actions", actions: feedWrite("2026-10-10T20:00:00-04:00", "r2") } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.doc.frontmatter.sources, [{ resource: FEED, id: "evt-1", title: "Calendar", revision: "r2" }, { resource: OTHER, id: "x" }]);
  assert.equal(seen.length, 2, "first attempt lost the CAS, second decided on fresh state");
  assert.deepEqual((await readDocVersioned(bundle, "events/a")).doc.frontmatter.sources, result.doc.frontmatter.sources);
  // The guard can refuse the group: nothing is written.
  const before = await readDocVersioned(bundle, "events/a");
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: before.version,
    assertCandidate: () => { throw new Error("FIELD_NOT_OWNED"); },
    input: { kind: "field-actions", actions: feedWrite("2026-10-11T20:00:00-04:00", "r3") } }), /FIELD_NOT_OWNED/);
  assert.equal((await readDocVersioned(bundle, "events/a")).version, before.version);
});

test("upsert appends a missing identity, and refuses ambiguity and a document-local ID already used by another resource", async () => {
  const { bundle, written, base } = await memSetup({ sources: [{ resource: "Other text" }] });
  const added = await mutateDocument({ ...base, expectedVersion: written.version,
    input: { kind: "field-actions", actions: [{ action: "upsert", field: "sources", value: { resource: FEED, id: "evt-1" } }] } });
  assert.deepEqual(added.doc.frontmatter.sources, [{ resource: "Other text" }, { resource: FEED, id: "evt-1" }]);
  assert.equal(added.scopes?.[0]?.outcome, "added");
  const conflict = await mutateDocument({ ...base, expectedVersion: added.version,
    input: { kind: "field-actions", actions: [{ action: "upsert", field: "sources", value: { resource: OTHER, id: "evt-1" } }] } }).catch((e) => e);
  assert.ok(conflict instanceof FieldActionError);
  assert.equal(conflict.details.reason, "source-id-conflict");
  assert.deepEqual(conflict.details.recommendedSelector, { id: "evt-1" });
  assert.equal((await readDocVersioned(bundle, "events/a")).version, added.version);
});

test("upsert refuses ambiguous identities with bounded candidates", () => {
  const rows = [{ resource: FEED, id: "evt-1" }, { resource: FEED, id: "evt-1", note: "dup" }];
  assert.throws(() => prepareDocumentFieldAction(overlay({ sources: rows }),
    { action: "upsert", field: "sources", value: { resource: FEED, id: "evt-1", revision: "r" } }, { registry: REGISTRY, okfVersion: "0.2" }), (error) => {
    assert.ok(error instanceof FieldActionError);
    assert.equal(error.details.reason, "ambiguous-source");
    assert.equal(error.details.total, 2);
    return true;
  });
});

test("malformed sources and malformed upsert values refuse before any write", async () => {
  const context = { registry: REGISTRY, okfVersion: "0.2" as const };
  const prepare = (fm: Record<string, unknown>, value: unknown) =>
    prepareDocumentFieldAction(overlay(fm), { action: "upsert", field: "sources", value } as FieldAction, context);
  assert.throws(() => prepare({ sources: "not a list" }, { resource: FEED, id: "evt-1" }), /not a list/);
  assert.throws(() => prepare({ sources: { resource: FEED, id: "evt-1" } }, { resource: FEED, id: "evt-1" }), /not a list/);
  assert.throws(() => prepare({}, { id: "evt-1" }), /nonempty resource/);
  assert.throws(() => prepare({}, { resource: "  ", id: "evt-1" }), /nonempty resource/);
  assert.throws(() => prepare({}, { resource: FEED }), /nonempty id/);
  assert.throws(() => prepare({}, { resource: FEED, id: "" }), /nonempty id/);
  assert.throws(() => prepare({}, { resource: FEED, id: 7 }), /ID must be a string/);
  assert.throws(() => prepare({}, { resource: FEED, id: "evt-1", windows: ["a"] }), /contains a list/);
  assert.throws(() => prepare({}, { resource: FEED, id: "evt-1", nested: { list: [1] } }), /contains a list/);
  assert.throws(() => prepare({}, { resource: FEED, id: "evt-1", title: undefined }), /must have values/);
  assert.throws(() => prepare({ sources: [{ resource: FEED, id: "evt-1", windows: ["a"] }] }, { resource: FEED, id: "evt-1", windows: "b" }), /old subtree contains a list/);
  assert.throws(() => prepareDocumentFieldAction(overlay(), { action: "upsert", field: "tags", value: "x" } as unknown as FieldAction, context), /not upsert/);
  assert.throws(() => prepareDocumentFieldAction(overlay(), { action: "upsert", field: "sources", value: { resource: FEED, id: "evt-1" }, selector: { id: "evt-1" } } as unknown as FieldAction, context), /incompatible/);
  // Malformed rows elsewhere in the list survive an upsert of a well-formed identity.
  const kept = prepare({ sources: [{ resource: FEED, id: 9 }, "legacy text"] }, { resource: FEED, id: "evt-1" });
  assert.deepEqual(kept.candidate.frontmatter.sources, [{ resource: FEED, id: 9 }, "legacy text", { resource: FEED, id: "evt-1" }]);

  // Through mutateDocument: the scalar sets in the same group are not written either.
  const { bundle, written, base } = await memSetup({ sources: "not a list" });
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: written.version,
    input: { kind: "field-actions", actions: feedWrite("2026-10-10T20:00:00-04:00", "r2") } }), /not a list/);
  assert.equal((await readDocVersioned(bundle, "events/a")).version, written.version);
  // OKF v0.2 write policy still checks the final candidate's standard source properties.
  const policy = await memSetup();
  await assert.rejects(() => mutateDocument({ ...policy.base, expectedVersion: policy.written.version,
    input: { kind: "field-actions", actions: [{ action: "upsert", field: "sources", value: { resource: FEED, id: "evt-1", usage_count: -1 } }] } }), /usage_count/);
  assert.equal((await readDocVersioned(policy.bundle, "events/a")).version, policy.written.version);
});

test("strict Kind rejection and group-shape errors write nothing", async () => {
  const { backend, bundle, written, base } = await memSetup();
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: written.version, input: { kind: "field-actions", actions: [
    { action: "upsert", field: "sources", value: { resource: FEED, id: "evt-1", revision: "r2" } },
    { action: "set", field: "event_status", value: "postponed" },
  ] } }), KindConformanceError);
  await assert.rejects(() => mutateDocument({ ...base, input: { kind: "field-actions", actions: [] } }), /nonempty list/);
  await assert.rejects(() => mutateDocument({ ...base, input: { kind: "field-actions", actions: [
    { action: "set", field: "location", value: "x" },
    { action: "edit", field: "sources", selector: { id: "evt-1" }, patch: { revision: "r" } },
  ] } }), /expectedVersion/);
  await assert.rejects(() => mutateDocument({ ...base, input: { kind: "field-actions", actions: [
    { action: "set", field: "sources", value: [] },
  ] } as never }), /collection/);
  await assert.rejects(() => mutateDocument({ ...base, input: { kind: "field-actions", actions: [
    { action: "set", field: "generated", value: { by: "human:x" } },
  ] } }), /managed/);
  assert.equal(backend.writes, 0);
  assert.equal((await readDocVersioned(bundle, "events/a")).version, written.version);
});

test("logical Kind fields resolve to their edition storage inside a group", async () => {
  const { base, written } = await memSetup();
  const result = await mutateDocument({ ...base, expectedVersion: written.version, input: { kind: "field-actions", actions: [
    { action: "set", field: "progress_status", value: "todo" },
    { action: "upsert", field: "sources", value: { resource: FEED, id: "evt-1", revision: "r2" } },
  ] } });
  assert.equal(result.doc.frontmatter.superbee_progress_status, "todo");
  assert.equal(result.doc.frontmatter.progress_status, undefined);
});

test("OKF v0.1: grouped scalar sets advance the legacy clock once; sources actions refuse and write nothing", async () => {
  const { backend, bundle, written, base } = await memSetup({ timestamp: "2026-01-01T00:00:00.000Z" }, "0.1");
  await assert.rejects(() => mutateDocument({ ...base, expectedVersion: written.version,
    input: { kind: "field-actions", actions: feedWrite("2026-10-10T20:00:00-04:00", "r2") } }), /require OKF v0.2/);
  assert.equal(backend.writes, 0);
  const result = await mutateDocument({ ...base, expectedVersion: written.version, input: { kind: "field-actions", actions: [
    { action: "set", field: "start", value: "2026-10-10T20:00:00-04:00" },
    { action: "set", field: "location", value: "Main St" },
  ] } });
  assert.equal(result.changed, true);
  assert.equal(backend.writes, 1);
  assert.equal(result.doc.frontmatter.timestamp, T1);
  assert.equal(result.doc.frontmatter.generated, undefined);
  assert.deepEqual((await readDocVersioned(bundle, "events/a")).doc.frontmatter.sources, [{ resource: FEED, id: "evt-1", title: "Calendar" }]);
});
