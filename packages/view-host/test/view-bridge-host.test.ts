import test from "node:test";
import assert from "node:assert/strict";
// The operation-mapped View bridge host: no address in `hello` or `open-page`, `relationships`
// mapped, and refusing instead of degrading a query feature the operations cannot answer.
import {
  createViewBridgeHost,
  BRIDGE_LIMITS,
  bridgeLimits,
  type ViewBridgeFrame,
  type ViewBridgeHostOptions,
  type ViewBridgeOperation as AppOperation,
  type ViewBridgeUiResult as AppUiResult,
  ReadAdapterError,
} from "../dist/view-bridge-host.js";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";

/** One options object, onto the host's call shape (frame, bundle, execute, options). */
function createBridgeHost(
  options: Omit<ViewBridgeHostOptions, "renderDocument"> & {
    source: ViewBridgeFrame;
    title: string;
    bundleId: string;
    execute: Parameters<typeof createViewBridgeHost>[2];
    renderDocument?: ViewBridgeHostOptions["renderDocument"] | false;
  },
) {
  const { source, title, bundleId, execute, renderDocument, ...rest } = options;
  return createViewBridgeHost(source, { id: bundleId, name: title }, execute, {
    ...rest,
    ...(renderDocument === false ? {} : { renderDocument: renderDocument ?? renderDocumentToStaticHtml }),
  });
}

const version = "sha256:" + "a".repeat(64);
const later = "sha256:" + "b".repeat(64);
const alpha = { id: "bridge/alpha", frontmatter: { type: "Note", superbee_progress_status: "active" }, version };
const beta = { id: "bridge/beta", frontmatter: { type: "Note", superbee_progress_status: "done" }, version: later };
const relationships = [
  { from: "bridge/alpha", to: "bridge/beta", text: "depends on", href: "beta.md" },
  { from: "bridge/beta", to: "areas/finance", text: "informs", href: "../areas/finance.md" },
];
const graph = {
  bundleId: "bound",
  complete: true,
  readIdentity: version,
  counts: { documents: 2, relationships: 2 },
  okfVersion: "0.2",
  rootVersion: version,
  modelVersion: version,
  definitions: [],
  model: { schemaVersion: 0, kinds: [], relationships: [], registryWarnings: [], diagnostics: [] },
  documents: [alpha, beta],
  relationships,
};
const envelope = (operationId: string, data: unknown) => ({ ok: true, operationId, data });

function fixture(
  operations: AppOperation[] = ["documents.read.v1", "documents.query.v1", "bundles.graph.v1"],
  extra: { renderDocument?: false } = {},
) {
  const replies: any[] = [];
  const calls: { operation: AppOperation; input: any; signal: AbortSignal }[] = [];
  const opened: string[] = [];
  const state = {
    admitted: true,
    invalidated: 0,
    ready: 0,
    recordAvailable: true,
    body: "# Alpha\n\nLinks to [depends on](beta.md).\n",
    graph: graph as any,
    answer: undefined as undefined | ((operation: AppOperation, input: any) => unknown),
    open: (async () => ({ ok: true })) as (id: string, signal: AbortSignal) => Promise<AppUiResult>,
  };
  const source = {
    postMessage(data: any, origin: string) {
      assert.equal(origin, "*");
      replies.push(data);
    },
  } as unknown as ViewBridgeFrame;
  const host = createBridgeHost({
    source,
    title: "Conformance View",
    bundleId: "bound",
    operations,
    admitted: () => state.admitted,
    invalidate() {
      state.invalidated++;
      host.stop();
    },
    onReady() {
      state.ready++;
    },
    async execute(operation, input, signal) {
      calls.push({ operation, input, signal });
      if (state.answer) return state.answer(operation, input);
      if (operation === "documents.query.v1") return envelope(operation, { documents: [alpha, beta] });
      if (operation === "documents.edges.v1")
        return envelope(operation, {
          edges: state.graph.relationships.map(({ from, to, text }: { from: string; to: string; text: string }) => ({
            from,
            to,
            text,
          })),
        });
      if (operation === "documents.read.v1")
        return envelope(operation, { document: { ...alpha, body: state.body, version: undefined }, version });
      // The transport's result check refuses a graph row carrying a body the request did not ask
      // for, so the fake strips them the way the real operation never sends them.
      if ((input as { includeBodies?: true }).includeBodies === true) return envelope(operation, state.graph);
      return envelope(operation, {
        ...state.graph,
        documents: state.graph.documents.map(({ body: _body, ...head }: { body?: string }) => head),
      });
    },
    recordAvailable: () => state.recordAvailable,
    async openRecord(id, signal) {
      opened.push(id);
      return state.open(id, signal);
    },
    ...extra,
  });
  const send = (data: unknown, origin = "null", from: unknown = source) =>
    host.receive({ source: from as ViewBridgeFrame, origin, data });
  const request = async (message: Record<string, unknown>) => {
    await send({ bridge: "v0", ...message });
    return replies.find((reply) => reply.id === message.id);
  };
  return { host, replies, calls, opened, state, send, request };
}

test("only the frame's own bridge envelopes are admitted; another protocol's envelope is ignored", async () => {
  const f = fixture();
  await f.send({ bridge: "v0", id: "1", type: "hello" }, "https://app.test");
  await f.send({ bridge: "v0", id: "1", type: "hello" }, "null", {});
  await f.send({ v: 1, channel: "a".repeat(64), generation: 1, type: "app-ready" });
  await f.send("hello");
  await f.send(null);
  await f.send([]);
  await f.send({ bridge: "v2", id: "1", type: "hello" });
  await f.send({ bridge: "v0", id: "1", type: 7 });
  assert.equal(f.replies.length, 0);
  assert.equal(f.state.ready, 0, "nothing admitted, so no readiness");
  await f.send({ bridge: "v0", id: "big", type: "read", docId: "x".repeat(70000) });
  assert.equal(f.replies.length, 1);
  assert.deepEqual(f.replies[0], {
    bridge: "v0",
    id: "big",
    type: "error",
    error: { code: "TOO_LARGE", message: "the bridge request exceeded the 64 KiB message limit" },
  });
  assert.equal(f.state.ready, 0, "an oversize message is answered before parsing and is not readiness");
  await f.send({ bridge: "v1", requestId: "a-big", type: "action.propose", action: "x".repeat(70000) });
  assert.equal(f.replies.at(-1).id, "a-big", "a v1 proposal is refused on its own correlation key");
  assert.equal(f.replies.at(-1).error.code, "TOO_LARGE");
  const count = f.replies.length;
  await f.send({ bridge: "v0", id: "i".repeat(256), type: "read", docId: "x".repeat(70000) });
  await f.send({ bridge: "v0", id: 7, type: "read", docId: "x".repeat(70000) });
  await f.send({ bridge: "v0", type: "read", docId: "x".repeat(70000) });
  assert.equal(f.replies.length, count, "an oversize message without a cheap id is the one message never answered");
});

test("readiness fires once on the first bridge request of any type", async () => {
  for (const first of [
    { id: "1", type: "subscribe" },
    { id: "1", type: "query", params: {} },
    { id: "1", type: "unknown-thing" },
    { bridge: "v1", id: "1", type: "read-versioned", docId: "bridge/alpha" },
  ]) {
    const f = fixture();
    await f.request(first);
    await f.request({ id: "2", type: "hello" });
    assert.equal(f.state.ready, 1, JSON.stringify(first));
  }
});

test("hello answers locally with no address, the page title, sorted registry capabilities and zeroed limits", async () => {
  const full = { query: 100, edges: 1000, graphDocuments: 1000, graphRelationships: 10000, replyBytes: 2097152 };
  const cases: [AppOperation[], string[], Record<string, number>][] = [
    [
      ["documents.read.v1", "documents.query.v1", "documents.edges.v1", "bundles.graph.v1"],
      ["edges", "graph", "query.newest", "record.open", "render-document"],
      full,
    ],
    [
      ["documents.read.v1", "documents.query.v1", "bundles.graph.v1"],
      ["graph", "query.newest", "record.open", "render-document"],
      { ...full, edges: 0 },
    ],
    [
      ["documents.read.v1", "documents.query.v1"],
      ["query.newest", "record.open", "render-document"],
      { ...full, edges: 0, graphDocuments: 0, graphRelationships: 0 },
    ],
    [
      ["documents.read.v1"],
      ["record.open", "render-document"],
      { ...full, query: 0, edges: 0, graphDocuments: 0, graphRelationships: 0 },
    ],
    [["documents.query.v1"], ["query.newest"], { ...full, edges: 0, graphDocuments: 0, graphRelationships: 0 }],
    [["bundles.graph.v1"], ["graph"], { ...full, query: 0, edges: 0 }],
    [["documents.edges.v1"], ["edges"], { ...full, query: 0, graphDocuments: 0, graphRelationships: 0 }],
    // A caller with no graph, and the relationships and edges reads.
    [
      ["documents.read.v1", "documents.query.v1", "documents.relationships.v1", "documents.edges.v1"],
      ["edges", "query.newest", "record.open", "relationships", "render-document"],
      { ...full, graphDocuments: 0, graphRelationships: 0 },
    ],
  ];
  for (const [operations, capabilities, limits] of cases) {
    const f = fixture(operations);
    const reply = await f.request({ id: "1", type: "hello" });
    assert.deepEqual(
      reply,
      {
        bridge: "v0",
        id: "1",
        type: "hello:result",
        result: {
          bundle: { root: null, name: "Conformance View" },
          mode: "hosted",
          protocol: "v0",
          grant: "read",
          host: { kind: "hosted", capabilities, limits },
        },
      },
      operations.join(","),
    );
    assert.deepEqual(capabilities, [...capabilities].sort(), "capabilities are sorted");
    // `query.newest` is the one query capability, declared exactly where `query` is offered: no
    // `query.field-or`, `query.open`, `query.kind-projection` or `query.count`.
    assert.deepEqual(
      capabilities.filter((name) => name.startsWith("query")),
      operations.includes("documents.query.v1") ? ["query.newest"] : [],
    );
    assert.deepEqual(bridgeLimits(new Set(operations)), limits);
    assert.equal(f.calls.length, 0);
  }
  assert.deepEqual(BRIDGE_LIMITS, full);
  // `limits.edges` is `documents.edges.v1`'s own cap: the conformance bundle's 1,005 links must
  // exceed it.
  assert.equal(BRIDGE_LIMITS.edges, 1000);
  const noReader = fixture(["documents.read.v1"]);
  noReader.state.recordAvailable = false;
  const reply = await noReader.request({ id: "1", type: "hello" });
  assert.deepEqual(reply.result.host.capabilities, ["render-document"]);
  assert.deepEqual((await noReader.request({ id: "2", type: "hello", extra: 1 })).error.code, "USAGE");
  // Without the page's renderer, render-document is neither declared nor served.
  const f = fixture(["documents.read.v1"], { renderDocument: false });
  assert.deepEqual((await f.request({ id: "1", type: "hello" })).result.host.capabilities, ["record.open"]);
  assert.equal((await f.request({ id: "2", type: "render-document", docId: "bridge/alpha" })).error.code, "FORBIDDEN");
  assert.equal(f.calls.length, 0);
});

test("query passes the documents the host skipped for invalid frontmatter through to the View", async () => {
  const f = fixture();
  const skipped = [{ id: "bridge/broken", reason: "bad indentation of a mapping entry" }];
  f.state.answer = (operation) => envelope(operation, { documents: [alpha], skipped });
  const reply = await f.request({ id: "1", type: "query", params: {} });
  assert.deepEqual(reply.result, { rows: [alpha], count: 1, skipped });
});

test("query maps to documents.query.v1 at the declared conformance level", async () => {
  const f = fixture();
  const reply = await f.request({ id: "1", type: "query", params: {} });
  assert.deepEqual(reply, {
    bridge: "v0",
    id: "1",
    type: "query:result",
    result: { rows: [alpha, beta], count: 2 },
  });
  assert.equal(f.calls[0].operation, "documents.query.v1");
  assert.deepEqual(f.calls[0].input, { bundleId: "bound", limit: 100 });
  await f.request({
    id: "2",
    type: "query",
    params: { type: "Note", prefix: "bridge/", field: "status = active", limit: 0 },
  });
  assert.equal(f.calls[1].operation, "documents.query.v1");
  assert.deepEqual(f.calls[1].input, {
    bundleId: "bound",
    type: "Note",
    prefix: "bridge/",
    fields: { status: "active" },
    limit: 100,
  });
  await f.request({ id: "3", type: "query", params: { limit: 7 } });
  assert.deepEqual(f.calls[2].input, { bundleId: "bound", limit: 7 });
  // The protocol's field grammar onto the operation's one value per key: blank entries are
  // dropped, a filter without `=` or with an empty key is ignored, `open: false` is absent.
  const honored: [string, unknown, Record<string, unknown>][] = [
    ["one value after blank entries", { field: "status= , ,done" }, { fields: { status: "done" }, limit: 100 }],
    ["a trailing comma is one value", { field: "status=todo," }, { fields: { status: "todo" }, limit: 100 }],
    ["field without = is ignored", { field: "status" }, { limit: 100 }],
    ["empty key is ignored", { field: "=x" }, { limit: 100 }],
    ["open false is absent", { open: false, limit: 1 }, { limit: 1 }],
    ["order newest is sent", { order: "newest", limit: 5 }, { order: "newest", limit: 5 }],
    ["order id is the operation's default", { order: "id" }, { limit: 100 }],
  ];
  for (const [label, params, input] of honored) {
    const id = `honored-${label}`;
    const answered = await f.request({ id, type: "query", params });
    assert.equal(answered?.type, "query:result", label);
    assert.equal(answered.result.count, 2, label);
    assert.equal(f.calls.at(-1)!.operation, "documents.query.v1", label);
    assert.deepEqual(f.calls.at(-1)!.input, { bundleId: "bound", ...input }, label);
  }
  // An empty value list matches nothing and never reaches the operation.
  const before = f.calls.length;
  for (const [label, params] of [
    ["empty value", { field: "status=" }],
    ["only separators", { field: "status=, ," }],
  ] as [string, unknown][]) {
    const nothing = await f.request({ id: `nothing-${label}`, type: "query", params });
    assert.deepEqual(nothing.result, { rows: [], count: 0 }, label);
  }
  assert.equal(f.calls.length, before, "an empty value list runs no operation");
  const usage: [string, unknown][] = [
    ["limit over 100", { limit: 101 }],
    ["negative limit", { limit: -1 }],
    ["fractional limit", { limit: 1.5 }],
    ["open as a string", { open: "yes" }],
    ["unknown key", { tags: ["a"] }],
    ["blank type", { type: "  " }],
    ["blank field", { field: " " }],
    ["non-canonical prefix", { prefix: "../x" }],
    ["params not an object", "Note"],
    ["unknown order", { order: "oldest" }],
    ["order not a string", { order: 1 }],
    ["cursor is not offered", { order: "newest", cursor: "abc" }],
    // What the operations cannot answer yet is refused, never answered with less (protocol: refuse,
    // never degrade): several field values (no query.field-or), open (no query.open), and the
    // logical progress_status (no query.kind-projection; as a raw key it matches nothing).
    ["several field values", { field: "status=todo,blocked" }],
    ["several values after blanks", { field: "status= todo , ,blocked" }],
    ["open true", { open: true, limit: 5 }],
    ["a logical Kind field", { field: "progress_status=active" }],
  ];
  for (const [label, params] of usage) {
    const id = `usage-${label}`;
    const refused = await f.request({ id, type: "query", params });
    assert.equal(refused?.type, "error", label);
    assert.equal(refused.error.code, "USAGE", label);
  }
  assert.equal(f.calls.length, before, "no USAGE case reached the transport");
  const messages = new Map(f.replies.filter((r) => r.type === "error").map((r) => [r.id, r.error.message]));
  assert.equal(
    messages.get("usage-several field values"),
    "this host does not offer query.field-or: send one field value",
  );
  assert.equal(messages.get("usage-open true"), "this host does not offer query.open");
  assert.equal(
    messages.get("usage-a logical Kind field"),
    "this host does not offer query.kind-projection: progress_status is a logical Kind field",
  );
});

test("a query that filled its cap says more: true; one that did not says nothing", async () => {
  const f = fixture();
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `bridge/n${i}`, version, frontmatter: { type: "Note" } }));
  for (const [label, params, returned, more] of [
    ["the default cap, filled", {}, 100, true],
    ["the default cap, not filled", {}, 99, false],
    ["limit 0 is the cap", { limit: 0 }, 100, true],
    ["a View's own limit, filled", { limit: 2 }, 2, true],
    ["a View's own limit, not filled", { limit: 3 }, 2, false],
  ] as const) {
    f.state.answer = (operation) => envelope(operation, { documents: rows(returned) });
    const reply = await f.request({ id: label, type: "query", params });
    assert.equal(reply.result.count, returned, label);
    assert.equal(reply.result.more, more ? true : undefined, label);
    assert.equal(Object.hasOwn(reply.result, "more"), more, label);
  }
});

test("relationships maps to documents.relationships.v1, its continuation as the opaque cursor", async () => {
  const f = fixture(["documents.read.v1", "documents.relationships.v1"]);
  const next = { readIdentity: version, documentId: "bridge/alpha", offset: 30 };
  f.state.answer = (operation, input) =>
    envelope(operation, {
      links: [
        { documentId: "bridge/beta", title: "Beta", label: "depends on", direction: "outgoing" },
        { documentId: "areas/finance", title: "areas/finance", label: "informs", direction: "incoming" },
      ],
      ...(input.cursor ? {} : { next }),
    });
  const first = await f.request({ id: "1", type: "relationships", docId: "bridge/alpha" });
  assert.equal(f.calls[0].operation, "documents.relationships.v1");
  assert.deepEqual(f.calls[0].input, { bundleId: "bound", documentId: "bridge/alpha" });
  assert.deepEqual(first.result, {
    documentId: "bridge/alpha",
    rows: [
      { direction: "outgoing", documentId: "bridge/beta", label: "depends on", title: "Beta" },
      { direction: "incoming", documentId: "areas/finance", label: "informs", title: "areas/finance" },
    ],
    cursor: next,
  });
  const second = await f.request({
    id: "2",
    type: "relationships",
    docId: "bridge/alpha",
    cursor: first.result.cursor,
  });
  assert.deepEqual(f.calls[1].input, { bundleId: "bound", documentId: "bridge/alpha", cursor: next });
  assert.equal(second.result.cursor, undefined, "the last page carries no cursor");
  f.state.answer = (operation) => ({
    ok: false,
    operationId: operation,
    error: { code: "document_not_found", message: "No such document", retryable: false },
  });
  assert.equal((await f.request({ id: "3", type: "relationships", docId: "bridge/none" })).error.code, "NOT_FOUND");
  const calls = f.calls.length;
  for (const [label, message] of [
    ["no docId", { type: "relationships" }],
    ["a non-canonical docId", { type: "relationships", docId: "../x" }],
    ["a cursor that is not an object", { type: "relationships", docId: "bridge/alpha", cursor: "abc" }],
    ["an extra key", { type: "relationships", docId: "bridge/alpha", limit: 3 }],
  ] as const)
    assert.equal((await f.request({ id: label, ...message })).error.code, "USAGE", label);
  assert.equal(f.calls.length, calls, "no malformed request reached the transport");
  // Where the caller does not offer the operation, FORBIDDEN, undeclared.
  const narrow = fixture();
  assert.ok(!(await narrow.request({ id: "h", type: "hello" })).result.host.capabilities.includes("relationships"));
  assert.equal(
    (await narrow.request({ id: "r", type: "relationships", docId: "bridge/alpha" })).error.code,
    "FORBIDDEN",
  );
  assert.equal(narrow.calls.length, 0);
});

test("read, read-versioned and render-document map to documents.read.v1", async () => {
  const f = fixture();
  const read = await f.request({ id: "1", type: "read", docId: "bridge/alpha" });
  assert.deepEqual(read.result, { id: "bridge/alpha", frontmatter: alpha.frontmatter, body: f.state.body });
  assert.equal(f.calls[0].operation, "documents.read.v1");
  assert.deepEqual(f.calls[0].input, { bundleId: "bound", documentId: "bridge/alpha" });
  await f.send({ bridge: "v1", id: "2", type: "read-versioned", docId: "bridge/alpha" });
  const versioned = f.replies.find((reply) => reply.id === "2");
  assert.deepEqual(versioned, {
    bridge: "v1",
    id: "2",
    type: "read-versioned:result",
    result: { doc: { id: "bridge/alpha", frontmatter: alpha.frontmatter, body: f.state.body }, version },
  });
  assert.equal(f.calls[1].operation, "documents.read.v1");
  assert.deepEqual(f.calls[1].input, { bundleId: "bound", documentId: "bridge/alpha" });
  const rendered = await f.request({ id: "3", type: "render-document", docId: "bridge/alpha" });
  assert.equal(rendered.type, "render-document:result");
  assert.equal(f.calls[2].operation, "documents.read.v1");
  assert.deepEqual(f.calls[2].input, { bundleId: "bound", documentId: "bridge/alpha" });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(rendered.result.document, { id: "bridge/alpha", version });
  assert.equal(rendered.result.bounded, false);
  assert.match(rendered.result.html, /data-aslite-rendered-document/);
  assert.match(rendered.result.html, /data-aslite-doc-id="bridge\/beta"/);
  assert.doesNotMatch(rendered.result.html, /<a |<script|href=/);
  f.state.body = "See the [public page](https://example.com/docs) here.";
  const external = await f.request({ id: "external", type: "render-document", docId: "bridge/alpha" });
  assert.match(external.result.html, /public page/);
  assert.doesNotMatch(external.result.html, /<a |href=/);
  f.calls.pop();
  assert.equal((await f.request({ id: "4", type: "read", docId: "../escape" })).error.code, "USAGE");
  assert.equal((await f.request({ id: "5", type: "read" })).error.code, "USAGE");
  assert.equal((await f.request({ id: "6", type: "read", docId: "" })).error.code, "USAGE");
  await f.send({ bridge: "v1", id: "x".repeat(65), type: "read-versioned", docId: "bridge/alpha" });
  assert.equal(f.replies.at(-1).error.code, "USAGE", "a v1 id over 64 bytes is refused as the OSS shells refuse it");
  assert.equal(f.replies.at(-1).id, undefined);
  await f.send({ bridge: "v1", id: "y".repeat(64), type: "read-versioned", docId: "bridge/alpha" });
  assert.equal(f.replies.at(-1).type, "read-versioned:result", "exactly 64 bytes is accepted");
  await f.send({ bridge: "v0", id: "z".repeat(128), type: "read", docId: "bridge/alpha" });
  assert.equal(f.replies.at(-1).type, "read:result", "a v0 id keeps the 128 byte bound");
  f.state.answer = (operation) => ({
    ok: false,
    operationId: operation,
    error: { code: "document_not_found", message: "No such document", retryable: false },
  });
  assert.equal((await f.request({ id: "7", type: "read", docId: "bridge/none" })).error.code, "NOT_FOUND");
  assert.equal((await f.request({ id: "8", type: "render-document", docId: "bridge/none" })).error.code, "NOT_FOUND");
  f.state.answer = undefined;
  f.state.body = "x".repeat(1024 * 1024 + 1);
  assert.equal((await f.request({ id: "9", type: "read", docId: "bridge/alpha" })).error.code, "TOO_LARGE");
});

test("edges maps to documents.edges.v1: the View's selectors as sent, the operation's rows and order", async () => {
  const f = fixture(["documents.edges.v1"]);
  const all = await f.request({ id: "1", type: "edges", params: {} });
  assert.deepEqual(all.result, {
    edges: [
      { from: "bridge/alpha", to: "bridge/beta", text: "depends on" },
      { from: "bridge/beta", to: "areas/finance", text: "informs" },
    ],
    count: 2,
  });
  assert.equal(f.calls[0].operation, "documents.edges.v1");
  assert.deepEqual(f.calls[0].input, { bundleId: "bound" });
  // The selectors reach the operation unchanged, with the host's bundle; the host filters nothing
  // and sorts nothing: the rows are the operation's, in its order (code points).
  const params = { from: ["bridge/alpha", "bridge/"], to: "areas/finance", text: "informs" };
  const unordered = [
    { from: "bridge/beta", to: "areas/finance", text: "informs" },
    { from: "bridge/alpha", to: "areas/finance", text: "informs" },
  ];
  f.state.answer = () => envelope("documents.edges.v1", { edges: unordered });
  const asked = await f.request({ id: "2", type: "edges", params });
  assert.deepEqual(f.calls[1].input, { ...params, bundleId: "bound" });
  assert.deepEqual(asked.result, { edges: unordered, count: 2 });
  // Only the envelope is the host's: params must be an object of from, to and text. Everything
  // else is the operation's to refuse, and its invalid_input answers USAGE.
  const calls = f.calls.length;
  for (const bad of ["bridge/alpha", [], null, { since: "yesterday" }, { from: "a", bundleId: "other" }]) {
    const reply = await f.request({ id: `bad-${JSON.stringify(bad)}`, type: "edges", params: bad });
    assert.equal(reply?.error?.code, "USAGE", JSON.stringify(bad));
  }
  assert.equal(f.calls.length, calls, "a malformed envelope reaches no operation");
  const refusals: [string, string][] = [
    ["invalid_input", "USAGE"],
    ["result_too_large", "TOO_LARGE"],
    ["links_unavailable", "RUNTIME"],
    ["backend_unavailable", "RUNTIME"],
    ["bundle_not_found", "REVOKED"],
  ];
  for (const [code, bridge] of refusals) {
    f.state.answer = (operation) => ({ ok: false, operationId: operation, error: { code, message: "m" } });
    const reply = await f.request({ id: `refused-${code}`, type: "edges", params: { from: "edges/../a" } });
    assert.equal(reply.error.code, bridge, code);
  }
});

test("graph reshapes bundles.graph.v1 to the OSS reply without a model", async () => {
  const f = fixture();
  const reply = await f.request({ id: "1", type: "graph" });
  assert.deepEqual(reply.result, {
    okfVersion: "0.2",
    documents: [alpha, beta],
    relationships: [
      { from: "bridge/alpha", to: "bridge/beta", text: "depends on" },
      { from: "bridge/beta", to: "areas/finance", text: "informs" },
    ],
    counts: { documents: 2, relationships: 2 },
  });
  assert.deepEqual(Object.keys(reply.result).sort(), ["counts", "documents", "okfVersion", "relationships"]);
  assert.equal(f.calls[0].operation, "bundles.graph.v1");
  assert.deepEqual(f.calls[0].input, { bundleId: "bound" });
  f.state.graph = {
    ...graph,
    documents: [
      { ...alpha, body: "# A" },
      { ...beta, body: "# B" },
    ],
  };
  const bodies = await f.request({ id: "2", type: "graph", includeBodies: true });
  assert.equal(f.calls[1].operation, "bundles.graph.v1");
  assert.deepEqual(f.calls[1].input, { bundleId: "bound", includeBodies: true });
  assert.equal(bodies.result.documents[0].body, "# A");
  // One body over 1 MiB refuses the whole request, as a plain read would refuse that body.
  f.state.graph = {
    ...graph,
    documents: [
      { ...alpha, body: "# A" },
      { ...beta, body: "x".repeat(1024 * 1024 + 1) },
    ],
  };
  const oversize = await f.request({ id: "2-big", type: "graph", includeBodies: true });
  assert.equal(oversize.type, "error");
  assert.equal(oversize.error.code, "TOO_LARGE");
  assert.equal((await f.request({ id: "2-heads", type: "graph" })).type, "graph:result", "heads stay answerable");
  f.state.graph = graph;
  assert.equal((await f.request({ id: "3", type: "graph", includeBodies: false })).type, "graph:result");
  assert.equal((await f.request({ id: "4", type: "graph", includeBodies: "yes" })).error.code, "USAGE");
  assert.equal((await f.request({ id: "5", type: "graph", model: true })).error.code, "USAGE");
  f.state.graph = { ...graph, okfVersion: undefined };
  assert.equal((await f.request({ id: "6", type: "graph" })).result.okfVersion, "0.1");
  f.state.graph = {
    ...graph,
    documents: Array.from({ length: 1001 }, (_, index) => ({ ...alpha, id: `bridge/doc-${index}` })),
  };
  assert.equal((await f.request({ id: "7", type: "graph" })).error.code, "TOO_LARGE");
  f.state.graph = {
    ...graph,
    relationships: Array.from({ length: 10001 }, (_, index) => ({ ...relationships[0], to: `bridge/t-${index}` })),
  };
  assert.equal((await f.request({ id: "8", type: "graph" })).error.code, "TOO_LARGE");
  // The operation lists links by source and target; the View sees them sorted by (from, to, text)
  // by code unit, the same order on every browser.
  f.state.graph = {
    ...graph,
    relationships: [
      { from: "bridge/beta", to: "areas/finance", text: "informs", href: "x.md" },
      { from: "bridge/alpha", to: "bridge/beta", text: "sees", href: "x.md" },
      { from: "bridge/alpha", to: "bridge/beta", text: "Depends on", href: "x.md" },
      { from: "bridge/Zed", to: "areas/finance", text: "informs", href: "x.md" },
    ],
  };
  assert.deepEqual((await f.request({ id: "order-graph", type: "graph" })).result.relationships, [
    { from: "bridge/Zed", to: "areas/finance", text: "informs" },
    { from: "bridge/alpha", to: "bridge/beta", text: "Depends on" },
    { from: "bridge/alpha", to: "bridge/beta", text: "sees" },
    { from: "bridge/beta", to: "areas/finance", text: "informs" },
  ]);
  const narrow = fixture(["bundles.graph.v1"]);
  assert.equal((await narrow.request({ id: "1", type: "graph", includeBodies: true })).error.code, "FORBIDDEN");
  assert.equal(narrow.calls.length, 0);
  assert.equal((await narrow.request({ id: "2", type: "graph" })).type, "graph:result");
});

test("a caller without the operation refuses the request with FORBIDDEN before any transport call", async () => {
  const f = fixture(["documents.read.v1", "documents.query.v1"]);
  for (const message of [
    { id: "1", type: "edges", params: {} },
    { id: "2", type: "graph" },
  ]) {
    const reply = await f.request(message);
    assert.equal(reply.type, "error");
    assert.equal(reply.error.code, "FORBIDDEN");
  }
  const reads = fixture(["bundles.graph.v1"]);
  assert.equal(
    (await reads.request({ id: "0", type: "edges", params: {} })).error.code,
    "FORBIDDEN",
    "graph is not edges",
  );
  assert.equal((await reads.request({ id: "1", type: "read", docId: "bridge/alpha" })).error.code, "FORBIDDEN");
  assert.equal((await reads.request({ id: "2", type: "query", params: {} })).error.code, "FORBIDDEN");
  assert.equal(
    (await reads.request({ id: "3", type: "render-document", docId: "bridge/alpha" })).error.code,
    "FORBIDDEN",
  );
  assert.equal(f.calls.length + reads.calls.length, 0);
});

test("subscribe is acknowledged and refresh pushes an empty change only to a subscribed View", async () => {
  const f = fixture();
  f.host.refresh();
  assert.equal(f.replies.length, 0);
  const reply = await f.request({ id: "1", type: "subscribe" });
  assert.deepEqual(reply, { bridge: "v0", id: "1", type: "subscribe:result", result: { ok: true } });
  f.host.refresh();
  assert.deepEqual(f.replies.at(-1), { bridge: "v0", type: "change", event: { changes: [], removed: [] } });
  f.state.admitted = false;
  const count = f.replies.length;
  f.host.refresh();
  assert.equal(f.replies.length, count, "a changed binding pushes nothing");
  assert.equal(f.state.invalidated, 1);
});

test("host record.open reaches the reader and every other capability is refused", async () => {
  const f = fixture();
  const opened = await f.request({
    id: "1",
    type: "host",
    capability: "record.open",
    input: { documentId: "bridge/alpha" },
  });
  assert.deepEqual(opened, {
    bridge: "v0",
    id: "1",
    type: "host:result",
    result: { capability: "record.open", output: { opened: true } },
  });
  assert.deepEqual(f.opened, ["bridge/alpha"]);
  const other = await f.request({
    id: "2",
    type: "host",
    capability: "record.edit",
    input: { documentId: "bridge/alpha" },
  });
  assert.equal(other.error.code, "FORBIDDEN");
  const bad = await f.request({ id: "3", type: "host", capability: "record.open", input: { documentId: "../x" } });
  assert.equal(bad.error.code, "USAGE");
  const extra = await f.request({
    id: "4",
    type: "host",
    capability: "record.open",
    input: { documentId: "a" },
    more: 1,
  });
  assert.equal(extra.error.code, "USAGE");
  // A malformed envelope is USAGE before an undeclared name is FORBIDDEN.
  const malformed: [string, Record<string, unknown>][] = [
    ["uppercase name", { capability: "Record.Open", input: { documentId: "bridge/alpha" } }],
    ["leading dot", { capability: ".open" }],
    ["trailing hyphen", { capability: "record-" }],
    ["empty name", { capability: "" }],
    ["name over 128 bytes", { capability: "a".repeat(129) }],
    ["name not a string", { capability: 7 }],
    ["array input", { capability: "record.open", input: ["bridge/alpha"] }],
    ["string input", { capability: "record.open", input: "bridge/alpha" }],
    ["null input", { capability: "record.open", input: null }],
    ["undeclared name with array input", { capability: "record.edit", input: [] }],
  ];
  for (const [label, message] of malformed) {
    const reply = await f.request({ id: `bad-${label}`, type: "host", ...message });
    assert.equal(reply?.error?.code, "USAGE", label);
  }
  assert.equal((await f.request({ id: "no-input", type: "host", capability: "record.edit" })).error.code, "FORBIDDEN");
  assert.equal(
    (await f.request({ id: "no-input-open", type: "host", capability: "record.open" })).error.code,
    "USAGE",
    "record.open without its documentId input",
  );
  assert.equal(f.opened.length, 1, "no malformed or undeclared request reached the reader");
  const codes: [AppUiResult, string][] = [
    [{ ok: false, code: "not_found" }, "NOT_FOUND"],
    [{ ok: false, code: "denied" }, "REVOKED"],
    [{ ok: false, code: "invalid_input" }, "USAGE"],
    [{ ok: false, code: "unsupported" }, "FORBIDDEN"],
    [{ ok: false, code: "busy" }, "RUNTIME"],
    [{ ok: false, code: "unavailable" }, "RUNTIME"],
    [{ ok: false, code: "cancelled" }, "RUNTIME"],
  ];
  for (const [result, code] of codes) {
    f.state.open = async () => result;
    const reply = await f.request({
      id: `ui-${code}-${(result as any).code}`,
      type: "host",
      capability: "record.open",
      input: { documentId: "bridge/alpha" },
    });
    assert.equal(reply.error.code, code);
  }
  f.state.open = async () => {
    throw new Error("boom");
  };
  assert.equal(
    (await f.request({ id: "thrown", type: "host", capability: "record.open", input: { documentId: "bridge/alpha" } }))
      .error.code,
    "RUNTIME",
  );
  f.state.open = async () => ({ ok: true });
  f.state.recordAvailable = false;
  assert.equal(
    (await f.request({ id: "gone", type: "host", capability: "record.open", input: { documentId: "bridge/alpha" } }))
      .error.code,
    "FORBIDDEN",
  );
  const readless = fixture(["documents.query.v1"]);
  assert.equal(
    (
      await readless.request({
        id: "1",
        type: "host",
        capability: "record.open",
        input: { documentId: "bridge/alpha" },
      })
    ).error.code,
    "FORBIDDEN",
  );
  assert.equal(readless.opened.length, 0);
});

test("open-page without a page resolver, action.propose and unknown types are refused, never dropped", async () => {
  const f = fixture();
  const page = await f.request({ id: "1", type: "open-page", pageId: "views-registry/other" });
  assert.equal(page.error.code, "FORBIDDEN");
  assert.equal(page.error.message, "this host does not serve open-page");
  await f.send({ bridge: "v0", type: "open-page", pageId: "views-registry/other" });
  const idless = f.replies.at(-1);
  assert.equal(idless.type, "error");
  assert.equal(idless.id, undefined);
  assert.ok(!(await f.request({ id: "h", type: "hello" })).result.host.capabilities.includes("open-page"));
  await f.send({
    bridge: "v1",
    type: "action.propose",
    requestId: "a1",
    action: {
      kind: "document.set-field",
      docId: "bridge/alpha",
      field: "superbee_progress_status",
      value: "done",
      expectedVersion: version,
    },
  });
  assert.deepEqual(f.replies.at(-1), {
    bridge: "v1",
    id: "a1",
    type: "error",
    error: { code: "FORBIDDEN", message: "this host serves no bridge actions" },
  });
  assert.equal(
    (await f.request({ id: "u", type: "update", docId: "bridge/alpha", body: "x" })).error.code,
    "FORBIDDEN",
  );
  assert.equal((await f.request({ id: "d", type: "delete", docId: "bridge/alpha" })).error.code, "FORBIDDEN");
  await f.send({ bridge: "v1", id: "v1-query", type: "query", params: {} });
  assert.equal(f.replies.at(-1).error.code, "FORBIDDEN");
  assert.equal(f.calls.length, 0);
});

test("operation failures map onto the bridge vocabulary", async () => {
  const table: [unknown, string][] = [
    [{ code: "insufficient_scope" }, "REVOKED"],
    [{ code: "bundle_not_found" }, "REVOKED"],
    [{ code: "invalid_input" }, "USAGE"],
    [{ code: "validation_failed" }, "USAGE"],
    [{ code: "result_too_large" }, "TOO_LARGE"],
    [{ code: "document_not_found" }, "NOT_FOUND"],
    [{ code: "backend_unavailable" }, "RUNTIME"],
    [{ code: "deadline_exceeded" }, "RUNTIME"],
    [{ code: "internal_error" }, "RUNTIME"],
  ];
  for (const [error, code] of table) {
    const f = fixture();
    f.state.answer = (operation) => ({
      ok: false,
      operationId: operation,
      error: { ...(error as object), message: "m", retryable: false },
    });
    const reply = await f.request({ id: "1", type: "query", params: {} });
    assert.equal(reply.error.code, code, JSON.stringify(error));
  }
  const thrown: [unknown, string][] = [
    [Object.assign(new Error("denied"), { code: "denied" }), "REVOKED"],
    [Object.assign(new Error("access_denied"), { code: "access_denied" }), "REVOKED"],
    [Object.assign(new Error("unavailable"), { code: "unavailable" }), "RUNTIME"],
    [new ReadAdapterError("invalid_input"), "USAGE"],
    [new ReadAdapterError("invalid_response"), "RUNTIME"],
    [new Error("invalid_response"), "TOO_LARGE"],
    [new Error("anything"), "RUNTIME"],
    ["string", "RUNTIME"],
  ];
  for (const [error, code] of thrown) {
    const f = fixture();
    f.state.answer = () => {
      throw error;
    };
    const reply = await f.request({ id: "1", type: "read", docId: "bridge/alpha" });
    assert.equal(reply.error.code, code, String(error));
  }
});

test("a changed binding before or after the operation invalidates without a reply", async () => {
  const before = fixture();
  before.state.admitted = false;
  await before.request({ id: "1", type: "query", params: {} });
  assert.equal(before.calls.length, 0);
  assert.equal(before.replies.length, 0);
  assert.equal(before.state.invalidated, 1);
  const after = fixture();
  after.state.answer = () => {
    after.state.admitted = false;
    return envelope("documents.query.v1", { documents: [] });
  };
  await after.request({ id: "1", type: "query", params: {} });
  assert.equal(after.calls.length, 1);
  assert.equal(after.replies.length, 0);
  assert.equal(after.state.invalidated, 1);
  const hello = fixture();
  hello.state.admitted = false;
  await hello.request({ id: "1", type: "hello" });
  assert.equal(hello.replies.length, 0);
  assert.equal(hello.state.invalidated, 1);
});

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
/** Blocks `execute` until the test releases it, one resolver per call in call order; a release
 * with an error rejects that call instead. */
function blocking(f: ReturnType<typeof fixture>) {
  const release: ((error?: Error) => void)[] = [];
  f.state.answer = (operation) =>
    new Promise((resolve, reject) =>
      release.push((error) => {
        if (error) reject(error);
        else if (operation === "documents.read.v1")
          resolve(envelope(operation, { document: { ...alpha, body: "# Alpha", version: undefined }, version }));
        else resolve(envelope(operation, { documents: [] }));
      }),
    );
  return release;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a repeated id answers USAGE while the first is pending and after it was answered", async () => {
  const f = fixture();
  await f.request({ id: "1", type: "query", params: {} });
  const replayed = await f.send({ bridge: "v0", id: "1", type: "query", params: {} }).then(() => f.replies.at(-1));
  assert.deepEqual(replayed, {
    bridge: "v0",
    id: "1",
    type: "error",
    error: { code: "USAGE", message: "duplicate request id" },
  });
  assert.equal(f.calls.length, 1, "the replay never reaches the transport");
  const release = blocking(f);
  const pending = f.send({ bridge: "v0", id: "p", type: "query", params: {} });
  await tick();
  await f.send({ bridge: "v0", id: "p", type: "query", params: {} });
  assert.equal(f.replies.at(-1).id, "p");
  assert.equal(f.replies.at(-1).error.code, "USAGE");
  assert.equal(f.calls.length, 2);
  release[0]!();
  await pending;
  assert.equal(f.replies.filter((reply) => reply.id === "p").length, 2, "the first still answers");
  assert.equal(f.replies.at(-1).type, "query:result");
});

test("concurrent requests wait FIFO behind four in flight and are all answered in order", async () => {
  const f = fixture();
  const release = blocking(f);
  const pending = ids("r", 6).map((id) => f.send({ bridge: "v0", id, type: "read", docId: "bridge/alpha" }));
  await tick();
  assert.equal(release.length, 4, "at most four execute at once");
  assert.equal(f.replies.length, 0);
  release[0]!();
  await tick();
  assert.equal(release.length, 5, "a freed slot starts the next waiting request");
  assert.deepEqual(
    f.replies.map((reply) => reply.id),
    ["r0"],
  );
  for (const fn of release.slice(1)) fn();
  await tick();
  release.slice(5).forEach((fn) => fn());
  await Promise.all(pending);
  assert.deepEqual(
    f.replies.map((reply) => [reply.id, reply.type]),
    ids("r", 6).map((id) => [id, "read:result"]),
  );
  assert.equal(f.calls.length, 6);
  assert.deepEqual(
    f.calls.map((call) => call.input.documentId),
    Array(6).fill("bridge/alpha"),
  );
});

test("the sixty-fifth waiting request answers RUNTIME; hello and refusals answer at once past a full queue", async () => {
  const f = fixture();
  const release = blocking(f);
  const pending = ids("q", 69).map((id) => f.send({ bridge: "v0", id, type: "query", params: {} }));
  await tick();
  assert.equal(release.length, 4);
  assert.deepEqual(f.replies, [
    {
      bridge: "v0",
      id: "q68",
      type: "error",
      error: { code: "RUNTIME", message: "too many pending requests" },
    },
  ]);
  const hello = await f.request({ id: "hi", type: "hello" });
  assert.equal(hello.type, "hello:result", "hello takes no slot");
  const refused = await f.request({ id: "no", type: "host", capability: "record.edit", input: {} });
  assert.equal(refused.error.code, "FORBIDDEN", "a refusal takes no slot");
  const usage = await f.request({ id: "bad", type: "query", params: { limit: "x" } });
  assert.equal(usage.error.code, "USAGE");
  const narrow = fixture(["documents.read.v1"]);
  assert.equal((await narrow.request({ id: "1", type: "edges", params: {} })).error.code, "FORBIDDEN");
  assert.equal(f.replies.length, 4, "nothing else answered while the slots are held");
  f.state.answer = undefined;
  for (const fn of release) fn();
  await Promise.all(pending);
  const answered = f.replies.filter((reply) => reply.type === "query:result").map((reply) => reply.id);
  assert.deepEqual(answered, ids("q", 68), "every accepted request is answered in arrival order");
  assert.equal(f.calls.length, 68);
});

test("a queued request rechecks the binding when it starts", async () => {
  const f = fixture();
  const release = blocking(f);
  const pending = ids("w", 5).map((id) => f.send({ bridge: "v0", id, type: "query", params: {} }));
  await tick();
  f.state.admitted = false;
  // A failed operation answers without the post-operation binding check, so the slot it frees is
  // the first place the changed binding is seen: by the waiting request as it starts.
  release[0]!(new Error("transport"));
  await tick();
  assert.equal(f.state.invalidated, 1, "the waiting request invalidated once when it started");
  assert.equal(f.calls.length, 4, "it never reached the transport");
  assert.deepEqual(
    f.replies.map((reply) => [reply.id, reply.error?.code]),
    [["w0", "RUNTIME"]],
  );
  for (const fn of release.slice(1)) fn();
  await Promise.all(pending);
  assert.equal(f.replies.length, 1, "nothing answers after the invalidation stopped the host");
});

test("a stopped host aborts what execute holds, answers nothing waiting and ignores what follows", async () => {
  const f = fixture();
  const release = blocking(f);
  const pending = ids("s", 6).map((id) => f.send({ bridge: "v0", id, type: "query", params: {} }));
  await tick();
  const signals = f.calls.map((call) => call.signal);
  assert.equal(signals.length, 4);
  f.host.stop();
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, true, true, true],
    "stop aborts in-flight work as the app host does",
  );
  for (const fn of release) fn();
  await Promise.all(pending);
  assert.equal(f.calls.length, 4, "the waiting requests never start");
  assert.equal(f.replies.length, 0);
  await f.request({ id: "after-stop", type: "hello" });
  assert.equal(f.replies.length, 0);
});

test("replies over 2 MiB are TOO_LARGE", async () => {
  const f = fixture();
  f.state.answer = () =>
    envelope("documents.read.v1", { document: { ...alpha, body: "y".repeat(3 * 1024 * 1024) }, version });
  assert.equal((await f.request({ id: "huge", type: "read", docId: "bridge/alpha" })).error.code, "TOO_LARGE");
});

test("frame.resize is offered only with a frame owner, bounded by it, and never touches the transport", async () => {
  const plain = fixture(["documents.read.v1"]);
  const withoutOwner = await plain.request({ id: "1", type: "hello" });
  assert.equal(withoutOwner.result.host.frame, undefined);
  assert.equal(withoutOwner.result.host.theme, undefined);
  assert.ok(!withoutOwner.result.host.capabilities.includes("frame.resize"));
  const refused = await plain.request({ id: "2", type: "host", capability: "frame.resize", input: { height: 900 } });
  assert.equal(refused.error.code, "FORBIDDEN");

  const applied: number[] = [];
  const theme = {
    scheme: "light" as const,
    ground: "#F3F7FA",
    surface: "#FFFFFF",
    text: "#0F1A24",
    muted: "#4A5D6E",
    accent: "#0073B0",
    border: "#DADEE2",
    focus: "#956300",
    fontSans: "'DM Sans',system-ui,sans-serif",
    fontDisplay: "'Space Grotesk',system-ui,sans-serif",
    fontMono: "'JetBrains Mono',monospace",
    radius: "2px",
    spacing: "8px",
  };
  const replies: any[] = [];
  // The host answers on the window it was bound to; the report must come from that window.
  const source = { postMessage: (data: any) => replies.push(data) } as unknown as ViewBridgeFrame;
  const bound = createBridgeHost({
    source,
    title: "Team brief",
    bundleId: "bound",
    operations: ["documents.read.v1", "documents.query.v1"],
    admitted: () => true,
    invalidate() {},
    execute: async () => {
      throw new Error("no operation runs for a height report");
    },
    recordAvailable: () => true,
    openRecord: async () => ({ ok: true }),
    frame: {
      resize(height) {
        applied.push(height);
        return Math.min(16000, Math.max(680, Math.round(height)));
      },
      maxHeight: 16000,
      theme,
    },
  });
  const ask = async (data: Record<string, unknown>) => {
    const count = replies.length;
    await bound.receive({ source, origin: "null", data: { bridge: "v0", ...data } });
    return replies[count];
  };
  const hello = await ask({ id: "1", type: "hello" });
  assert.deepEqual(hello.result.host.capabilities, ["frame.resize", "query.newest", "record.open", "render-document"]);
  assert.deepEqual(hello.result.host.frame, { title: "host", height: "content", maxHeight: 16000 });
  assert.deepEqual(hello.result.host.theme, theme);
  const grown = await ask({ id: "2", type: "host", capability: "frame.resize", input: { height: 1400.6 } });
  assert.deepEqual(grown, {
    bridge: "v0",
    id: "2",
    type: "host:result",
    result: { capability: "frame.resize", output: { height: 1401 } },
  });
  const floored = await ask({ id: "3", type: "host", capability: "frame.resize", input: { height: 10 } });
  assert.equal(floored.result.output.height, 680, "the owner's floor wins over a short report");
  assert.deepEqual(applied, [1400.6, 10]);
  for (const [name, input] of [
    ["negative", { height: -1 }],
    ["infinite", { height: Infinity }],
    ["string", { height: "900" }],
    ["extra key", { height: 900, width: 10 }],
    ["missing", {}],
  ] as const) {
    const bad = await ask({ id: `bad-${name}`, type: "host", capability: "frame.resize", input });
    assert.equal(bad.error.code, "USAGE", name);
  }
  const bare = await ask({ id: "no-input", type: "host", capability: "frame.resize" });
  assert.equal(bare.error.code, "USAGE");
  assert.deepEqual(applied, [1400.6, 10], "a refused report never reaches the owner");
});

test("open-page asks the page to open a sibling View by registry id and refuses every other target", async () => {
  // The page's own resolver: here the sibling Views it knows for this bundle. The host builds no
  // address; what the page does with a known id is the page's.
  const siblings = new Set(["views-registry/portfolio", "views-registry/timeline", "pages-registry/legacy"]);
  const replies: any[] = [];
  const opened: string[] = [];
  const resolved: string[] = [];
  const source = { postMessage: (data: any) => replies.push(data) } as unknown as ViewBridgeFrame;
  const state = { admitted: true, invalidated: 0, calls: 0 };
  const host = createBridgeHost({
    source,
    title: "Portfolio",
    bundleId: "bound",
    operations: ["documents.read.v1"],
    admitted: () => state.admitted,
    invalidate() {
      state.invalidated++;
      host.stop();
    },
    execute: async () => {
      state.calls++;
      throw new Error("no operation runs for a navigation");
    },
    openPage(pageId) {
      resolved.push(pageId);
      if (!siblings.has(pageId)) return false;
      opened.push(pageId);
      return true;
    },
  });
  const ask = async (data: Record<string, unknown>) => {
    const count = replies.length;
    await host.receive({ source, origin: "null", data: { bridge: "v0", ...data } });
    return replies.length > count ? replies[count] : undefined;
  };
  const hello = await ask({ id: "0", type: "hello" });
  assert.deepEqual(hello.result.host.capabilities, ["open-page", "render-document"]);

  // A known sibling: the page opens it, nothing is replied.
  assert.equal(await ask({ id: "1", type: "open-page", pageId: "views-registry/timeline" }), undefined);
  assert.deepEqual(opened, ["views-registry/timeline"]);
  assert.equal(await ask({ type: "open-page", pageId: "views-registry/timeline" }), undefined, "fire and forget");
  assert.equal(await ask({ id: "self", type: "open-page", pageId: "views-registry/portfolio" }), undefined);
  assert.equal(opened.at(-1), "views-registry/portfolio", "the current View may be a target");
  assert.equal(await ask({ id: "legacy", type: "open-page", pageId: "pages-registry/legacy" }), undefined);
  assert.equal(opened.at(-1), "pages-registry/legacy", "a legacy-location registry id is a registry id");
  const navigations = opened.length;

  const unknown = "this host does not open that View",
    invalid = "invalid open-page request";
  // The protocol's rule for a host that navigates: a well-formed target it cannot use is
  // NOT_FOUND; a malformed envelope is USAGE, as for every other request type.
  const refused: [string, Record<string, unknown>, string, "NOT_FOUND" | "USAGE"][] = [
    ["an unknown registry id", { pageId: "views-registry/other" }, unknown, "NOT_FOUND"],
    ["another bundle's View id", { pageId: "views-registry/room" }, unknown, "NOT_FOUND"],
    ["a document id", { pageId: "bridge/alpha" }, invalid, "USAGE"],
    ["a malformed id", { pageId: "views-registry/" }, invalid, "USAGE"],
    ["a non-string id", { pageId: 7 }, invalid, "USAGE"],
    ["a missing pageId", {}, invalid, "USAGE"],
    ["an extra key", { pageId: "views-registry/timeline", target: "_blank" }, invalid, "USAGE"],
    ["a path in place of an id", { pageId: "/apps/views/timeline" }, invalid, "USAGE"],
  ];
  for (const [name, data, message, code] of refused) {
    const reply = await ask({ id: `r-${name}`, type: "open-page", ...data });
    assert.deepEqual(reply, { bridge: "v0", id: `r-${name}`, type: "error", error: { code, message } }, name);
    const silent = await ask({ type: "open-page", ...data });
    assert.equal(silent?.type, "error", `${name}: without an id the refusal is still posted`);
    assert.equal(silent?.id, undefined, name);
    assert.equal(silent?.error.code, code, name);
  }
  assert.equal(opened.length, navigations, "no refused target opens");
  assert.ok(!resolved.includes("bridge/alpha"), "a non-registry id never reaches the resolver");
  assert.ok(!resolved.includes("/apps/views/timeline"));
  // A repeated id is USAGE, as for every other request; nothing opens.
  const duplicate = await ask({ id: "1", type: "open-page", pageId: "views-registry/timeline" });
  assert.equal(duplicate.error.code, "USAGE");
  assert.equal(opened.length, navigations);
  assert.equal(state.calls, 0, "no operation ever runs");

  // A binding that changed invalidates and never opens.
  state.admitted = false;
  assert.equal(await ask({ id: "late", type: "open-page", pageId: "views-registry/timeline" }), undefined);
  assert.equal(state.invalidated, 1);
  assert.equal(opened.length, navigations);

  // A page without a resolver declares and serves nothing.
  const half: any[] = [];
  const halfSource = { postMessage: (data: any) => half.push(data) } as unknown as ViewBridgeFrame;
  const bound = createBridgeHost({
    source: halfSource,
    title: "Portfolio",
    bundleId: "bound",
    operations: ["documents.read.v1"],
    execute: async () => undefined,
  });
  await bound.receive({ source: halfSource, origin: "null", data: { bridge: "v0", id: "0", type: "hello" } });
  assert.deepEqual(half[0].result.host.capabilities, ["render-document"]);
  await bound.receive({
    source: halfSource,
    origin: "null",
    data: { bridge: "v0", id: "1", type: "open-page", pageId: "views-registry/timeline" },
  });
  assert.equal(half[1].error.code, "FORBIDDEN");
});

test("the host is given one fixed bundle and the operations its caller runs; anything else is refused at creation", () => {
  const source = { postMessage() {} } as unknown as ViewBridgeFrame;
  const execute = async () => undefined;
  for (const operations of [
    ["documents.read.v1", "documents.read.v1"],
    ["documents.search.v1"],
    ["views.list.v1"],
  ] as unknown as AppOperation[][])
    assert.throws(() => createViewBridgeHost(source, { id: "bound", name: "x" }, execute, { operations }));
  for (const bundle of [{ id: "", name: "x" }, { name: "x" }, { id: "bound" }] as never[])
    assert.throws(() => createViewBridgeHost(source, bundle, execute, { operations: [] }));
});

test("the host's import path loads no schema library", async () => {
  const { build } = await import("esbuild");
  const bundled = await build({
    stdin: {
      contents: 'export { createViewBridgeHost } from "./dist/view-bridge-host.js";',
      resolveDir: new URL("..", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
  });
  const inputs = Object.keys(bundled.metafile.inputs);
  assert.deepEqual(
    inputs.filter((path) => /node_modules\/zod\//.test(path)),
    [],
    "a page that runs a View does not ship zod",
  );
});

test("a proposal answered after access was lost invalidates and posts nothing", async () => {
  const replies: any[] = [];
  const source = { postMessage: (data: any) => replies.push(data) } as unknown as ViewBridgeFrame;
  let admitted = true,
    invalidated = 0,
    finish: (value: unknown) => void = () => {};
  const host = createViewBridgeHost(source, { id: "bound", name: "x" }, async () => undefined, {
    operations: ["documents.read.v1", "documents.update.v1"],
    admitted: () => admitted,
    invalidate: () => invalidated++,
    proposeAction: () => new Promise((resolve) => (finish = resolve)),
  });
  const action = {
    kind: "document.set-field",
    docId: "bridge/alpha",
    field: "superbee_progress_status",
    value: "done",
    expectedVersion: version,
  };
  const pending = host.receive({
    source,
    origin: "null",
    data: { bridge: "v1", type: "action.propose", requestId: "a1", action },
  });
  admitted = false;
  finish({ status: "committed", version });
  await pending;
  assert.equal(replies.length, 0);
  assert.equal(invalidated, 1);
});
