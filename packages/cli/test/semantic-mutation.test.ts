import assert from "node:assert/strict";
import test from "node:test";
import { MemoryBackend, readDocVersioned, writeDocVersioned, type OkfDocument, type WriteOptions, type Version, type Bundle } from "@superbee/core";
import { mutateDoc } from "../src/mutate.js";

class RaceBackend extends MemoryBackend {
  race?: OkfDocument;
  override async write(id: string, next: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (this.race) { const other = this.race; this.race = undefined; await super.write(id, other, options); }
    return super.write(id, next, options);
  }
}
for (const semantic of [true, false]) test(`${semantic ? "semantic assignment" : "complete-document"} body guard rechecks the fresh head after CAS conflict`, async () => {
  const backend = new RaceBackend();
  const bundle: Bundle = { root: "/unused", backend };
  await writeDocVersioned(bundle, { id: "a", frontmatter: { type: "Note", title: "A" }, body: "old\n" });
  backend.race = { id: "a", frontmatter: { type: "Note", title: "Other" }, body: "[New evidence](b.md)\n" };
  const base = { bundle, id: "a", registry: { kinds: new Map(), warnings: [] }, strict: false, helpOnKindReject: "superbee kinds", errors: {} };
  await assert.rejects(() => mutateDoc(semantic
    ? { ...base, mode: "patch", input: { kind: "assign", assignments: { title: "Mine" }, body: "new\n" } }
    : { ...base, mode: "replace-document", buildCandidate: () => ({ frontmatter: { type: "Note", title: "Mine" }, body: "new\n" }) }), /link/i);
  const current = await readDocVersioned(bundle, "a");
  assert.equal(current.doc.body, "[New evidence](b.md)\n");
  assert.equal(current.doc.frontmatter.title, "Other");
});
