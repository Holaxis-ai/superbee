import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { parseMarkdown } from "../src/frontmatter.js";
import * as clocks from "../src/freshness.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { writeDocVersioned, readDocVersioned } from "../src/bundle.js";
import { defaultTimestampAndValidateAgainstRegistry } from "../src/kinds.js";
import type { KindConvention, KindRegistry } from "../src/kinds.js";

const NOW = "2026-09-09T12:00:00Z";
const valid = ["2026-09-08T12:00:00Z", "2026-09-08T06:00:00-06:00"];
const invalid: unknown[] = ["2026-09-08", "2026-09-08T12:00:00", "September 8, 2026", "2026-02-30T12:00:00Z", "", null, 1720915200000, new Date(NOW)];
const emptyRegistry: KindRegistry = { kinds: new Map(), warnings: [] };
const requiredRegistry: KindRegistry = {
  kinds: new Map([["Note", { id: "conventions/note", title: "Note", governs: "Note", fields: { required: ["timestamp"], optional: [], values: {}, terminal: {} } } as KindConvention]]), warnings: [],
};

async function harness(edition = "0.2") {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  return { root: "mem://legacy-clock", backend };
}

test("v0.2 parsing, effective-clock diagnostics and freshness agree on legacy values", () => {
  for (const timestamp of [...valid, ...invalid]) {
    const usable = valid.includes(timestamp as string);
    const fm = { type: "Note", timestamp };
    assert.equal(clocks.parseTimestamp(timestamp, "0.2") !== null, usable, String(timestamp));
    assert.equal(clocks.freshness({ id: "note", frontmatter: fm, body: "" }, { okfVersion: "0.2" }).verdict, usable ? "fresh" : "empty");
    assert.deepEqual(clocks.invalidLegacyTimestamp(fm, "0.2"), usable ? undefined : { field: "timestamp", value: timestamp });
    assert.equal(clocks.invalidLegacyTimestamp(fm, "0.1"), undefined);
  }
  assert.equal(clocks.invalidLegacyTimestamp({ type: "Note" }, "0.2"), undefined);
  for (const at of [null, "bad", NOW]) {
    assert.equal(clocks.invalidLegacyTimestamp({ timestamp: "bad", generated: { at } }, "0.2"), undefined);
  }
  assert.deepEqual(clocks.invalidLegacyTimestamp({ timestamp: "bad", generated: { at: undefined } }, "0.2"), { field: "timestamp", value: "bad" });
});

test("standalone and v0.1 codec keep old normalization; v0.2 retains scalar distinctions", () => {
  for (const raw of ["2026-09-08", "'2026-09-08'", "2026-09-08T12:00:00", "1720915200000"]) {
    const source = `---\ntype: Note\ntimestamp: ${raw}\n---\nbody\n`;
    const expected = raw === "1720915200000" ? 1720915200000 : raw.replaceAll("'", "");
    assert.equal(parseMarkdown(source, "note", { okfVersion: "0.2" }).frontmatter.timestamp, expected);
    assert.deepEqual(parseMarkdown(source), parseMarkdown(source, "note", { okfVersion: "0.1" }));
    assert.notEqual(parseMarkdown(source).frontmatter.timestamp, expected);
  }
  assert.equal(clocks.parseTimestamp("2026-09-08"), Date.parse("2026-09-08"));
  assert.equal(clocks.parseTimestamp(1720915200000, "0.1"), 1720915200000);
});

test("normal v0.2 creates seed a valid standard clock without changing ambiguous legacy input", async () => {
  for (const registry of [emptyRegistry, requiredRegistry]) {
    for (const timestamp of invalid.filter(value => !(value instanceof Date))) {
      const bundle = await harness();
      const result = await mutateDocument({ bundle, id: "note", registry, strict: false, mode: "create-only", actor: "process:test", now: () => NOW, buildCandidate: () => ({ frontmatter: { type: "Note", timestamp }, body: "body\n" }) });
      assert.equal(result.doc.frontmatter.timestamp, timestamp);
      assert.equal((result.doc.frontmatter.generated as {at: string}).at, NOW);
      assert.equal(clocks.freshness(result.doc, { okfVersion: "0.2" }).verdict, "fresh");
      assert.deepEqual((await readDocVersioned(bundle, "note")).doc, result.doc);
    }
  }
});

test("valid legacy clock and definition opt-out keep existing generation seeding choices", async () => {
  for (const timestamp of [...valid, "2026-09-08"]) {
    const bundle = await harness();
    const result = await mutateDocument({ bundle, id: "note", registry: emptyRegistry, strict: false, mode: "create-only", seedGenerationClock: valid.includes(timestamp), now: () => NOW, buildCandidate: () => ({ frontmatter: { type: "Note", timestamp }, body: "body\n" }) });
    assert.equal(result.doc.frontmatter.timestamp, timestamp);
    assert.equal((result.doc.frontmatter.generated as {at?: unknown} | undefined)?.at, undefined);
  }
  const bundle = await harness();
  const required = await mutateDocument({ bundle, id: "required", registry: requiredRegistry, strict: false, mode: "create-only", now: () => NOW, buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "body\n" }) });
  assert.equal(required.doc.frontmatter.timestamp, NOW);
  assert.equal((required.doc.frontmatter.generated as {at?: unknown} | undefined)?.at, undefined);
});

test("v0.2 Kind defaults only absent legacy timestamps and unrelated edits preserve imported values", async () => {
  for (const timestamp of [null, "", "2026-09-08"]) {
    const bundle = await harness();
    await writeDocVersioned(bundle, { id: "note", frontmatter: { type: "Note", timestamp, producer_extra: ["keep"] }, body: "body\n" });
    const result = await mutateDocument({ bundle, id: "note", registry: requiredRegistry, strict: false, mode: "patch", now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, title: "Edited" }, body: existing!.body }) });
    assert.equal(result.doc.frontmatter.timestamp, timestamp);
    assert.deepEqual(result.doc.frontmatter.producer_extra, ["keep"]);
    assert.equal(result.doc.body, "body\n");
  }
  const old = { id: "old", frontmatter: { type: "Note", timestamp: null }, body: "" };
  defaultTimestampAndValidateAgainstRegistry(old, requiredRegistry, { okfVersion: "0.1", now: () => NOW });
  assert.equal(old.frontmatter.timestamp, NOW);
});

test("strict legacy clock decisions do not depend on the host timezone", () => {
  const probe = `import {parseTimestamp} from './packages/core/dist/freshness.js'; process.stdout.write(JSON.stringify(['2026-09-08','2026-09-08T12:00:00','2026-09-08T06:00:00-06:00'].map(v=>parseTimestamp(v,'0.2'))));`;
  const outputs = ["UTC", "America/Los_Angeles", "Asia/Kolkata"].map(TZ => execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: new URL("../../..", import.meta.url), env: { ...process.env, TZ }, encoding: "utf8" }));
  for (const output of outputs) assert.equal(output, JSON.stringify([null, null, Date.parse(valid[0]!)]));
});

test("repairing an ambiguous legacy clock is a real mutation even when Date.parse guesses the same instant", async () => {
  for (const [before, after] of [["2026-09-08", "2026-09-08T00:00:00Z"], ["2026-09-08T00:00:00Z", "2026-09-08"]]) {
    const bundle = await harness();
    await writeDocVersioned(bundle, { id: "note", frontmatter: { type: "Note", timestamp: before, generated: { by: "process:test", at: "2026-09-07T00:00:00Z" } }, body: "body\n" });
    const result = await mutateDocument({ bundle, id: "note", registry: emptyRegistry, strict: false, mode: "patch", compareTimestamp: true, actor: "process:test", now: () => NOW, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, timestamp: after }, body: existing!.body }) });
    assert.equal(result.changed, true);
    assert.equal(result.doc.frontmatter.timestamp, after);
    assert.equal((result.doc.frontmatter.generated as { at: string }).at, NOW);
  }
});
