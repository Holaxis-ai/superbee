/** Reference authoring admission precedes every document and blob write. */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend } from "../src/memory-backend.js";
import { installRecipe, RecipeInputError } from "../src/recipe-lifecycle/index.js";
import type { LoadedRecipe } from "../src/recipes.js";
import type { BlobKey, Bundle, ConceptId, OkfDocument, Version, WriteOptions } from "../src/types.js";

const NOW = "2026-10-20T12:00:00.000Z";
class CountingBackend extends MemoryBackend {
  documentAttempts = 0;
  documentWrites = 0;
  blobAttempts = 0;
  blobWrites = 0;
  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    this.documentAttempts++;
    const version = await super.write(id, doc, options);
    this.documentWrites++;
    return version;
  }
  override async writeBlob(key: BlobKey, bytes: Uint8Array, contentType?: string, options: WriteOptions = {}): Promise<Version> {
    this.blobAttempts++;
    const version = await super.writeBlob(key, bytes, contentType, options);
    this.blobWrites++;
    return version;
  }
  counts(): number[] { return [this.documentAttempts, this.documentWrites, this.blobAttempts, this.blobWrites]; }
}
async function target(edition: "0.1" | "0.2") {
  const backend = new CountingBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  const bundle: Bundle = { root: "mem://reference-preflight", backend };
  return { backend, bundle };
}
function recipe(extra: Record<string, unknown>, blobFirst = false): LoadedRecipe {
  return {
    id: "reference-preflight", title: "Reference preflight", version: "1", summary: "Admission", offer: "Fixture", source: "test:reference-preflight",
    docs: blobFirst ? [] : [{ id: "conventions/item", frontmatter: { type: "Convention", title: "Item", governs: "Item", path: "items/" }, body: "# Item\n" }],
    pages: [{ registry: { id: "views-registry/items", frontmatter: { type: "View", title: "Items", entry: "views/items/index.html", access: "none" }, body: "" }, entry: "views/items/index.html", html: "<!doctype html><p>Items</p>" }],
    references: [{ doc: { id: "references/help", frontmatter: { type: "Reference", title: "Help", ...extra }, body: "# Help\n" } }],
    governs: blobFirst ? [] : ["Item"], warnings: [],
  };
}
const invalid: Array<[string, Record<string, unknown>]> = [
  ["tags", { tags: 7 }],
  ["source resource", { sources: [{ resource: "" }] }],
  ["verification", { verified: { by: "human:tester", at: "not-a-time" } }],
  ["generation actor", { generated: { by: "not-an-actor", at: NOW } }],
];
for (const [name, extra] of invalid) {
  for (const blobFirst of [false, true]) {
    test(`OKF 0.2 refuses invalid Reference ${name} before ${blobFirst ? "blob-first" : "convention-first"} writes`, async () => {
      const { backend, bundle } = await target("0.2");
      const error = await installRecipe(bundle, recipe(extra, blobFirst), { now: NOW, actor: "process:test" }).then(
        () => assert.fail("invalid Reference installed"), (caught: unknown) => caught,
      );
      assert.deepEqual(backend.counts(), [0, 0, 0, 0], "not even an attempted document or blob write");
      assert.ok(error instanceof RecipeInputError);
      assert.match(error.message, /recipe 'reference-preflight' cannot install Reference 'references\/help': OKF v0\.2 .*; nothing was written$/);
    });
  }
  test(`OKF 0.1 retains legacy Reference ${name} admission`, async () => {
    const { backend, bundle } = await target("0.1");
    assert.equal((await installRecipe(bundle, recipe(extra), { now: NOW })).changed, true);
    assert.deepEqual(backend.counts(), [3, 3, 1, 1]);
  });
}
test("valid OKF 0.2 Reference installs with provenance and re-add remains create-only", async () => {
  const { backend, bundle } = await target("0.2");
  const source = recipe({ tags: ["guide"], generated: { by: "process:recipe-author", at: NOW }, sources: [{ resource: "https://example.test/help", author: "Team" }] });
  const original = structuredClone(source);
  assert.equal((await installRecipe(bundle, source, { now: NOW, actor: "human:installer" })).changed, true);
  assert.deepEqual(backend.counts(), [3, 3, 1, 1]);
  const stored = await backend.read("references/help");
  assert.equal((stored.doc.frontmatter.generated as Record<string, unknown>).by, "process:recipe-author");
  assert.equal(stored.doc.frontmatter.superbee_updated_by, "human:installer");
  assert.deepEqual(source, original, "preparation does not mutate the recipe");
  assert.equal((await installRecipe(bundle, source, { now: NOW, actor: "human:installer" })).changed, false);
  assert.equal((await backend.read("references/help")).version, stored.version);
  assert.equal(backend.documentWrites, 3);
  assert.equal(backend.blobWrites, 1);
});
