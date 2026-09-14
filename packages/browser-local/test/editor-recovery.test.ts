import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { versionOfBytes } from "@superbee/core/versioning";
import {
  withEditorRecovery, editorRecoveryKey, EDITOR_RECOVERY_LIMITS,
  type EditorRecoveryScope, type EditorRecoverySession,
} from "../src/editor-recovery.ts";
import type { LockManagerLike } from "../src/push-role.ts";
import { openLocalBundle } from "../src/local-bundle.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";

const scope: EditorRecoveryScope = { endpoint: "https://example.test/api", principalScope: "account-1", workspace: "workspace-1", bundle: "bundle-1", installation: "installation-1", registrationScope: "registration-1" };
const version = versionOfBytes("original");
const draft = (body = "edit") => ({ base: { version, body: "original" }, body });
const id = "notes/one";
const rid = () => crypto.randomUUID();
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
/** Two simulated tabs use the same browser lock service, not separate process fallbacks. */
class Locks implements LockManagerLike {
  readonly held = new Set<string>();
  async request<T>(name: string, _: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<T>): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try { return await callback({ name }); } finally { this.held.delete(name); }
  }
}
function fixture() { return { backend: new MemoryJournaledBackend(), locks: new Locks() }; }

test("role exclusion spans callback and drains an entered write on return; stale handles refuse", async () => {
  const f = fixture();
  const entered = deferred(); const release = deferred(); const finish = deferred();
  const write = f.backend.writeMeta.bind(f.backend);
  f.backend.writeMeta = async (key, value) => { entered.resolve(); await release.promise; await write(key, value); };
  let old!: EditorRecoverySession;
  let writing!: Promise<unknown>;
  const first = withEditorRecovery(scope, f, async session => {
    old = session;
    writing = session.saveDraft(id, draft(), null);
    await finish.promise;
    return "done";
  });
  await entered.promise;
  assert.deepEqual(await withEditorRecovery(scope, f, async () => assert.fail("second tab entered")), { held: false, reason: "held-elsewhere" });
  finish.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.locks.held.size, 1, "callback return must not release an entered write");
  await assert.rejects(old.read(id), { code: "closed" });
  release.resolve(); await writing;
  assert.deepEqual(await first, { held: true, value: "done" });
  assert.equal(f.locks.held.size, 0);
  await assert.rejects(old.saveDraft(id, draft(), null), { code: "closed" });
  await withEditorRecovery(scope, f, async s => assert.equal((await s.read(id))?.body, "edit"));
});

test("callback throw also drains entered storage before releasing the role", async () => {
  const f = fixture(); const entered = deferred(); const release = deferred();
  const write = f.backend.writeMeta.bind(f.backend);
  f.backend.writeMeta = async (key, value) => { entered.resolve(); await release.promise; await write(key, value); };
  let writing!: Promise<unknown>;
  const run = withEditorRecovery(scope, f, async s => { writing = s.saveDraft(id, draft(), null); throw new Error("callback failed"); });
  const rejection = assert.rejects(run, /callback failed/);
  await entered.promise;
  assert.equal(f.locks.held.size, 1);
  release.resolve(); await writing; await rejection;
  assert.equal(f.locks.held.size, 0);
  await withEditorRecovery(scope, f, async s => assert.ok(await s.read(id)));
});

test("missing cross-tab locks never touches storage or invokes the callback", async () => {
  const f = fixture();
  f.backend.readMeta = async () => assert.fail("storage accessed without locks");
  assert.deepEqual(await withEditorRecovery(scope, { ...f, locks: null }, async () => assert.fail("entered")), { held: false, reason: "locks-unavailable" });
});

test("prepare returns only after its immutable attempt is durably written; acknowledgement keeps newer draft", async () => {
  const f = fixture(); const identity = rid();
  await withEditorRecovery(scope, f, async s => {
    const initial = await s.saveDraft(id, draft(), null);
    const entered = deferred(); const release = deferred();
    const write = f.backend.writeMeta.bind(f.backend);
    let returned = false;
    f.backend.writeMeta = async (key, value) => { entered.resolve(); await release.promise; await write(key, value); };
    const preparing = s.prepare(id, { requestId: identity }, initial.revision).then(attempt => { returned = true; return attempt; });
    await entered.promise;
    assert.equal(returned, false);
    assert.equal((await f.backend.readMeta<any>(editorRecoveryKey(scope))).documents[0].pending, null);
    release.resolve();
    const attempt = await preparing;
    assert.deepEqual(attempt, (await f.backend.readMeta<any>(editorRecoveryKey(scope))).documents[0].pending);
    attempt.body = "mutated output";
    const newer = await s.saveDraft(id, draft("later edit"), initial.revision);
    assert.equal(newer.pending?.body, "edit");
    await assert.rejects(s.prepare(id, { requestId: rid() }, newer.revision), { code: "pending" });
    await assert.rejects(s.prepare(id, { requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, newer.revision), { code: "invalid" });
    await assert.rejects(s.discardDraft(id, newer.revision), { code: "pending" });
    await assert.rejects(s.settle(id, rid(), { kind: "refused" }), { code: "request-mismatch" });
    assert.equal((await s.read(id))?.pending?.requestId, identity);
    const confirmedVersion = versionOfBytes("confirmed");
    const settled = await s.settle(id, identity, { kind: "committed", version: confirmedVersion });
    assert.equal(settled.body, "later edit");
    assert.equal(settled.revision, newer.revision);
    assert.deepEqual(settled.base, draft().base);
    assert.equal(settled.pending, null);
    assert.deepEqual(settled.confirmation, { requestId: identity, kind: "committed", version: confirmedVersion });
    assert.equal((await f.backend.list()).length, 0, "editor persistence must not commit a document");
    assert.equal((await f.backend.listIntents()).length, 0, "editor persistence must not create an intent");
  });
});

test("IndexedDB close and reopen retain both draft and exact prepared attempt", async () => {
  const indexedDB = new IDBFactory(); const locks = new Locks(); const name = rid();
  const local = openLocalBundle(name, { indexedDB });
  const identity = rid();
  let expected: unknown;
  await withEditorRecovery(scope, { backend: local.backend, locks }, async s => {
    const row = await s.saveDraft(id, draft(), null);
    await s.prepare(id, { requestId: identity }, row.revision);
    await s.saveDraft(id, draft("newer retained body"), row.revision);
    expected = await s.read(id);
  });
  local.close();
  const reopened = openLocalBundle(name, { indexedDB });
  try {
    await withEditorRecovery(scope, { backend: reopened.backend, locks }, async s => {
      assert.deepEqual(await s.read(id), expected);
      const settled = await s.settle(id, identity, { kind: "refused" });
      assert.equal(settled.body, "newer retained body");
      assert.deepEqual(settled.confirmation, { requestId: identity, kind: "refused" });
    });
  } finally { reopened.close(); }
});

test("failed atomic storage writes leave the original row and poison further operations until reopen", async () => {
  const f = fixture();
  await withEditorRecovery(scope, f, async s => { await s.saveDraft(id, draft(), null); });
  const key = editorRecoveryKey(scope); const before = await f.backend.readMeta(key);
  const write = f.backend.writeMeta.bind(f.backend);
  f.backend.writeMeta = async () => { throw new DOMException("full", "QuotaExceededError"); };
  await assert.rejects(withEditorRecovery(scope, f, async s => {
    const row = (await s.read(id))!;
    await assert.rejects(s.prepare(id, { requestId: rid() }, row.revision), { name: "QuotaExceededError" });
    await assert.rejects(s.saveDraft(id, draft("bad"), row.revision), { code: "closed" });
  }), { name: "QuotaExceededError" });
  assert.deepEqual(await f.backend.readMeta(key), before);
  f.backend.writeMeta = write;
  await withEditorRecovery(scope, f, async s => assert.equal((await s.read(id))?.body, "edit"));
});

test("an ambiguous write failure cannot be overwritten by a queued operation", async () => {
  const f = fixture(); const write = f.backend.writeMeta.bind(f.backend);
  await withEditorRecovery(scope, f, async s => { await s.saveDraft(id, draft(), null); });
  f.backend.writeMeta = async (key, value) => { await write(key, value); throw new Error("completion lost"); };
  const identity = rid();
  await assert.rejects(withEditorRecovery(scope, f, async s => {
    const row = (await s.read(id))!;
    const prepare = s.prepare(id, { requestId: identity }, row.revision);
    const edit = s.saveDraft(id, draft("must not overwrite attempt"), row.revision);
    await Promise.all([assert.rejects(prepare, /completion lost/), assert.rejects(edit, { code: "closed" })]);
  }), /completion lost/);
  f.backend.writeMeta = write;
  await withEditorRecovery(scope, f, async s => assert.equal((await s.read(id))?.pending?.requestId, identity));
});

test("draft CAS serializes concurrent edits and revisions prevent discard/recreate ABA", async () => {
  await withEditorRecovery(scope, fixture(), async s => {
    const row = await s.saveDraft(id, draft(), null);
    const results = await Promise.allSettled([s.saveDraft(id, draft("first"), row.revision), s.saveDraft(id, draft("second"), row.revision)]);
    assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
    const next = (await s.read(id))!;
    await s.discardDraft(id, next.revision);
    const recreated = await s.saveDraft(id, draft("recreated"), null);
    assert.ok(recreated.revision > next.revision);
    await assert.rejects(s.discardDraft(id, next.revision), { code: "stale" });
    assert.equal((await s.read(id))?.body, "recreated");
  });
});

test("captures scope, options and operation inputs before waits and detaches all output", async () => {
  const f = fixture(); const localScope = structuredClone(scope); const originalKey = editorRecoveryKey(scope);
  const read = f.backend.readMeta.bind(f.backend); const entered = deferred(); const release = deferred();
  f.backend.readMeta = async key => { entered.resolve(); await release.promise; return read(key); };
  const run = withEditorRecovery(localScope, f, async s => {
    const input = draft();
    const saving = s.saveDraft(id, input, null);
    input.body = "caller mutation"; input.base.body = "bad";
    const saved = await saving;
    saved.base.body = "output mutation";
    const request = { requestId: rid() }; const identity = request.requestId;
    const preparing = s.prepare(id, request, saved.revision);
    request.requestId = rid();
    assert.equal((await preparing).requestId, identity);
    const result = (await s.read(id))!;
    assert.deepEqual(result.base, draft().base); assert.equal(result.body, "edit");
    result.pending!.body = "mutated read";
    assert.equal((await s.read(id))?.pending?.body, "edit");
    const outcome = { kind: "committed" as const, version };
    const settling = s.settle(id, identity, outcome); outcome.version = versionOfBytes("changed");
    assert.equal((await settling).confirmation?.kind, "committed");
    assert.deepEqual((await s.read(id))?.confirmation, { requestId: identity, kind: "committed", version });
  });
  await entered.promise; localScope.principalScope = "other-account"; release.resolve(); await run;
  assert.ok(await read(originalKey));
  assert.equal(await read(editorRecoveryKey(localScope)), undefined);
});

for (const [name, mutate] of [
  ["foreign scope", (e: any) => { e.scope.principalScope = "other"; }],
  ["future schema", (e: any) => { e.schemaVersion = 2; }],
  ["unknown fields", (e: any) => { e.documents[0].secret = "unexpected"; }],
  ["invalid version", (e: any) => { e.documents[0].base.version = "version"; }],
  ["invalid revision", (e: any) => { e.documents[0].revision = e.nextRevision; }],
  ["duplicate document", (e: any) => { e.documents.push(e.documents[0]); }],
  ["malformed pending", (e: any) => { e.documents[0].pending = { requestId: rid() }; }],
  ["unknown outcome", (e: any) => { e.documents[0].confirmation = { requestId: rid(), kind: "unknown" }; }],
] as const) {
  test(`${name} fails closed on reopen without resetting bytes`, async () => {
    const f = fixture(); const key = editorRecoveryKey(scope);
    await withEditorRecovery(scope, f, async s => { await s.saveDraft(id, draft(), null); });
    const bad = await f.backend.readMeta<any>(key); mutate(bad); await f.backend.writeMeta(key, bad);
    await assert.rejects(withEditorRecovery(scope, f, async () => assert.fail("corrupt storage opened")));
    assert.deepEqual(await f.backend.readMeta(key), bad);
  });
}

test("every scope dimension partitions both lock and storage, while canonical endpoints agree", async () => {
  const keys = Object.keys(scope) as (keyof EditorRecoveryScope)[];
  for (const field of keys) {
    const changed = { ...scope, [field]: `${scope[field]}-other` };
    assert.notEqual(editorRecoveryKey(changed), editorRecoveryKey(scope), field);
  }
  assert.equal(editorRecoveryKey({ ...scope, endpoint: "https://EXAMPLE.test:443/api" }), editorRecoveryKey(scope));
  assert.throws(() => editorRecoveryKey({ ...scope, endpoint: "https://user:pass@example.test/api" }));
  assert.throws(() => editorRecoveryKey({ ...scope, endpoint: "https://example.test/api?token=x" }));
});

test("UTF-8 body and total envelope limits refuse without eviction or changing the original", async () => {
  const f = fixture(); const key = editorRecoveryKey(scope);
  await withEditorRecovery(scope, f, async s => {
    const row = await s.saveDraft(id, draft("😀".repeat(EDITOR_RECOVERY_LIMITS.bodyBytes / 4)), null);
    const before = await f.backend.readMeta(key);
    await assert.rejects(s.saveDraft(id, draft(`${row.body}a`), row.revision), { code: "capacity" });
    assert.deepEqual(await f.backend.readMeta(key), before);
    await s.discardDraft(id, row.revision);
    const body = "x".repeat(EDITOR_RECOVERY_LIMITS.bodyBytes);
    let capacityReached = false;
    for (let i = 0; i < EDITOR_RECOVERY_LIMITS.documents; i++) {
      const previous = await f.backend.readMeta(key);
      try { await s.saveDraft(`notes/${i}`, { base: { version, body }, body }, null); }
      catch (error: any) { assert.equal(error.code, "capacity"); assert.deepEqual(await f.backend.readMeta(key), previous); capacityReached = true; break; }
    }
    assert.ok(capacityReached, "total envelope limit must apply before 32 large documents");
    assert.equal((await s.read("notes/0"))?.body, body);
  });
});

test("document count refuses the 33rd small document without evicting any draft", async () => {
  const f = fixture();
  await withEditorRecovery(scope, f, async s => {
    for (let i = 0; i < 32; i++) await s.saveDraft(`notes/${i}`, draft(), null);
    const before = await f.backend.readMeta(editorRecoveryKey(scope));
    await assert.rejects(s.saveDraft("notes/33", draft(), null), { code: "capacity" });
    assert.deepEqual(await f.backend.readMeta(editorRecoveryKey(scope)), before);
    for (let i = 0; i < 32; i++) assert.ok(await s.read(`notes/${i}`));
  });
});
