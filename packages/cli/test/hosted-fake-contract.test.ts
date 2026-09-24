// The CLI's fake hosted sync family (`support/fake-hosted-sync.ts`) against the `/sync/v1` golden
// exchanges captured from the real hosted gateway (core's `test/fixtures/hosted-sync-v1/`). For
// every exchange the fake is driven into the same situation and must answer with the same status,
// the same grammar headers and the same body shape: the same keys at every level, the same value
// types, and content versions where the host sends versions. Values (ids, versions, messages) are
// the fake's own. A fake that drifts from what the host emits fails here, not on staging.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BUNDLE, FakeHost, SYNC_FIXTURES } from "./support/fake-hosted-sync.js";

interface Exchange {
  name: string;
  route: string;
  request: { headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

const index = JSON.parse(readFileSync(path.join(SYNC_FIXTURES, "index.json"), "utf8")) as { exchanges: { name: string; file: string }[] };
const golden = new Map<string, Exchange>(index.exchanges.map((entry) => [entry.name, JSON.parse(readFileSync(path.join(SYNC_FIXTURES, entry.file), "utf8")) as Exchange]));

/** Exchanges the fake does not model, each with the reason; every other exchange must be driven below. */
const NOT_MODELED: Readonly<Record<string, string>> = Object.freeze({
  "create-429-request-capacity": "the fake has no sync quota; tests inject the capacity refusal through a write hook",
});

const VERSION = /^sha256:[a-f0-9]{64}$/;

/** A value's shape: keys and types all the way down; frontmatter is authored content, so only its kind. */
function shape(value: unknown, key?: string): unknown {
  if (value === null) return "null";
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

async function answerOf(response: Response) {
  const headers = GRAMMAR.filter((name) => response.headers.has(name)).sort();
  return { status: response.status, headers, body: bodyShape(await response.text()) };
}

function expectedOf(exchange: Exchange) {
  return { status: exchange.response.status, headers: Object.keys(exchange.response.headers).sort(), body: bodyShape(exchange.response.body) };
}

const identity = (n: number) => `4a2f9c1e-8b3d-4e6f-9a1b-${String(n).padStart(12, "0")}`;
const BINDING = `sha256:${"c".repeat(64)}`;

test("the fake answers every golden /sync/v1 exchange in the host's shape", async () => {
  const host = new FakeHost();
  const send = (route: string, body: unknown, options: { requestId?: string | null; bearer?: string } = {}) =>
    host.fetch(`${host.origin}/sync/v1/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${options.bearer ?? host.token}`,
        ...(options.requestId === undefined || options.requestId === null ? {} : { "X-Superbee-Write-Request": options.requestId, "X-Superbee-Checkout": BINDING }),
        ...(options.requestId === null ? { "X-Superbee-Checkout": BINDING } : {}),
      },
      body: JSON.stringify(body),
    });
  const [firstId, first] = [...host.docs][0]!;
  const create = (documentId: string, body = "two") => ({ bundleId: BUNDLE, documentId, expectAbsent: true, frontmatter: { type: "Note" }, body });
  const replace = (expectedVersion: string, body: string) => ({ bundleId: BUNDLE, documentId: firstId, expectedVersion, frontmatter: { type: "Note" }, body });
  const remove = (expectedVersion: string) => ({ bundleId: BUNDLE, documentId: "notes/two", expectedVersion });

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

  const created = await json(send("create", create("notes/two"), { requestId: identity(1) }));
  observed.set("create-200-ok", await answerOf(await send("create", create("notes/two"), { requestId: identity(1) })));
  await observe("outcome-200-committed-create", send("outcome", create("notes/two"), { requestId: identity(1) }));
  await observe("create-200-document-exists", send("create", create(firstId, "dup"), { requestId: identity(2) }));
  const replaced = await json(send("replace", replace(first.version, "one edited"), { requestId: identity(3) }));
  observed.set("replace-200-ok", await answerOf(await send("replace", replace(first.version, "one edited"), { requestId: identity(3) })));
  await observe("replace-200-version-conflict", send("replace", replace(first.version, "stale"), { requestId: identity(4) }));
  await observe("outcome-200-refused-replace", send("outcome", replace(first.version, "stale"), { requestId: identity(4) }));
  await observe("delete-200-ok", send("delete", remove(created.data.version), { requestId: identity(5) }));
  await observe("outcome-200-committed-delete", send("outcome", remove(created.data.version), { requestId: identity(5) }));
  await observe("delete-200-unchanged", send("delete", remove(created.data.version), { requestId: identity(6) }));
  await observe("create-200-version-conflict-tombstone", send("create", create("notes/two", "again"), { requestId: identity(7) }));
  await observe("outcome-200-absent", send("outcome", create("notes/never"), { requestId: identity(8) }));
  await observe("write-400-invalid-input", send("replace", { ...replace(replaced.data.version, "x"), extra: true }, { requestId: identity(9) }));
  await observe("write-400-missing-identity", send("create", create("notes/x"), { requestId: null }));

  for (const [name, exchange] of golden) {
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

test("the contract's shape check catches the read answer the fake used to give", async () => {
  const host = new FakeHost();
  const [id, doc] = [...host.docs][0]!;
  const drifted = { ok: true, operationId: "documents.read.v1", data: { bundleId: BUNDLE, documentId: id, version: doc.version, document: { frontmatter: doc.frontmatter, body: doc.body } } };
  assert.notDeepEqual(shape(drifted), bodyShape(golden.get("read-200-ok")!.response.body));
});
