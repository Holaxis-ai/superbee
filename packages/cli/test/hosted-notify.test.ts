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
import { defaultHostedAuthDeps, type HostedAuthDeps } from "../src/hosted-auth/session.js";
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
    [["ana@example.com", "hi"], /principal id or self; naming someone by email is not supported yet/],
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

// ── local and Git bundles ──────────────────────────────────────────────────────────────────

const noNetwork = (async () => assert.fail("a local or Git bundle makes no request")) as typeof fetch;

test("a local and a Git bundle refuse notify and inbox as hosted-only, naming the command that connects, with no request", async () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  for (const home of ["local", "git"] as const) {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "sb-notify-local-")));
    const userHome = await mkdtemp(path.join(tmpdir(), "sb-notify-local-home-"));
    await init(["--dir", path.join(root, ".superbee"), "--recipe", "none"], { stdout: () => {} });
    if (home === "git") {
      execFileSync("git", ["init", "-q"], { cwd: root, env: gitEnv });
      execFileSync("git", ["add", "-A"], { cwd: root, env: gitEnv });
      execFileSync("git", ["commit", "-q", "-m", "bundle"], { cwd: root, env: gitEnv });
    }
    const deps = { stdout: () => {}, hosted: { auth: defaultHostedAuthDeps(userHome), fetch: noNetwork } };
    for (const [command, argv] of [
      [notify, ["self", "hi"]],
      [inbox, ["list"]],
      [inbox, ["ack", "item-1"]],
    ] as const) {
      const error = await rejects(() => command([...argv, "--dir", path.join(root, ".superbee")], deps));
      assert.equal(error.code, "NOT_IMPLEMENTED");
      assert.match(error.message, /^Notifications need hosted Superbee: /);
      assert.equal(error.details?.home, home);
      assert.equal(error.details?.reason, "hosted_only");
      assert.match(error.help ?? "", /checkout <bundle-id>/);
    }
  }
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
