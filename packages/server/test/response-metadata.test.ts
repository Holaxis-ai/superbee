import test from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend, RemoteBackend, type ConceptId, type Frontmatter } from "@superbee/core";
import { REMOTE_LOSSY_METADATA } from "../../core/test/storage-backend-contract.ts";
import { createRouterForBackend } from "../src/legacy-router.js";

const base = "http://wire.local/v0/bundles/default";
class InjectedMetadata extends MemoryBackend {
  metadata: Frontmatter = { type: "Note" };
  override async read(id: ConceptId) {
    const result = await super.read(id);
    return { ...result, doc: { ...result.doc, frontmatter: this.metadata } };
  }
}
async function fixture() {
  const backend = new InjectedMetadata();
  await backend.write("notes/a", { id: "notes/a", frontmatter: { type: "Note" }, body: "hello" });
  return { backend, router: createRouterForBackend(backend) };
}
const routes = [
  () => new Request(`${base}/docs/notes/a`),
  () => new Request(`${base}/docs:read-many`, { method: "POST", body: JSON.stringify({ ids: ["notes/a"] }) }),
  () => new Request(`${base}/docs?fields=frontmatter`),
];

for (const row of REMOTE_LOSSY_METADATA) {
  test(`response agreement: ${row.name} cannot be silently changed`, async () => {
    const { backend, router } = await fixture();
    backend.metadata = { type: "Note", extra: row.make() };
    for (const request of routes) {
      const response = await router(request());
      assert.equal(response.status, 500);
      const payload = await response.json();
      assert.equal(payload.error.code, "RUNTIME");
      assert.match(payload.error.message, /frontmatter/);
    }
    assert.equal((await router(new Request(`${base}/docs`))).status, 200, "hidden extension does not block thin projection");
    assert.equal((await router(new Request(`${base}/docs/notes/a`, { method: "HEAD" }))).status, 200);
    const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "default", fetchImpl: router, maxRetries: 0 });
    const snapshot = await remote.snapshot();
    await assert.rejects(async () => { for await (const _ of snapshot.docs) { /* consume */ } });
    backend.metadata = { type: "Note", title: row.make() };
    assert.equal((await router(new Request(`${base}/docs`))).status, 500, "emitted field must be compatible");
  });
}

test("normal response bytes, missing optionals, and Date conversion remain compatible", async () => {
  const { backend, router } = await fixture();
  backend.metadata = { type: "Note", extra: { when: new Date(0), values: [null, false, 1, "x"] } };
  const stored = await backend.read("notes/a");
  const response = await router(routes[0]!());
  assert.equal(response.headers.get("x-version"), stored.version);
  assert.equal(await response.text(), JSON.stringify({ id: "notes/a", frontmatter: backend.metadata, body: stored.doc.body }));
  const thin = await (await router(new Request(`${base}/docs`))).json();
  assert.deepEqual(thin.docs, [{ id: "notes/a", version: stored.version, type: "Note" }]);
  Object.defineProperty(backend.metadata, "title", { value: "Hidden own title", enumerable: false });
  const withTitle = await (await router(new Request(`${base}/docs`))).json();
  assert.equal(withTitle.docs[0].title, "Hidden own title", "selected own fields retain projection semantics");
});

test("selected metadata accessors and serialization hooks are refused without execution", async () => {
  const { backend, router } = await fixture();
  let calls = 0;
  backend.metadata = { type: "Note", get title() { calls++; return "changed"; } };
  assert.equal((await router(new Request(`${base}/docs`))).status, 500);
  for (const request of routes) assert.equal((await router(request())).status, 500);
  assert.equal(calls, 0);
  backend.metadata = { type: "Note", extra: { toJSON() { calls++; return null; } } };
  for (const request of routes) assert.equal((await router(request())).status, 500);
  assert.equal(calls, 0);
});

test("locally stored YAML values remain readable locally but cannot be silently changed by a response", async () => {
  for (const extra of [Infinity, NaN, Buffer.from([1]), (() => { const a: unknown[] = []; a.push(a); return a; })()]) {
    const backend = new MemoryBackend();
    await backend.write("notes/a", { id: "notes/a", frontmatter: { type: "Note", extra }, body: "hello" });
    const before = await backend.read("notes/a");
    const router = createRouterForBackend(backend);
    assert.equal((await router(routes[0]!())).status, 500);
    assert.deepEqual(await backend.read("notes/a"), before);
  }
});
