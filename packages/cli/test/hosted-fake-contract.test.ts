// The CLI's fake hosted sync family (`support/fake-hosted-sync.ts`) against the `/sync/v1` golden
// exchanges captured from the real hosted gateway (core's `test/fixtures/hosted-sync-v1/`). For
// every exchange the fake is driven into the same situation and must answer with the same status,
// the same grammar headers and the same body: the same keys at every level and the same value
// types, and the same VALUES wherever a value selects a row or an outcome (every boolean, and the
// discriminator strings in DISCRIMINATORS: operation, error code, write state, outcome status and
// the like). Only values that name the fixture's own data (ids, versions, messages, timestamps)
// may differ. A fake that drifts from what the host emits fails here, not on staging.
//
// The export exchanges are held to more than a shape: the fake is loaded with the bundle the
// captured archive holds, at the captured instant, and must answer the same status, the same
// header values and the same bytes, the zip included. The CLI's archive reader is held to the
// captured archive's values in `hosted-export.test.ts`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { verifyExport } from "../src/hosted/export-archive.js";
import { BUNDLE, FakeHost, SYNC_FIXTURES } from "./support/fake-hosted-sync.js";

interface Exchange {
  name: string;
  route: string;
  request: { headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string; bodyBase64?: string };
}

/** Exchanges compared by value in the export test below, not by shape. */
const isExport = (exchange: Exchange) => exchange.route === "/sync/v1/export";

const index = JSON.parse(readFileSync(path.join(SYNC_FIXTURES, "index.json"), "utf8")) as { exchanges: { name: string; file: string }[] };
const golden = new Map<string, Exchange>(index.exchanges.map((entry) => [entry.name, JSON.parse(readFileSync(path.join(SYNC_FIXTURES, entry.file), "utf8")) as Exchange]));

/** Exchanges the fake does not model, each with the reason; every other exchange must be driven below. */
const NOT_MODELED: Readonly<Record<string, string>> = Object.freeze({
  "create-429-request-capacity": "the fake has no sync quota; tests inject the capacity refusal through a write hook",
});

const VERSION = /^sha256:[a-f0-9]{64}$/;

/** String keys whose value selects a row or an outcome, and so must equal the host's. */
const DISCRIMINATORS: ReadonlySet<string> = new Set(["operationId", "code", "writeState", "status", "kind", "surface", "scope", "encoding", "consistency", "error"]);

/**
 * A value's shape: keys and types all the way down, with the value itself wherever it is a
 * boolean, a discriminator string or `schemaVersion`; frontmatter is authored content, so only its kind.
 */
function shape(value: unknown, key?: string): unknown {
  if (value === null) return "null";
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && key !== undefined && DISCRIMINATORS.has(key)) return `=${value}`;
  if (key === "schemaVersion") return value;
  if (Array.isArray(value)) return ["array", ...[...new Set(value.map((item) => JSON.stringify(shape(item))))].sort()];
  if (typeof value === "object") {
    if (key === "frontmatter") return "frontmatter";
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, shape((value as Record<string, unknown>)[name], name)]));
  }
  if (typeof value === "string") return VERSION.test(value) ? "version" : "string";
  return typeof value;
}

/** A body's shape: one JSON value, NDJSON lines grouped by the set of line shapes, or empty. */
function bodyShape(text: string): unknown {
  if (text === "") return "empty";
  const lines = text.split("\n").filter((line) => line !== "");
  if (lines.length > 1) return ["ndjson", ...[...new Set(lines.map((line) => JSON.stringify(shape(JSON.parse(line)))))].sort()];
  return shape(JSON.parse(text));
}

const GRAMMAR = ["content-type", "etag", "x-superbee-root-version", "x-superbee-write-settled"];

/** Header names, and the root version header's value where it selects a row: `none` (no root) or a version. */
function headerShape(get: (name: string) => string | null): string[] {
  return GRAMMAR.filter((name) => get(name) !== null)
    .sort()
    .map((name) => (name === "x-superbee-root-version" ? `${name}=${get(name) === "none" ? "none" : shape(get(name))}` : name));
}

async function answerOf(response: Response) {
  return { status: response.status, headers: headerShape((name) => response.headers.get(name)), body: bodyShape(await response.text()) };
}

function expectedOf(exchange: Exchange) {
  return { status: exchange.response.status, headers: headerShape((name) => exchange.response.headers[name] ?? null), body: bodyShape(exchange.response.body) };
}

const identity = (n: number) => `4a2f9c1e-8b3d-4e6f-9a1b-${String(n).padStart(12, "0")}`;
const BINDING = `sha256:${"c".repeat(64)}`;

test("the fake answers every golden /sync/v1 exchange in the host's shape", async () => {
  const host = new FakeHost();
  const sendTo = (to: FakeHost, route: string, body: unknown, options: { requestId?: string | null; bearer?: string; recreate?: string; via?: string } = {}) =>
    to.fetch(`${to.origin}/sync/v1/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${options.bearer ?? to.token}`,
        ...(options.requestId === undefined || options.requestId === null ? {} : { "X-Superbee-Write-Request": options.requestId, "X-Superbee-Checkout": BINDING }),
        ...(options.requestId === null ? { "X-Superbee-Checkout": BINDING } : {}),
        ...(options.recreate === undefined ? {} : { "X-Superbee-Recreate": options.recreate }),
        ...(options.via === undefined ? {} : { "X-Superbee-Via": options.via }),
      },
      body: JSON.stringify(body),
    });
  const send = (route: string, body: unknown, options: { requestId?: string | null; bearer?: string; recreate?: string; via?: string } = {}) => sendTo(host, route, body, options);
  const [firstId, first] = [...host.docs][0]!;
  const create = (documentId: string, body = "two") => ({ bundleId: BUNDLE, documentId, expectAbsent: true, frontmatter: { type: "Note" }, body });
  const replace = (expectedVersion: string, body: string) => ({ bundleId: BUNDLE, documentId: firstId, expectedVersion, frontmatter: { type: "Note" }, body });
  const remove = (expectedVersion: string, documentId = "notes/two") => ({ bundleId: BUNDLE, documentId, expectedVersion });

  const observed = new Map<string, Awaited<ReturnType<typeof answerOf>>>();
  const observe = async (name: string, response: Promise<Response>) => {
    const answer = await answerOf(await response);
    observed.set(name, answer);
    return answer;
  };
  const json = async (response: Promise<Response>) => (await (await response).clone().json()) as { data: { version: string; digest?: string }; digest: string };

  await observe("whoami-200", send("whoami", {}));
  await observe("bundles-200", send("bundles", {}));
  await observe("capabilities-200", send("capabilities", { bundleId: BUNDLE }));
  const { digest } = await json(send("heads", { bundleId: BUNDLE }));
  await observe("heads-200", send("heads", { bundleId: BUNDLE }));
  await observe("heads-304", send("heads", { bundleId: BUNDLE, ifNoneMatch: digest }));
  await observe("snapshot-200", send("snapshot", { bundleId: BUNDLE }));
  await observe("read-200-ok", send("read", { bundleId: BUNDLE, documentId: firstId }));
  await observe("read-200-document-not-found", send("read", { bundleId: BUNDLE, documentId: "notes/absent" }));
  await observe("read-200-bundle-not-found", send("read", { bundleId: "nope.a", documentId: firstId }));
  await observe("read-400-invalid-input", send("read", { bundleId: BUNDLE, documentId: firstId, extra: true }));
  await observe("read-401-unauthenticated", send("read", { bundleId: BUNDLE, documentId: firstId }, { bearer: "not-a-token" }));
  await observe("read-403-access-denied", sendTo(new FakeHost({ syncSurface: false }), "read", { bundleId: BUNDLE, documentId: firstId }));
  host.unavailable = true;
  await observe("heads-503-backend-unavailable", send("heads", { bundleId: BUNDLE }));
  host.unavailable = false;

  const created = await json(send("create", create("notes/two"), { requestId: identity(1) }));
  observed.set("create-200-ok", await answerOf(await send("create", create("notes/two"), { requestId: identity(1) })));
  await observe("outcome-200-committed-create", send("outcome", create("notes/two"), { requestId: identity(1) }));
  await observe("create-200-document-exists", send("create", create(firstId, "dup"), { requestId: identity(2) }));
  const replaced = await json(send("replace", replace(first.version, "one edited"), { requestId: identity(3) }));
  observed.set("replace-200-ok", await answerOf(await send("replace", replace(first.version, "one edited"), { requestId: identity(3) })));
  await observe("outcome-200-committed-replace", send("outcome", replace(first.version, "one edited"), { requestId: identity(3) }));
  await observe("replace-200-version-conflict", send("replace", replace(first.version, "stale"), { requestId: identity(4) }));
  await observe("outcome-200-refused-replace", send("outcome", replace(first.version, "stale"), { requestId: identity(4) }));
  await observe("delete-200-version-conflict", send("delete", remove(first.version, firstId), { requestId: identity(16) }));
  await observe("delete-200-ok", send("delete", remove(created.data.version), { requestId: identity(5) }));
  await observe("outcome-200-committed-delete", send("outcome", remove(created.data.version), { requestId: identity(5) }));
  await observe("delete-200-unchanged", send("delete", remove(created.data.version), { requestId: identity(6) }));
  await observe("create-200-version-conflict-tombstone", send("create", create("notes/two", "again"), { requestId: identity(7) }));
  const firstTombstone = host.latestTombstone("notes/two")!.tombstone;
  const recreated = await json(send("create", create("notes/two", "again"), { requestId: identity(17), recreate: firstTombstone }));
  observed.set("create-200-recreate", await answerOf(await send("create", create("notes/two", "again"), { requestId: identity(17), recreate: firstTombstone })));
  await send("delete", remove(recreated.data.version), { requestId: identity(18) });
  await observe("create-200-version-conflict-stale-recreate", send("create", create("notes/two", "stale acknowledgement"), { requestId: identity(19), recreate: firstTombstone }));
  await observe("create-200-insufficient-scope", sendTo(new FakeHost({ writable: false }), "create", create("notes/reader"), { requestId: identity(20) }));
  await observe("outcome-200-absent", send("outcome", create("notes/never"), { requestId: identity(8) }));
  await observe("write-400-invalid-input", send("replace", { ...replace(replaced.data.version, "x"), extra: true }, { requestId: identity(9) }));
  await observe("write-400-missing-identity", send("create", create("notes/x"), { requestId: null }));
  const viaCreated = await json(send("create", create("notes/via", "via"), { requestId: identity(22), via: "claude-code" }));
  observed.set("create-200-ok-via", await answerOf(await send("create", create("notes/via", "via"), { requestId: identity(22), via: "claude-code" })));
  // History: the labeled create, then a replace, newest first; a page back with its content.
  await send("replace", { bundleId: BUNDLE, documentId: "notes/via", expectedVersion: viaCreated.data.version, frontmatter: { type: "Note" }, body: "via edited" }, { requestId: identity(24) });
  await observe("history-200-ok", send("history", { bundleId: BUNDLE, documentId: "notes/via" }));
  await observe("history-200-content", send("history", { bundleId: BUNDLE, documentId: "notes/via", limit: 1, before: 2, includeContent: true }));
  await observe("history-200-document-not-found", send("history", { bundleId: BUNDLE, documentId: "notes/absent" }));
  await observe("history-400-invalid-input", send("history", { bundleId: BUNDLE, documentId: "notes/via", extra: true }));
  await observe("write-400-invalid-via", send("create", create("notes/x"), { requestId: identity(23), via: "Claude Code" }));
  host.hook = (call) => (call.requestId === identity(21) ? { kind: "unknown" } : undefined);
  await observe("create-200-write-outcome-unknown", send("create", create("notes/unknown"), { requestId: identity(21) }));
  host.hook = undefined;
  await observe("outcome-200-pending", send("outcome", create("notes/unknown"), { requestId: identity(21) }));

  // Pages: the three-document bundle served two to a page, then a write between pages.
  const paged = new FakeHost({ pageSize: 2 });
  const firstPage = await json(sendTo(paged, "heads", { bundleId: BUNDLE })) as unknown as { next: string };
  await observe("heads-200-page-first", sendTo(paged, "heads", { bundleId: BUNDLE }));
  await observe("heads-200-page-last", sendTo(paged, "heads", { bundleId: BUNDLE, cursor: firstPage.next }));
  await observe("snapshot-200-page-first", sendTo(paged, "snapshot", { bundleId: BUNDLE }));
  await observe("snapshot-200-page-last", sendTo(paged, "snapshot", { bundleId: BUNDLE, cursor: firstPage.next }));
  paged.put("notes/four", { type: "Note" }, "four");
  await observe("heads-409-concurrent-change", sendTo(paged, "heads", { bundleId: BUNDLE, cursor: firstPage.next }));
  await observe("heads-200-no-root", sendTo(new FakeHost({ root: false }), "heads", { bundleId: BUNDLE }));

  for (const [name, exchange] of golden) {
    if (isExport(exchange)) continue;
    if (NOT_MODELED[name]) {
      assert.ok(!observed.has(name), `${name} is marked not modeled but was driven`);
      continue;
    }
    const answer = observed.get(name);
    assert.ok(answer, `golden exchange ${name} is not driven against the fake; drive it or mark it NOT_MODELED with a reason`);
    assert.deepEqual(answer, expectedOf(exchange), `the fake's ${exchange.route} answer for ${name} differs from the host's`);
  }
  for (const name of observed.keys()) assert.ok(golden.has(name), `${name} has no golden exchange`);
});

test("the contract catches the read answer the fake used to give, and a wrong error code or outcome", async () => {
  const host = new FakeHost();
  const [id, doc] = [...host.docs][0]!;
  const drifted = { ok: true, operationId: "documents.read.v1", data: { bundleId: BUNDLE, documentId: id, version: doc.version, document: { frontmatter: doc.frontmatter, body: doc.body } } };
  assert.notDeepEqual(shape(drifted), bodyShape(golden.get("read-200-ok")!.response.body));
  // Same keys and types, another row: a create over a present document answered as a version conflict.
  const exists = golden.get("create-200-document-exists")!.response.body;
  assert.notDeepEqual(bodyShape(exists.replace('"document_exists"', '"version_conflict"')), bodyShape(exists));
  const refused = golden.get("outcome-200-refused-replace")!.response.body;
  assert.notDeepEqual(bodyShape(refused.replace('"status":"refused"', '"status":"committed"')), bodyShape(refused));
  const changed = golden.get("delete-200-unchanged")!.response.body;
  assert.notDeepEqual(bodyShape(changed.replace('"changed":false', '"changed":true')), bodyShape(changed));
  // A history row's keys are grammar: a row named with other keys (`revision`, `at`) is another answer.
  const history = golden.get("history-200-ok")!.response.body;
  assert.notDeepEqual(bodyShape(history.replaceAll('"seq"', '"revision"').replaceAll('"timestamp"', '"at"')), bodyShape(history));
});

test("the fake answers every golden /sync/v1/export exchange with the host's exact values and bytes", async () => {
  const exchanges = [...golden.values()].filter(isExport);
  assert.deepEqual(exchanges.map((exchange) => exchange.name).sort(), ["export-200", "export-400-invalid-input", "export-401-unauthenticated", "export-404-bundle-not-found"]);
  const captured = golden.get("export-200")!;
  const archive = Buffer.from(captured.response.bodyBase64!, "base64");
  // The bundle the captured archive holds, as the fake's storage: the files are the input, and
  // every byte the fake adds around them (order, headers, manifest, directory) is compared.
  const exported = verifyExport(archive, "notes.a");
  const host = new FakeHost({ bundles: ["notes.a"] });
  host.exportState = {
    tenantId: exported.source.tenantId,
    bundleId: exported.source.bundleId,
    revision: exported.source.revision,
    files: new Map([...exported.entries].reverse().map((entry) => [entry.path, entry.bytes])),
  };
  host.exportedAt = () => new Date(exported.exportedAt);

  for (const exchange of exchanges) {
    const bearer = exchange.name === "export-401-unauthenticated" ? "not-a-token" : host.token;
    const response = await host.fetch(`${host.origin}/sync/v1/export`, {
      method: "POST",
      headers: { ...exchange.request.headers, Authorization: `Bearer ${bearer}` },
      body: exchange.request.body,
    });
    assert.equal(response.status, exchange.response.status, exchange.name);
    const headers = Object.fromEntries(Object.keys(exchange.response.headers).map((name) => [name, response.headers.get(name)]));
    assert.deepEqual(headers, exchange.response.headers, `${exchange.name}: header values`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (exchange.response.bodyBase64 !== undefined) {
      assert.equal(bytes.toString("base64"), exchange.response.bodyBase64, `${exchange.name}: the archive bytes`);
    } else {
      assert.equal(bytes.toString("utf8"), exchange.response.body, `${exchange.name}: the body bytes`);
    }
  }
});

test("the export value check catches a manifest, order or header the host does not emit", async () => {
  const captured = golden.get("export-200")!;
  const archive = Buffer.from(captured.response.bodyBase64!, "base64");
  const exported = verifyExport(archive, "notes.a");
  const answer = async (mutate: (host: FakeHost) => void) => {
    const host = new FakeHost({ bundles: ["notes.a"] });
    host.exportState = { tenantId: exported.source.tenantId, bundleId: "notes.a", revision: exported.source.revision, files: new Map(exported.entries.map((entry) => [entry.path, entry.bytes])) };
    host.exportedAt = () => new Date(exported.exportedAt);
    mutate(host);
    const response = await host.fetch(`${host.origin}/sync/v1/export`, { method: "POST", headers: { Authorization: `Bearer ${host.token}` }, body: JSON.stringify({ bundleId: "notes.a" }) });
    return { disposition: response.headers.get("content-disposition"), base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
  };
  assert.equal((await answer(() => {})).base64, captured.response.bodyBase64);
  // Another revision changes the manifest and the file name; another instant changes every header.
  const revised = await answer((host) => void (host.exportState = { ...host.exportState!, revision: 3 }));
  assert.notEqual(revised.base64, captured.response.bodyBase64);
  assert.notEqual(revised.disposition, captured.response.headers["content-disposition"]);
  assert.notEqual((await answer((host) => void (host.exportedAt = () => new Date(Date.parse(exported.exportedAt) + 60_000)))).base64, captured.response.bodyBase64);
});
