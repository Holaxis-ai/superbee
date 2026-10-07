import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initBundle, writeDoc, readDoc, type OkfDocument } from "@superbee/core";
import { inferKindCandidate, draftPromotions, collectInstanceStats, warningsAfterApply } from "../src/kind-draft.js";
import { doc } from "../src/commands/doc.js";
import { newCommand } from "../src/commands/new.js";
import { promote } from "../src/commands/promote.js";
const metadata = ["generated", "verified", "actor", "timestamp", "superbee_updated_by", "head_version", "superbee_progress_status", "superbee_custom"];
for (const presence of ["all", "partial"]) test(`inference excludes ${presence} metadata from declarations, enums and promotions`, () => {
  const docs: OkfDocument[] = Array.from({ length: 10 }, (_, i) => ({ id: `showings/${i}`, frontmatter: { type: "Showing", title: `Showing ${i}`, listing_status: i % 2 ? "open" : "closed", ...(presence === "all" || i < 6 ? Object.fromEntries(metadata.map(key => [key, i % 2 ? "one" : "two"])) : {}) }, body: "# Feedback\n\n# Visitors\n" }));
  const stats = collectInstanceStats(docs); const kind = inferKindCandidate("Showing", docs, stats);
  assert.deepEqual(kind.fields.required, ["listing_status", "title"]); assert.deepEqual(kind.fields.optional, []);
  assert.deepEqual(kind.fields.values, { listing_status: ["closed", "open"] }); assert.deepEqual(kind.sections, ["Feedback", "Visitors"]);
  assert.deepEqual(draftPromotions(kind, stats), []); assert.equal(warningsAfterApply(kind, docs), 0);
});
test("domain inference from doc write, new and promote retains title and sections", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-domain-inference-")); const sink = { stdout: () => {} };
  try {
    const bundle = { root: dir }; await initBundle(dir); const body = "# Feedback\n\n# Visitors\n";
    await doc(["write", "showings/a", "--type", "Showing", "--title", "A", "--body", body, "--actor", "process:test", "--dir", dir], sink);
    await writeDoc(bundle, { id: "conventions/showing", frontmatter: { type: "Convention", governs: "Showing", fields: { required: ["title"] }, sections: ["Feedback", "Visitors"] }, body: "" });
    await newCommand(["Showing", "showings/b", "--title", "B", "--actor", "process:test", "--dir", dir], sink);
    const file = path.join(dir, "import.md"); await writeFile(file, `---\ntype: Showing\ntitle: C\nactor: human:importer\nhead_version: receipt\nsuperbee_custom: value\n---\n${body}`);
    await promote([file, "--doc-key", "showings/c.md", "--dir", dir], sink);
    const docs = await Promise.all(["a", "b", "c"].map(id => readDoc(bundle, `showings/${id}`))); const stats = collectInstanceStats(docs); const candidate = inferKindCandidate("Showing", docs, stats);
    assert.deepEqual(candidate.fields.required, ["title"]); assert.deepEqual(candidate.fields.optional, []); assert.deepEqual(candidate.fields.values, {});
    assert.deepEqual(candidate.sections, ["Feedback", "Visitors"]); assert.deepEqual(draftPromotions(candidate, stats), []); assert.equal(warningsAfterApply(candidate, docs), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
