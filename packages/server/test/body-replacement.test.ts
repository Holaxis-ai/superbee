import assert from "node:assert/strict";
import test from "node:test";
import { MemoryBackend, type OkfDocument, type WriteOptions } from "@superbee/core";
import { RemoteBackend } from "@superbee/core/remote";
import { mutateDocument } from "@superbee/core/document-mutation";
import { createRouter } from "../src/router.js";
import { MemoryOperationOutcomeStore } from "../src/operation-outcomes.js";

const bundleId = "bnd_00112233445566778899aabbccddeeff";
const url = `https://example.test/v0/bundles/${bundleId}/docs/note`;
const frontmatter = { type: "Unregistered", timestamp: "2026-10-20T12:00:00Z", custom: { preserve: true } };
const doc = (body: string): OkfDocument => ({ id: "note", frontmatter, body });
function fixture(backend = new MemoryBackend()) {
  const router = createRouter({
    capabilities: { enforced_cas: true, blobs: true, projections: true, backlinks: false },
    outcomes: new MemoryOperationOutcomeStore(),
    resolveContext: () => ({ backend, attribution: { actor: "person:test" } }),
  });
  const put = (body: string, bodyReplace?: unknown, headers?: Record<string, string>) => router(new Request(url, {
    method: "PUT", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ frontmatter, body, ...(bodyReplace === undefined ? {} : { bodyReplace }) }),
  }));
  return { backend, router, put };
}

for (const edition of ["0.1", "0.2"]) {
  test(`PUT body replacement agreement rows, OKF ${edition}`, async () => {
    for (const row of [
      { name: "silent link loss", old: "[Source](./source.md)", next: "replacement", posture: undefined, status: 400, reason: "dropped_links" },
      { name: "preview prefix", old: "a".repeat(1200), next: "a".repeat(1000), posture: undefined, status: 400, reason: "stored_body_preview" },
      { name: "foreign preview notice", old: "full", next: "[superbee:body-preview-truncated] 12 more character(s) are NOT shown", posture: undefined, status: 400, reason: "preview_marker" },
      { name: "explicit link removal", old: "[Source](./source.md)", next: "replacement", posture: { replaceLinks: true }, status: 200 },
      { name: "preview override does not remove links", old: "[Source](./source.md)", next: "replacement", posture: { acceptTruncatedBody: true }, status: 400, reason: "dropped_links" },
      { name: "link override does not accept preview", old: "a".repeat(1200), next: "a".repeat(1000), posture: { replaceLinks: true }, status: 400, reason: "stored_body_preview" },
      { name: "explicit preview", old: "a".repeat(1200), next: "a".repeat(1000), posture: { acceptTruncatedBody: true }, status: 200 },
      { name: "preserving append", old: "[Source](./source.md)", next: "[Source](./source.md)\nmore", posture: undefined, status: 200 },
      { name: "retext same target", old: "[Source](./source.md)", next: "[Renamed](./source.md)", posture: {}, status: 200 },
      { name: "unchanged", old: "[Source](./source.md)", next: "[Source](./source.md)", posture: undefined, status: 200 },
    ]) {
      const { backend, put } = fixture();
      await backend.writeReserved("", "index.md", `---\nokf_version: '${edition}'\n---\n`);
      const base = await backend.write("note", doc(row.old));
      const response = await put(row.next, row.posture, { "If-Match": base });
      assert.equal(response.status, row.status, row.name);
      const saved = await backend.read("note");
      assert.equal(saved.doc.body.trimEnd(), (row.status === 400 ? row.old : row.next).trimEnd(), row.name);
      assert.deepEqual(saved.doc.frontmatter.custom, frontmatter.custom);
      assert.equal(saved.doc.frontmatter["updated.at"], undefined);
      if (row.reason) {
        const answer = await response.json();
        assert.equal(answer.error.details.reason, row.reason);
        assert.equal(saved.version, base);
        assert.equal((await backend.versions("note")).length, 1);
      }
    }
  });
}

test("malformed replacement intent is refused without writes; overrides require a premise", async () => {
  const { backend, put } = fixture();
  const base = await backend.write("note", doc("original"));
  for (const posture of [null, [], true, "yes", { replaceLinks: "true" }, { acceptTruncatedBody: 1 }, { unknown: true }]) {
    assert.equal((await put("replacement", posture, { "If-Match": base })).status, 400);
    assert.equal((await backend.read("note")).version, base);
  }
  assert.equal((await put("replacement", { replaceLinks: true })).status, 400);
  assert.equal((await put("replacement", {})).status, 200);
});

test("stale premise is conflict before body refusal and recorded refusal cannot be widened", async () => {
  const { backend, put } = fixture();
  const stale = await backend.write("note", doc("old"));
  const base = await backend.write("note", doc("[Source](./source.md)"));
  assert.equal((await put("replacement", undefined, { "If-Match": stale })).status, 412);
  const headers = { "If-Match": base, "Idempotency-Key": "same-edit" };
  const first = await put("replacement", undefined, headers);
  const replay = await put("replacement", { replaceLinks: true }, headers);
  assert.equal(first.status, 400);
  assert.equal(replay.status, first.status);
  assert.equal(await replay.text(), await first.text());
  assert.equal((await backend.read("note")).version, base);
});

test("observed-head CAS prevents concurrent replacement, disappearance, or create from being overwritten", async () => {
  for (const mode of ["replace", "delete", "create"] as const) {
    class RacingBackend extends MemoryBackend {
      armed = false;
      override async write(id: string, next: OkfDocument, options?: WriteOptions) {
        if (this.armed) {
          this.armed = false;
          if (mode === "delete") await super.delete(id);
          else await super.write(id, doc("concurrent [Source](./new.md)"));
        }
        return super.write(id, next, options);
      }
    }
    const backend = new RacingBackend();
    if (mode !== "create") await backend.write("note", doc("old"));
    backend.armed = true;
    const { put } = fixture(backend);
    assert.equal((await put("stale replacement")).status, 412, mode);
    if (mode !== "delete") assert.equal((await backend.read("note")).doc.body.trimEnd(), "concurrent [Source](./new.md)");
    else await assert.rejects(backend.read("note"), { code: "ENOENT" });
  }
});

test("create status and raw metadata survive the protected document boundary", async () => {
  for (const explicit of [false, true]) {
    const { backend, put } = fixture();
    const response = await put("body", undefined, explicit ? { "If-None-Match": "*" } : {});
    assert.equal(response.status, explicit ? 201 : 200);
    assert.deepEqual((await backend.read("note")).doc.frontmatter.custom, frontmatter.custom);
  }
});

test("RemoteBackend captures explicit per-call posture before capability discovery yields", async () => {
  const { backend, router } = fixture();
  const base = await backend.write("note", doc("[Source](./source.md)"));
  const posture = { replaceLinks: false };
  const remote = new RemoteBackend({ baseUrl: "https://example.test", bundle: bundleId, fetchImpl: async (request) => {
    if (request.url.endsWith("/capabilities")) posture.replaceLinks = true;
    return router(request);
  } });
  await assert.rejects(remote.write("note", doc("replacement"), { expectedVersion: base, bodyReplace: posture }));
  assert.equal((await backend.read("note")).version, base);
  await remote.write("note", doc("replacement"), { expectedVersion: base, bodyReplace: { replaceLinks: true } });
  assert.equal((await backend.read("note")).doc.body.trimEnd(), "replacement");
});


test("Core mutation explicit link removal survives the actual RemoteBackend and Server boundary", async () => {
  const { backend, router } = fixture();
  const base = await backend.write("note", doc("[Source](./source.md)"));
  const remote = new RemoteBackend({ baseUrl: "https://example.test", bundle: bundleId, fetchImpl: router });
  const options = {
    bundle: { root: "", backend: remote }, id: "note", mode: "patch" as const,
    registry: { kinds: new Map(), warnings: [] }, strict: false,
    expectedVersion: base,
    input: { kind: "assign" as const, assignments: {}, body: "intentional replacement" },
  };
  await assert.rejects(mutateDocument(options), { name: "BodyReplaceError" });
  const result = await mutateDocument({ ...options, bodyReplace: { replaceLinks: true } });
  assert.equal(result.changed, true);
  assert.equal((await backend.read("note")).doc.body.trimEnd(), "intentional replacement");
});

test("guarded Core write captures candidate and options before backend yields", async () => {
  const { writeDocVersionedGuarded } = await import("@superbee/core/engine");
  const candidate = doc("[Source](./source.md)\naddition");
  const options: WriteOptions = { bodyReplace: { replaceLinks: false } };
  class MutatingBackend extends MemoryBackend {
    override async readReserved(...args: Parameters<MemoryBackend["readReserved"]>) {
      candidate.body = "silently removed";
      options.bodyReplace!.replaceLinks = true;
      return super.readReserved(...args);
    }
  }
  const backend = new MutatingBackend();
  options.expectedVersion = await backend.write("note", doc("[Source](./source.md)"));
  await writeDocVersionedGuarded(backend, candidate, options);
  assert.equal((await backend.read("note")).doc.body.trimEnd(), "[Source](./source.md)\naddition");
});

test("wire journal transport keeps default protection and does not invent editor intent", async () => {
  const { createRemoteOperationTransport } = await import("@superbee/core/remote-operations");
  const { backend, router } = fixture();
  const base = await backend.write("note", doc("[Source](./source.md)"));
  const remote = new RemoteBackend({ baseUrl: "https://example.test", bundle: bundleId, fetchImpl: router });
  const transport = createRemoteOperationTransport(remote);
  const outcome = await transport.submit({ kind: "document.write", requestId: "journal-link-removal", target: "note", base,
    content: "---\ntype: Unregistered\ntimestamp: '2026-10-20T12:00:00Z'\n---\nreplacement" });
  assert.equal(outcome.kind, "refused");
  assert.equal((await backend.read("note")).version, base);
});
