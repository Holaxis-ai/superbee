/**
 * `createHostedInbox` (`@superbee/core/hosted-client`) against the attention routes' wire as the
 * hosted gateway serves it (`POST <prefix>/attention/<operationId>`, `Superbee-Workspace`, the
 * catalog's `{ ok, operationId, data | error }`): each method's route and body, the typed refusals
 * in this client's own words, the workspace header's uniform refusal, a gateway from before the
 * routes, and one ticket per send that every retry reuses.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  bearerCredentials,
  createHostedClient,
  createHostedInbox,
  HostedAttentionOutcomeUnknown,
  HostedAttentionRefusal,
  HostedCarrierError,
  HostedRouteNotServed,
  isAttentionTicket,
  isMalformedAnswer,
  matchDirectoryMember,
  mintAttentionTicket,
  readDirectory,
  RemoteError,
  type DirectoryMember,
  type InboxEntry,
} from "../src/hosted-client/index.js";

const ORIGIN = "https://hosted.example";
const TENANT = "tenant:a";

interface Sent {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

function host(answer: (path: string, body: Record<string, unknown>, attempt: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.search, "", "no input travels in a URL");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path: url.pathname, body, headers: new Headers(init?.headers) });
    return answer(url.pathname, body, sent.length);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

function inboxOf(fetch: typeof globalThis.fetch, options: { via?: string; sendAttempts?: number; syncPrefix?: string } = {}) {
  const client = createHostedClient({ target: { origin: ORIGIN, syncPrefix: options.syncPrefix ?? "/sync/v1" }, credentials: bearerCredentials(() => "token-1"), fetch });
  return createHostedInbox(client, { tenantId: TENANT, retryDelayMs: 0, ...(options.via ? { via: options.via } : {}), ...(options.sendAttempts ? { sendAttempts: options.sendAttempts } : {}) });
}

const ok = (operationId: string, data: unknown) => Response.json({ ok: true, operationId, data });
const refusal = (operationId: string, code: string, status: number, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: false, operationId, error: { code, message: "HOST WORDS THAT MUST NOT TRAVEL", retryable: false, hint: "HOST HINT", ...extra } }, { status });

const THREAD = "01890a5d-ac96-774b-bcce-b302099a8057";

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    itemId: "item-1",
    seq: 7,
    threadId: THREAD,
    revision: 1,
    kind: "needs_input",
    state: "unread",
    recipient: { kind: "principal", principalId: "person:me" },
    producer: { tenantId: TENANT, principalId: "person:me", surface: "sync", credentialId: "credential:cli", via: "claude-code" },
    producerDisplay: { personName: "Me", firstPartyName: "Superbee command line" },
    target: null,
    note: "look at this",
    meta: { "dev.superbee.cli": { run: "wt" } },
    alert: "default",
    withdrawReason: null,
    createdAt: 1_900_000_000_000,
    expiresAt: 1_902_000_000_000,
    readAt: null,
    readBy: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...overrides,
  };
}

test("each method posts its operation's input to <prefix>/attention/<operationId>, naming the workspace in the header", async () => {
  const { fetch, sent } = host((path) => {
    const id = path.slice("/sync/v1/attention/".length);
    switch (id) {
      case "inbox.list.v1":
        return ok(id, { entries: [entry()], nextAfterSeq: 7 });
      case "inbox.threads.v1":
        return ok(id, {
          threads: [
            {
              threadId: THREAD,
              startedByYou: true,
              self: true,
              system: false,
              counterpart: { tenantId: TENANT, principalId: "person:me", personName: "Me" },
              initiator: { tenantId: TENANT, principalId: "person:me", surface: "sync" },
              createdAt: 1,
              lastItemAt: 2,
              last: { itemId: "item-1", seq: 7, kind: "needs_input", state: "unread", createdAt: 2, sentByYou: true },
              openToYou: 1,
              unreadToYou: 1,
              openFromYou: 1,
            },
          ],
          nextBefore: null,
        });
      case "inbox.summary.v1":
        return ok(id, { waitingThreads: { count: 1, capped: false }, unreadUpdates: { count: 0, capped: false }, newestSeq: 7 });
      case "inbox.get.v1":
        return ok(id, { entry: entry() });
      case "inbox.open.v1":
        return ok(id, { entry: entry({ state: "read", revision: 2, readAt: 3 }) });
      case "inbox.ack.v1":
        return ok(id, { entry: entry({ state: "acknowledged", revision: 3, acknowledgedAt: 4 }) });
      case "attention.cancel.v1":
        return ok(id, { itemId: "item-1", state: "withdrawn", revision: 2 });
      default:
        return assert.fail(`unexpected ${path}`);
    }
  });
  const inbox = inboxOf(fetch);
  assert.equal(inbox.tenantId, TENANT);
  assert.deepEqual(await inbox.list({ threadId: THREAD, afterSeq: 3, exclude: { principalId: ["self"], kind: ["reply"] } }), { entries: [entry()], nextAfterSeq: 7 });
  assert.equal((await inbox.threads({ scope: "self" })).threads[0]!.openToYou, 1);
  assert.deepEqual(await inbox.summary(), { waitingThreads: { count: 1, capped: false }, unreadUpdates: { count: 0, capped: false }, newestSeq: 7 });
  assert.equal((await inbox.get("item-1")).state, "unread");
  assert.equal((await inbox.open("item-1")).state, "read");
  assert.equal((await inbox.ack("item-1", { expectedRevision: 2 })).state, "acknowledged");
  assert.deepEqual(await inbox.cancel("item-1"), { itemId: "item-1", state: "withdrawn", revision: 2 });
  assert.deepEqual(
    sent.map(({ path, body }) => [path, body]),
    [
      ["/sync/v1/attention/inbox.list.v1", { threadId: THREAD, afterSeq: 3, exclude: { principalId: ["self"], kind: ["reply"] } }],
      ["/sync/v1/attention/inbox.threads.v1", { scope: "self" }],
      ["/sync/v1/attention/inbox.summary.v1", {}],
      ["/sync/v1/attention/inbox.get.v1", { itemId: "item-1" }],
      ["/sync/v1/attention/inbox.open.v1", { itemId: "item-1" }],
      ["/sync/v1/attention/inbox.ack.v1", { itemId: "item-1", expectedRevision: 2 }],
      ["/sync/v1/attention/attention.cancel.v1", { itemId: "item-1" }],
    ],
  );
  for (const request of sent) {
    assert.equal(request.headers.get("superbee-workspace"), TENANT);
    assert.equal(request.headers.get("authorization"), "Bearer token-1");
    assert.equal(request.headers.get("x-superbee-via"), null, "only a send carries via");
  }
});

test("an agent connection's inbox is under its own sync prefix", async () => {
  const prefix = "/agents/0b2f6c3e-1d4a-4b5c-9e8f-7a6b5c4d3e2f/sync/v1";
  const { fetch, sent } = host((_path) => ok("inbox.summary.v1", { waitingThreads: { count: 0, capped: false }, unreadUpdates: { count: 0, capped: false }, newestSeq: 0 }));
  await inboxOf(fetch, { syncPrefix: prefix }).summary();
  assert.equal(sent[0]!.path, `${prefix}/attention/inbox.summary.v1`);
});

test("a send mints one UUIDv7 ticket, carries via, and returns the receipt with its ticket", async () => {
  const { fetch, sent } = host(() => ok("attention.request.v1", { itemId: "item-9", threadId: THREAD, itemRevision: 1, replayed: false, delivery: { inApp: "visible", email: "off" } }));
  const before = Date.now();
  const receipt = await inboxOf(fetch, { via: "claude-code" }).request({ recipient: { kind: "principal", principalId: "person:me" }, kind: "needs_input", note: "ready for review", alert: "none" });
  assert.ok(isAttentionTicket(receipt.ticket));
  const ticketTime = Number.parseInt(receipt.ticket.slice(0, 8) + receipt.ticket.slice(9, 13), 16);
  assert.ok(ticketTime >= before && ticketTime <= Date.now(), "the ticket carries the send's time");
  assert.deepEqual(receipt, { itemId: "item-9", threadId: THREAD, itemRevision: 1, replayed: false, delivery: { inApp: "visible", email: "off" }, ticket: receipt.ticket });
  assert.deepEqual(sent[0]!.body, { recipient: { kind: "principal", principalId: "person:me" }, kind: "needs_input", note: "ready for review", alert: "none", ticket: receipt.ticket });
  assert.equal(sent[0]!.headers.get("x-superbee-via"), "claude-code");
  assert.equal(sent[0]!.headers.get("superbee-workspace"), TENANT);
});

test("an unclear send is retried with the same ticket and body, and the host's replay answers it", async () => {
  const { fetch, sent } = host((_path, _body, attempt) => {
    if (attempt === 1) throw new TypeError("socket hang up");
    if (attempt === 2) return refusal("attention.request.v1", "backend_unavailable", 503, { retryable: true });
    return ok("attention.request.v1", { itemId: "item-9", threadId: THREAD, itemRevision: 1, replayed: true, delivery: { inApp: "visible", email: "pending" } });
  });
  const receipt = await inboxOf(fetch).request({ recipient: { kind: "principal", principalId: "person:me" }, kind: "needs_input" });
  assert.equal(sent.length, 3);
  assert.equal(receipt.replayed, true);
  assert.ok(sent.every((request) => request.body.ticket === receipt.ticket));
  assert.deepEqual(sent[0]!.body, sent[2]!.body);
});

test("a send that stays unclear throws its ticket, and sending again with it sends that same ticket", async () => {
  let down = true;
  const { fetch, sent } = host(() => {
    if (down) throw new TypeError("offline");
    return ok("attention.request.v1", { itemId: "item-9", threadId: THREAD, itemRevision: 1, replayed: true, delivery: { inApp: "visible", email: "off" } });
  });
  const inbox = inboxOf(fetch, { sendAttempts: 2 });
  const input = { recipient: { kind: "principal" as const, principalId: "person:me" }, kind: "needs_input" as const };
  const error = await inbox.request(input).then(
    () => assert.fail("expected an unknown outcome"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof HostedAttentionOutcomeUnknown);
  assert.equal(error.code, "attention_outcome_unknown");
  assert.equal(sent.length, 2);
  assert.ok(sent.every((request) => request.body.ticket === error.ticket));
  down = false;
  const receipt = await inbox.request({ ...input, ticket: error.ticket });
  assert.equal(receipt.ticket, error.ticket);
  assert.equal(sent.at(-1)!.body.ticket, error.ticket);
});

test("after an unclear attempt, a later outright refusal still reports the outcome as unknown with the ticket", async () => {
  for (const later of [
    () => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }),
    () => Response.json({ ok: false, code: "workspace_not_available", retryable: false }, { status: 403 }),
    () => refusal("attention.request.v1", "quota_exceeded", 429),
  ]) {
    const { fetch, sent } = host((_path, _body, attempt) => {
      if (attempt === 1) throw new TypeError("socket hang up");
      return later();
    });
    const error = await inboxOf(fetch).request({ recipient: { kind: "principal", principalId: "p:x" }, kind: "needs_input" }).catch((caught: unknown) => caught);
    assert.ok(error instanceof HostedAttentionOutcomeUnknown, String(error));
    assert.equal(sent.length, 2, "the refusal ends the retries");
    assert.equal(error.ticket, sent[0]!.body.ticket);
    assert.ok(error.cause instanceof RemoteError, "the refusal that ended it is the cause");
  }
});

test("a send the host refused outright is never retried", async () => {
  for (const [code, status] of [
    ["invalid_input", 400],
    ["request_conflict", 409],
    ["quota_exceeded", 429],
    ["attention_disabled", 403],
    ["target_unavailable", 409],
  ] as const) {
    const { fetch, sent } = host(() => refusal("attention.request.v1", code, status));
    const error = await inboxOf(fetch).request({ recipient: { kind: "principal", principalId: "person:x" }, kind: "needs_input" }).then(
      () => assert.fail("expected a refusal"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof HostedAttentionRefusal, code);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(sent.length, 1, `${code} is final`);
  }
});

test("refusals carry the catalog's code in this client's own words, never the host's message or hint", async () => {
  const cases: Array<[string, number, Record<string, unknown>]> = [
    ["not_found", 404, {}],
    ["version_conflict", 409, {}],
    ["target_unsupported", 409, {}],
    ["ticket_expired", 400, { serverTime: 1_900_000_000_123 }],
    ["insufficient_scope", 403, {}],
  ];
  for (const [code, status, extra] of cases) {
    const { fetch } = host(() => refusal("inbox.ack.v1", code, status, extra));
    const error = await inboxOf(fetch).ack("item-1", { expectedRevision: 1 }).then(
      () => assert.fail("expected a refusal"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof HostedAttentionRefusal);
    assert.ok(error instanceof RemoteError, "a refusal is a RemoteError, as the client's other refusals are");
    assert.equal(error.code, code);
    assert.equal(error.operationId, "inbox.ack.v1");
    assert.doesNotMatch(error.message, /HOST/);
    assert.equal(error.serverTime, code === "ticket_expired" ? 1_900_000_000_123 : undefined);
  }
});

test("the workspace header's refusal, an unauthenticated answer and a gateway from before the routes", async () => {
  const workspace = host(() => Response.json({ ok: false, code: "workspace_not_available", retryable: false }, { status: 403 }));
  const refused = await inboxOf(workspace.fetch).summary().catch((caught: unknown) => caught);
  assert.ok(refused instanceof HostedAttentionRefusal);
  assert.equal(refused.code, "workspace_not_available");

  const unauthenticated = host(() => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }));
  const denied = await inboxOf(unauthenticated.fetch).summary().catch((caught: unknown) => caught);
  assert.ok(denied instanceof RemoteError && !(denied instanceof HostedAttentionRefusal));
  assert.equal(denied.code, "unauthenticated");
  assert.equal(denied.status, 401);

  const old = host(() => Response.json({ error: "not_found" }, { status: 404 }));
  const missing = await inboxOf(old.fetch).list().catch((caught: unknown) => caught);
  assert.ok(missing instanceof HostedRouteNotServed);
  assert.equal(missing.route, "/sync/v1/attention/inbox.list.v1");
});

test("an answer the contract does not admit is malformed, naming the route", async () => {
  const cases: Array<[string, () => Response]> = [
    ["another operation's answer", () => ok("inbox.get.v1", { entries: [], nextAfterSeq: null })],
    ["an entry without a state", () => ok("inbox.list.v1", { entries: [{ ...entry(), state: "lost" }], nextAfterSeq: null })],
    ["no page", () => ok("inbox.list.v1", { entries: "none" })],
    ["a 400 with no catalog code", () => Response.json({ nope: true }, { status: 400 })],
  ];
  for (const [label, answer] of cases) {
    const { fetch } = host(answer);
    const error = await inboxOf(fetch).list().catch((caught: unknown) => caught);
    assert.ok(isMalformedAnswer(error), label);
    assert.equal(error.route, "/sync/v1/attention/inbox.list.v1", label);
  }
});

test("a malformed receipt is not retried: the host answered", async () => {
  const { fetch, sent } = host(() => ok("attention.request.v1", { itemId: "item-9" }));
  const error = await inboxOf(fetch).request({ recipient: { kind: "principal", principalId: "p:x" }, kind: "needs_input" }).catch((caught: unknown) => caught);
  assert.ok(isMalformedAnswer(error));
  assert.equal(sent.length, 1);
});

test("no credential means nothing was sent and nothing is retried", async () => {
  const { fetch, sent } = host(() => assert.fail("nothing is sent"));
  const client = createHostedClient({
    target: { origin: ORIGIN, syncPrefix: "/sync/v1" },
    credentials: async () => {
      throw new Error("signed out");
    },
    fetch,
  });
  const error = await createHostedInbox(client, { tenantId: TENANT, retryDelayMs: 0 })
    .request({ recipient: { kind: "principal", principalId: "p:x" }, kind: "needs_input" })
    .catch((caught: unknown) => caught);
  assert.ok(error instanceof HostedCarrierError);
  assert.equal(error.code, "denied");
  assert.equal(sent.length, 0);
});

test("the workspace, via and ticket are checked before anything is sent", async () => {
  const { fetch, sent } = host(() => assert.fail("nothing is sent"));
  const client = createHostedClient({ target: { origin: ORIGIN, syncPrefix: "/sync/v1" }, credentials: bearerCredentials(() => "t"), fetch });
  assert.throws(() => createHostedInbox(client, { tenantId: "holaxis" }), TypeError);
  assert.throws(() => createHostedInbox(client, { tenantId: TENANT, via: "superbee-cli" }), TypeError);
  await assert.rejects(createHostedInbox(client, { tenantId: TENANT }).request({ ticket: "not-a-ticket", kind: "needs_input" }), TypeError);
  // The carrier itself refuses a workspace header that is not a tenant id.
  await assert.rejects(client.carrier.json("/sync/v1/attention/inbox.summary.v1", {}, client.signal, { maximum: 1024, workspace: "tenant:a\r\nx: y" }), (error: unknown) => error instanceof HostedCarrierError && error.code === "denied");
  assert.equal(sent.length, 0);
});

test("mintAttentionTicket is a UUIDv7 carrying its millisecond time", () => {
  const at = Date.UTC(2026, 9, 17, 12, 0, 0, 123);
  const ticket = mintAttentionTicket(at);
  assert.ok(isAttentionTicket(ticket));
  assert.equal(Number.parseInt(ticket.slice(0, 8) + ticket.slice(9, 13), 16), at);
  assert.notEqual(mintAttentionTicket(at), ticket, "random bits differ");
  assert.equal(isAttentionTicket("01890a5d-ac96-674b-bcce-b302099a8057"), false, "a v6 is not a ticket");
});

// ── the notification directory ────────────────────────────────────────────────────────────────

const member = (principalId: string, displayName: string | null, extra: Partial<DirectoryMember> = {}): DirectoryMember => ({ principalId, displayName, self: false, ...extra });

test("directory posts members.directory.v1 in the workspace and decodes a page; email is optional", async () => {
  const { fetch, sent } = host((path) =>
    ok("members.directory.v1", {
      members: [
        { principalId: "person:ana", displayName: "Ana Lopez", self: false },
        { principalId: "person:me", displayName: null, email: null, self: true },
        { principalId: "person:sam", displayName: "Sam", email: "sam@example.com", self: false },
      ],
      nextAfter: path.length > 0 ? "person:sam" : null,
    }),
  );
  const page = await inboxOf(fetch).directory({ limit: 3, after: "person:a" });
  assert.deepEqual(page, {
    members: [
      { principalId: "person:ana", displayName: "Ana Lopez", self: false },
      { principalId: "person:me", displayName: null, email: null, self: true },
      { principalId: "person:sam", displayName: "Sam", email: "sam@example.com", self: false },
    ],
    nextAfter: "person:sam",
  });
  assert.equal(Object.hasOwn(page.members[0]!, "email"), false, "an absent email stays absent");
  assert.equal(sent[0]!.path, "/sync/v1/attention/members.directory.v1");
  assert.deepEqual(sent[0]!.body, { limit: 3, after: "person:a" });
  assert.equal(sent[0]!.headers.get("superbee-workspace"), TENANT);
  for (const bad of [
    { members: [{ principalId: "", displayName: "x", self: false }], nextAfter: null },
    { members: [{ principalId: "p:x\u001b", displayName: "x", self: false }], nextAfter: null },
    { members: [{ principalId: "p:x", displayName: 7, self: false }], nextAfter: null },
    { members: [{ principalId: "p:x", displayName: "x", email: 3, self: false }], nextAfter: null },
    { members: [{ principalId: "p:x", displayName: "x" }], nextAfter: null },
    { members: [], nextAfter: "" },
    { members: "all" },
  ]) {
    const malformed = host(() => ok("members.directory.v1", bad));
    assert.ok(isMalformedAnswer(await inboxOf(malformed.fetch).directory().catch((caught: unknown) => caught)), JSON.stringify(bad));
  }
  const refused = host(() => refusal("members.directory.v1", "attention_disabled", 403));
  const error = await inboxOf(refused.fetch).directory().catch((caught: unknown) => caught);
  assert.ok(error instanceof HostedAttentionRefusal);
  assert.equal(error.operationId, "members.directory.v1");
});

test("readDirectory follows nextAfter to the last page, and says when it stopped early", async () => {
  const pages: Record<string, unknown> = {
    "": { members: [member("p:a", "A")], nextAfter: "p:a" },
    "p:a": { members: [member("p:a", "A"), member("p:b", "B")], nextAfter: "p:b" },
    "p:b": { members: [member("p:c", "C")], nextAfter: null },
  };
  const { fetch, sent } = host((_path, body) => ok("members.directory.v1", pages[String(body.after ?? "")]));
  const whole = await readDirectory(inboxOf(fetch));
  assert.deepEqual(whole.members.map((m) => m.principalId), ["p:a", "p:b", "p:c"], "a repeated member is listed once");
  assert.equal(whole.complete, true);
  assert.deepEqual(sent.map((request) => request.body), [{ limit: 100 }, { limit: 100, after: "p:a" }, { limit: 100, after: "p:b" }]);
  const capped = await readDirectory(inboxOf(fetch), { maxPages: 2 });
  assert.equal(capped.complete, false);
  const stuck = host(() => ok("members.directory.v1", { members: [member("p:a", "A")], nextAfter: "p:a" }));
  const looped = await readDirectory(inboxOf(stuck.fetch));
  assert.equal(looped.complete, false, "a cursor that does not move ends the read");
  assert.equal(stuck.sent.length, 2);
});

test("matchDirectoryMember: principal id, email when shared, exact name in any case; the start of a name only suggests; never a guess", () => {
  const members = [
    member("person:ana", "Ana Lopez", { email: "Ana@Example.com" }),
    member("person:anna", "Anna  Berg", { email: "anna@example.com" }),
    member("person:sam", "Sam"),
    member("person:sam2", "sam "),
    member("person:me", null, { self: true, email: null }),
    member("person:zed", "Zed\u202e"),
  ];
  const by = (query: string) => matchDirectoryMember(members, query);
  assert.deepEqual(by("person:me"), { outcome: "matched", member: members[4], by: "principal_id" });
  assert.deepEqual(by("ana@example.COM"), { outcome: "matched", member: members[0], by: "email" });
  assert.deepEqual(by("nobody@example.com"), { outcome: "none", emails: true });
  assert.deepEqual(by("  ana LOPEZ "), { outcome: "matched", member: members[0], by: "name" });
  assert.deepEqual(by("anna berg"), { outcome: "matched", member: members[1], by: "name" }, "spacing folds");
  assert.deepEqual(by("anna"), { outcome: "prefix", candidates: [members[1]] }, "a unique start is a suggestion, not a match");
  assert.deepEqual(by("an"), { outcome: "prefix", candidates: [members[0], members[1]] });
  assert.deepEqual(by("SAM"), { outcome: "ambiguous", by: "name", candidates: [members[2], members[3]] }, "an exact tie is ambiguous, not the first");
  assert.deepEqual(by("zed"), { outcome: "matched", member: members[5], by: "name" }, "format characters do not count");
  assert.deepEqual(by("bob"), { outcome: "none", emails: true });
  // The host shares no emails: an address cannot match, and says so.
  const noEmails = members.map(({ email: _email, ...rest }) => rest);
  assert.deepEqual(matchDirectoryMember(noEmails, "ana@example.com"), { outcome: "none", emails: false });
});

test("matchDirectoryMember: an id with @ is matched as an id first, and takes part in every tie", () => {
  const members = [member("person:alice@acme.com", "Alice Smith"), member("person:7f00", "Alice Jones")];
  assert.deepEqual(matchDirectoryMember(members, "person:alice@acme.com"), { outcome: "matched", member: members[0], by: "principal_id" });
  assert.deepEqual(matchDirectoryMember(members, "alice"), { outcome: "prefix", candidates: members });
});
