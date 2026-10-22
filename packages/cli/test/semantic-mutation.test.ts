import assert from "node:assert/strict";
import test from "node:test";
import { MemoryBackend, readDocVersioned, writeDocVersioned, type DeleteOptions, type OkfDocument, type WriteOptions, type Version, type Bundle } from "@superbee/core";
import { deleteMutatedDoc, mutateDoc } from "../src/mutate.js";
import { CliError } from "../src/errors.js";

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

for (const row of ["unconditional", "matching", "stale", "absent-with-token", "backend-failure", "throwing-hook"] as const) {
  test(`document deletion seam: ${row} preserves one attempt, no reads and true-only hooks`, async () => {
    class DeleteBackend extends MemoryBackend {
      calls: Array<DeleteOptions | undefined> = [];
      override async read(): Promise<never> { assert.fail("deletion must not read a target"); }
      override async readReserved(): Promise<never> { assert.fail("deletion seam must not read edition metadata"); }
      override async delete(id: string, options?: DeleteOptions): Promise<boolean> {
        this.calls.push(options);
        if (row === "backend-failure") throw new Error("backend unavailable");
        return super.delete(id, options);
      }
    }
    const backend = new DeleteBackend();
    const id = "notes/remove";
    const head = await backend.write(id, { id, frontmatter: { type: "Note" }, body: "preserve until removed" });
    await backend.write(id, { id, frontmatter: { type: "Note", title: "Newest" }, body: "latest" });
    const newest = (await backend.versions(id))[0]!.version;
    if (row === "absent-with-token") await MemoryBackend.prototype.delete.call(backend, id);
    const expectedVersion = row === "unconditional" || row === "throwing-hook" || row === "backend-failure"
      ? undefined : row === "matching" ? newest : head;
    let hooks = 0;
    const stale = new CliError("STALE_HEAD", "caller-specific conflict", { help: "caller fix" });
    const run = () => deleteMutatedDoc({ bundle: { root: "/unused", backend }, id, expectedVersion,
      staleHead: error => { assert.equal(error.expected, head); assert.equal(error.actual, newest); return stale; },
      onPersisted: () => { hooks++; if (row === "throwing-hook") throw new Error("bookkeeping unavailable"); },
    });
    if (row === "stale") await assert.rejects(run, error => error === stale);
    else if (row === "backend-failure") await assert.rejects(run, (error: unknown) => error instanceof CliError && error.code === "RUNTIME" && /backend unavailable/.test(error.message));
    else assert.equal(await run(), row !== "absent-with-token");
    assert.deepEqual(backend.calls, [expectedVersion === undefined ? undefined : { expectedVersion }]);
    const persisted = row === "unconditional" || row === "matching" || row === "throwing-hook";
    assert.equal(hooks, persisted ? 1 : 0);
    assert.equal((await backend.versions(id)).length, row === "stale" || row === "backend-failure" ? 2 : 0);
  });
}
