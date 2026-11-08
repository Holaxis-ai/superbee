import assert from "node:assert/strict";
import { test } from "node:test";

import { KindConformanceError, prepareDocumentMutationCandidate } from "../src/document-mutation.js";
import { kindConventionDoc, parseConventionDoc, type KindConvention, type KindRegistry } from "../src/kinds.js";
import { kindDeclaresAnything } from "../src/kind-authoring.js";
import { kindCoverage } from "../src/kind-coverage.js";
import { prepareKindFieldMutation } from "../src/kind-field-mutation.js";
import type { OkfDocument } from "../src/types.js";

function kind(policy?: "warn" | "error"): KindConvention {
  return {
    id: "conventions/signal",
    title: "Signal",
    governs: "Signal",
    fields: { required: ["title"], optional: ["owner", "superbee_progress_status"], values: {}, terminal: {}, descriptions: {} },
    ...(policy ? { undeclaredFields: policy } : {}),
  };
}
const registry = (k: KindConvention): KindRegistry => ({ kinds: new Map([[k.governs, k]]), warnings: [] });
const now = () => "2026-11-08T00:00:00Z";
const prepare = (k: KindConvention, frontmatter: Record<string, unknown>, strict: boolean, existing?: OkfDocument) =>
  prepareDocumentMutationCandidate(existing, { frontmatter: { type: "Signal", ...frontmatter }, body: "" }, {
    mode: "overwrite", id: "signals/a", registry: registry(k), strict, okfVersion: "0.2", now, persistActor: false,
  });
const undeclared = (warnings: { code: string; field?: string }[]) =>
  warnings.filter((w) => w.code === "KIND_FIELD_UNDECLARED").map((w) => w.field);

test("default warn: a strict write with an undeclared key succeeds and names the key", () => {
  const result = prepare(kind(), { title: "A", ownr: "me" }, true);
  assert.deepEqual(undeclared(result.warnings), ["ownr"]);
  assert.match(result.warnings[0]!.message, /'ownr' is not declared by kind 'Signal' \(declared: title, owner, progress_status\)/);
});

test("standard, managed and superbee_* keys never count; declared progress status is declared", () => {
  const result = prepare(kind("error"), {
    title: "A", description: "d", tags: ["x"], sources: [], status: "draft", superbee_updated_by: "me",
    superbee_progress_status: "todo", owner: "me",
  }, true);
  assert.deepEqual(undeclared(result.warnings), []);
});

test("error policy refuses a strict write naming the key and still warns a lenient one", () => {
  assert.throws(() => prepare(kind("error"), { title: "A", ownr: "me" }, true), (error: unknown) =>
    error instanceof KindConformanceError && error.violations.length === 1 &&
    error.violations[0]!.code === "KIND_FIELD_UNDECLARED" && error.violations[0]!.field === "ownr");
  assert.deepEqual(undeclared(prepare(kind("error"), { title: "A", ownr: "me" }, false).warnings), ["ownr"]);
});

test("existing undeclared keys are preserved and only trip the check when the write changes them", () => {
  const existing: OkfDocument = { id: "signals/a", frontmatter: { type: "Signal", title: "A", legacy: "keep" }, body: "" };
  const unchanged = prepare(kind("error"), { title: "B", legacy: "keep" }, true, existing);
  assert.equal(unchanged.candidate.frontmatter.legacy, "keep");
  assert.deepEqual(undeclared(unchanged.warnings), []);
  assert.throws(() => prepare(kind("error"), { title: "B", legacy: "changed" }, true, existing), KindConformanceError);
});

test("an undeclared-key warning never trips the lenient overwrite ratchet", () => {
  const existing: OkfDocument = { id: "signals/a", frontmatter: { type: "Signal", title: "A" }, body: "" };
  const result = prepare(kind(), { title: "A", extra: 1 }, false, existing);
  assert.deepEqual(undeclared(result.warnings), ["extra"]);
});

test("undeclared_fields parses, warns on a bad value, round-trips and survives kind field edits", () => {
  const doc = (value: unknown): OkfDocument => ({ id: "conventions/signal", body: "", frontmatter: {
    type: "Convention", title: "Signal", governs: "Signal", undeclared_fields: value, fields: { required: ["title"] },
  } as never });
  const parsed = parseConventionDoc(doc("error"));
  assert.ok(parsed.ok);
  assert.equal(parsed.kind.undeclaredFields, "error");
  assert.equal(kindConventionDoc(parsed.kind, "", now()).frontmatter.undeclared_fields, "error");
  assert.ok(kindDeclaresAnything({ ...kind("error"), fields: { required: [], optional: [], values: {}, terminal: {}, descriptions: {} } }));
  const bad = parseConventionDoc(doc("strict"));
  assert.ok(bad.ok);
  assert.equal(bad.kind.undeclaredFields, undefined);
  assert.ok(bad.warnings.some((w) => w.field === "undeclared_fields"));
  const edited = prepareKindFieldMutation(doc("error"), { action: "add", field: "owner", governs: "Signal", okfVersion: "0.2" }, "0.2");
  assert.equal(edited.frontmatter.undeclared_fields, "error");
});

test("coverage reports the same undeclared keys the write check names", () => {
  const docs: OkfDocument[] = [{ id: "signals/a", body: "", frontmatter: { type: "Signal", title: "A", ownr: "me", superbee_updated_by: "x", runtime: "y" } as never }];
  const report = kindCoverage(registry(kind()), docs, { now: new Date(now()), okfVersion: "0.2" });
  assert.deepEqual(report.kinds[0]!.drift.undeclared.map((row) => row.key), ["ownr"]);
});
