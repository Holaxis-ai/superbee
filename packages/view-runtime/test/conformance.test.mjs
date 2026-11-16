import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  BRIDGE_HOST_CAPABILITIES,
  BRIDGE_SERVICE_CAPABILITIES,
  BRIDGE_SERVICE_LIMITS,
  BridgeService,
} from "../dist/index.js";
import {
  compareCodePoints,
  compareCodeUnits,
  extractMarkdownLinks,
  MemoryBackend,
  parseMarkdown,
  queryEdges,
  queryHeads,
  readDoc,
  resolveConceptId,
  writeBlob,
  writeDoc,
} from "@superbee/core";
import { admitActiveView } from "@superbee/core/view-admission";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const FIXTURE_DIR = path.join(repoRoot, "examples/views/conformance");
const PROTOCOL_DOC = path.join(repoRoot, "docs/VIEW-PROTOCOL.md");
const REFERENCE_DOC = path.join(repoRoot, "examples/views/references/view-authoring-v0.md");
const ENTRY = path.join(FIXTURE_DIR, "views/conformance.html");
const REGISTRY = path.join(FIXTURE_DIR, "views-registry/conformance.md");
const EXPECTED = JSON.parse(readFileSync(path.join(here, "fixtures/view-conformance-expected.json"), "utf8"));
const REVISION = "7";

const REQUEST_ORDER = [
  "hello",
  "query",
  "query-newest",
  "read",
  "read-versioned",
  "edges",
  "graph",
  "render-document",
  "subscribe",
  "host",
  "action.propose",
  "burst",
  "relationships",
  "query-over-limit",
  "query-field-or",
  "query-open",
  "query-more",
  "read-missing",
  "read-versioned-missing",
  "edges-from",
  "edges-from-text",
  "edges-to",
  "edges-prefix-union",
  "edges-dangling",
  "edges-from-list-limit",
  "edges-invalid-selector",
  "edges-too-large",
  "open-page",
];
const EDGE_ROWS = REQUEST_ORDER.filter((request) => request.startsWith("edges-"));
/** The request type each row sends on the wire, where it differs from the row name. */
const WIRE_TYPE = {
  "query-newest": "query",
  "query-over-limit": "query",
  "query-field-or": ["query", "query"],
  "query-open": ["query", "query"],
  "query-more": "query",
  "read-missing": "read",
  "read-versioned-missing": "read-versioned",
  ...Object.fromEntries(EDGE_ROWS.map((request) => [request, "edges"])),
  "edges-from-list-limit": ["edges", "edges"],
};
const BURST_READS = 12;
/** The wire order: the burst row is BURST_READS `read` requests fired at once. */
const SENT_ORDER = REQUEST_ORDER.flatMap((request) => {
  if (request === "burst") return Array(BURST_READS).fill("read");
  return [WIRE_TYPE[request] ?? request].flat();
});

/**
 * Hold a run to the shared expected table, the one another host mirrors: every row in order, each
 * status acceptable for what this host declared, and never `failed`.
 */
function assertExpected(rows, capabilities) {
  assert.equal(EXPECTED.revision, REVISION);
  assert.deepEqual(rows.map((row) => row.request), EXPECTED.rows.map((row) => row.request), "the expected table names every row in order");
  EXPECTED.rows.forEach((expected, index) => {
    const row = rows[index];
    const rule = expected.capability === undefined
      ? expected.expect
      : capabilities.includes(expected.capability) ? expected.declared : expected.undeclared;
    assert.notEqual(row.status, "failed", `${row.request}: ${row.summary}`);
    assert.ok(rule.status.includes(row.status), `${row.request}: ${row.status} is not one of ${rule.status.join(", ")} (${row.summary})`);
    if (rule.code) assert.ok(row.summary.startsWith(`${rule.code}: `), `${row.request}: ${row.summary} does not name ${rule.code}`);
  });
}

function clientFromMarkdown(file) {
  const text = readFileSync(file, "utf8");
  const match = text.match(/```js\r?\n(\(function \(\) \{[\s\S]*?\r?\n\}\)\(\);)\r?\n```/);
  assert.ok(match, `no reference client fence in ${file}`);
  return match[1];
}

function clientFromHtml(file) {
  const text = readFileSync(file, "utf8");
  const match = text.match(/<script>\s*(\(function \(\) \{[\s\S]*?\n\}\)\(\);)/);
  assert.ok(match, `no inlined reference client in ${file}`);
  return match[1];
}

function scriptFromHtml(file) {
  const text = readFileSync(file, "utf8");
  const match = text.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, `no inline script in ${file}`);
  return match[1];
}

test("the protocol document, the bundle reference and the conformance View embed one identical client", () => {
  const canonical = clientFromMarkdown(PROTOCOL_DOC);
  assert.equal(clientFromMarkdown(REFERENCE_DOC), canonical, "bundle reference drifted from docs/VIEW-PROTOCOL.md");
  assert.equal(clientFromHtml(ENTRY), canonical, "conformance View drifted from docs/VIEW-PROTOCOL.md");
  assert.match(canonical, /readVersioned/);
  assert.match(canonical, /send\("host"/);
  assert.match(canonical, /send\("graph"/);
});

test("the conformance registry document and entry are a valid View under the admission rules", () => {
  const registry = parseMarkdown(readFileSync(REGISTRY, "utf8"));
  assert.equal(registry.frontmatter.type, "View");
  assert.equal(registry.frontmatter.entry, "views/conformance.html");
  assert.equal(registry.frontmatter.access, "bundle-read");
  const bytes = readFileSync(ENTRY);
  const admitted = admitActiveView(bytes, "text/html; charset=utf-8");
  assert.equal(admitted.bytes.byteLength, bytes.byteLength);
  const html = bytes.toString("utf8");
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\//, "the entry inlines everything");
  assert.match(html, new RegExp(`<meta name="superbee-conformance-revision" content="${REVISION}">`));
  assert.match(html, new RegExp(`var REVISION = "${REVISION}";`));
});

/** The smallest DOM the fixture touches: elements with attributes, text and children. */
function fakeDocument() {
  const elements = new Map();
  function element(tag) {
    return {
      tag,
      attributes: {},
      children: [],
      textContent: "",
      setAttribute(name, value) { this.attributes[name] = String(value); },
      appendChild(child) { this.children.push(child); return child; },
    };
  }
  for (const id of ["revision", "host", "rows", "status"]) elements.set(id, element(id === "rows" ? "tbody" : "span"));
  return {
    elements,
    createElement: element,
    getElementById: (id) => elements.get(id) ?? null,
  };
}

/**
 * The bundle the expected table names: two types (Convention and Doc), a Kind with a terminal set
 * and one closed document, so `open: true` has a row to drop and a dropped `field` shows, and the
 * table's edgeDocuments, written as another host writes them.
 */
async function fixtureBundle() {
  const bundle = { root: "mem://conformance", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "conventions/doc",
    frontmatter: {
      type: "Convention",
      governs: "Doc",
      timestamp: "2026-09-13T00:00:00.000Z",
      fields: { required: ["title"], optional: ["status"], values: { status: ["open", "closed"] }, terminal: { status: ["closed"] } },
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "docs/gamma",
    frontmatter: { type: "Doc", title: "Gamma", status: "closed", timestamp: "2026-09-14T00:00:00.000Z" },
    body: "# Gamma\n",
  });
  await writeDoc(bundle, {
    id: "docs/alpha",
    frontmatter: { type: "Doc", title: "Alpha", timestamp: "2026-09-15T00:00:00.000Z" },
    body: "# Alpha\n\nLinks to [Beta](/docs/beta.md).",
  });
  await writeDoc(bundle, {
    id: "docs/beta",
    frontmatter: { type: "Doc", title: "Beta", timestamp: "2026-09-16T00:00:00.000Z" },
    body: "# Beta\n",
  });
  for (const { id, frontmatter, body, repeat = 1 } of EXPECTED.edgeDocuments) {
    await writeDoc(bundle, { id, frontmatter, body: body.repeat(repeat) });
  }
  const registry = parseMarkdown(readFileSync(REGISTRY, "utf8"));
  await writeDoc(bundle, { id: "views-registry/conformance", frontmatter: registry.frontmatter, body: registry.body });
  await writeBlob(bundle, "views/conformance.html", new Uint8Array(readFileSync(ENTRY)), "text/html; charset=utf-8");
  return bundle;
}

/**
 * Run the fixture entry's script against the service the way a host frame would: every
 * parent.postMessage becomes one BridgeService.handle call, every reply is delivered back through
 * the View's message listener with the parent as its source.
 */
async function runFixture(service, launchId) {
  const document = fakeDocument();
  const listeners = new Set();
  const sent = [];
  const parent = {
    postMessage(message) {
      sent.push(message);
      void service.handle(launchId, JSON.parse(JSON.stringify(message))).then((outcome) => {
        if (!outcome.reply) return;
        for (const listener of [...listeners]) listener({ source: parent, data: outcome.reply });
      });
    },
  };
  // The context is its own `window`, as in a browser, so `window.Bridge` is the global `Bridge`.
  const window = {
    parent,
    document,
    setTimeout,
    clearTimeout,
    Promise,
    TypeError,
    Error,
    String,
    JSON,
    console: { error() {} },
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(scriptFromHtml(ENTRY), window);
  const rows = await window.__conformance.done;
  // Values cross the vm realm boundary; strict deep equality wants host-realm prototypes.
  const normalize = (value) => JSON.parse(JSON.stringify(value));
  return { rows: normalize(rows), document, sent: normalize(sent), revision: window.__conformance.revision };
}

test("the conformance View exercises every request type against the OSS service and reports one row per type", async () => {
  const bundle = await fixtureBundle();
  const service = new BridgeService({
    bundle,
    launches: {
      async resolve(launchId) {
        return launchId === "launch" ? { launchId, capability: "bundle-read" } : null;
      },
      revoke() {},
    },
    config: async () => ({ root: null, name: "Conformance fixture", mode: "test" }),
    renderDocument: ({ id, body }) => ({ html: `<article data-id="${id}">${body}</article>`, bounded: false }),
    host: {
      kind: "oss",
      capabilities: [
        ...BRIDGE_SERVICE_CAPABILITIES,
        BRIDGE_HOST_CAPABILITIES.openPage,
        BRIDGE_HOST_CAPABILITIES.relationships,
        BRIDGE_HOST_CAPABILITIES.subscribeDeltas,
      ],
      limits: BRIDGE_SERVICE_LIMITS,
    },
    enablePolling: true,
  });

  const { rows, document, sent, revision } = await runFixture(service, "launch");
  assert.equal(revision, REVISION);
  assert.deepEqual(rows.map((row) => row.request), REQUEST_ORDER, "one row per request type, in protocol order");
  assert.deepEqual(sent.map((message) => message.type), SENT_ORDER, "one request per row, in the same order, and a burst of reads");

  const byRequest = Object.fromEntries(rows.map((row) => [row.request, row]));
  assert.equal(byRequest.hello.status, "answered");
  assert.match(byRequest.hello.summary, /^kind=oss grant=read limits\.query=500 capabilities=edges,graph,open-page,query\.count,query\.field-or,query\.kind-projection,query\.newest,query\.open,relationships,render-document,subscribe-deltas$/);
  assert.equal(byRequest.query.status, "answered");
  assert.equal(byRequest.query.summary, "rows=5 count=14");
  assert.equal(byRequest["query-newest"].status, "answered");
  assert.equal(byRequest["query-newest"].summary, "rows=5 count=14 first=docs/beta", "the newer document leads");
  assert.deepEqual(sent.filter((message) => message.type === "query").map((message) => message.params), [
    { limit: 5 },
    { order: "newest", limit: 5 },
    { limit: BRIDGE_SERVICE_LIMITS.query + 1 },
    { field: "type=conformance-missing-type,Convention", limit: 0 },
    { type: "Convention", limit: 0 },
    { open: true, limit: 0 },
    { limit: 0 },
    { limit: 1 },
  ]);
  const firstDoc = sent.find((message) => message.type === "read").docId;
  assert.equal(byRequest.read.status, "answered");
  assert.match(byRequest.read.summary, new RegExp(`^id=${firstDoc.replace(/[/.]/g, "\\$&")} body=\\d+ chars$`));
  assert.equal(byRequest["read-versioned"].status, "answered");
  assert.match(byRequest["read-versioned"].summary, new RegExp(`^id=${firstDoc.replace(/[/.]/g, "\\$&")} version=sha256:[0-9a-f]{64}$`));
  assert.equal(byRequest.edges.status, "answered");
  assert.match(byRequest.edges.summary, /^from=\S+ count=\d+$/);
  assert.equal(byRequest.graph.status, "answered");
  assert.equal(byRequest.graph.summary, "okfVersion=0.1 documents=14 relationships=1017 model=absent bodies=0");
  assert.equal(sent.find((message) => message.type === "graph").includeBodies, undefined, "the fixture asks for heads only");
  assert.equal(byRequest["render-document"].status, "answered");
  assert.match(byRequest["render-document"].summary, /^version=sha256:[0-9a-f]{64} html=\d+ chars bounded=false$/);
  assert.equal(byRequest.subscribe.status, "answered");
  assert.equal(byRequest.subscribe.summary, "acknowledged; deltas=declared");
  assert.equal(byRequest.host.status, "refused");
  assert.match(byRequest.host.summary, /^FORBIDDEN: .* for undeclared capability \(expected\)$/);
  assert.equal(byRequest["action.propose"].status, "refused");
  assert.match(byRequest["action.propose"].summary, /^FORBIDDEN: /);
  assert.equal(byRequest.burst.status, "answered");
  assert.equal(byRequest.burst.summary, `${BURST_READS} results, ${BURST_READS} of ${firstDoc}`, "the OSS host caps nothing and answers every read");
  const burstReads = sent.filter((message) => message.type === "read").slice(1, 1 + BURST_READS);
  assert.equal(burstReads.length, BURST_READS);
  assert.equal(new Set(burstReads.map((message) => message.id)).size, BURST_READS, "every burst read carries its own id");
  assert.ok(burstReads.every((message) => message.docId === firstDoc));
  assert.equal(byRequest.relationships.status, "answered");
  assert.equal(byRequest.relationships.summary, `documentId=${firstDoc} rows=0 cursor=absent`);
  assert.equal(byRequest["query-over-limit"].status, "refused");
  assert.match(byRequest["query-over-limit"].summary, /^USAGE: .* for limit=501 above limits\.query=500 \(expected\)$/);
  assert.equal(byRequest["query-field-or"].status, "answered");
  assert.equal(byRequest["query-field-or"].summary,
    "field=type=conformance-missing-type,Convention matched=1 type=Convention matched=1 other-type rows=0", "the second value is honored");
  assert.equal(byRequest["query-open"].status, "answered");
  assert.equal(byRequest["query-open"].summary, "open matched=13 of 14", "the closed document is dropped");
  assert.equal(byRequest["query-more"].status, "answered");
  assert.equal(byRequest["query-more"].summary, "rows=1 count=14 more=true");
  assert.equal(byRequest["read-missing"].status, "refused");
  assert.match(byRequest["read-missing"].summary, /^NOT_FOUND: .* for docs\/conformance-missing-document \(expected\)$/);
  assert.equal(byRequest["read-versioned-missing"].status, "refused");
  assert.match(byRequest["read-versioned-missing"].summary, /^NOT_FOUND: .* for docs\/conformance-missing-document \(expected\)$/);
  assert.deepEqual(Object.fromEntries(EDGE_ROWS.map((request) => [request, byRequest[request].summary])), {
    "edges-from": "from=[2] rows=9",
    "edges-from-text": "from=edges/a text=beta rows=2",
    "edges-to": "to=edges/b rows=6",
    "edges-prefix-union": "from=[2] rows=2",
    "edges-dangling": "to=edges/missing rows=1",
    "edges-from-list-limit": "from=[32] rows=8; from=[33] USAGE: invalid or unsupported bridge request",
    "edges-invalid-selector": "USAGE: invalid or unsupported bridge request for from=edges/../a (expected)",
    "edges-too-large": "TOO_LARGE: the edge query exceeded 1000 rows for 1005 rows above limits.edges=1000 (expected)",
  });
  assert.equal(byRequest["open-page"].status, "refused");
  assert.equal(byRequest["open-page"].summary, "NOT_FOUND for views-registry/conformance-missing-target");
  assertExpected(rows, byRequest.hello.summary.split("capabilities=")[1].split(","));

  const rendered = document.getElementById("rows").children;
  assert.equal(rendered.length, REQUEST_ORDER.length);
  rendered.forEach((tr, index) => {
    assert.equal(tr.attributes["data-request"], rows[index].request);
    assert.equal(tr.attributes["data-status"], rows[index].status);
    assert.deepEqual([...tr.children.map((td) => td.textContent)], [rows[index].request, rows[index].status, rows[index].summary]);
  });
  assert.equal(document.getElementById("host").textContent, "host: oss (test)");
  assert.match(document.getElementById("status").textContent, /^complete: 28 rows, 0 change events/);
  assert.equal(
    sent.find((message) => message.type === "action.propose").action.expectedVersion,
    byRequest["read-versioned"].summary.split("version=")[1],
    "the proposal pins the version read-versioned returned",
  );
});

test("the conformance View reports refresh-only subscriptions and refused reads on a host that declares less", async () => {
  const bundle = await fixtureBundle();
  const service = new BridgeService({
    bundle,
    launches: {
      async resolve(launchId) {
        return launchId === "launch" ? { launchId, capability: "none" } : null;
      },
      revoke() {},
    },
    config: async () => ({ root: null, name: "Conformance fixture", mode: "test" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    host: { kind: "oss", capabilities: BRIDGE_SERVICE_CAPABILITIES, limits: BRIDGE_SERVICE_LIMITS },
  });
  const { rows } = await runFixture(service, "launch");
  assert.deepEqual(rows.map((row) => row.request), REQUEST_ORDER);
  for (const request of ["hello", "query", "edges", "graph", "subscribe", "host"]) {
    const row = rows.find((candidate) => candidate.request === request);
    assert.equal(row.status, "refused", request);
    assert.match(row.summary, /^FORBIDDEN: /, request);
  }
  for (const request of [
    "query-newest", "read", "read-versioned", "render-document", "burst", "relationships", "query-over-limit",
    "query-field-or", "query-open", "query-more", "read-missing", "read-versioned-missing", ...EDGE_ROWS,
  ]) {
    assert.equal(rows.find((candidate) => candidate.request === request).status, "skipped", request);
  }
  assert.equal(rows.find((row) => row.request === "action.propose").status, "refused");
  assert.equal(rows.find((row) => row.request === "open-page").status, "refused");
});

test("the conformance View skips query-newest on a host that does not declare query.newest", async () => {
  const bundle = await fixtureBundle();
  const service = new BridgeService({
    bundle,
    launches: {
      async resolve(launchId) {
        return launchId === "launch" ? { launchId, capability: "bundle-read" } : null;
      },
      revoke() {},
    },
    config: async () => ({ root: null, name: "Conformance fixture", mode: "test" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    host: {
      kind: "oss",
      capabilities: BRIDGE_SERVICE_CAPABILITIES.filter((name) => name !== BRIDGE_HOST_CAPABILITIES.queryNewest),
      limits: BRIDGE_SERVICE_LIMITS,
    },
  });
  const { rows, sent } = await runFixture(service, "launch");
  assert.deepEqual(rows.map((row) => row.request), REQUEST_ORDER);
  const row = rows.find((candidate) => candidate.request === "query-newest");
  assert.deepEqual(row, { request: "query-newest", status: "skipped", summary: "query.newest not declared" });
  assert.ok(sent.filter((message) => message.type === "query").every((message) => message.params.order === undefined), "no ordered query is sent");
  assertExpected(rows, BRIDGE_SERVICE_CAPABILITIES.filter((name) => name !== BRIDGE_HOST_CAPABILITIES.queryNewest));
});

function readOnlyService(bundle, capabilities) {
  return new BridgeService({
    bundle,
    launches: {
      async resolve(launchId) {
        return launchId === "launch" ? { launchId, capability: "bundle-read" } : null;
      },
      revoke() {},
    },
    config: async () => ({ root: null, name: "Conformance fixture", mode: "test" }),
    renderDocument: ({ body }) => ({ html: body, bounded: false }),
    host: { kind: "oss", capabilities, limits: BRIDGE_SERVICE_LIMITS },
  });
}

test("a host that does not declare a query feature or relationships refuses it, and the View expects the refusal", async () => {
  const undeclared = [BRIDGE_HOST_CAPABILITIES.queryFieldOr, BRIDGE_HOST_CAPABILITIES.queryOpen];
  const capabilities = BRIDGE_SERVICE_CAPABILITIES.filter((name) => !undeclared.includes(name));
  const { rows } = await runFixture(readOnlyService(await fixtureBundle(), capabilities), "launch");
  const byRequest = Object.fromEntries(rows.map((row) => [row.request, row]));
  assert.equal(byRequest["query-field-or"].status, "refused");
  assert.match(byRequest["query-field-or"].summary, /^USAGE: .* for a multi-value field \(query\.field-or not declared\) \(expected\)$/);
  assert.equal(byRequest["query-open"].status, "refused");
  assert.match(byRequest["query-open"].summary, /^USAGE: .* for open: true \(query\.open not declared\) \(expected\)$/);
  assert.equal(byRequest.relationships.status, "refused");
  assert.match(byRequest.relationships.summary, /^FORBIDDEN: .* \(not declared, expected\)$/);
  assertExpected(rows, capabilities);
});

/** A host that declares every query feature but quietly mishandles one: the drift the rows catch. */
function driftingHost(service, drift) {
  return {
    handle(launchId, message) {
      const request = drift.request ? drift.request(message) : message;
      return service.handle(launchId, request).then((outcome) => (drift.reply ? { ...outcome, reply: drift.reply(message, outcome.reply) } : outcome));
    },
  };
}

test("a host that declares a query feature and ignores it fails that row", async () => {
  const query = (message, change) => (message.type === "query" ? { ...message, params: change({ ...message.params }) } : message);
  for (const [request, drift, summary] of [
    ["query-open", { request: (m) => query(m, ({ open, ...rest }) => rest) }, /^open matched=14 of 14; expected the terminal document to be dropped$/],
    ["query-field-or", { request: (m) => query(m, ({ field, ...rest }) => rest) }, /other-type rows=13; expected exactly the rows of type Convention$/],
    ["query-field-or", { request: (m) => query(m, (p) => (p.field ? { ...p, field: p.field.split(",")[0] } : p)) }, /matched=0 type=Convention matched=1 .*; expected exactly/],
    ["query-more", { reply: (m, reply) => {
      if (m.type !== "query" || reply?.type !== "query:result") return reply;
      const { more, ...result } = reply.result;
      return { ...reply, result };
    } }, /^rows=1 count=14 more=false; expected one row and more: true from a capped reply$/],
  ]) {
    const service = readOnlyService(await fixtureBundle(), BRIDGE_SERVICE_CAPABILITIES);
    const { rows } = await runFixture(driftingHost(service, drift), "launch");
    const row = rows.find((candidate) => candidate.request === request);
    assert.equal(row.status, "failed", `${request}: ${row.summary}`);
    assert.match(row.summary, summary);
  }
});

test("the rows hold on a host without query.count, where rows are the only total", async () => {
  const capabilities = BRIDGE_SERVICE_CAPABILITIES.filter((name) => name !== BRIDGE_HOST_CAPABILITIES.queryCount);
  const { rows } = await runFixture(readOnlyService(await fixtureBundle(), capabilities), "launch");
  assert.equal(rows.find((row) => row.request === "query-open").summary, "open matched=13 of 14");
  assertExpected(rows, capabilities);
});

test("a host that does not declare edges skips the edges rows, and the table expects it", async () => {
  const capabilities = BRIDGE_SERVICE_CAPABILITIES.filter((name) => name !== BRIDGE_HOST_CAPABILITIES.edges);
  // Every OSS host offers edges, so this host refuses it the way a host without the request does.
  const withoutEdges = driftingHost(readOnlyService(await fixtureBundle(), capabilities), {
    reply: (message, reply) => (message.type === "edges"
      ? { bridge: "v0", id: message.id, type: "error", error: { code: "FORBIDDEN", message: "not offered here" } }
      : reply),
  });
  const { rows, sent } = await runFixture(withoutEdges, "launch");
  for (const request of EDGE_ROWS) {
    assert.deepEqual(rows.find((row) => row.request === request), { request, status: "skipped", summary: "edges not declared" });
  }
  assert.equal(sent.filter((message) => message.type === "edges").length, 1, "only the plain edges row is sent");
  assertExpected(rows, capabilities);
});

const EDGE_ROW_LIMIT = BRIDGE_SERVICE_LIMITS.edges;

/**
 * A host that answers `edges` itself, the way a store-backed host does: it parses every document
 * once, then filters, orders and caps. With no `change` it must give Core's answer and pass every
 * row; each `change` breaks one rule of the dialect, so the rows that fail show what each row pins.
 */
async function edgesHost(bundle, change = {}) {
  const service = readOnlyService(bundle, BRIDGE_SERVICE_CAPABILITIES);
  const ids = (await queryHeads(bundle)).map((head) => head.id);
  const existing = new Set(ids);
  const all = [];
  for (const id of ids) {
    const doc = await readDoc(bundle, id);
    for (const link of extractMarkdownLinks(doc.body, { skipCode: change.skipCode === true })) {
      const to = resolveConceptId(id, link.href);
      if (to !== null) all.push({ from: id, to, text: link.text });
    }
  }
  const compare = change.codeUnits ? compareCodeUnits : compareCodePoints;
  all.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.text, b.text));
  const matches = (value, selectors) => selectors === undefined || [selectors].flat().some((selector) => {
    if (change.prefixAsExact) return value === selector;
    if (change.exactAsPrefix) return value.startsWith(selector);
    return selector.endsWith("/") ? value.startsWith(selector) : value === selector;
  });
  return {
    all,
    async handle(launchId, message) {
      const answer = await service.handle(launchId, message);
      if (message.type !== "edges") return answer;
      const code = answer.reply?.type === "error" ? answer.reply.error.code : null;
      if (code === "USAGE" && change.malformed === "RUNTIME") {
        return { reply: { ...answer.reply, error: { code: "RUNTIME", message: "the View request failed" } } };
      }
      if (code === "USAGE" && !change.malformed) return answer;
      const { from, to, text } = message.params ?? {};
      let rows = all.filter((row) => (change.ignore === "from" || matches(row.from, from)) &&
        (change.ignore === "to" || matches(row.to, to)) &&
        (change.ignore === "text" || text === undefined || row.text === text));
      if (change.dropDangling) rows = rows.filter((row) => existing.has(row.to));
      if (change.dropSelf) rows = rows.filter((row) => row.from !== row.to);
      if (change.dedupe) rows = rows.filter((row, index) => index === 0 || JSON.stringify(row) !== JSON.stringify(rows[index - 1]));
      if (rows.length > EDGE_ROW_LIMIT) {
        if (!change.truncate) {
          return { reply: { bridge: "v0", id: message.id, type: "error", error: { code: "TOO_LARGE", message: "too many edges" } } };
        }
        rows = rows.slice(0, EDGE_ROW_LIMIT);
      }
      const edges = rows.map((row) => (change.href ? { ...row, href: `${row.to}.md` } : row));
      return { reply: { bridge: "v0", id: message.id, type: "edges:result", result: { edges, count: edges.length } } };
    },
  };
}

test("a host that answers edges itself passes every row only when it keeps every rule of the dialect", async () => {
  const bundle = await fixtureBundle();
  const faithful = await edgesHost(bundle);
  const core = (await queryEdges(bundle, {})).map(({ from, to, text }) => ({ from, to, text }));
  assert.deepEqual(faithful.all, core, "the reimplementation without a change is Core's queryEdges");
  assertExpected((await runFixture(faithful, "launch")).rows, BRIDGE_SERVICE_CAPABILITIES);

  const failing = async (change) => {
    const { rows } = await runFixture(await edgesHost(bundle, change), "launch");
    for (const row of rows.filter((candidate) => !candidate.request.startsWith("edges-"))) {
      assert.notEqual(row.status, "failed", `${JSON.stringify(change)} broke ${row.request}: ${row.summary}`);
    }
    return rows.filter((row) => row.status === "failed").map((row) => row.request);
  };
  for (const [change, rows] of [
    // Filters: a host that ignores a facet answers more rows, or TOO_LARGE once the bulk links count.
    [{ ignore: "from" }, ["edges-from", "edges-from-text", "edges-prefix-union", "edges-from-list-limit"]],
    [{ ignore: "to" }, ["edges-to", "edges-dangling"]],
    [{ ignore: "text" }, ["edges-from-text"]],
    // Selectors: an id is exact (edges/a never matches edges/ab, edges/b never edges/bulk/1); only a
    // trailing slash is a prefix.
    [{ exactAsPrefix: true }, ["edges-from", "edges-from-text", "edges-to", "edges-prefix-union", "edges-from-list-limit"]],
    [{ prefixAsExact: true }, ["edges-prefix-union"]],
    // Rows: every occurrence, self-links, links to missing documents and links in code are rows (the
    // bulk links are repeated occurrences of one link to a missing document).
    [{ dedupe: true }, ["edges-from", "edges-from-text", "edges-to", "edges-from-list-limit", "edges-too-large"]],
    [{ dropSelf: true }, ["edges-from", "edges-from-list-limit"]],
    [{ dropDangling: true }, ["edges-from", "edges-dangling", "edges-from-list-limit", "edges-too-large"]],
    [{ skipCode: true }, ["edges-from", "edges-to", "edges-from-list-limit"]],
    [{ href: true }, ["edges-from", "edges-from-text", "edges-to", "edges-prefix-union", "edges-dangling", "edges-from-list-limit"]],
    // Order: code units put the astral id before U+E000.
    [{ codeUnits: true }, ["edges-from", "edges-from-list-limit"]],
    // Cap and refusals: above limits.edges is TOO_LARGE, never cut; a malformed selector is USAGE.
    [{ truncate: true }, ["edges-too-large"]],
    [{ malformed: "RUNTIME" }, ["edges-from-list-limit", "edges-invalid-selector"]],
    [{ malformed: "answer" }, ["edges-from-list-limit", "edges-invalid-selector"]],
  ]) {
    assert.deepEqual(await failing(change), rows, JSON.stringify(change));
  }
});
