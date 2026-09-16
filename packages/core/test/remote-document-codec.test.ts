import assert from "node:assert/strict";
import test from "node:test";
import { RemoteBackend } from "../src/remote-backend.js";
import { encodeRemoteDocument, RemoteDocumentValueError } from "../src/remote-document-codec.js";
import { createRemoteOperationTransport, openRemoteOperationTransport } from "../src/remote-operations.js";
import { performUncertainWrite } from "../src/uncertain-write.js";
import { REMOTE_LOSSY_METADATA } from "./remote-metadata-fixtures.js";

const version = `sha256:${"a".repeat(64)}`;

for (const row of REMOTE_LOSSY_METADATA) {
  test(`remote metadata refuses ${row.name} before sending any write`, async () => {
    let requests = 0;
    const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: async () => {
      requests++; throw new Error("must not send");
    } });
    await assert.rejects(remote.write("note", {
      id: "note", frontmatter: { type: "Note", nested: [{ field: row.make() }] }, body: "body",
    }, { expectedVersion: null, requestId: "guard-test" }), error => {
      assert.ok(error instanceof RemoteDocumentValueError);
      assert.match(error.path, /^frontmatter\["nested"\]\[0\]\["field"\]/);
      return true;
    });
    assert.equal(requests, 0);
  });
}

test("remote metadata captures ordinary values and valid Dates without changing JSON bytes", async () => {
  const shared = { title: "shared" };
  const frontmatter = Object.assign(Object.create(null), {
    type: "Note", null: null, array: [0, true, "string"], date: new Date("2026-01-02T03:04:05Z"),
    first: shared, second: shared, toJSON: "literal",
  });
  Object.defineProperty(frontmatter, "__proto__", { value: { safe: true }, enumerable: true });
  const expected = JSON.stringify({ frontmatter, body: "unchanged" });
  assert.equal(encodeRemoteDocument(frontmatter, "unchanged"), expected);
  let requests = 0;
  const payloads: string[] = [];
  const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", maxRetries: 1, fetchImpl: async request => {
    requests++;
    payloads.push(await request.text());
    assert.equal(request.headers.get("If-None-Match"), "*");
    assert.equal(request.headers.get("Idempotency-Key"), "capture");
    if (requests === 1) { shared.title = "mutated after capture"; return new Response("", { status: 503 }); }
    return Response.json({ version });
  } });
  assert.equal(await remote.write("note", { id: "note", frontmatter, body: "unchanged" }, { expectedVersion: null, requestId: "capture" }), version);
  assert.deepEqual(payloads, [expected, expected]);
});

test("remote metadata does not execute accessors or custom serialization hooks", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { calls++; return 1; } });
  const hook = { toJSON() { calls++; return {}; } };
  const date = Object.defineProperty(new Date(0), "toJSON", { value() { calls++; return "different"; } });
  for (const value of [accessor, hook, date]) assert.throws(() => encodeRemoteDocument({ type: "Note", value }, ""), RemoteDocumentValueError);
  assert.equal(calls, 0);
});

for (const eager of [false, true]) {
  test(`identified metadata refusal is definitive (${eager ? "eager" : "lazy"} transport)`, async () => {
    const methods: string[] = [];
    const remote = new RemoteBackend({ baseUrl: "http://wire.local", bundle: "test", fetchImpl: async request => {
      methods.push(request.method);
      assert.ok(request.url.endsWith("/v0/capabilities"));
      return Response.json({ operations: true });
    } });
    const transport = eager ? await openRemoteOperationTransport(remote) : createRemoteOperationTransport(remote);
    const result = await performUncertainWrite(transport, {
      requestId: "lossy", kind: "document.write", target: "note", base: null,
      content: "---\ntype: Note\nvalue: .inf\n---\nbody\n", local: version, createdAt: "2026-01-02T00:00:00Z",
      attempts: 0, state: "pending",
    });
    assert.equal(result.outcome.kind, "refused");
    assert.equal(result.intent.state, "refused");
    assert.equal(result.lookups, 0);
    assert.deepEqual(methods, ["GET"]);
  });
}
