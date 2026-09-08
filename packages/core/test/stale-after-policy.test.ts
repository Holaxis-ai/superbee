import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "@superbee/server";
import { readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { InvalidInputError } from "../src/errors.js";
import type { Bundle, Frontmatter } from "../src/types.js";

const registry = { kinds: new Map(), warnings: [] };
const invalid = ["2020-01-01", "garbage", "", "2026-01-01T12:00:00", "2026-02-30T12:00:00Z", null, false, 42, NaN, Infinity, ["2020-01-01"], { date: "2020-01-01", other: NaN }];
const instant = "2026-09-07T12:34:56.123456789-06:00";
async function fixture(edition = "0.2") {
  const backend = new MemoryBackend();
  await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
  return { backend, bundle: { root: "mem://stale-after-policy", backend } as Bundle };
}
function mutate(bundle: Bundle, mode: "create-only" | "patch", change: (fm: Frontmatter) => Frontmatter) {
  return mutateDocument({ bundle, id: "notes/one", mode, registry, strict: false,
    buildCandidate: (existing) => ({ frontmatter: change({ ...(existing?.frontmatter ?? { type: "Note" }) }), body: "body\n" }) });
}

test("authored v0.2 creates reject every invalid deadline before persistence", async () => {
  for (const value of invalid) {
    const { bundle, backend } = await fixture();
    await assert.rejects(mutate(bundle, "create-only", fm => ({ ...fm, stale_after: value })),
      error => error instanceof InvalidInputError && /stale_after/.test(error.message));
    assert.equal(await backend.exists("notes/one"), false);
  }
});

test("authored changes reject invalid deadlines, preserve unchanged legacy values, and allow repair/removal", async () => {
  for (const value of invalid) {
    const { bundle } = await fixture();
    // Raw import is intentionally preservation-capable; authored mutation is stricter.
    await writeDocVersioned(bundle, { id: "notes/one", frontmatter: { type: "Note", stale_after: value }, body: "body\n" });
    const changed = await mutate(bundle, "patch", fm => ({ ...fm, title: "Unrelated edit", stale_after: structuredClone(value) }));
    assert.deepEqual(changed.doc.frontmatter.stale_after, value);
    const before = await readDocVersioned(bundle, "notes/one");
    await assert.rejects(mutate(bundle, "patch", fm => ({ ...fm, stale_after: "different-invalid-value" })), InvalidInputError);
    assert.deepEqual(await readDocVersioned(bundle, "notes/one"), before);
    const repaired = await mutate(bundle, "patch", fm => ({ ...fm, stale_after: instant }));
    assert.equal(repaired.doc.frontmatter.stale_after, instant);
    const removed = await mutate(bundle, "patch", fm => { delete fm.stale_after; return fm; });
    assert.equal(Object.hasOwn(removed.doc.frontmatter, "stale_after"), false);
  }
});

test("v0.1 authored mutations retain legacy extension behavior", async () => {
  const { bundle } = await fixture("0.1");
  await mutate(bundle, "create-only", fm => ({ ...fm, stale_after: "2020-01-01" }));
  const changed = await mutate(bundle, "patch", fm => ({ ...fm, stale_after: "anything" }));
  assert.equal(changed.doc.frontmatter.stale_after, "anything");
});

test("raw core and wire imports preserve legacy deadlines while authored remote mutations reject new invalid values", async () => {
  const { bundle: server } = await fixture();
  const remote: Bundle = { root: "wire://stale-after", backend: new RemoteBackend({
    baseUrl: "http://wire.local", bundle: "stale-after", fetchImpl: createRouter(server),
  }) };
  for (const bundle of [server, remote]) {
    await writeDocVersioned(bundle, { id: "notes/one", frontmatter: { type: "Note", stale_after: "2020-01-01" }, body: "body\n" });
    assert.equal((await readDocVersioned(bundle, "notes/one")).doc.frontmatter.stale_after, "2020-01-01");
    await assert.rejects(mutate(bundle, "patch", fm => ({ ...fm, stale_after: "garbage" })), InvalidInputError);
    assert.equal((await readDocVersioned(bundle, "notes/one")).doc.frontmatter.stale_after, "2020-01-01");
  }
});
