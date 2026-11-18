// The repository's conformance View (`examples/views/conformance`) run against the
// operation-mapped host, judged row by row against the shared expected table for what the host
// declared in `hello`. The host has no data of its own, so `execute` here is a small reference
// adapter that answers the named read operations from a Core bundle, with the envelopes, ceilings
// and refusal codes the host maps: it stands in for whatever runs the operations for a real page.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  assertSafeConceptId,
  compareCodeUnits,
  MemoryBackend,
  parseMarkdown,
  queryEdges,
  queryHeads,
  readBundleOkfVersion,
  readDocVersioned,
  readRelationshipPage,
  writeBlob,
  writeDoc,
} from "@superbee/core";
import { sortByMeaningfulChange } from "@superbee/core/query-order";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import { createViewBridgeHost } from "../dist/view-bridge-host.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const FIXTURE_DIR = path.join(repoRoot, "examples/views/conformance");
const ENTRY = path.join(FIXTURE_DIR, "views/conformance.html");
const REGISTRY = path.join(FIXTURE_DIR, "views-registry/conformance.md");
const TABLE = JSON.parse(
  readFileSync(path.join(repoRoot, "packages/view-runtime/test/fixtures/view-conformance-expected.json"), "utf8"),
);
const html = readFileSync(ENTRY, "utf8");
const revision = /<meta name="superbee-conformance-revision" content="([^"]+)">/.exec(html)?.[1];
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

/** The bundle the expected table names, as the bridge service's conformance test writes it. */
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
  for (const { id, frontmatter, body, repeat = 1 } of TABLE.edgeDocuments) {
    await writeDoc(bundle, { id, frontmatter, body: body.repeat(repeat) });
  }
  const registry = parseMarkdown(readFileSync(REGISTRY, "utf8"));
  await writeDoc(bundle, { id: "views-registry/conformance", frontmatter: registry.frontmatter, body: registry.body });
  await writeBlob(bundle, "views/conformance.html", new Uint8Array(readFileSync(ENTRY)), "text/html; charset=utf-8");
  return bundle;
}

const ok = (data) => ({ ok: true, data });
const refuse = (code, message) => ({ ok: false, error: { code, message } });
const encoder = new TextEncoder();
const QUERY_ROWS = 100;
const EDGE_ROWS = 1000;
const RELATIONSHIP_ROWS = 30;

/** One edge selector as the operation accepts it: a canonical id, or one followed by `/`. */
function selector(value) {
  if (typeof value !== "string" || !value.trim() || encoder.encode(value).length > 1024) return null;
  try {
    assertSafeConceptId(value.endsWith("/") ? value.slice(0, -1) : value);
    return value;
  } catch {
    return null;
  }
}
function selectors(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return selector(value);
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const out = value.map(selector);
  return out.includes(null) ? null : out;
}

/** The read operations over one Core bundle, answered in the operation result envelope. */
function coreOperations(bundle, bundleId) {
  const calls = [];
  async function run(operation, input) {
    if (input.bundleId !== bundleId) return refuse("bundle_not_found", "no such bundle");
    switch (operation) {
      case "documents.query.v1": {
        const skipped = [];
        const filter = {
          ...(input.type ? { type: input.type } : {}),
          ...(input.prefix ? { prefix: input.prefix } : {}),
          ...(input.fields ? { fields: input.fields } : {}),
        };
        let rows = await queryHeads(bundle, filter, { onSkip: (skip) => skipped.push({ id: skip.id, reason: skip.reason }) });
        rows = input.order === "newest"
          ? sortByMeaningfulChange(rows, await readBundleOkfVersion(bundle))
          : [...rows].sort((a, b) => compareCodeUnits(a.id, b.id));
        const documents = rows.slice(0, Math.min(input.limit ?? QUERY_ROWS, QUERY_ROWS))
          .map(({ id, frontmatter, version }) => ({ id, frontmatter, version }));
        return ok({ documents, ...(skipped.length ? { skipped } : {}) });
      }
      case "documents.read.v1": {
        try {
          const { doc, version } = await readDocVersioned(bundle, input.documentId);
          return ok({ document: { id: doc.id, frontmatter: doc.frontmatter, body: doc.body }, version });
        } catch (error) {
          if (error?.code === "ENOENT") return refuse("document_not_found", `Document '${input.documentId}' is not available`);
          throw error;
        }
      }
      case "documents.relationships.v1": {
        const page = await readRelationshipPage(bundle, input.documentId, RELATIONSHIP_ROWS, input.cursor);
        if (page.status === "not_found") return refuse("document_not_found", "the document is not available");
        if (page.status !== "ready") return refuse("unavailable", "relationships are not ready");
        const last = page.rows.at(-1);
        return ok({
          links: page.rows.map(({ direction, documentId, label, title }) => ({ direction, documentId, label, title: title ?? documentId })),
          ...(page.more && last ? { next: { direction: last.direction, documentId: last.documentId, labelKey: last.labelKey } } : {}),
        });
      }
      case "documents.edges.v1": {
        const from = selectors(input.from);
        const to = selectors(input.to);
        if (from === null || to === null || (input.text !== undefined && (typeof input.text !== "string" || !input.text.trim())))
          return refuse("invalid_input", "invalid edge selector");
        const edges = await queryEdges(bundle, {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(input.text === undefined ? {} : { text: input.text }),
        });
        if (edges.length > EDGE_ROWS) return refuse("result_too_large", `the edge query exceeded ${EDGE_ROWS} rows`);
        return ok({ edges: edges.map(({ from, to, text }) => ({ from, to, text })) });
      }
      case "bundles.graph.v1": {
        const heads = await queryHeads(bundle, {});
        const documents = [];
        for (const { id, frontmatter, version } of heads) {
          const body = input.includeBodies ? (await readDocVersioned(bundle, id)).doc.body : undefined;
          documents.push({ id, version, frontmatter, ...(body === undefined ? {} : { body }) });
        }
        const relationships = (await queryEdges(bundle, {})).map(({ from, to, text }) => ({ from, to, text }));
        return ok({ okfVersion: (await readBundleOkfVersion(bundle)) ?? "0.1", documents, relationships });
      }
      default:
        return refuse("invalid_input", `no operation ${operation}`);
    }
  }
  return {
    calls,
    execute: (operation, input) => {
      calls.push({ operation, input });
      return run(operation, input);
    },
  };
}

/** The smallest DOM the View touches. */
function fakeDocument() {
  const elements = new Map();
  const element = (tag) => ({
    tag,
    attributes: {},
    children: [],
    textContent: "",
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); return child; },
  });
  for (const id of ["revision", "host", "rows", "status"]) elements.set(id, element(id === "rows" ? "tbody" : "span"));
  return { createElement: element, getElementById: (id) => elements.get(id) ?? null };
}

/** The View's script in its own realm, its `parent` the host: every `parent.postMessage` is one
 * `receive` from the frame, and every reply the host posts reaches the View's listeners. */
async function runConformance(operations) {
  const bundle = await fixtureBundle();
  const adapter = coreOperations(bundle, "conformance");
  const listeners = new Set();
  const parent = {
    postMessage(message) {
      void host.receive({ source: frame, origin: "null", data: JSON.parse(JSON.stringify(message)) });
    },
  };
  const frame = {
    postMessage(reply, targetOrigin) {
      assert.equal(targetOrigin, "*");
      const data = JSON.parse(JSON.stringify(reply));
      for (const listener of [...listeners]) listener({ source: parent, data });
    },
  };
  const host = createViewBridgeHost(frame, { id: "conformance", name: "Conformance" }, adapter.execute, {
    operations,
    renderDocument: renderDocumentToStaticHtml,
  });
  const window = {
    parent,
    document: fakeDocument(),
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
  vm.runInContext(script, window);
  const rows = JSON.parse(JSON.stringify(await window.__conformance.done));
  const hello = rows.find((row) => row.request === "hello");
  const capabilities = /capabilities=(\S*)/.exec(hello.summary)?.[1]?.split(",").filter(Boolean) ?? [];
  host.stop();
  return { rows, capabilities, calls: adapter.calls, revision: window.__conformance.revision };
}

/** Each row against the table, for the capabilities `hello` declared; no row may fail. */
function judge(rows, capabilities) {
  assert.deepEqual(rows.map((row) => row.request), TABLE.rows.map((row) => row.request), "the rows, in the table's order");
  for (const [index, row] of TABLE.rows.entries()) {
    const seen = rows[index];
    const expectation = "expect" in row ? row.expect : capabilities.includes(row.capability) ? row.declared : row.undeclared;
    assert.ok(expectation.status.includes(seen.status), `${row.request}: ${seen.status} (${seen.summary})`);
    if (expectation.code) assert.ok(seen.summary.startsWith(expectation.code), `${row.request}: ${seen.summary}`);
    assert.notEqual(seen.status, "failed", `${row.request}: ${seen.summary}`);
  }
}

test("the conformance View is the revision the expected table describes", () => {
  assert.equal(revision, TABLE.revision);
});

test("with the query, read, relationships and edges operations the View passes every row at the declared level", async () => {
  const { rows, capabilities, revision: ran } = await runConformance([
    "documents.read.v1",
    "documents.query.v1",
    "documents.relationships.v1",
    "documents.edges.v1",
  ]);
  assert.equal(ran, TABLE.revision);
  assert.deepEqual(capabilities, ["edges", "query.newest", "relationships", "render-document"]);
  judge(rows, capabilities);
  const row = (name) => rows.find((entry) => entry.request === name);
  assert.match(row("hello").summary, /^kind=hosted grant=read limits\.query=100 /);
  assert.match(row("graph").summary, /^FORBIDDEN/);
  // What the host itself decides, apart from the adapter: the query features it does not declare
  // are refused, a capped query says more, and the edges operation's refusals map to the protocol's.
  for (const [name, status, start] of [
    ["relationships", "answered", "documentId="],
    ["query-over-limit", "refused", "USAGE"],
    ["query-field-or", "refused", "USAGE"],
    ["query-open", "refused", "USAGE"],
    ["query-more", "answered", "rows=1 count=1 more=true"],
    ["read-missing", "refused", "NOT_FOUND"],
    ["read-versioned-missing", "refused", "NOT_FOUND"],
    ["edges-from", "answered", "from=[2] rows=9"],
    ["edges-from-text", "answered", "from=edges/a text=beta rows=2"],
    ["edges-to", "answered", "to=edges/b rows=6"],
    ["edges-prefix-union", "answered", "from=[2] rows=2"],
    ["edges-dangling", "answered", "to=edges/missing rows=1"],
    ["edges-from-list-limit", "answered", "from=[32] rows=8; from=[33] USAGE"],
    ["edges-invalid-selector", "refused", "USAGE"],
    ["edges-too-large", "refused", "TOO_LARGE"],
  ]) {
    assert.equal(row(name).status, status, `${name}: ${row(name).summary}`);
    assert.ok(row(name).summary.startsWith(start), `${name}: ${row(name).summary}`);
  }
});

test("with the query, read and graph operations (no relationships, no edges) the View passes every row at the declared level", async () => {
  const { rows, capabilities, calls } = await runConformance(["documents.read.v1", "documents.query.v1", "bundles.graph.v1"]);
  assert.deepEqual(capabilities, ["graph", "query.newest", "render-document"]);
  judge(rows, capabilities);
  assert.match(rows.find((entry) => entry.request === "edges").summary, /^FORBIDDEN/);
  assert.equal(rows.find((entry) => entry.request === "edges-from").status, "skipped");
  assert.match(rows.find((entry) => entry.request === "graph").summary, /^okfVersion=0\.1 documents=14 relationships=1017 /);
  // The host never asks for an operation it was not given.
  const offered = new Set(["documents.read.v1", "documents.query.v1", "bundles.graph.v1"]);
  assert.ok(calls.every(({ operation }) => offered.has(operation)));
  assert.ok(calls.every(({ input }) => input.bundleId === "conformance"));
});
