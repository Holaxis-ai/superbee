// `superbee notify` and `superbee inbox` in a hosted checkout, through core's hosted inbox over the
// sync family's attention routes (`POST /sync/v1/attention/<operationId>`, `Superbee-Workspace`),
// against the stateful sync fake plus a small attention fake that answers in the catalog's shape.
// Notifications are hosted-only: a local or Git bundle is refused before any request.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";

import { CliError } from "../src/errors.js";
import { checkout } from "../src/commands/checkout.js";
import { init } from "../src/commands/init.js";
import { inbox } from "../src/commands/inbox.js";
import { notify } from "../src/commands/notify.js";
import { defaultHostedAuthDeps, writeDefaultHost, type HostedAuthDeps } from "../src/hosted-auth/session.js";
import { writeDefaultWorkspace } from "../src/hosted/defaults.js";
import { BUNDLE, FakeHost, HOST, PRINCIPAL, TOKEN, type FakeHostOptions } from "./support/fake-hosted-sync.js";

const TENANT = "tenant:a";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface AttentionCall {
  readonly operationId: string;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

interface Item {
  itemId: string;
  seq: number;
  threadId: string;
  revision: number;
  kind: string;
  state: string;
  recipient: { kind: "principal"; principalId: string };
  note: string | null;
  meta: Record<string, Record<string, unknown>> | null;
  target: unknown;
  createdAt: number;
  readAt: number | null;
  acknowledgedAt: number | null;
}

/** The attention routes as the catalog answers them, for one person in one workspace. */
class AttentionFake {
  readonly calls: AttentionCall[] = [];
  readonly items = new Map<string, Item>();
  /** Answers the next calls with these, in order, before the normal answer. */
  readonly scripted: Array<() => Response> = [];
  private seq = 0;

  /** The notification directory's members, by principal id order, served a page at a time. */
  directory: Array<{ principalId: string; displayName: string | null; email?: string | null; self: boolean }> = [];
  directoryPage = 100;

  /** Producers other than the signed-in person's CLI, by item id. */
  readonly producers = new Map<string, Record<string, unknown>>();

  entry(item: Item) {
    return {
      ...item,
      producer: this.producers.get(item.itemId) ?? { tenantId: TENANT, principalId: PRINCIPAL, surface: "sync", credentialId: "cli", via: "claude-code" },
      producerDisplay: { personName: "Pat", firstPartyName: "Superbee command line" },
      alert: "default",
      withdrawReason: item.state === "withdrawn" ? "sender_cancelled" : null,
      expiresAt: item.createdAt + 86_400_000,
      readBy: null,
      acknowledgedBy: null,
    };
  }

  add(overrides: Partial<Item> = {}): Item {
    this.seq += 1;
    const item: Item = {
      itemId: `item-${this.seq}`,
      seq: this.seq,
      threadId: "01890a5d-ac96-774b-bcce-b302099a8057",
      revision: 1,
      kind: "needs_input",
      state: "unread",
      recipient: { kind: "principal", principalId: PRINCIPAL },
      note: null,
      meta: null,
      target: null,
      createdAt: Date.UTC(2026, 9, 17, 12, 0, this.seq),
      readAt: null,
      acknowledgedAt: null,
      ...overrides,
    };
    this.items.set(item.itemId, item);
    return item;
  }

  handle(operationId: string, body: Record<string, unknown>): Response {
    const ok = (data: unknown) => Response.json({ ok: true, operationId, data });
    const missing = () => Response.json({ ok: false, operationId, error: { code: "not_found", message: "Not available.", retryable: false } }, { status: 404 });
    const item = typeof body.itemId === "string" ? this.items.get(body.itemId) : undefined;
    switch (operationId) {
      case "attention.request.v1": {
        const created = this.add({ kind: String(body.kind), recipient: body.recipient as Item["recipient"], note: (body.note as string | undefined) ?? null, meta: (body.meta as Item["meta"]) ?? null, target: body.target ?? null });
        return ok({ itemId: created.itemId, threadId: created.threadId, itemRevision: 1, replayed: false, delivery: { inApp: "visible", email: "pending" } });
      }
      case "inbox.list.v1": {
        const states = (body.states as string[] | undefined) ?? ["unread", "read"];
        const entries = [...this.items.values()].filter((entry) => states.includes(entry.state)).reverse().slice(0, (body.limit as number | undefined) ?? 100);
        return ok({ entries: entries.map((entry) => this.entry(entry)), nextAfterSeq: entries.length ? Math.max(...entries.map((entry) => entry.seq)) : null });
      }
      case "inbox.summary.v1":
        return ok({ waitingThreads: { count: 1, capped: false }, unreadUpdates: { count: 0, capped: false }, newestSeq: this.seq });
      case "inbox.threads.v1":
        return ok({ threads: [], nextBefore: null });
      case "inbox.get.v1":
        return item ? ok({ entry: this.entry(item) }) : missing();
      case "inbox.open.v1":
        if (!item) return missing();
        if (item.state === "unread") Object.assign(item, { state: "read", revision: item.revision + 1, readAt: Date.now() });
        return ok({ entry: this.entry(item) });
      case "inbox.ack.v1":
        if (!item) return missing();
        if (item.state === "unread" || item.state === "read") {
          if (item.revision !== body.expectedRevision) return Response.json({ ok: false, operationId, error: { code: "version_conflict", message: "x", retryable: false } }, { status: 409 });
          Object.assign(item, { state: "acknowledged", revision: item.revision + 1, acknowledgedAt: Date.now() });
        }
        return ok({ entry: this.entry(item) });
      case "members.directory.v1": {
        const sorted = [...this.directory].sort((a, b) => (a.principalId < b.principalId ? -1 : 1));
        const after = body.after as string | undefined;
        const rest = after === undefined ? sorted : sorted.filter((entry) => entry.principalId > after);
        const limit = Math.min((body.limit as number | undefined) ?? 100, this.directoryPage);
        const page = rest.slice(0, limit);
        return ok({ members: page, nextAfter: rest.length > limit ? page.at(-1)!.principalId : null });
      }
      case "attention.cancel.v1":
        if (!item) return missing();
        if (item.state === "unread" || item.state === "read") Object.assign(item, { state: "withdrawn", revision: item.revision + 1 });
        return ok({ itemId: item.itemId, state: item.state, revision: item.revision });
      default:
        return assert.fail(`unexpected ${operationId}`);
    }
  }
}

interface Harness {
  folder: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  attention: AttentionFake;
  fetch: typeof globalThis.fetch;
  id: string;
}

async function harness(options: FakeHostOptions = {}, env: Record<string, string> = {}): Promise<Harness> {
  const host = new FakeHost({ tenants: [TENANT], ...options });
  const attention = new AttentionFake();
  const home = await mkdtemp(path.join(tmpdir(), "sb-notify-home-"));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "sb-notify-cwd-")));
  const auth = defaultHostedAuthDeps(home, {
    env: { SUPERBEE_ACCESS_TOKEN: TOKEN, ...env },
    fetch: async () => assert.fail("the sign-in module must not be reached"),
  });
  await checkout([BUNDLE, "--host", HOST, "--dir", "team"], { stdout: () => {}, auth, cwd, fetch: host.fetch });
  host.requests.length = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/sync/v1/attention/")) return host.fetch(input, init);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    const operationId = url.pathname.slice("/sync/v1/attention/".length);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    attention.calls.push({ operationId, body, headers });
    const scripted = attention.scripted.shift();
    if (scripted) return scripted();
    return attention.handle(operationId, body);
  }) as typeof globalThis.fetch;
  return { folder: path.join(cwd, "team"), auth, host, attention, fetch, id: [...host.docs.keys()][0]! };
}

async function run(h: Harness, command: typeof notify, argv: string[]): Promise<string> {
  const out: string[] = [];
  await command([...argv, "--dir", h.folder], { stdout: (text) => void out.push(text), hosted: { auth: h.auth, fetch: h.fetch } });
  return out.join("");
}

async function json(h: Harness, command: typeof notify, argv: string[]): Promise<Record<string, unknown>> {
  return JSON.parse(await run(h, command, [...argv, "--json"])) as Record<string, unknown>;
}

async function rejects(action: () => Promise<unknown>): Promise<CliError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail("expected the command to fail");
}

test("notify self sends one item to the signed-in person in the checkout's workspace, with a fresh ticket and the agent's via", async () => {
  const h = await harness({}, { CLAUDECODE: "1" });
  const record = await json(h, notify, ["self", "The access table is ready", "--label", "worktree hm-row-fix", "--alert", "none"]);
  assert.equal(h.attention.calls.length, 1);
  const [call] = h.attention.calls;
  assert.equal(call!.operationId, "attention.request.v1");
  assert.equal(call!.headers.get("superbee-workspace"), TENANT);
  assert.equal(call!.headers.get("x-superbee-via"), "claude-code");
  assert.match(String(call!.body.ticket), UUID_V7);
  assert.deepEqual(call!.body, {
    recipient: { kind: "principal", principalId: PRINCIPAL },
    kind: "needs_input",
    note: "The access table is ready",
    meta: { "dev.superbee.cli": { run: "worktree hm-row-fix" } },
    alert: "none",
    ticket: call!.body.ticket,
  });
  assert.equal(record.notify, "sent");
  assert.equal(record.item, "item-1");
  assert.equal(record.recipient, `self (${PRINCIPAL})`);
  assert.equal(record.workspace, TENANT);
  assert.equal(record.ticket, call!.body.ticket);
  assert.equal(record.email, "pending");
  assert.match((record.help as string[])[0]!, /inbox list --thread 01890a5d-ac96-774b-bcce-b302099a8057 --dir /);
  // The only sync request is the checkout's identity check.
  assert.deepEqual(h.host.requests.map((request) => request.path), ["/sync/v1/whoami"]);
});

test("notify --doc points at the document at the version the host holds, under the host's authority key", async () => {
  const h = await harness({ targetAuthorityKey: "orgs" });
  await run(h, notify, ["self", "please look", "--kind", "review_requested", "--doc", h.id, "--label-namespace", "com.anthropic.claude-code", "--label", "run 7"]);
  const version = h.host.docs.get(h.id)!.version;
  assert.deepEqual(h.attention.calls[0]!.body.target, {
    document: { schemaVersion: "superbee.document-target.v1", authority: { mode: "hosted", authorityKey: "orgs", workspaceKey: TENANT }, bundleKey: BUNDLE, documentId: h.id },
    eventVersion: version,
  });
  assert.deepEqual(h.attention.calls[0]!.body.meta, { "com.anthropic.claude-code": { run: "run 7" } });
  assert.deepEqual(h.host.requests.map((request) => request.path), ["/sync/v1/whoami", "/sync/v1/read"]);
});

test("notify --doc on a host that does not report its document authority (every /sync/v1 host today) is refused before anything is sent", async () => {
  const h = await harness();
  const error = await rejects(() => run(h, notify, ["self", "--kind", "ready", "--doc", h.id]));
  assert.equal(error.code, "NOT_IMPLEMENTED");
  assert.equal(error.details?.reason, "target_authority_unknown");
  assert.match(error.message, /does not report its document authority yet/);
  assert.match(error.help ?? "", /send without --doc/);
  assert.equal(h.attention.calls.length, 0);
  // Without --doc the same host sends.
  await run(h, notify, ["self", "no document"]);
  assert.equal(h.attention.calls.length, 1);
});

test("notify checks what it can before any request: recipient, kind, thread, label", async () => {
  const h = await harness();
  const cases: Array<[string[], RegExp]> = [
    [["bad\u0007name", "hi"], /is not a principal id or self/],
    [["self", "--kind", "ready"], /--kind ready needs --doc/],
    [["self", "--kind", "reply"], /--kind reply needs --thread/],
    [["self", "--kind", "shout"], /--kind must be one of/],
    [["self", "--thread", "not-a-thread"], /--thread is a thread id/],
    [["self", "--label-namespace", "Com.Bad"], /--label-namespace files a --label/],
    [["self", "--label", "x", "--label-namespace", "nodots"], /lowercase dotted app namespace/],
    [["self", "x".repeat(2001)], /longer than 2000/],
    [["self", "--ticket", "123"], /--ticket is the ticket/],
  ];
  for (const [argv, message] of cases) {
    const error = await rejects(() => run(h, notify, argv));
    assert.equal(error.code, "USAGE", argv.join(" "));
    assert.match(error.message, message);
  }
  assert.equal(h.host.requests.length, 0, "nothing reached the host");
  assert.equal(h.attention.calls.length, 0);
});

test("a send with no answer is retried with its ticket, reported with it, and re-run with --ticket sends the same one", async () => {
  const h = await harness();
  const offline = () => {
    throw new TypeError("socket hang up");
  };
  h.attention.scripted.push(offline, offline, offline);
  const error = await rejects(() => run(h, notify, ["self", "are you there"]));
  assert.equal(error.code, "TRANSIENT");
  const ticket = String(error.details?.ticket);
  assert.match(ticket, UUID_V7);
  assert.equal(h.attention.calls.length, 3);
  assert.ok(h.attention.calls.every((call) => call.body.ticket === ticket), "every retry reuses the ticket");
  assert.match(error.help ?? "", new RegExp(`notify self 'are you there' --ticket ${ticket} --dir `));
  const record = await json(h, notify, ["self", "are you there", "--ticket", ticket]);
  assert.equal(record.ticket, ticket);
  assert.equal(h.attention.calls.at(-1)!.body.ticket, ticket);
});

test("a send whose retry meets an ended sign-in keeps its ticket: sign in, then re-run with --ticket", async () => {
  const h = await harness();
  h.attention.scripted.push(
    () => {
      throw new TypeError("socket hang up");
    },
    () => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }),
  );
  const error = await rejects(() => run(h, notify, ["self", "landed?"]));
  assert.equal(error.code, "TRANSIENT");
  const ticket = String(error.details?.ticket);
  assert.equal(ticket, h.attention.calls[0]!.body.ticket);
  assert.equal(error.details?.after, "unauthenticated");
  assert.match(error.help ?? "", /^sign in again \(.*login --host /);
  assert.match(error.help ?? "", new RegExp(`--ticket ${ticket} --dir `));
});

test("the reply hint names the thread's other participant: the sender, or self on your own thread", async () => {
  const h = await harness();
  const mine = h.attention.add();
  const theirs = h.attention.add();
  h.attention.producers.set(theirs.itemId, { tenantId: TENANT, principalId: "person:sam" });
  const own = await json(h, inbox, ["open", mine.itemId, "--peek"]);
  assert.match((own.help as string[]).at(-1)!, /notify self <reply> --kind reply --thread /);
  const other = await json(h, inbox, ["open", theirs.itemId, "--peek"]);
  assert.match((other.help as string[]).at(-1)!, /notify person:sam <reply> --kind reply --thread /);
  // The hint runs: a reply to the sender names the recipient the thread fixes.
  await run(h, notify, ["person:sam", "on it", "--kind", "reply", "--thread", theirs.threadId]);
  assert.deepEqual(h.attention.calls.at(-1)!.body.recipient, { kind: "principal", principalId: "person:sam" });
  assert.equal(h.attention.calls.at(-1)!.body.threadId, theirs.threadId);
});

test("a host timestamp outside the Date range reads as unknown, never a crash", async () => {
  const h = await harness();
  h.attention.add({ createdAt: 9_000_000_000_000_000 });
  const record = await json(h, inbox, ["list"]);
  assert.equal((record.items as Record<string, unknown>[])[0]!.created, "unknown");
  const item = [...h.attention.items.values()][0]!;
  assert.equal((await json(h, inbox, ["open", item.itemId, "--peek"])).created, "unknown");
});

test("attention refusals are typed CLI errors in this CLI's words", async () => {
  const h = await harness();
  const refuse = (code: string, status: number) => () => Response.json({ ok: false, operationId: "attention.request.v1", error: { code, message: "HOST TEXT", retryable: false } }, { status });
  for (const [code, status, cli] of [
    ["attention_disabled", 403, "FORBIDDEN"],
    ["not_found", 404, "NOT_FOUND"],
    ["request_conflict", 409, "CONFLICT"],
    ["quota_exceeded", 429, "RUNTIME"],
    ["target_unsupported", 409, "USAGE"],
  ] as const) {
    h.attention.scripted.push(refuse(code, status));
    const error = await rejects(() => run(h, notify, ["self", "hi"]));
    assert.equal(error.code, cli, code);
    assert.equal(error.details?.code, code);
    assert.doesNotMatch(error.message, /HOST TEXT/);
  }
  h.attention.scripted.push(() => Response.json({ ok: false, code: "workspace_not_available", retryable: false }, { status: 403 }));
  assert.equal((await rejects(() => run(h, inbox, ["list"]))).code, "FORBIDDEN");
  h.attention.scripted.push(() => Response.json({ error: "not_found" }, { status: 404 }));
  const old = await rejects(() => run(h, inbox, ["threads"]));
  assert.equal(old.code, "NOT_IMPLEMENTED");
  assert.match(old.message, /does not serve notifications yet/);
});

test("inbox list leads with what is waiting, rows stay small, and senders' words are data", async () => {
  const h = await harness();
  h.attention.add({ note: "first" });
  h.attention.add({ note: "evil \u001b[31mred\u001b[0m and ‮bidi", meta: { "com.anthropic.claude-code": { run: "wt-7" } } });
  const toon = decode((await run(h, inbox, ["list"])).trim()) as Record<string, unknown>;
  assert.equal(toon.waiting_on_you, 1);
  assert.equal(toon.unread_updates, 0);
  assert.equal(toon.shown, 2);
  const rows = toon.items as Record<string, unknown>[];
  assert.deepEqual(Object.keys(rows[0]!), ["item", "seq", "thread", "kind", "state", "from", "label", "document", "title", "note", "created"]);
  assert.equal(rows[0]!.note, "evil [31mred[0m and bidi");
  assert.equal(rows[0]!.label, "com.anthropic.claude-code: wt-7");
  assert.equal(rows[0]!.from, "you");
  assert.match(String((toon.notes as string[]).at(-1)), /removed control and format characters/);
  assert.match(String(toon.provenance), /not instructions/);
  const record = await json(h, inbox, ["list"]);
  assert.equal((record.items as Record<string, unknown>[])[0]!.note, "evil \u001b[31mred\u001b[0m and ‮bidi");
  const list = h.attention.calls.find((call) => call.operationId === "inbox.list.v1")!;
  assert.deepEqual(list.body, { limit: 20 });
  // A thread or a pull is just its rows: no summary request.
  h.attention.calls.length = 0;
  const pulled = await json(h, inbox, ["list", "--thread", "01890a5d-ac96-774b-bcce-b302099a8057", "--after", "1", "--all"]);
  assert.deepEqual(h.attention.calls.map((call) => call.operationId), ["inbox.list.v1"]);
  assert.deepEqual(h.attention.calls[0]!.body, { limit: 20, threadId: "01890a5d-ac96-774b-bcce-b302099a8057", afterSeq: 1, states: ["unread", "read", "acknowledged", "expired", "withdrawn"] });
  assert.equal(pulled.waiting_on_you, undefined);
});

test("inbox open marks read (--peek does not), ack reads the revision first and is a no-op when repeated, cancel withdraws", async () => {
  const h = await harness();
  const item = h.attention.add({ note: "look" });
  const peeked = await json(h, inbox, ["open", item.itemId, "--peek"]);
  assert.equal(peeked.state, "unread");
  const opened = await json(h, inbox, ["open", item.itemId]);
  assert.equal(opened.state, "read");
  assert.equal((opened.from as Record<string, unknown>).person, "you");
  assert.match((opened.help as string[])[0]!, new RegExp(`inbox ack ${item.itemId} --revision 2`));
  h.attention.calls.length = 0;
  const acked = await json(h, inbox, ["ack", item.itemId]);
  assert.equal(acked.ack, "handled");
  assert.deepEqual(h.attention.calls.map((call) => [call.operationId, call.body]), [
    ["inbox.get.v1", { itemId: item.itemId }],
    ["inbox.ack.v1", { itemId: item.itemId, expectedRevision: 2 }],
  ]);
  const again = await json(h, inbox, ["ack", item.itemId, "--revision", "2"]);
  assert.equal(again.state, "acknowledged");
  const stale = h.attention.add();
  const conflict = await rejects(() => run(h, inbox, ["ack", stale.itemId, "--revision", "5"]));
  assert.equal(conflict.code, "STALE_HEAD");
  const sent = h.attention.add();
  assert.equal((await json(h, inbox, ["cancel", sent.itemId])).cancel, "withdrawn");
  assert.equal((await json(h, inbox, ["cancel", sent.itemId])).state, "withdrawn");
  const missing = await rejects(() => run(h, inbox, ["open", "item-404"]));
  assert.equal(missing.code, "NOT_FOUND");
});

// ── outside a checkout: the signed-in account ─────────────────────────────────────────────

const noNetwork = (async () => assert.fail("a signed-out command makes no request")) as typeof fetch;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.invalid" };

/** A folder that is not a checkout: a local bundle, a Git bundle, or no bundle at all. */
async function folder(kind: "local" | "git" | "none"): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "sb-notify-folder-")));
  if (kind === "none") return root;
  await init(["--dir", path.join(root, ".superbee"), "--recipe", "none"], { stdout: () => {} });
  if (kind === "git") {
    execFileSync("git", ["init", "-q"], { cwd: root, env: gitEnv });
    execFileSync("git", ["add", "-A"], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-q", "-m", "bundle"], { cwd: root, env: gitEnv });
  }
  return root;
}

interface Account {
  home: string;
  auth: HostedAuthDeps;
  host: FakeHost;
  attention: AttentionFake;
  fetch: typeof globalThis.fetch;
}

/** A person signed in to HOST (the last sign-in recorded, a token in the environment), with no checkout. */
async function account(options: FakeHostOptions = {}, signedIn = true): Promise<Account> {
  const host = new FakeHost({ tenants: [TENANT], ...options });
  const attention = new AttentionFake();
  const home = await mkdtemp(path.join(tmpdir(), "sb-notify-account-"));
  const auth = defaultHostedAuthDeps(home, {
    env: signedIn ? { SUPERBEE_ACCESS_TOKEN: TOKEN } : {},
    fetch: async () => assert.fail("the sign-in module must not be reached"),
  });
  await writeDefaultHost(home, HOST);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/sync/v1/attention/")) return host.fetch(input, init);
    const operationId = url.pathname.slice("/sync/v1/attention/".length);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    attention.calls.push({ operationId, body, headers: new Headers(init?.headers) });
    return attention.handle(operationId, body);
  }) as typeof globalThis.fetch;
  return { home, auth, host, attention, fetch };
}

async function runAt(a: Pick<Account, "auth" | "fetch">, cwd: string, command: typeof notify, argv: string[]): Promise<Record<string, unknown>> {
  const out: string[] = [];
  await command([...argv, "--json"], { stdout: (text) => void out.push(text), cwd, hosted: { auth: a.auth, fetch: a.fetch } });
  return JSON.parse(out.join("")) as Record<string, unknown>;
}

test("from a local bundle, a Git bundle or no bundle, notify and inbox use the signed-in account's only workspace", async () => {
  for (const kind of ["local", "git", "none"] as const) {
    const a = await account();
    const cwd = await folder(kind);
    const sent = await runAt(a, cwd, notify, ["self", `from a ${kind} folder`]);
    assert.equal(sent.notify, "sent", kind);
    assert.equal(sent.through, "account");
    assert.equal(sent.workspace, TENANT);
    assert.equal(a.attention.calls[0]!.headers.get("superbee-workspace"), TENANT);
    assert.deepEqual(a.attention.calls[0]!.body.recipient, { kind: "principal", principalId: PRINCIPAL });
    // Next steps reach the same inbox by host, not by folder.
    assert.match((sent.help as string[])[0]!, new RegExp(`inbox list --thread \\S+ --host ${HOST.replace(/[.]/g, "\\.")}`));
    assert.doesNotMatch((sent.help as string[])[0]!, /--dir/);
    const listed = await runAt(a, cwd, inbox, ["list"]);
    assert.equal(listed.through, "account");
    assert.equal(listed.shown, 1);
  }
});

test("outside a checkout the workspace is --workspace, then the setup hosted default, then the only one; several and none chosen is refused, naming them", async () => {
  const tenants = { tenants: ["tenant:a", "tenant:b"], workspaces: [{ tenantId: "tenant:a", slug: "north" }, { tenantId: "tenant:b", slug: "south" }] };
  const cwd = await folder("none");

  const ambiguous = await account(tenants);
  const error = await rejects(() => runAt(ambiguous, cwd, notify, ["self", "hi"]));
  assert.equal(error.code, "USAGE");
  assert.equal(error.details?.reason, "workspace_ambiguous");
  assert.deepEqual(error.details?.workspaces, ["north", "south"]);
  assert.match(error.help ?? "", /--workspace set to one of: north, south/);
  assert.equal(ambiguous.attention.calls.length, 0, "nothing is sent");

  const named = await account(tenants);
  assert.equal((await runAt(named, cwd, notify, ["self", "hi", "--workspace", "south"])).workspace, "tenant:b");
  assert.equal(named.attention.calls[0]!.headers.get("superbee-workspace"), "tenant:b");
  const record = await runAt(named, cwd, inbox, ["list", "--workspace", "south"]);
  assert.match((record.help as string[] | undefined)?.[0] ?? "", /--workspace south/);

  const defaulted = await account(tenants);
  await writeDefaultWorkspace(defaulted.home, { origin: HOST, workspace: "tenant:a" });
  assert.equal((await runAt(defaulted, cwd, notify, ["self", "hi"])).workspace, "tenant:a");
  // --workspace still wins over the default.
  assert.equal((await runAt(defaulted, cwd, notify, ["self", "hi", "--workspace", "tenant:b"])).workspace, "tenant:b");

  const outsider = await account(tenants);
  const notMember = await rejects(() => runAt(outsider, cwd, notify, ["self", "hi", "--workspace", "west"]));
  assert.equal(notMember.code, "NOT_FOUND");
});

test("signed out, from any folder: AUTH_REQUIRED with the one command that signs in, and no request", async () => {
  // The last sign-in is remembered, but there is no session for it.
  const remembered = await account({}, false);
  for (const kind of ["local", "none"] as const) {
    const cwd = await folder(kind);
    for (const [command, argv] of [
      [notify, ["self", "hi"]],
      [inbox, ["list"]],
    ] as const) {
      const error = await rejects(() => runAt({ auth: remembered.auth, fetch: noNetwork }, cwd, command, [...argv]));
      assert.equal(error.code, "AUTH_REQUIRED");
      assert.equal(error.details?.status, "not_signed_in");
      assert.match(error.message, /^not signed in to https:\/\/hosted\.example: /);
      assert.match(error.help ?? "", /login --host /);
    }
  }
  // No sign-in ever on this machine: the first sign-in command.
  const home = await mkdtemp(path.join(tmpdir(), "sb-notify-fresh-"));
  const fresh = { auth: defaultHostedAuthDeps(home, { env: {}, fetch: async () => assert.fail("no sign-in") }), fetch: noNetwork };
  const plain = await folder("none");
  const first = await rejects(() => runAt(fresh, plain, notify, ["self", "hi"]));
  assert.equal(first.code, "AUTH_REQUIRED");
  assert.equal(first.details?.status, "not_signed_in");
  assert.match(first.help ?? "", /login --host /);
});

test("outside a checkout --doc needs --bundle, refused before any request; with it the target names that bundle and its workspace", async () => {
  const a = await account({ targetAuthorityKey: "orgs", tenants: ["tenant:a", "tenant:b"], workspaces: [{ tenantId: "tenant:a", slug: "north" }, { tenantId: "tenant:b", slug: "tenant-b" }], slug: "north" });
  const cwd = await folder("local");
  const missing = await rejects(() => runAt({ auth: a.auth, fetch: noNetwork }, cwd, notify, ["self", "--kind", "ready", "--doc", "notes/a"]));
  assert.equal(missing.code, "USAGE");
  assert.equal(missing.details?.reason, "document_bundle_unknown");
  assert.match(missing.message, /--bundle <bundle-id>/);
  const lonely = await rejects(() => runAt({ auth: a.auth, fetch: noNetwork }, cwd, notify, ["self", "--bundle", BUNDLE]));
  assert.match(lonely.message, /--bundle names the bundle a --doc document is in/);

  const id = [...a.host.docs.keys()][0]!;
  const sent = await runAt(a, cwd, notify, ["self", "--kind", "review_requested", "--doc", id, "--bundle", `north/${BUNDLE}`]);
  assert.equal(sent.workspace, "tenant:a", "the bundle's workspace is the inbox's");
  assert.deepEqual(a.attention.calls[0]!.body.target, {
    document: { schemaVersion: "superbee.document-target.v1", authority: { mode: "hosted", authorityKey: "orgs", workspaceKey: "tenant:a" }, bundleKey: BUNDLE, documentId: id },
    eventVersion: a.host.docs.get(id)!.version,
  });
  const read = a.host.requests.find((request) => request.path === "/sync/v1/read")!;
  assert.equal((read.body as { bundleId?: unknown }).bundleId, `north/${BUNDLE}`, "the read names the bundle in its workspace");
  const clash = await rejects(() => runAt(a, cwd, notify, ["self", "--kind", "ready", "--doc", id, "--bundle", `north/${BUNDLE}`, "--workspace", "tenant-b"]));
  assert.equal(clash.code, "USAGE");
  assert.match(clash.message, /names workspace 'north', but --workspace names 'tenant-b'/);
});

test("--dir with an account flag is refused; account flags inside a checkout use the account", async () => {
  const h = await harness();
  const both = await rejects(() => run(h, notify, ["self", "hi", "--workspace", TENANT]));
  assert.equal(both.code, "USAGE");
  assert.match(both.message, /pass one or the other/);
  await writeDefaultHost(h.auth.home, HOST);
  const out: string[] = [];
  await notify(["self", "hi", "--workspace", TENANT, "--json"], { stdout: (text) => void out.push(text), cwd: h.folder, hosted: { auth: h.auth, fetch: h.fetch } });
  assert.equal((JSON.parse(out.join("")) as Record<string, unknown>).through, "account");
  const inside = await json(h, notify, ["self", "hi"]);
  assert.equal(inside.through, "checkout");
});

test("each verb's --help is focused and needs no folder", async () => {
  const out: string[] = [];
  await notify(["--help"], { stdout: (text) => void out.push(text) });
  assert.match(out.join(""), /^superbee notify — ask a person, or yourself, to look at something/);
  out.length = 0;
  await inbox(["list", "--help"], { stdout: (text) => void out.push(text) });
  assert.match(out.join(""), /^superbee inbox — read and handle your hosted Superbee inbox/);
  const unknown = await rejects(() => inbox(["done", "item-1"], { stdout: () => {} }));
  assert.equal(unknown.code, "USAGE");
});

test("every next step a notify --doc --bundle receipt prints runs as an inbox command", async () => {
  const a = await account({ targetAuthorityKey: "orgs", tenants: ["tenant:a", "tenant:b"], workspaces: [{ tenantId: "tenant:a", slug: "north" }, { tenantId: "tenant:b", slug: "tenant-b" }], slug: "north" });
  const cwd = await folder("local");
  const id = [...a.host.docs.keys()][0]!;
  const sent = await runAt(a, cwd, notify, ["self", "--kind", "review_requested", "--doc", id, "--bundle", `north/${BUNDLE}`]);
  const steps = sent.help as string[];
  assert.ok(steps.length > 0);
  for (const line of steps) {
    assert.ok(!line.includes("--bundle"), `inbox next steps take no --bundle: ${line}`);
    const words = line.split(" ");
    const from = words.indexOf("inbox") + 1;
    const to = words.findIndex((w) => w === "reads" || w === "withdraws");
    const args = words.slice(from, to).map((w) => w.replace(/^'|'$/g, ""));
    await inbox([...args, "--json"], { stdout: () => undefined, cwd, hosted: { auth: a.auth, fetch: a.fetch } });
  }
});

test("signed out with --host naming a host never signed in to: AUTH_REQUIRED and no request at all", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "sb-notify-signed-out-"));
  const requests: string[] = [];
  const spy = (async (input: string | URL | Request) => {
    requests.push(String(input));
    throw new TypeError("offline");
  }) as typeof fetch;
  const auth = defaultHostedAuthDeps(home, { env: {}, fetch: spy });
  const cwd = await folder("none");
  const error = await rejects(() => runAt({ auth, fetch: spy }, cwd, notify, ["self", "hi", "--host", "https://other.example"]));
  assert.deepEqual(requests, [], "a signed-out notify sent nothing");
  assert.equal(error.code, "AUTH_REQUIRED");
});

// ── naming a teammate through hosted's notification directory ─────────────────────────────────

const TEAM = [
  { principalId: PRINCIPAL, displayName: "Pat Doe", self: true },
  { principalId: "person:ana", displayName: "Ana Lopez", self: false },
  { principalId: "person:anna", displayName: "Anna Berg", self: false },
  { principalId: "person:sam", displayName: "Sam \u001b[31mRed\u001b[0m", self: false },
  { principalId: "person:quiet", displayName: null, self: false },
];

async function team(offered: boolean, members: AttentionFake["directory"] = TEAM) {
  const h = await harness(offered ? { notificationDirectoryWorkspaces: [TENANT] } : {});
  h.attention.directory = members.map((m) => ({ ...m }));
  return h;
}

const sends = (h: Harness) => h.attention.calls.filter((call) => call.operationId === "attention.request.v1");
const directoryReads = (h: Harness) => h.attention.calls.filter((call) => call.operationId === "members.directory.v1");

test("where hosted offers the directory, a teammate's exact name (any case) or a unique start resolves to one principal", async () => {
  const h = await team(true);
  const exact = await json(h, notify, ["  ana LOPEZ ", "please look"]);
  assert.deepEqual(sends(h)[0]!.body.recipient, { kind: "principal", principalId: "person:ana" });
  assert.equal(exact.recipient, "Ana Lopez (person:ana)");
  assert.equal(exact.matched_by, "name");
  assert.deepEqual(directoryReads(h)[0]!.body, { limit: 100 });
  assert.equal(directoryReads(h)[0]!.headers.get("superbee-workspace"), TENANT);
  const prefix = await json(h, notify, ["Anna", "hi"]);
  assert.deepEqual(sends(h)[1]!.body.recipient, { kind: "principal", principalId: "person:anna" });
  assert.equal(prefix.matched_by, "name_prefix");
  // Your own name resolves to you.
  const me = await json(h, notify, ["pat doe", "note to self"]);
  assert.equal(me.recipient, `self (${PRINCIPAL})`);
});

test("a name that fits several teammates or none is refused, listing them as ready commands by principal id; nothing is sent", async () => {
  const h = await team(true);
  const ambiguous = await rejects(() => run(h, notify, ["an", "hi"]));
  assert.equal(ambiguous.code, "USAGE");
  assert.equal(ambiguous.details?.reason, "recipient_ambiguous");
  assert.match(ambiguous.message, /'an' matches 2 teammates; name one by principal id/);
  assert.deepEqual(ambiguous.details?.candidates, [
    { principal: "person:ana", name: "Ana Lopez" },
    { principal: "person:anna", name: "Anna Berg" },
  ]);
  const commands = ambiguous.details?.commands as string[];
  assert.match(commands[0]!, /notify person:ana hi --dir /);
  assert.match(commands[1]!, /notify person:anna hi --dir /);
  const none = await rejects(() => run(h, notify, ["bob", "hi"]));
  assert.equal(none.code, "USAGE");
  assert.equal(none.details?.reason, "recipient_not_found");
  assert.match(none.message, /no teammate you can notify is named 'bob'/);
  const listed = none.details?.candidates as Array<Record<string, unknown>>;
  assert.equal(listed.length, TEAM.length);
  // Teammates' names are other people's words: control characters never reach the terminal.
  assert.ok(listed.some((c) => c.principal === "person:sam" && c.name === "Sam [31mRed[0m"));
  assert.ok(listed.some((c) => c.principal === PRINCIPAL && c.self === true));
  assert.ok(listed.some((c) => c.principal === "person:quiet" && c.name === null));
  assert.equal(sends(h).length, 0, "nothing is sent on a guess");
  // The ready command runs.
  await run(h, notify, ["person:anna", "hi"]);
  assert.deepEqual(sends(h)[0]!.body.recipient, { kind: "principal", principalId: "person:anna" });
});

test("an email matches only where the directory shares emails; absent, it is refused naming why", async () => {
  const withEmail = await team(true, [...TEAM.slice(0, 2), { principalId: "person:kim", displayName: "Kim", email: "Kim@Example.com", self: false }]);
  const sent = await json(withEmail, notify, ["kim@example.COM", "hi"]);
  assert.equal(sent.matched_by, "email");
  assert.deepEqual(sends(withEmail)[0]!.body.recipient, { kind: "principal", principalId: "person:kim" });
  const unknown = await rejects(() => run(withEmail, notify, ["lee@example.com", "hi"]));
  assert.equal(unknown.details?.reason, "recipient_not_found");

  const withoutEmail = await team(true);
  const refused = await rejects(() => run(withoutEmail, notify, ["ana@example.com", "hi"]));
  assert.equal(refused.code, "USAGE");
  assert.equal(refused.details?.reason, "directory_has_no_emails");
  assert.match(refused.message, /does not share emails/);
  assert.equal(sends(withoutEmail).length, 0);
});

test("a large directory is read page by page, and one larger than notify reads is refused rather than guessed", async () => {
  const many = Array.from({ length: 250 }, (_, index) => ({ principalId: `person:m${String(index).padStart(3, "0")}`, displayName: `Member ${index}`, self: false }));
  const h = await team(true, [...many, { principalId: "person:zoe", displayName: "Zoe", self: false }]);
  h.attention.directoryPage = 100;
  await run(h, notify, ["zoe", "hi"]);
  assert.equal(directoryReads(h).length, 3);
  assert.deepEqual(directoryReads(h).map((call) => call.body.after ?? null), [null, "person:m099", "person:m199"]);
  h.attention.directoryPage = 1;
  const big = await rejects(() => run(h, notify, ["zoe", "hi"]));
  assert.equal(big.details?.reason, "directory_too_large");
});

test("self and a principal id are sent as before, with no directory read, whether or not it is offered", async () => {
  for (const offered of [true, false]) {
    const h = await team(offered);
    await run(h, notify, ["self", "hi"]);
    await run(h, notify, ["person:sam", "hi"]);
    assert.deepEqual(sends(h).map((call) => (call.body.recipient as { principalId: string }).principalId), [PRINCIPAL, "person:sam"]);
    assert.equal(directoryReads(h).length, 0, String(offered));
  }
  // Offered, an unqualified principal id is still found exactly, as a principal id.
  const h = await team(true);
  const record = await json(h, notify, [PRINCIPAL, "hi"]);
  assert.equal(record.recipient, `self (${PRINCIPAL})`);
});

test("where hosted does not offer the directory, a name or email is refused as before: no mention of names or a directory, no directory read", async () => {
  for (const options of [{}, { notificationDirectoryWorkspaces: ["tenant:other"] }]) {
    const h = await harness(options);
    h.attention.directory = TEAM.map((m) => ({ ...m }));
    const named = await rejects(() => run(h, notify, ["Ana Lopez", "hi"]));
    assert.equal(named.code, "USAGE");
    assert.equal(named.message, "'Ana Lopez' is not a principal id or self");
    const email = await rejects(() => run(h, notify, ["ana@example.com", "hi"]));
    assert.match(email.message, /principal id or self; naming someone by email is not supported yet/);
    for (const error of [named, email]) {
      assert.doesNotMatch(`${error.message} ${error.help ?? ""} ${JSON.stringify(error.details ?? {})}`, /directory|teammate|name one/i);
    }
    assert.equal(directoryReads(h).length, 0);
    assert.equal(sends(h).length, 0);
  }
});

test("a directory the host will not list for this sign-in is refused in this CLI's words, sending nothing", async () => {
  const h = await team(true);
  h.attention.scripted.push(() => Response.json({ ok: false, operationId: "members.directory.v1", error: { code: "not_found", message: "HOST TEXT", retryable: false } }, { status: 404 }));
  const error = await rejects(() => run(h, notify, ["ana", "hi"]));
  assert.equal(error.code, "FORBIDDEN");
  assert.equal(error.details?.reason, "directory_unavailable");
  assert.doesNotMatch(error.message, /HOST TEXT/);
  assert.equal(sends(h).length, 0);
});

test("a send by name with no answer is resent by the principal it resolved to, so the ticket carries the same input", async () => {
  const h = await team(true);
  const offline = () => {
    throw new TypeError("socket hang up");
  };
  // The directory read answers; the three send attempts do not.
  h.attention.scripted.push(() => h.attention.handle("members.directory.v1", { limit: 100 }), offline, offline, offline);
  const error = await rejects(() => run(h, notify, ["Ana Lopez", "hi"]));
  assert.equal(error.code, "TRANSIENT");
  assert.match(error.help ?? "", new RegExp(`notify person:ana hi --ticket ${String(error.details?.ticket)} --dir `));
});
