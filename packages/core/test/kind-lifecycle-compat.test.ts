import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouter } from "@superbee/server";
import { parseMarkdown } from "../src/frontmatter.js";
import { buildKindRegistry, parseConventionDoc } from "../src/kinds.js";
import { loadKinds } from "../src/kinds-load.js";
import { FilesystemBackend } from "../src/backend.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import { mutateDocument } from "../src/document-mutation.js";
import type { Bundle } from "../src/types.js";

const fixture = { id: "conventions/security-advisory", ...parseMarkdown(await readFile(new URL("./fixtures/security-advisory-convention.md", import.meta.url), "utf8")) };
const collision = "OKF_WORKFLOW_STATUS_COLLISION";
const registry = { kinds: new Map(), warnings: [] };

async function adapters(run: (bundle: Bundle, storage: Bundle) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "kind-lifecycle-"));
  const memory: Bundle = { root: "mem://kind-lifecycle", backend: new MemoryBackend() };
  const filesystem: Bundle = { root: dir, backend: new FilesystemBackend(dir) };
  const server: Bundle = { root: "mem://server", backend: new MemoryBackend() };
  const remote: Bundle = { root: "wire://kind-lifecycle", backend: new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: createRouter(server) }) };
  try {
    for (const [bundle, storage] of [[memory, memory], [filesystem, filesystem], [remote, server]]) await run(bundle!, storage!);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("real convention status conflict is edition-aware, nonfatal and preserves every declaration", () => {
  const legacy = parseConventionDoc(fixture);
  assert.ok(legacy.ok);
  for (const okfVersion of [undefined, "0.1", "0.2", "0.3", "unknown"]) {
    const parsed = parseConventionDoc(fixture, { okfVersion });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.kind, legacy.kind);
    assert.deepEqual(parsed.reservedFieldsIgnored, []);
    assert.equal(parsed.warnings.filter(w => w.code === collision).length, okfVersion === "0.2" ? 1 : 0);
    if (okfVersion === "0.2") {
      assert.equal(parsed.warnings[0]!.field, "fields.values.status");
      assert.match(parsed.warnings[0]!.message, /superbee_progress_status.*--progress_status/);
      assert.equal(parsed.warnings[0]!.severity, "warning");
    }
  }
  for (const values of [undefined, ["draft", "stable", "deprecated"], ["stable"], []]) {
    const control = { ...fixture, frontmatter: { ...fixture.frontmatter, fields: { required: ["status"], values: values ? { status: values } : {} } } };
    const parsed = parseConventionDoc(control, { okfVersion: "0.2" });
    assert.deepEqual(parsed.warnings, []);
  }
  const mixed = { ...fixture, frontmatter: { ...fixture.frontmatter, fields: { optional: ["status"], values: { status: ["draft", "investigating"] } } } };
  assert.equal(parseConventionDoc(mixed, { okfVersion: "0.2" }).warnings[0]!.code, collision);
});

test("known edition reaches the same registry through memory, filesystem and wire before instances exist", async () => {
  await adapters(async (bundle, storage) => {
    await writeDocVersioned(storage, fixture);
    for (const okfVersion of [undefined, "0.1", "0.2", "future"]) {
      await storage.backend!.writeReserved("", "index.md", `---\n${okfVersion ? `okf_version: '${okfVersion}'\n` : ""}---\n`);
      const expected = buildKindRegistry([fixture], [], { okfVersion });
      const loaded = await loadKinds(bundle);
      assert.deepEqual(loaded, expected);
      assert.equal(loaded.kinds.size, 1);
    }
    await storage.backend!.writeReserved("", "index.md", "---\nokf_version: [\n---\n");
    assert.deepEqual(await loadKinds(bundle), buildKindRegistry([fixture]));
  });
});

test("imported usage counts preserve actual storage values on body edits across backends", async () => {
  await adapters(async (bundle, storage) => {
    await storage.backend!.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
    for (const [index, usage_count] of [-1, 0.5, "2", NaN, Infinity].entries()) {
      const id = `imported/count-${index}`;
      await writeDocVersioned(storage, { id, frontmatter: { type: "Note", sources: [{ resource: "scope", usage_count }] }, body: "old\n" });
      const imported = await readDocVersioned(bundle, id);
      const expected = (bundle.backend instanceof RemoteBackend) && typeof usage_count === "number" && !Number.isFinite(usage_count) ? null : usage_count;
      assert.equal((imported.doc.frontmatter.sources as Array<Record<string, unknown>>)[0]!.usage_count, expected);
      const edited = await mutateDocument({ bundle, id, mode: "patch", registry, strict: false, seedGenerationClock: false, buildCandidate: existing => ({ frontmatter: existing!.frontmatter, body: "new\n" }) });
      const after = await readDocVersioned(bundle, id);
      assert.equal(edited.changed, true);
      assert.deepEqual(after.doc.frontmatter.sources, imported.doc.frontmatter.sources);
      assert.equal(after.doc.body, "new\n");
      assert.notEqual(after.version, imported.version);
    }
  });
});

test("producer Date changes persist while equal Date values remain no-ops", async () => {
  const bundle: Bundle = { root: "mem://dates", backend: new MemoryBackend() };
  await bundle.backend!.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n");
  const first = new Date("2026-09-08T12:00:00Z");
  const second = new Date("2026-09-09T12:00:00Z");
  await writeDocVersioned(bundle, { id: "dates", frontmatter: { type: "Note", producer: { at: first } }, body: "unchanged\n" });
  const mutate = (at: Date) => mutateDocument({ bundle, id: "dates", mode: "patch", registry, strict: false, buildCandidate: existing => ({ frontmatter: { ...existing!.frontmatter, producer: { at } }, body: existing!.body }) });
  const before = await readDocVersioned(bundle, "dates");
  assert.equal((await mutate(new Date(first))).changed, false);
  assert.deepEqual(await readDocVersioned(bundle, "dates"), before);
  assert.equal((await mutate(second)).changed, true);
  const after = await readDocVersioned(bundle, "dates");
  assert.deepEqual(after.doc.frontmatter.producer, { at: second });
  assert.notEqual(after.version, before.version);
});
