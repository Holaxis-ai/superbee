/**
 * `HostedClient.write` and `lookupWrite`: the one-call document write over the whole-document
 * transport and the uncertain-write primitive. The plain answers replay the `/sync/v1` golden
 * exchanges byte for byte; recovery runs against a stateful fake host with a request ledger
 * (identity, fingerprint, recorded result) whose answers take the exchanges' shapes, and which
 * can lose a request before or after applying it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bearerCredentials,
  checkoutBindingDigest,
  createHostedClient,
  createMemoryIntentStore,
  type HostedClientOptions,
  type HostedIntentStore,
  type HostedWriteIntent,
} from "../src/hosted-client/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "hosted-sync-v1");

interface Exchange {
  request: { headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string };
}
const fixture = (name: string): Exchange => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Exchange;
const replay = (name: string): Response => {
  const { response } = fixture(name);
  return new Response(response.body, { status: response.status, headers: response.headers });
};

const ORIGIN = "https://hosted.example";
const BUNDLE = "notes.a";
const BINDING = /^sha256:[a-f0-9]{64}$/;
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const doc = (body: string) => `---\ntype: Note\n---\n${body}`;

interface Sent {
  readonly route: string;
  readonly body: string;
  readonly requestId: string | null;
  readonly binding: string | null;
  readonly authorization: string | null;
}

function recorder(answer: (route: string, body: string, headers: Headers) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    sent.push({ route, body, requestId: headers.get("x-superbee-write-request"), binding: headers.get("x-superbee-checkout"), authorization: headers.get("authorization") });
    return answer(route, body, headers);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

function clientOf(fetch: typeof globalThis.fetch, overrides: Partial<HostedClientOptions> = {}) {
  return createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: bearerCredentials(() => "token-1"), fetch, ...overrides });
}

const routes = (sent: readonly Sent[]) => sent.map((row) => row.route.slice("/sync/v1/".length));

// ── golden exchanges ───────────────────────────────────────────────────────────────────────

/** A host answering by route with the named exchanges, in order per route. */
function golden(byRoute: Record<string, string[]>) {
  return recorder((route) => {
    const name = byRoute[route.slice(route.lastIndexOf("/") + 1)]?.shift();
    return name ? replay(name) : assert.fail(`unexpected ${route}`);
  });
}
const idOf = (name: string) => fixture(name).request.headers["x-superbee-write-request"]!;

test("golden: a create on an absent id commits at the host's version, with the exchange's body", async () => {
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], create: ["create-200-ok"] });
  const result = await clientOf(fetch).write(BUNDLE, { id: "notes/two", document: doc("two"), expectAbsent: true }, { requestId: idOf("create-200-ok") });
  assert.deepEqual(result, { requestId: idOf("create-200-ok"), documentId: "notes/two", status: "committed", version: JSON.parse(fixture("create-200-ok").response.body).data.version });
  assert.deepEqual(routes(sent), ["capabilities", "create"]);
  assert.deepEqual(JSON.parse(sent[1]!.body), JSON.parse(fixture("create-200-ok").request.body));
  assert.equal(sent[1]!.requestId, idOf("create-200-ok"));
  assert.match(sent[1]!.binding ?? "", BINDING);
});

test("golden: a create over an existing document is a conflict naming the version the host serves", async () => {
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], create: ["create-200-document-exists"], read: ["read-200-ok"] });
  const result = await clientOf(fetch).write(BUNDLE, { id: "notes/one", document: doc("dup"), expectAbsent: true });
  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "version_conflict");
  assert.equal(result.status === "conflict" && result.reason === "version_conflict" && result.currentVersion, JSON.parse(fixture("read-200-ok").response.body).data.version);
  assert.deepEqual(routes(sent), ["capabilities", "create", "read"]);
  assert.deepEqual(JSON.parse(sent[1]!.body), JSON.parse(fixture("create-200-document-exists").request.body));
});

test("golden: a replace at the current version commits", async () => {
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], replace: ["replace-200-ok"] });
  const expectedVersion = JSON.parse(fixture("replace-200-ok").request.body).expectedVersion as string;
  const result = await clientOf(fetch).write(BUNDLE, { id: "notes/one", document: doc("one edited"), expectedVersion });
  assert.equal(result.status, "committed");
  assert.equal(result.status === "committed" && result.version, JSON.parse(fixture("replace-200-ok").response.body).data.version);
  assert.deepEqual(JSON.parse(sent[1]!.body), JSON.parse(fixture("replace-200-ok").request.body));
});

test("golden: a replace at a stale version is a conflict carrying the actual version, and nothing is resent", async () => {
  const { fetch, sent } = golden({ capabilities: ["capabilities-200"], replace: ["replace-200-version-conflict"] });
  const expectedVersion = JSON.parse(fixture("replace-200-version-conflict").request.body).expectedVersion as string;
  const result = await clientOf(fetch).write(BUNDLE, { id: "notes/one", document: doc("stale"), expectedVersion }, { requestId: idOf("replace-200-version-conflict") });
  assert.deepEqual(result, {
    requestId: idOf("replace-200-version-conflict"),
    documentId: "notes/one",
    status: "conflict",
    reason: "version_conflict",
    currentVersion: JSON.parse(fixture("replace-200-version-conflict").response.body).error.currentVersion,
  });
  assert.deepEqual(routes(sent), ["capabilities", "replace"]);
});

// ── the stateful fake host ─────────────────────────────────────────────────────────────────

type Fault = "lost-request" | "lost-answer" | "concurrent-change";

/**
 * A host with documents and an identified-write ledger, answering as the exchanges do. A request
 * identity reused with a different body is refused `invalid_input` (the host's fingerprint check).
 * A queued fault applies to the next request of its route: `lost-request` fails before anything
 * applies, `lost-answer` applies and then fails, `concurrent-change` records a settled
 * `concurrent_change` refusal.
 */
function fakeHost(options: { retentionMs?: number; operations?: boolean } = {}) {
  const documents = new Map<string, { frontmatter: Record<string, unknown>; body: string; version: string; bytes: string }>();
  const ledger = new Map<string, { body: string; result: Record<string, unknown>; content?: { version: string; bytes: string } }>();
  const faults = new Map<string, Fault[]>();
  const capabilities = JSON.parse(fixture("capabilities-200").response.body) as Record<string, unknown>;
  if (options.retentionMs !== undefined) capabilities.operationsRetentionMs = options.retentionMs;
  if (options.operations === false) capabilities.operations = false;
  const settled = (requestId: string, body: unknown) => Response.json(body, { headers: { "x-superbee-write-settled": requestId } });
  const failure = (operationId: string, code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, operationId, error: { code, message, retryable: false, writeState: "not_applied", ...extra } });

  function apply(route: "create" | "replace", input: { documentId: string; expectedVersion?: string; frontmatter: Record<string, unknown>; body: string }): { result: Record<string, unknown>; content?: { version: string; bytes: string } } {
    const operationId = `documents.${route}.v1`;
    const current = documents.get(input.documentId);
    if (route === "create" && current) return { result: failure(operationId, "document_exists", "The document already exists.", { currentVersion: current.version }) };
    if (route === "replace" && !current) return { result: failure(operationId, "document_not_found", "The document was not found.") };
    if (route === "replace" && current!.version !== input.expectedVersion) return { result: failure(operationId, "version_conflict", "The document changed.", { currentVersion: current!.version }) };
    const bytes = `---\n${JSON.stringify(input.frontmatter)}\n---\n${input.body}\n`;
    const version = sha256(bytes);
    documents.set(input.documentId, { frontmatter: input.frontmatter, body: input.body, version, bytes });
    return { result: { ok: true, operationId, data: { bundleId: BUNDLE, documentId: input.documentId, version, changed: true } }, content: { version, bytes } };
  }

  const host = recorder((route, raw, headers) => {
    const name = route.slice(route.lastIndexOf("/") + 1);
    const fault = faults.get(name)?.shift();
    if (fault === "lost-request") throw new TypeError("network lost the request");
    const input = JSON.parse(raw) as { documentId: string; expectedVersion?: string; frontmatter: Record<string, unknown>; body: string };
    const requestId = headers.get("x-superbee-write-request")!;
    const binding = headers.get("x-superbee-checkout")!;
    switch (name) {
      case "capabilities":
        return Response.json(capabilities);
      case "read": {
        const found = documents.get(input.documentId);
        if (!found) return replay("read-200-document-not-found");
        return Response.json({ ok: true, operationId: "documents.read.v1", data: { document: { id: input.documentId, frontmatter: found.frontmatter, body: found.body }, version: found.version } });
      }
      case "create":
      case "replace": {
        const recorded = ledger.get(requestId);
        if (recorded && recorded.body !== raw) return Response.json(failure(`documents.${name}.v1`, "invalid_input", "This request identity was used for a different request."));
        if (recorded) return settled(requestId, recorded.result);
        const entry =
          fault === "concurrent-change"
            ? { result: failure(`documents.${name}.v1`, "concurrent_change", "Another change to this bundle overlapped; nothing was written.") }
            : apply(name, input);
        ledger.set(requestId, { body: raw, ...entry });
        if (fault === "lost-answer") throw new TypeError("network lost the answer");
        return settled(requestId, entry.result);
      }
      case "outcome": {
        const recorded = ledger.get(requestId);
        if (!recorded) return Response.json({ schemaVersion: 1, requestId, binding, status: "absent" });
        if (recorded.body !== raw) return Response.json({ error: { code: "invalid_input" } }, { status: 400 });
        const committed = (recorded.result as { ok: boolean }).ok;
        return Response.json({
          schemaVersion: 1,
          requestId,
          binding,
          status: committed ? "committed" : "refused",
          result: recorded.result,
          ...(committed ? { content: { encoding: "base64", version: recorded.content!.version, bytes: Buffer.from(recorded.content!.bytes).toString("base64") } } : {}),
        });
      }
      default:
        return replay("unknown-route-404");
    }
  });
  return {
    ...host,
    documents,
    ledger,
    fault(route: string, ...queued: Fault[]) {
      faults.set(route, [...(faults.get(route) ?? []), ...queued]);
    },
    seed(id: string, body: string): string {
      return apply("create", { documentId: id, frontmatter: { type: "Note" }, body }).content!.version;
    },
  };
}

const writes = (sent: readonly Sent[]) => sent.filter((row) => row.route.endsWith("/create") || row.route.endsWith("/replace"));
const lookups = (sent: readonly Sent[]) => sent.filter((row) => row.route.endsWith("/outcome"));

test("recovery: a lost answer is looked up under the same identity, binding and body, and settles committed", async () => {
  const host = fakeHost();
  host.fault("create", "lost-answer");
  const result = await clientOf(host.fetch).write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(result.status, "committed");
  assert.equal(result.status === "committed" && result.version, host.documents.get("notes/new")!.version);
  const [write] = writes(host.sent);
  const [lookup] = lookups(host.sent);
  assert.equal(writes(host.sent).length, 1);
  assert.equal(lookups(host.sent).length, 1);
  assert.equal(lookup!.requestId, write!.requestId);
  assert.equal(lookup!.binding, write!.binding);
  assert.equal(lookup!.body, write!.body);
});

test("recovery: a request lost before it applied is looked up, found absent, and sent once more under the same identity", async () => {
  const host = fakeHost();
  const base = host.seed("notes/one", "one");
  host.fault("replace", "lost-request");
  const result = await clientOf(host.fetch).write(BUNDLE, { id: "notes/one", document: doc("one edited"), expectedVersion: base });
  assert.equal(result.status, "committed");
  const sentWrites = writes(host.sent);
  assert.equal(sentWrites.length, 2);
  assert.equal(sentWrites[0]!.requestId, sentWrites[1]!.requestId);
  assert.equal(sentWrites[0]!.body, sentWrites[1]!.body);
  assert.equal(lookups(host.sent).length, 1);
  assert.equal(host.ledger.size, 1);
});

test("recovery: a lost answer whose lookups are lost too is unknown with its identity; lookupWrite later settles it without resending", async () => {
  const host = fakeHost();
  host.fault("create", "lost-answer");
  host.fault("outcome", "lost-request", "lost-request", "lost-request");
  const store = createMemoryIntentStore();
  const client = clientOf(host.fetch, { intentStore: store });
  const result = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(result.status, "unknown");
  assert.equal(result.requestId, writes(host.sent)[0]!.requestId);
  assert.equal(lookups(host.sent).length, 3);
  const held = await store.get(result.requestId);
  assert.equal(held?.state, "unknown");
  assert.equal(held?.attempts, 1);

  const later = await client.lookupWrite(result.requestId);
  assert.equal(later.status, "committed");
  assert.equal(later.status === "committed" && later.version, host.documents.get("notes/new")!.version);
  assert.equal(writes(host.sent).length, 1, "the write was never sent again");
  assert.equal(lookups(host.sent).at(-1)!.binding, writes(host.sent)[0]!.binding);
  assert.equal(await store.get(result.requestId), undefined, "a settled write leaves the store");
  await assert.rejects(client.lookupWrite(result.requestId), TypeError);
});

test("recovery: a settled concurrent_change is a conflict and is never resent by the client", async () => {
  const host = fakeHost();
  const base = host.seed("notes/one", "one");
  host.fault("replace", "concurrent-change");
  const client = clientOf(host.fetch);
  const result = await client.write(BUNDLE, { id: "notes/one", document: doc("mine"), expectedVersion: base });
  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "concurrent_change");
  assert.equal(writes(host.sent).length, 1);
  assert.equal(lookups(host.sent).length, 0);
  assert.equal(host.documents.get("notes/one")!.version, base, "nothing was applied");
  // The caller's next attempt is a new write, at the version it reads.
  const again = await client.write(BUNDLE, { id: "notes/one", document: doc("mine"), expectedVersion: base });
  assert.equal(again.status, "committed");
  assert.notEqual(again.requestId, result.requestId);
});

test("recovery: a concurrent_change recorded behind a lost answer comes back from the lookup as a conflict, with no second write", async () => {
  const host = fakeHost();
  const base = host.seed("notes/one", "one");
  // Record the refusal, then lose its answer.
  const original = host.fetch;
  let first = true;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    if (first && route.endsWith("/replace")) {
      first = false;
      host.fault("replace", "concurrent-change");
      await original(input, init);
      throw new TypeError("network lost the answer");
    }
    return original(input, init);
  }) as typeof globalThis.fetch;
  const result = await clientOf(fetch).write(BUNDLE, { id: "notes/one", document: doc("mine"), expectedVersion: base });
  assert.equal(result.status, "conflict");
  assert.equal(result.status === "conflict" && result.reason, "concurrent_change");
  assert.equal(writes(host.sent).length, 1);
  assert.equal(lookups(host.sent).length, 1);
  assert.equal(host.documents.get("notes/one")!.version, base, "nothing was applied");
});

test("identity: the same request identity with a different document is refused by the host, and surfaces as refused", async () => {
  const host = fakeHost();
  const requestId = "0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c1e";
  const first = await clientOf(host.fetch).write(BUNDLE, { id: "notes/new", document: doc("first"), expectAbsent: true }, { requestId });
  assert.equal(first.status, "committed");
  // Another client (its own store) reusing the identity for different bytes.
  const second = await clientOf(host.fetch).write(BUNDLE, { id: "notes/new", document: doc("second"), expectAbsent: true }, { requestId });
  assert.equal(second.status, "refused");
  assert.equal(second.status === "refused" && second.code, "invalid_input");
  assert.equal(host.documents.get("notes/new")!.body, "first");
});

test("identity: confirming a held write again resumes it under its identity; a different write under that identity is refused before sending", async () => {
  const host = fakeHost();
  host.fault("create", "lost-answer");
  host.fault("outcome", "lost-request", "lost-request", "lost-request");
  const client = clientOf(host.fetch);
  const unknown = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(unknown.status, "unknown");
  const before = host.sent.length;

  const other = await client.write(BUNDLE, { id: "notes/new", document: doc("other"), expectAbsent: true }, { requestId: unknown.requestId });
  assert.equal(other.status === "refused" && other.code, "invalid_input");
  assert.equal(host.sent.length, before, "nothing was sent");

  const again = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true }, { requestId: unknown.requestId });
  assert.equal(again.status, "committed");
  assert.equal(writes(host.sent).length, 1, "confirmed by lookup, never re-applied");
});

test("retention: absence is evidence only within the window the host serves, never a client constant", async () => {
  const intentFor = (binding: string): HostedWriteIntent => ({
    requestId: "0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c1f",
    binding,
    bundleId: BUNDLE,
    workspace: null,
    operation: "create",
    documentId: "notes/old",
    document: doc("old"),
    digest: sha256(doc("old")),
    expectedVersion: null,
    okfVersion: "0.2",
    // Three hours old: inside the thirty-day default, past a two-hour served window.
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    attempts: 1,
    state: "unknown",
  });
  const binding = checkoutBindingDigest("persisted-checkout");

  const short = fakeHost({ retentionMs: 2 * 60 * 60 * 1000 });
  const shortStore = createMemoryIntentStore();
  await shortStore.put(intentFor(binding));
  const expired = await clientOf(short.fetch, { intentStore: shortStore }).lookupWrite(intentFor(binding).requestId);
  assert.equal(expired.status, "unknown");
  assert.equal(writes(short.sent).length, 0, "an identity past the served window is never resent");

  const long = fakeHost();
  const longStore = createMemoryIntentStore();
  await longStore.put(intentFor(binding));
  const resent = await clientOf(long.fetch, { intentStore: longStore }).lookupWrite(intentFor(binding).requestId);
  assert.equal(resent.status, "committed");
  assert.equal(writes(long.sent).length, 1);
  assert.equal(writes(long.sent)[0]!.binding, binding, "the recorded binding, not the new client's");
});

test("intent store: a caller's store records the full intent before the request leaves, and loses it once settled", async () => {
  const host = fakeHost();
  const base = host.seed("notes/one", "one");
  const calls: { op: string; intent?: HostedWriteIntent; sentSoFar: number }[] = [];
  const inner = createMemoryIntentStore();
  const store: HostedIntentStore = {
    put: (intent) => {
      calls.push({ op: "put", intent, sentSoFar: writes(host.sent).length });
      return inner.put(intent);
    },
    get: (requestId) => {
      calls.push({ op: "get", sentSoFar: writes(host.sent).length });
      return inner.get(requestId);
    },
    delete: (requestId) => {
      calls.push({ op: "delete", sentSoFar: writes(host.sent).length });
      return inner.delete(requestId);
    },
  };
  const result = await clientOf(host.fetch, { intentStore: store }).write(BUNDLE, { id: "notes/one", document: doc("edited"), expectedVersion: base });
  assert.equal(result.status, "committed");
  const puts = calls.filter((call) => call.op === "put");
  assert.equal(puts.length, 2);
  const recorded = puts[0]!.intent!;
  assert.deepEqual(
    { ...recorded, createdAt: "x" },
    {
      requestId: result.requestId,
      binding: writes(host.sent)[0]!.binding,
      bundleId: BUNDLE,
      workspace: null,
      operation: "replace",
      documentId: "notes/one",
      document: doc("edited"),
      digest: sha256(doc("edited")),
      expectedVersion: base,
      okfVersion: "0.2",
      createdAt: "x",
      attempts: 0,
      state: "pending",
    },
  );
  assert.equal(puts[1]!.intent!.attempts, 1);
  assert.equal(puts[1]!.intent!.state, "in_flight");
  assert.equal(puts[1]!.sentSoFar, 0, "the attempt is recorded before the request leaves");
  assert.equal(calls.at(-1)!.op, "delete");
  assert.equal(await inner.get(result.requestId), undefined);
});

test("credentials: the provider is asked once per request, so each request carries the token current then", async () => {
  const host = fakeHost();
  host.fault("create", "lost-answer");
  let asked = 0;
  const client = clientOf(host.fetch, { credentials: bearerCredentials(() => `token-${++asked}`) });
  const result = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(result.status, "committed");
  assert.equal(asked, host.sent.length);
  assert.deepEqual(
    host.sent.map((row) => row.authorization),
    host.sent.map((_, index) => `Bearer token-${index + 1}`),
  );
});

test("credentials: none available before sending is a refusal, never an unknown", async () => {
  const host = fakeHost();
  let calls = 0;
  const client = clientOf(host.fetch, {
    credentials: async () => {
      calls += 1;
      if (calls > 1) throw new Error("signed out");
      return { Authorization: "Bearer token-1" };
    },
  });
  const result = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(result.status === "refused" && result.code, "AUTH_REQUIRED");
  assert.equal(writes(host.sent).length, 0);
});

test("a host serving this bundle no identified writes refuses before sending; a capabilities failure is the typed error", async () => {
  const host = fakeHost({ operations: false });
  const result = await clientOf(host.fetch).write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(result.status === "refused" && result.code, "read_only");
  assert.equal(writes(host.sent).length, 0);

  const down = recorder(() => new Response(null, { status: 503 }));
  await assert.rejects(clientOf(down.fetch).write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true }), { name: "HostedCarrierError" });
});

test("one binding per client: every write of a client and of its within clients carries the same one; another client mints its own", async () => {
  const host = fakeHost();
  const client = clientOf(host.fetch);
  await client.write(BUNDLE, { id: "notes/a", document: doc("a"), expectAbsent: true });
  await client.write(BUNDLE, { id: "notes/b", document: doc("b"), expectAbsent: true });
  await clientOf(host.fetch).write(BUNDLE, { id: "notes/c", document: doc("c"), expectAbsent: true });
  const bindings = writes(host.sent).map((row) => row.binding);
  assert.equal(bindings[0], bindings[1]);
  assert.notEqual(bindings[0], bindings[2]);
  for (const binding of bindings) assert.match(binding ?? "", BINDING);

  const scoped = recorder(() => Response.json({}));
  const within = clientOf(scoped.fetch).within("south");
  await within.write(BUNDLE, { id: "notes/a", document: doc("a"), expectAbsent: true }).catch(() => undefined);
  assert.equal(JSON.parse(scoped.sent[0]!.body).bundleId, `south/${BUNDLE}`);
});

test("a write's input is checked before anything is sent", async () => {
  const host = fakeHost();
  const client = clientOf(host.fetch);
  const version = sha256("x");
  const bad: unknown[] = [
    { id: "notes/a", document: doc("a") },
    { id: "notes/a", document: doc("a"), expectAbsent: true, expectedVersion: version },
    { id: "notes/a", document: doc("a"), expectedVersion: "v1" },
    { id: "", document: doc("a"), expectAbsent: true },
    { id: "notes/a", document: 1, expectAbsent: true },
  ];
  for (const input of bad) await assert.rejects(client.write(BUNDLE, input as never), TypeError);
  await assert.rejects(client.write(BUNDLE, { id: "notes/a", document: doc("a"), expectAbsent: true }, { requestId: "not-a-uuid" }), TypeError);
  assert.equal(host.sent.length, 0);
});

test("checkoutBindingDigest is the CLI's digest of a checkout id, byte for byte", () => {
  for (const id of ["0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c1e", "", "é"]) assert.equal(checkoutBindingDigest(id), sha256(id));
});
