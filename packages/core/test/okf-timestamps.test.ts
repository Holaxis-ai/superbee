import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouter } from "@superbee/server";
import { FilesystemBackend } from "../src/backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { invalidOkfTimestamps, assertAuthoredOkfTimestamps } from "../src/okf-timestamps.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import { freshness } from "../src/freshness.js";
import type { Frontmatter } from "../src/types.js";

const NOW = "2026-09-08T18:30:00Z";
const OLD = "2026-09-07T18:30:00Z";
const registry = { kinds: new Map(), warnings: [] };
const slots: Array<[string, (value: unknown) => Frontmatter]> = [
  ["generated.at", at => ({ type: "Note", generated: { by: "process:writer", at } })],
  ["verified.at", at => ({ type: "Note", verified: { by: "human:reviewer", at } })],
  ["verified[0].at", at => ({ type: "Note", verified: [{ by: "human:reviewer", at }] })],
  ["stale_after", stale_after => ({ type: "Note", stale_after })],
  ["usage_window.from", from => ({ type: "Note", usage_window: { from } })],
  ["usage_window.to", to => ({ type: "Note", usage_window: { to } })],
  ["sources[0].last_modified", last_modified => ({ type: "Note", sources: [{ resource: "source", last_modified }] })],
  ["sources[0].usage_window.from", from => ({ type: "Note", sources: [{ resource: "source", usage_window: { from } }] })],
  ["sources[0].usage_window.to", to => ({ type: "Note", sources: [{ resource: "source", usage_window: { to } }] })],
];
const valid = [NOW, "2026-09-08T12:30:00-06:00", "2026-09-09T00:00:00+05:30", "2026-09-08t18:30:00z", "2026-09-08T18:30:00.123456789+00", "2026-09-08T18:30:00+0000"];
const invalid: unknown[] = ["2026-09-08", "2026-09-08T12:30:00", "September 8, 2026", "2026-02-30T12:30:00Z", "2026-09-08T24:00:00Z", "2026-09-08T12:30:00+25:00", null, 123, {}, ""];

async function harness(edition = "0.2") {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  return { root: "mem://offsets", backend };
}

test("every standard timestamp slot shares strict validation and exact field diagnostics", () => {
  for (const [field, make] of slots) {
    for (const value of valid) {
      assert.deepEqual(invalidOkfTimestamps(make(value)), [], `${field}: ${value}`);
      assert.doesNotThrow(() => assertAuthoredOkfTimestamps(make(value)));
    }
    for (const value of invalid) {
      assert.deepEqual(invalidOkfTimestamps(make(value)), [{ field, value }]);
      assert.throws(() => assertAuthoredOkfTimestamps(make(value)), error => error instanceof Error && error.message.includes(field));
    }
  }
  assert.deepEqual(invalidOkfTimestamps({ type: "Note", custom: { at: "yesterday" }, timestamp: "2026-09-08", date: "2026-09-08" }), []);
});

test("authored create, patch and overwrite reject invalid slots before any persistence", async () => {
  for (const [field, make] of slots) {
    for (const mode of ["create-only", "patch", "overwrite"] as const) {
      const bundle = await harness();
      if (mode !== "create-only") await writeDocVersioned(bundle, { id: "notes/check", frontmatter: make(OLD), body: "old\n" });
      const before = mode === "create-only" ? undefined : await readDocVersioned(bundle, "notes/check");
      await assert.rejects(mutateDocument({ bundle, id: "notes/check", mode, registry, strict: false, actor: "process:writer", now: () => NOW, buildCandidate: () => ({ frontmatter: make("2026-09-08T12:30:00"), body: "changed\n" }) }), error => error instanceof Error && error.message.includes(field));
      if (before) assert.deepEqual(await readDocVersioned(bundle, "notes/check"), before);
      else await assert.rejects(readDocVersioned(bundle, "notes/check"));
    }
  }
});

test("explicit-offset values persist on create, including unquoted YAML-shaped strings", async () => {
  for (const [, make] of slots) for (const value of valid) {
    const bundle = await harness();
    const result = await mutateDocument({ bundle, id: "notes/check", mode: "create-only", registry, strict: false, actor: "process:writer", now: () => NOW, buildCandidate: () => ({ frontmatter: make(value), body: "test\n" }) });
    assert.deepEqual(invalidOkfTimestamps(result.doc.frontmatter), []);
    for (const [key, expected] of Object.entries(make(value))) assert.deepEqual(result.doc.frontmatter[key], expected);
  }
});

test("legacy scalar clocks survive unrelated edits and generated clock obeys its existing advancement policy", async () => {
  for (const [field, make] of slots) {
    const bundle = await harness();
    const imported = await writeDocVersioned(bundle, { id: "notes/legacy", frontmatter: make("2026-09-08"), body: "old\n" });
    assert.equal(invalidOkfTimestamps(imported.doc.frontmatter)[0]?.field, field);
    const noop = await mutateDocument({ bundle, id: "notes/legacy", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter }, body: existing!.body }) });
    assert.equal(noop.changed, false);
    const changed = await mutateDocument({ bundle, id: "notes/legacy", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter }, body: "new\n" }) });
    if (field === "generated.at") assert.deepEqual(invalidOkfTimestamps(changed.doc.frontmatter), []);
    else assert.equal(invalidOkfTimestamps(changed.doc.frontmatter)[0]?.field, field);
  }
});

test("invalid explicit generation input is rejected before no-op or automatic clock replacement", async () => {
  const bundle = await harness();
  await writeDocVersioned(bundle, { id: "notes/check", frontmatter: { type: "Note", generated: { by: "process:writer", at: OLD } }, body: "old\n" });
  for (const body of ["old\n", "changed\n"]) await assert.rejects(mutateDocument({ bundle, id: "notes/check", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, generated: { by: "process:writer", at: "2026-09-08" } }, body }) }), /generated.at/);
  for (const seedGenerationClock of [true, false]) await assert.rejects(mutateDocument({ bundle, id: `notes/new-${seedGenerationClock}`, mode: "create-only", registry, strict: false, seedGenerationClock, now: () => NOW, buildCandidate: () => ({ frontmatter: { type: "Note", generated: { by: "process:writer", at: "2026-09-08" } }, body: "x" }) }), /generated.at/);
  await assert.rejects(mutateDocument({ bundle, id: "notes/clock", mode: "create-only", registry, strict: false, now: () => "2026-09-08", buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "x" }) }), /generated.at/);
});

test("legacy array rows use consumed exact matches, preserving reorder and append without allowing duplicate laundering", () => {
  for (const key of ["verified", "sources"] as const) {
    const row = key === "verified" ? { by: "human:old", at: "2026-09-08", method: "review" } : { resource: "source", last_modified: "2026-09-08", usage_window: { from: "2026-09-08" } };
    const good = key === "verified" ? { by: "human:new", at: NOW } : { resource: "new", last_modified: NOW };
    const existing = { [key]: [row, good] };
    assert.doesNotThrow(() => assertAuthoredOkfTimestamps({ [key]: [good, row, good] }, existing));
    assert.doesNotThrow(() => assertAuthoredOkfTimestamps({ [key]: [good] }, existing));
    assert.throws(() => assertAuthoredOkfTimestamps({ [key]: [row, row] }, existing));
    assert.throws(() => assertAuthoredOkfTimestamps({ [key]: [{ ...row, title: "edited row" }] }, existing));
    assert.throws(() => assertAuthoredOkfTimestamps({ [key]: [{ ...row, ...(key === "verified" ? { at: "2026-09-09" } : { last_modified: "2026-09-09" }) }] }, existing));
    assert.doesNotThrow(() => assertAuthoredOkfTimestamps({ [key]: [good] }, { [key]: [row] }));
  }
  const event = { by: "human:old", at: "2026-09-08" };
  assert.doesNotThrow(() => assertAuthoredOkfTimestamps({ verified: [event, { by: "human:new", at: NOW }] }, { verified: event }));
  assert.doesNotThrow(() => assertAuthoredOkfTimestamps({ verified: event }, { verified: [event] }));
});

test("v0.1 compatibility remains separate and v0.2 freshness does not infer a missing offset", async () => {
  const bundle = await harness("0.1");
  const result = await mutateDocument({ bundle, id: "notes/legacy", mode: "create-only", registry, strict: false, now: () => NOW, buildCandidate: () => ({ frontmatter: { type: "Note", generated: { at: "2026-09-08" }, stale_after: "2026-09-08" }, body: "x" }) });
  assert.equal(result.doc.frontmatter.stale_after, "2026-09-08");
  for (const at of ["2026-09-08", "2026-09-08T12:30:00"]) {
    const doc = { id: "notes/legacy", frontmatter: { type: "Note", generated: { at } }, body: "x" };
    assert.equal(freshness(doc, { okfVersion: "0.2", now: new Date(NOW), maxAgeMs: 1 }).verdict, "empty");
  }
});


test("a CAS retry cannot reuse a legacy timestamp allowance from an obsolete head", async () => {
  const bundle = await harness();
  const legacy = { type: "Note", verified: [{ by: "human:reviewer", at: "2026-09-08" }] };
  await writeDocVersioned(bundle, { id: "notes/race", frontmatter: legacy, body: "original\n" });
  let attempts = 0;
  await assert.rejects(mutateDocument({
    bundle, id: "notes/race", mode: "patch", registry, strict: false, now: () => NOW,
    buildCandidate: async () => {
      if (++attempts === 1) await writeDocVersioned(bundle, { id: "notes/race", frontmatter: { type: "Note", verified: [{ by: "human:reviewer", at: NOW }] }, body: "racer\n" });
      return { frontmatter: legacy, body: "edit\n" };
    },
  }), /verified\[0\].at/);
  assert.equal(attempts, 2);
  assert.equal((await readDocVersioned(bundle, "notes/race")).doc.body, "racer\n");
});

test("strict v0.2 freshness agrees across host zones for explicit and ambiguous inputs", () => {
  const previous = process.env.TZ;
  try {
    const results = ["UTC", "America/New_York", "Asia/Tokyo"].map(zone => {
      process.env.TZ = zone;
      return [NOW, "2026-09-08T12:30:00-06:00", "2026-09-08T12:30:00", "2026-09-08"].map(at => freshness({ id: "notes/time", frontmatter: { type: "Note", generated: { at } }, body: "" }, { okfVersion: "0.2", now: new Date(NOW), maxAgeMs: 1000 }));
    });
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    assert.deepEqual(results[0]?.[0], results[0]?.[1]);
    assert.equal(results[0]?.[2]?.verdict, "empty");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});


test("filesystem and remote authored validation agree while raw imports stay permissive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-offset-adapters-"));
  const memory = new MemoryBackend();
  const router = createRouter({ root: "mem://offset-server", backend: memory });
  const backends = [new FilesystemBackend(root), new RemoteBackend({ baseUrl: "http://wire.local", bundle: "offsets", fetchImpl: router })];
  try {
    for (const backend of backends) {
      const bundle = { root, backend };
      await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
      const legacy = { type: "Note", sources: [{ resource: "source", last_modified: "2026-09-08" }] };
      await assert.rejects(mutateDocument({ bundle, id: "notes/new", mode: "create-only", registry, strict: false, buildCandidate: () => ({ frontmatter: legacy, body: "x" }) }), /sources\[0\].last_modified/);
      await assert.rejects(readDocVersioned(bundle, "notes/new"));
      const imported = await writeDocVersioned(bundle, { id: "notes/imported", frontmatter: legacy, body: "imported\n" });
      assert.deepEqual(imported.doc.frontmatter.sources, legacy.sources);
      const edited = await mutateDocument({ bundle, id: "notes/imported", mode: "patch", registry, strict: false, now: () => NOW, buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: "edited\n" }) });
      assert.deepEqual(edited.doc.frontmatter.sources, legacy.sources);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a newly injected generation clock gets no legacy allowance even if its text is unchanged", async () => {
  const bundle = await harness();
  const imported = await writeDocVersioned(bundle, { id: "notes/clock", frontmatter: { type: "Note", generated: { by: "process:writer", at: "2026-09-08" } }, body: "old\n" });
  await assert.rejects(mutateDocument({
    bundle, id: "notes/clock", mode: "patch", registry, strict: false, now: () => "2026-09-08",
    buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: "changed\n" }),
  }), /generated.at/);
  assert.deepEqual(await readDocVersioned(bundle, "notes/clock"), imported);
});
