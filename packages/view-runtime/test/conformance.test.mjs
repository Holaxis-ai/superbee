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
import { MemoryBackend, parseMarkdown, writeBlob, writeDoc } from "@superbee/core";
import { admitActiveView } from "@superbee/core/view-admission";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const FIXTURE_DIR = path.join(repoRoot, "examples/views/conformance");
const PROTOCOL_DOC = path.join(repoRoot, "docs/VIEW-PROTOCOL.md");
const REFERENCE_DOC = path.join(repoRoot, "examples/views/references/view-authoring-v0.md");
const ENTRY = path.join(FIXTURE_DIR, "views/conformance.html");
const REGISTRY = path.join(FIXTURE_DIR, "views-registry/conformance.md");

const REQUEST_ORDER = [
  "hello",
  "query",
  "read",
  "read-versioned",
  "edges",
  "render-document",
  "subscribe",
  "host",
  "action.propose",
  "open-page",
];

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
  assert.match(html, /<meta name="superbee-conformance-revision" content="1">/);
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

async function fixtureBundle() {
  const bundle = { root: "mem://conformance", backend: new MemoryBackend() };
  await writeDoc(bundle, {
    id: "docs/alpha",
    frontmatter: { type: "Doc", title: "Alpha", timestamp: "2026-09-15T00:00:00.000Z" },
    body: "# Alpha\n\nLinks to [Beta](/docs/beta.md).",
  });
  await writeDoc(bundle, {
    id: "docs/beta",
    frontmatter: { type: "Doc", title: "Beta", timestamp: "2026-09-15T00:00:00.000Z" },
    body: "# Beta\n",
  });
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
        BRIDGE_HOST_CAPABILITIES.subscribeDeltas,
      ],
      limits: BRIDGE_SERVICE_LIMITS,
    },
    enablePolling: true,
  });

  const { rows, document, sent, revision } = await runFixture(service, "launch");
  assert.equal(revision, "1");
  assert.deepEqual(rows.map((row) => row.request), REQUEST_ORDER, "one row per request type, in protocol order");
  assert.deepEqual(sent.map((message) => message.type), REQUEST_ORDER, "one request per row, in the same order");

  const byRequest = Object.fromEntries(rows.map((row) => [row.request, row]));
  assert.equal(byRequest.hello.status, "answered");
  assert.match(byRequest.hello.summary, /^kind=oss grant=read limits\.query=500 capabilities=edges,open-page,query\.count,query\.field-or,query\.kind-projection,query\.open,render-document,subscribe-deltas$/);
  assert.equal(byRequest.query.status, "answered");
  assert.equal(byRequest.query.summary, "rows=3 count=3");
  const firstDoc = sent.find((message) => message.type === "read").docId;
  assert.equal(byRequest.read.status, "answered");
  assert.match(byRequest.read.summary, new RegExp(`^id=${firstDoc.replace(/[/.]/g, "\\$&")} body=\\d+ chars$`));
  assert.equal(byRequest["read-versioned"].status, "answered");
  assert.match(byRequest["read-versioned"].summary, new RegExp(`^id=${firstDoc.replace(/[/.]/g, "\\$&")} version=sha256:[0-9a-f]{64}$`));
  assert.equal(byRequest.edges.status, "answered");
  assert.match(byRequest.edges.summary, /^from=\S+ count=\d+$/);
  assert.equal(byRequest["render-document"].status, "answered");
  assert.match(byRequest["render-document"].summary, /^version=sha256:[0-9a-f]{64} html=\d+ chars bounded=false$/);
  assert.equal(byRequest.subscribe.status, "answered");
  assert.equal(byRequest.subscribe.summary, "acknowledged; deltas=declared");
  assert.equal(byRequest.host.status, "refused");
  assert.match(byRequest.host.summary, /^FORBIDDEN: .* for undeclared capability \(expected\)$/);
  assert.equal(byRequest["action.propose"].status, "refused");
  assert.match(byRequest["action.propose"].summary, /^FORBIDDEN: /);
  assert.equal(byRequest["open-page"].status, "refused");
  assert.equal(byRequest["open-page"].summary, "NOT_FOUND for views-registry/conformance-missing-target");

  const rendered = document.getElementById("rows").children;
  assert.equal(rendered.length, REQUEST_ORDER.length);
  rendered.forEach((tr, index) => {
    assert.equal(tr.attributes["data-request"], rows[index].request);
    assert.equal(tr.attributes["data-status"], rows[index].status);
    assert.deepEqual([...tr.children.map((td) => td.textContent)], [rows[index].request, rows[index].status, rows[index].summary]);
  });
  assert.equal(document.getElementById("host").textContent, "host: oss (test)");
  assert.match(document.getElementById("status").textContent, /^complete: 10 rows, 0 change events/);
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
  for (const request of ["hello", "query", "edges", "subscribe", "host"]) {
    const row = rows.find((candidate) => candidate.request === request);
    assert.equal(row.status, "refused", request);
    assert.match(row.summary, /^FORBIDDEN: /, request);
  }
  for (const request of ["read", "read-versioned", "render-document"]) {
    assert.equal(rows.find((candidate) => candidate.request === request).status, "skipped", request);
  }
  assert.equal(rows.find((row) => row.request === "action.propose").status, "refused");
  assert.equal(rows.find((row) => row.request === "open-page").status, "refused");
});
