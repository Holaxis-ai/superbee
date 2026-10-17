/**
 * `HostedClient.write`, `lookupWrite`, `settleWrite` and `heldWrites`: the one-call document write over the whole-document
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
  HostedIntentsNotListable,
  INTENTS_NOT_LISTABLE,
} from "../src/hosted-client/index.js";
import { performUncertainWrite, type OperationIntent, type OperationTransport } from "../src/uncertain-write.js";
import { createCapabilitiesCache, hostedWrite, type HostedWriteContext } from "../src/hosted-client/write.js";
import { createFetchCarrier } from "../src/hosted-transport/index.js";

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
  return createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: bearerCredentials(() => "token-1"), fetch, writeRecovery: { lookupDelayMs: 0 }, ...overrides });
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

type Fault = "lost-request" | "lost-answer" | "concurrent-change" | "held" | "unauthenticated-401" | "capacity-429";

/**
 * A host with documents and an identified-write ledger, answering as the exchanges do. A request
 * identity reused with a different body is refused `invalid_input` (the host's fingerprint check).
 * A queued fault applies to the next request of its route: `lost-request` fails before anything
 * applies, `lost-answer` applies and then fails, `concurrent-change` records a settled
 * `concurrent_change` refusal, `held` reserves the identity without answering (its lookup is
 * `pending` until `release()` commits it), and `unauthenticated-401` and `capacity-429` refuse
 * before dispatch, recording nothing.
 */
function fakeHost(options: { retentionMs?: number; operations?: boolean } = {}) {
  const documents = new Map<string, { frontmatter: Record<string, unknown>; body: string; version: string; bytes: string }>();
  const ledger = new Map<string, { body: string; result?: Record<string, unknown>; content?: { version: string; bytes: string }; held?: { route: "create" | "replace"; input: Parameters<typeof apply>[1] } }>();
  const faults = new Map<string, Fault[]>();
  const capabilities = JSON.parse(fixture("capabilities-200").response.body) as Record<string, unknown>;
  if (options.retentionMs !== undefined) capabilities.operationsRetentionMs = options.retentionMs;
  if (options.operations === false) capabilities.operations = false;
  const settled = (requestId: string, body: unknown) => Response.json(body, { headers: { "x-superbee-write-settled": requestId } });
  const failure = (operationId: string, code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, operationId, error: { code, message, retryable: false, writeState: "not_applied", ...extra } });

  function apply(route: "create" | "replace", input: { bundleId?: string; documentId: string; expectedVersion?: string; frontmatter: Record<string, unknown>; body: string }): { result: Record<string, unknown>; content?: { version: string; bytes: string } } {
    const operationId = `documents.${route}.v1`;
    const current = documents.get(input.documentId);
    if (route === "create" && current) return { result: failure(operationId, "document_exists", "The document already exists.", { currentVersion: current.version }) };
    if (route === "replace" && !current) return { result: failure(operationId, "document_not_found", "The document was not found.") };
    if (route === "replace" && current!.version !== input.expectedVersion) return { result: failure(operationId, "version_conflict", "The document changed.", { currentVersion: current!.version }) };
    const bytes = `---\n${JSON.stringify(input.frontmatter)}\n---\n${input.body}\n`;
    const version = sha256(bytes);
    documents.set(input.documentId, { frontmatter: input.frontmatter, body: input.body, version, bytes });
    // The host's answer names the bare id, whichever workspace the request named it in.
    const bundleId = (input.bundleId ?? BUNDLE).split("/").pop()!;
    return { result: { ok: true, operationId, data: { bundleId, documentId: input.documentId, version, changed: true } }, content: { version, bytes } };
  }

  const host = recorder((route, raw, headers) => {
    const name = route.slice(route.lastIndexOf("/") + 1);
    const fault = faults.get(name)?.shift();
    if (fault === "lost-request") throw new TypeError("network lost the request");
    const input = JSON.parse(raw) as { bundleId?: string; documentId: string; expectedVersion?: string; frontmatter: Record<string, unknown>; body: string };
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
        if (fault === "unauthenticated-401") return Response.json({ error: { code: "unauthenticated", writeState: "not_applied" } }, { status: 401 });
        if (fault === "capacity-429") return replay("create-429-request-capacity");
        if (fault === "held") {
          ledger.set(requestId, { body: raw, held: { route: name, input } });
          throw new TypeError("the deadline passed while the host held the request");
        }
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
        if (recorded.held) return Response.json({ schemaVersion: 1, requestId, binding, status: "pending" });
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
    /** Commit every held request, as the host finishing it would. */
    release() {
      for (const entry of ledger.values()) {
        if (!entry.held) continue;
        Object.assign(entry, apply(entry.held.route, entry.held.input));
        delete entry.held;
      }
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
  assert.deepEqual(await client.lookupWrite(result.requestId), { status: "unrecorded", requestId: result.requestId });
  assert.deepEqual(await client.settleWrite(result.requestId), { status: "unrecorded", requestId: result.requestId });
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
  const expired = await clientOf(short.fetch, { intentStore: shortStore }).settleWrite(intentFor(binding).requestId);
  assert.equal(expired.status, "unknown");
  assert.equal(writes(short.sent).length, 0, "an identity past the served window is never resent");

  const long = fakeHost();
  const longStore = createMemoryIntentStore();
  await longStore.put(intentFor(binding));
  const longClient = clientOf(long.fetch, { intentStore: longStore });
  const looked = await longClient.lookupWrite(intentFor(binding).requestId);
  assert.equal(looked.status, "unknown", "absent is not settled by a lookup");
  assert.equal(writes(long.sent).length, 0, "lookupWrite never sends the write");
  const resent = await longClient.settleWrite(intentFor(binding).requestId);
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

// ── review fixes ───────────────────────────────────────────────────────────────────────────

test("store failure: a store that cannot record the first submission makes write throw, with nothing sent or looked up", async () => {
  const host = fakeHost();
  const inner = createMemoryIntentStore();
  const failure = new Error("disk full");
  const store: HostedIntentStore = {
    put: (intent) => {
      if (intent.state === "in_flight") throw failure;
      return inner.put(intent);
    },
    get: (requestId) => inner.get(requestId),
    delete: (requestId) => inner.delete(requestId),
  };
  await assert.rejects(clientOf(host.fetch, { intentStore: store }).write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true }), (error) => error === failure);
  assert.equal(writes(host.sent).length, 0);
  assert.equal(lookups(host.sent).length, 0);
  assert.equal(host.documents.size, 0);
});

test("lookupWrite never sends; settleWrite sends the same identity once when the host never recorded it", async () => {
  const host = fakeHost();
  host.fault("create", "lost-request");
  host.fault("outcome", "lost-request", "lost-request", "lost-request");
  const client = clientOf(host.fetch);
  const unknown = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(unknown.status, "unknown");
  const sentWrites = writes(host.sent).length;

  const looked = await client.lookupWrite(unknown.requestId);
  assert.equal(looked.status, "unknown");
  assert.equal(writes(host.sent).length, sentWrites, "a lookup that finds nothing sends nothing");

  const settled = await client.settleWrite(unknown.requestId);
  assert.equal(settled.status, "committed");
  assert.equal(writes(host.sent).length, sentWrites + 1);
  assert.equal(writes(host.sent).at(-1)!.requestId, unknown.requestId);
});

test("unrecorded: an identity the store never held answers unrecorded from lookupWrite and settleWrite, and nothing is sent", async () => {
  const host = fakeHost();
  const client = clientOf(host.fetch);
  const requestId = "0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c20";
  assert.deepEqual(await client.lookupWrite(requestId), { status: "unrecorded", requestId });
  assert.deepEqual(await client.settleWrite(requestId), { status: "unrecorded", requestId });
  assert.equal(host.sent.length, 0);
});

test("heldWrites: the store's unsettled writes, for a service that restarts; a store without list is a typed error", async () => {
  const host = fakeHost();
  host.fault("create", "lost-answer");
  host.fault("outcome", "lost-request", "lost-request", "lost-request");
  const store = createMemoryIntentStore();
  const unknown = await clientOf(host.fetch, { intentStore: store }).write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  const restarted = clientOf(host.fetch, { intentStore: store });
  const held = await restarted.heldWrites();
  assert.deepEqual(held.map((intent) => [intent.requestId, intent.state]), [[unknown.requestId, "unknown"]]);
  assert.equal((await restarted.settleWrite(held[0]!.requestId)).status, "committed");
  assert.deepEqual(await restarted.heldWrites(), []);

  const unlistable: HostedIntentStore = { put: () => {}, get: () => undefined, delete: () => {} };
  await assert.rejects(clientOf(host.fetch, { intentStore: unlistable }).heldWrites(), (error) => error instanceof HostedIntentsNotListable && (error as HostedIntentsNotListable).code === INTENTS_NOT_LISTABLE);
});

test("workspace: a held identity confirmed from a client naming another workspace is refused, and the message says so", async () => {
  const host = fakeHost();
  host.fault("create", "lost-answer");
  host.fault("outcome", "lost-request", "lost-request", "lost-request");
  const client = clientOf(host.fetch);
  const unknown = await client.within("south").write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  assert.equal(unknown.status, "unknown");
  const before = host.sent.length;
  const root = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true }, { requestId: unknown.requestId });
  assert.equal(root.status, "refused");
  assert.match(root.status === "refused" ? root.message : "", /workspace 'south'/);
  assert.equal(host.sent.length, before);
  const other = await client.write(BUNDLE, { id: "notes/new", document: doc("other"), expectAbsent: true }, { requestId: unknown.requestId });
  assert.doesNotMatch(other.status === "refused" ? other.message : "", /workspace/);
});

test("concurrency: two writes under one identity on one client run one after the other, so the second sees the first's record", async () => {
  const host = fakeHost();
  host.fault("create", "lost-answer");
  host.fault("outcome", "lost-request", "lost-request", "lost-request");
  const client = clientOf(host.fetch);
  const requestId = "0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c21";
  const [first, second] = await Promise.all([
    client.write(BUNDLE, { id: "notes/new", document: doc("first"), expectAbsent: true }, { requestId }),
    client.write(BUNDLE, { id: "notes/new", document: doc("second"), expectAbsent: true }, { requestId }),
  ]);
  assert.equal(first.status, "unknown");
  assert.equal(second.status === "refused" && second.code, "invalid_input");
  assert.equal(writes(host.sent).length, 1, "the second write never left");
  const held = await client.heldWrites();
  assert.equal(held.length, 1);
  assert.equal(held[0]!.document, doc("first"), "the first write's record stands");
});

test("abort: an abort after sending ends recovery at once, with no lookup and no wait between lookups", async () => {
  const controller = new AbortController();
  const host = fakeHost();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/create")) {
      await host.fetch(input, init);
      controller.abort();
      throw new TypeError("network lost the answer");
    }
    return host.fetch(input, init);
  }) as typeof globalThis.fetch;
  // A minute between lookups: an abort that waited for it would never finish in time.
  const client = clientOf(fetch, { writeRecovery: { lookupDelayMs: 60_000 } });
  const started = performance.now();
  const result = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true }, { signal: controller.signal });
  assert.equal(result.status, "unknown");
  assert.ok(performance.now() - started < 5_000);
  assert.equal(lookups(host.sent).length, 0);
});

test("performUncertainWrite: an aborted signal stops lookups, the wait between them and resubmission; absent, nothing changes", async () => {
  const intent: OperationIntent = { requestId: "r", kind: "document.write", target: "t", base: null, local: "sha256:" + "0".repeat(64), content: "", createdAt: new Date().toISOString(), attempts: 0, state: "pending" };
  const run = async (signal?: AbortSignal, abortOnSubmit?: AbortController) => {
    let submits = 0;
    let lookupCount = 0;
    const sleeps: number[] = [];
    const transport: OperationTransport = {
      async submit() {
        submits += 1;
        abortOnSubmit?.abort();
        throw new Error("lost");
      },
      async lookup() {
        lookupCount += 1;
        throw new Error("lost");
      },
    };
    const result = await performUncertainWrite(transport, intent, { lookupDelayMs: 7, sleep: async (ms) => void sleeps.push(ms), ...(signal ? { signal } : {}) });
    return { outcome: result.outcome.kind, submits, lookupCount, sleeps };
  };
  assert.deepEqual(await run(), { outcome: "unknown", submits: 1, lookupCount: 3, sleeps: [7, 7] });
  const controller = new AbortController();
  assert.deepEqual(await run(controller.signal, controller), { outcome: "unknown", submits: 1, lookupCount: 0, sleeps: [] });
});

// ── QA fixes ───────────────────────────────────────────────────────────────────────────────

/**
 * The first create is held by the host and its answer lost; the lookup says pending, so the same
 * identity is sent again, and that resend is refused before dispatch by `refuse`. The held first
 * delivery then commits on the host.
 */
async function heldThenRefused(refuse: "credentials" | "unauthenticated-401" | "capacity-429") {
  const host = fakeHost();
  host.fault("create", "held");
  if (refuse !== "credentials") host.fault("create", refuse);
  let creates = 0;
  const store = createMemoryIntentStore();
  const credentials = async (_signal: AbortSignal) => {
    // capabilities, create (held), outcome (pending), then the resend's credential.
    if (refuse === "credentials" && ++creates === 4) throw new Error("signed out");
    return { Authorization: "Bearer token-1" };
  };
  const client = clientOf(host.fetch, { intentStore: store, credentials });
  const result = await client.write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true });
  return { host, store, client, result };
}

for (const refuse of ["credentials", "unauthenticated-401", "capacity-429"] as const) {
  test(`resend refused before dispatch (${refuse}) after a pending lookup is unknown, keeps the record, and settles later`, async () => {
    const { host, store, client, result } = await heldThenRefused(refuse);
    assert.equal(result.status, "unknown", "a refused resend says nothing about the held first delivery");
    const held = await store.get(result.requestId);
    assert.equal(held?.state, "unknown");
    assert.equal(held?.attempts, 2);
    host.release();
    const settled = await client.settleWrite(result.requestId);
    assert.equal(settled.status, "committed");
    assert.equal(settled.status === "committed" && settled.version, host.documents.get("notes/new")!.version);
  });
}

test("performUncertainWrite: a resend refused before execution after an unclear submission is unknown; after a definitive one, or first, it settles", async () => {
  const intent: OperationIntent = { requestId: "r", kind: "document.write", target: "t", base: null, local: "sha256:" + "0".repeat(64), content: "", createdAt: new Date().toISOString(), attempts: 0, state: "pending" };
  const refusal = { kind: "refused" as const, code: "AUTH_REQUIRED", message: "no credential" };
  let submits = 0;
  const resend: OperationTransport = {
    async submit() {
      submits += 1;
      if (submits === 1) throw new Error("lost");
      return refusal;
    },
    async lookup() {
      return null;
    },
  };
  const second = await performUncertainWrite(resend, intent, { lookupDelayMs: 0 });
  assert.equal(second.outcome.kind, "unknown");
  assert.equal(second.intent.state, "unknown");
  assert.equal(second.intent.attempts, 2);
  const first = await performUncertainWrite({ submit: async () => refusal, lookup: async () => null }, intent, { lookupDelayMs: 0 });
  assert.deepEqual(first.outcome, refusal);
  // An earlier call's unclear submission, resent and refused, is unknown too.
  const resumed = await performUncertainWrite({ submit: async () => refusal, lookup: async () => null }, { ...intent, attempts: 1 }, { lookupDelayMs: 0, earlierDeliveryUnclear: true });
  assert.equal(resumed.outcome.kind, "unknown");
  // A requeued intent whose earlier submission was refused definitively is refused again, as before.
  const requeued = await performUncertainWrite({ submit: async () => refusal, lookup: async () => null }, { ...intent, attempts: 1 }, { lookupDelayMs: 0 });
  assert.deepEqual(requeued.outcome, refusal);
});

test("abort: an already-aborted write sends nothing, not even capabilities, and throws the abort reason", async () => {
  const host = fakeHost();
  const store = createMemoryIntentStore();
  const controller = new AbortController();
  const reason = new Error("caller gave up");
  controller.abort(reason);
  await assert.rejects(
    clientOf(host.fetch, { intentStore: store }).write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true }, { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(host.sent.length, 0);
  assert.deepEqual(await clientOf(host.fetch, { intentStore: store }).heldWrites(), []);
});

test("abort: an already-aborted settleWrite of a never-sent intent sends nothing, throws the abort reason and keeps the record", async () => {
  const host = fakeHost();
  const store = createMemoryIntentStore();
  const intent: HostedWriteIntent = {
    requestId: "0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c22",
    binding: checkoutBindingDigest("persisted-checkout"),
    bundleId: BUNDLE,
    workspace: null,
    operation: "create",
    documentId: "notes/new",
    document: doc("new"),
    digest: sha256(doc("new")),
    expectedVersion: null,
    okfVersion: "0.2",
    createdAt: new Date().toISOString(),
    attempts: 0,
    state: "pending",
  };
  await store.put(intent);
  const controller = new AbortController();
  const reason = new Error("caller gave up");
  controller.abort(reason);
  await assert.rejects(clientOf(host.fetch, { intentStore: store }).settleWrite(intent.requestId, { signal: controller.signal }), (error) => error === reason);
  assert.equal(host.sent.length, 0);
  assert.deepEqual(await store.get(intent.requestId), intent);
});

test("abort: a refusal caused by an abort during delivery never settles or deletes the record", async () => {
  const host = fakeHost();
  const store = createMemoryIntentStore();
  const controller = new AbortController();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // The capabilities answer arrives, then the caller aborts before the write leaves.
    const answer = await host.fetch(input, init);
    if (new URL(String(input)).pathname.endsWith("/capabilities")) controller.abort(new Error("caller gave up"));
    return answer;
  }) as typeof globalThis.fetch;
  const result = await clientOf(fetch, { intentStore: store }).write(BUNDLE, { id: "notes/new", document: doc("new"), expectAbsent: true }, { signal: controller.signal });
  assert.equal(result.status, "unknown");
  assert.equal(writes(host.sent).length, 0);
  assert.equal((await store.get(result.requestId))?.state, "unknown");
});

test("settleWrite on a bundle the host serves no writes for only looks the identity up, and sends nothing", async () => {
  const host = fakeHost({ operations: false });
  const store = createMemoryIntentStore();
  const intent: HostedWriteIntent = {
    requestId: "0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c23",
    binding: checkoutBindingDigest("persisted-checkout"),
    bundleId: BUNDLE,
    workspace: null,
    operation: "create",
    documentId: "notes/new",
    document: doc("new"),
    digest: sha256(doc("new")),
    expectedVersion: null,
    okfVersion: "0.2",
    createdAt: new Date().toISOString(),
    attempts: 0,
    state: "pending",
  };
  await store.put(intent);
  const result = await clientOf(host.fetch, { intentStore: store }).settleWrite(intent.requestId);
  assert.equal(result.status, "unknown");
  assert.equal(writes(host.sent).length, 0);
  assert.equal(lookups(host.sent).length, 1);
  assert.ok(await store.get(intent.requestId));
});

// ── the capabilities cache ─────────────────────────────────────────────────────────────────

const capabilityReads = (sent: readonly Sent[]) => sent.filter((row) => row.route.endsWith("/capabilities"));

/** A clock the test moves by hand. */
function manualClock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => void (time += ms) };
}

/** The fake host with the next answers of a route replaced, in order; a replaced request is recorded as the host records one. */
function overriding(host: ReturnType<typeof fakeHost>, answers: Record<string, (() => Response | Promise<Response>)[]>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const next = answers[route.slice(route.lastIndexOf("/") + 1)]?.shift();
    if (!next) return host.fetch(input, init);
    const headers = new Headers(init?.headers);
    host.sent.push({ route, body: String(init?.body ?? ""), requestId: headers.get("x-superbee-write-request"), binding: headers.get("x-superbee-checkout"), authorization: headers.get("authorization") });
    return next();
  }) as typeof globalThis.fetch;
}

const capabilitiesWith = (changes: Record<string, unknown>) => () => Response.json({ ...(JSON.parse(fixture("capabilities-200").response.body) as Record<string, unknown>), ...changes });
const createRefused = (code: string) => () =>
  Response.json({ ok: false, operationId: "documents.create.v1", error: { code, message: `The host refused this write (${code}).`, retryable: false, writeState: "not_applied" } });

async function created(client: ReturnType<typeof clientOf>, bundleId: string, id: string): Promise<void> {
  const result = await client.write(bundleId, { id, document: doc(id), expectAbsent: true });
  assert.equal(result.status, "committed", `${bundleId} ${id}: ${JSON.stringify(result)}`);
}

test("capabilities cache: sequential writes to one bundle read its capabilities once, until the TTL passes", async () => {
  const host = fakeHost();
  const clock = manualClock();
  const client = clientOf(host.fetch, { now: clock.now });
  for (let n = 0; n < 5; n += 1) await created(client, BUNDLE, `notes/n${n}`);
  assert.equal(capabilityReads(host.sent).length, 1);
  assert.deepEqual(routes(host.sent), ["capabilities", "create", "create", "create", "create", "create"]);

  clock.advance(59_999);
  await created(client, BUNDLE, "notes/before-ttl");
  assert.equal(capabilityReads(host.sent).length, 1, "the answer serves for 60 s by default");
  clock.advance(1);
  await created(client, BUNDLE, "notes/at-ttl");
  assert.equal(capabilityReads(host.sent).length, 2, "an answer 60 s old is read again");
  await created(client, BUNDLE, "notes/after-ttl");
  assert.equal(capabilityReads(host.sent).length, 2, "and the new answer serves the writes after it");
});

test("capabilities cache: capabilitiesTtlMs sets the TTL, and 0 reads capabilities before every write", async () => {
  const host = fakeHost();
  const clock = manualClock();
  const short = clientOf(host.fetch, { now: clock.now, capabilitiesTtlMs: 1_000 });
  await created(short, BUNDLE, "notes/s1");
  clock.advance(999);
  await created(short, BUNDLE, "notes/s2");
  clock.advance(1);
  await created(short, BUNDLE, "notes/s3");
  assert.equal(capabilityReads(host.sent).length, 2);

  const none = fakeHost();
  const uncached = clientOf(none.fetch, { now: clock.now, capabilitiesTtlMs: 0 });
  for (let n = 0; n < 3; n += 1) await created(uncached, BUNDLE, `notes/u${n}`);
  assert.deepEqual(routes(none.sent), ["capabilities", "create", "capabilities", "create", "capabilities", "create"]);

  for (const ttl of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => clientOf(none.fetch, { capabilitiesTtlMs: ttl }), TypeError);
});

/** Each case: what makes the first write's result, and the result it is. The next write must read capabilities again. */
const DROP_CASES: { name: string; arrange(host: ReturnType<typeof fakeHost>): typeof globalThis.fetch; document?: string; expect: { status: string; code?: string } | "throws" }[] = [
  { name: "a read_only refusal", arrange: (host) => overriding(host, { capabilities: [capabilitiesWith({ operations: false })] }), expect: { status: "refused", code: "read_only" } },
  { name: "the client's invalid_input (a document that does not parse to a typed document)", arrange: (host) => host.fetch, document: "---\nnote: untyped\n---\nbody", expect: { status: "refused", code: "invalid_input" } },
  { name: "the host's invalid_input", arrange: (host) => overriding(host, { create: [createRefused("invalid_input")] }), expect: { status: "refused", code: "invalid_input" } },
  { name: "bundle_not_found (reported as PERMISSION_DENIED)", arrange: (host) => overriding(host, { create: [createRefused("bundle_not_found")] }), expect: { status: "refused", code: "PERMISSION_DENIED" } },
  { name: "an edition refusal (validation_failed)", arrange: (host) => overriding(host, { create: [createRefused("validation_failed")] }), expect: { status: "refused", code: "validation_failed" } },
  {
    name: "an unknown outcome",
    arrange: (host) => {
      host.fault("create", "lost-answer");
      host.fault("outcome", "lost-request", "lost-request", "lost-request");
      return host.fetch;
    },
    expect: { status: "unknown" },
  },
  { name: "a failed capabilities read", arrange: (host) => overriding(host, { capabilities: [() => new Response(null, { status: 503 })] }), expect: "throws" },
];

for (const drop of DROP_CASES) {
  test(`capabilities cache: ${drop.name} drops the held answer, so the next write reads it again`, async () => {
    const host = fakeHost();
    const client = clientOf(drop.arrange(host), { now: manualClock().now });
    const first = client.write(BUNDLE, { id: "notes/first", document: drop.document ?? doc("first"), expectAbsent: true });
    if (drop.expect === "throws") await assert.rejects(first, { name: "HostedCarrierError" });
    else {
      const result = await first;
      assert.equal(result.status, drop.expect.status);
      if (drop.expect.code !== undefined) assert.equal(result.status === "refused" && result.code, drop.expect.code);
    }
    assert.equal(capabilityReads(host.sent).length, 1);
    await created(client, BUNDLE, "notes/second");
    assert.equal(capabilityReads(host.sent).length, 2, "the next write read capabilities again");
    await created(client, BUNDLE, "notes/third");
    assert.equal(capabilityReads(host.sent).length, 2, "and holds the new answer");
  });
}

test("capabilities cache: a conflict and a committed write keep the held answer", async () => {
  const host = fakeHost();
  const client = clientOf(host.fetch, { now: manualClock().now });
  await created(client, BUNDLE, "notes/one");
  const conflict = await client.write(BUNDLE, { id: "notes/one", document: doc("again"), expectAbsent: true });
  assert.equal(conflict.status, "conflict");
  await created(client, BUNDLE, "notes/two");
  assert.equal(capabilityReads(host.sent).length, 1);
});

test("capabilities cache: each bundle and each workspace holds its own answer; within clients of one workspace share it", async () => {
  const host = fakeHost();
  const client = clientOf(host.fetch, { now: manualClock().now });
  await created(client, BUNDLE, "notes/a");
  await created(client, "notes.b", "notes/b");
  await created(client.within("south"), BUNDLE, "notes/c");
  await created(client.within("south"), BUNDLE, "notes/d");
  await created(client.within("north"), BUNDLE, "notes/e");
  await created(client, BUNDLE, "notes/f");
  await created(client, "notes.b", "notes/g");
  await created(client.within("north"), BUNDLE, "notes/h");
  assert.deepEqual(
    capabilityReads(host.sent).map((row) => JSON.parse(row.body).bundleId),
    [BUNDLE, "notes.b", `south/${BUNDLE}`, `north/${BUNDLE}`],
  );
  // Each write went to the bundle its own answer was read for.
  assert.deepEqual(
    writes(host.sent).map((row) => JSON.parse(row.body).bundleId),
    [BUNDLE, "notes.b", `south/${BUNDLE}`, `south/${BUNDLE}`, `north/${BUNDLE}`, BUNDLE, "notes.b", `north/${BUNDLE}`],
  );
});

test("capabilities cache: concurrent writes to one bundle share one capabilities read in flight", async () => {
  const host = fakeHost();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let reads = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/capabilities")) {
      reads += 1;
      await gate;
    }
    return host.fetch(input, init);
  }) as typeof globalThis.fetch;
  const client = clientOf(fetch, { now: manualClock().now });
  const pending = Array.from({ length: 5 }, (_, n) => client.write(BUNDLE, { id: `notes/c${n}`, document: doc(`c${n}`), expectAbsent: true }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, "one read is in flight for all five writes");
  open();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((result) => result.status), Array(5).fill("committed"));
  assert.equal(reads, 1);
  assert.equal(writes(host.sent).length, 5);
});

/** A held create three hours old, sent once: inside the thirty-day default, past a two-hour window. */
const threeHoursOld = (): HostedWriteIntent => ({
  requestId: "0b5c8a2e-1f3d-4c6b-9a7e-2d4f6b8a0c1f",
  binding: checkoutBindingDigest("persisted-checkout"),
  bundleId: BUNDLE,
  workspace: null,
  operation: "create",
  documentId: "notes/old",
  document: doc("old"),
  digest: sha256(doc("old")),
  expectedVersion: null,
  okfVersion: "0.2",
  createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  attempts: 1,
  state: "unknown",
});

/**
 * A host now serving a two-hour window, behind a client whose held answer (read before the host
 * shortened it) still says thirty days. Absence past the window the host serves now is no evidence.
 */
async function shortenedWindow() {
  const host = fakeHost({ retentionMs: 2 * 60 * 60 * 1000 });
  const store = createMemoryIntentStore();
  const fetch = overriding(host, { capabilities: [capabilitiesWith({ operationsRetentionMs: 30 * 24 * 60 * 60 * 1000 })] });
  const client = clientOf(fetch, { intentStore: store, now: manualClock().now });
  await created(client, BUNDLE, "notes/fresh");
  await store.put(threeHoursOld());
  return { host, client };
}

test("capabilities cache: settleWrite decides a resend by the window the host serves now, never a held answer's", async () => {
  const { host, client } = await shortenedWindow();
  const settled = await client.settleWrite(threeHoursOld().requestId);
  assert.equal(settled.status, "unknown");
  assert.equal(writes(host.sent).length, 1, "an identity past the window served now is never resent");
  assert.equal(capabilityReads(host.sent).length, 2, "the window was read again for the decision");
});

test("capabilities cache: write recovery decides a resend by the window the host serves now, never a held answer's", async () => {
  const { host, client } = await shortenedWindow();
  const old = threeHoursOld();
  const confirmed = await client.write(BUNDLE, { id: old.documentId, document: old.document, expectAbsent: true }, { requestId: old.requestId });
  assert.equal(confirmed.status, "unknown");
  assert.equal(writes(host.sent).length, 1, "an identity past the window served now is never resent");
  assert.equal(capabilityReads(host.sent).length, 2, "the window was read again for the decision");
});

test("capabilities cache: within the window served now, absence still resends the held identity once", async () => {
  const host = fakeHost();
  const store = createMemoryIntentStore();
  const client = clientOf(host.fetch, { intentStore: store, now: manualClock().now });
  await created(client, BUNDLE, "notes/fresh");
  await store.put(threeHoursOld());
  const settled = await client.settleWrite(threeHoursOld().requestId);
  assert.equal(settled.status, "committed");
  assert.equal(writes(host.sent).length, 2);
  // The fresh read refreshed the held answer: the next write reads nothing more.
  await created(client, BUNDLE, "notes/after");
  assert.equal(capabilityReads(host.sent).length, 2);
});

test("capabilities cache: an expired entry is removed when another bundle's answer is read, and replaced when its own is", async () => {
  const host = fakeHost();
  const clock = manualClock();
  const cache = createCapabilitiesCache(1_000, clock.now);
  const carrier = createFetchCarrier({ baseUrl: ORIGIN, credentials: bearerCredentials(() => "token-1"), fetch: host.fetch });
  const context: HostedWriteContext = {
    binding: checkoutBindingDigest("cache-eviction"),
    store: createMemoryIntentStore(),
    inFlight: new Map(),
    prefix: "/sync/v1",
    workspace: null,
    signal: new AbortController().signal,
    lookupDelayMs: 0,
    capabilities: cache,
    carrierFor: () => carrier,
    readRoutes: { capabilities: "/sync/v1/capabilities", heads: "/sync/v1/heads", snapshot: "/sync/v1/snapshot", read: "/sync/v1/read" },
  };
  const write = async (bundleId: string, id: string) => assert.equal((await hostedWrite(context, bundleId, { id, document: doc(id), expectAbsent: true })).status, "committed");
  const keys = () => [...cache.entries.keys()];
  await write(BUNDLE, "notes/a1");
  await write("notes.b", "notes/b1");
  assert.deepEqual(keys(), [JSON.stringify([null, BUNDLE]), JSON.stringify([null, "notes.b"])]);
  clock.advance(1_000);
  await write("notes.c", "notes/c1");
  assert.deepEqual(keys(), [JSON.stringify([null, "notes.c"])], "both expired entries left when notes.c was read");
  clock.advance(1_000);
  await write("notes.c", "notes/c2");
  assert.deepEqual(keys(), [JSON.stringify([null, "notes.c"])], "an expired entry is replaced by its own re-read");
  assert.equal(cache.entries.get(JSON.stringify([null, "notes.c"]))!.answeredAt, clock.now());
});
