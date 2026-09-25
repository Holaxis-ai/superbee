// Exact mode's fold of a refused chain: a never-sent edit that waits on a predecessor the
// authority refused on its content is folded into it by push. The pair retires and one fresh
// intent on the refused head's premise carries the working document, delivered in the same run.
// Every case runs over the IndexedDB adapter and the in-memory seam adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import type { OkfDocument } from "@superbee/core";
import type { IntentRecord, JournaledBackend } from "@superbee/core/journaled-backend";
import type { OperationIntent, OperationTransport, Outcome } from "@superbee/core/uncertain-write";
import { baseKey, bootstrap, commitLocal, deleteLocal, openLocalBundle, push, resume, syncStatus, type LocalBundle } from "../src/local-bundle.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";
import { createRemoteFixture } from "./fixtures/remote-fixture.ts";

const id = "notes/fold";
const doc = (body: string): OkfDocument => ({ id, frontmatter: { type: "Note", title: "Fold" }, body });
const edit = (body: string) => ({ buildCandidate: () => doc(body) });
const create = (body: string) => ({ mode: "replace-document" as const, onAbsent: "create" as const, buildCandidate: () => doc(body) });
const immediate = { sleep: async () => {}, lookupDelayMs: 0 };
const CONTENT = { kind: "refused", code: "INVALID_DOCUMENT", message: "refused by a rule" } as const;
const TOMBSTONE = "sha256:" + "7".repeat(64);

/** A transport that records every submission and answers each from `answer`; lookups find nothing unless `lookup` says otherwise. */
function scripted(answer: (intent: OperationIntent) => Outcome | Promise<Outcome>, lookup: (requestId: string) => Outcome | null = () => null): OperationTransport & { sent: string[] } {
  const sent: string[] = [];
  return { sent, async submit(intent) { sent.push(intent.requestId); return answer(intent); }, async lookup(requestId) { return lookup(requestId); } };
}

/** The given transport, recording every submission. */
function counting(inner: OperationTransport): OperationTransport & { sent: string[] } {
  const sent: string[] = [];
  return { sent, submit: (intent, options) => { sent.push(intent.requestId); return inner.submit(intent, options); }, lookup: (requestId) => inner.lookup(requestId) };
}

/** Answers any delivery as committed: a write at its own version, a deletion with a tombstone. */
const accepting = () => scripted((intent) => ({ kind: "committed", version: intent.kind === "document.delete" ? TOMBSTONE : intent.local }));

const unsettled = async (local: LocalBundle) => (await local.backend.readWithJournal(id)).intents.filter(row => row.state !== "acknowledged");

for (const adapter of ["indexeddb", "memory"] as const) {
  const open = () => openLocalBundle(`fold-${crypto.randomUUID()}`, adapter === "memory" ? { backend: new MemoryJournaledBackend() } : { indexedDB: new IDBFactory() });

  /** A working copy bootstrapped from an authority holding `id`. */
  async function synced(body = "v1\n") {
    const remote = await createRemoteFixture();
    await remote.authority.write(id, doc(body));
    const local = open();
    await bootstrap(remote.remote, local);
    return { remote, local };
  }

  /** The B2 shape through the product's own verbs: an edit lands while P is in flight, then P is refused. */
  async function wedged(code = CONTENT.code) {
    const { remote, local } = await synced();
    const p = (await commitLocal(local, id, edit("p\n"))).intent!;
    let s = null as IntentRecord | null;
    const refusing = scripted(async () => {
      s = (await commitLocal(local, id, edit("s\n"))).intent;
      return { kind: "refused", code, message: CONTENT.message };
    });
    const first = await push(local, refusing, { write: immediate });
    assert.deepEqual(first.settled.map(row => row.state), ["refused"]);
    assert.equal(first.rebased, undefined, "the edit landed after the listing; this run did not see it");
    assert.equal(s!.after, p.requestId);
    return { remote, local, p, s: s! };
  }

  /** Put the latest intent in flight (claimed, attempt recorded) so the next edit chains behind it. */
  async function inFlight(backend: JournaledBackend, requestId: string) {
    await backend.updateIntent(requestId, "pending", { state: "in_flight", attempts: 1 });
  }

  test(`${adapter}: an edit during flight plus a content refusal folds on the next push; the authority ends at the edit, P is never sent again`, async () => {
    const { remote, local, p, s } = await wedged();
    try {
      const before = await local.backend.readWithJournal(id);
      const transport = counting(remote.transport);
      const report = await push(local, transport, { remote: remote.remote, write: immediate });
      assert.equal(report.rebased?.length, 1);
      const [rebase] = report.rebased!;
      assert.deepEqual(rebase!.retired, [p.requestId, s.requestId]);
      assert.deepEqual(rebase!.refusal, { code: CONTENT.code, message: CONTENT.message });
      assert.ok(rebase!.requestId && rebase!.requestId !== p.requestId && rebase!.requestId !== s.requestId);
      assert.deepEqual(report.settled, [{ requestId: rebase!.requestId, target: id, state: "acknowledged" }]);
      assert.deepEqual(report.skipped, []);
      assert.deepEqual(transport.sent, [rebase!.requestId], "one new identity; P's is never submitted again");
      const fresh = (await local.backend.readIntent(rebase!.requestId))!;
      assert.deepEqual([fresh.base, fresh.baseContent, fresh.after, fresh.recreates, fresh.kind], [p.base, p.baseContent, undefined, undefined, "document.write"]);
      assert.deepEqual([fresh.local, fresh.content], [before.document!.version, before.raw], "the working document's bytes are what was sent");
      assert.equal((await local.backend.readWithJournal(id)).document!.version, before.document!.version, "the fold does not change the document");
      assert.equal((await remote.authority.read(id)).doc.body, "s\n");
      assert.equal(await local.backend.readIntent(p.requestId), undefined);
      assert.equal(await local.backend.readIntent(s.requestId), undefined);
      const { counts } = await syncStatus(local);
      assert.deepEqual([counts.pending, counts.in_flight, counts.refused, counts.conflict, counts.unknown], [0, 0, 0, 0, 0]);
      assert.equal((await push(local, transport, { remote: remote.remote, write: immediate })).rebased, undefined);
    } finally { local.close(); }
  });

  test(`${adapter}: a journal wedged before this change, built through the seam, heals on its next push with no migration`, async () => {
    const { remote, local } = await synced();
    try {
      const first = (await commitLocal(local, id, edit("first edit\n"))).intent!;
      await local.backend.updateIntent(first.requestId, "pending", { state: "refused", attempts: 1, refusal: { code: "validation_failed", message: "refused by a rule" } });
      const before = await local.backend.readWithJournal(id);
      await local.backend.writeJournaled(id, doc("second edit\n"), { expectedVersion: before.document!.version, intent: { requestId: "successor", kind: "document.write", target: id, base: first.local, baseContent: first.content, createdAt: "2026-09-15T00:00:00.000Z", after: first.requestId } });
      const transport = counting(remote.transport);
      const report = await push(local, transport, { remote: remote.remote, write: immediate });
      assert.deepEqual(report.rebased?.map(row => row.retired), [[first.requestId, "successor"]]);
      assert.deepEqual(report.settled.map(row => row.state), ["acknowledged"]);
      assert.deepEqual(transport.sent, [report.rebased![0]!.requestId]);
      assert.equal((await remote.authority.read(id)).doc.body, "second edit\n");
      assert.deepEqual(await unsettled(local), []);
    } finally { local.close(); }
  });

  test(`${adapter}: deletion shapes fold as compose and delete compose them: a delete at P's base, a collapse to nothing, a replace at P's base`, async () => {
    // write P refused, delete S: the fresh intent deletes at P's base.
    {
      const { local } = await synced();
      try {
        const p = (await commitLocal(local, id, edit("p\n"))).intent!;
        await inFlight(local.backend, p.requestId);
        const s = (await deleteLocal(local, id)).intent!;
        assert.deepEqual([s.kind, s.after, s.base], ["document.delete", p.requestId, p.local]);
        await local.backend.updateIntent(p.requestId, "in_flight", { state: "refused", attempts: 1, refusal: { code: CONTENT.code, message: CONTENT.message } });
        const transport = accepting();
        const report = await push(local, transport, { write: immediate });
        const fresh = (await local.backend.readIntent(report.rebased![0]!.requestId))!;
        assert.deepEqual([fresh.kind, fresh.base, fresh.baseContent, fresh.after, fresh.state], ["document.delete", p.base, p.baseContent, undefined, "acknowledged"]);
        assert.deepEqual(transport.sent, [fresh.requestId]);
        assert.equal((await local.backend.readWithJournal(id)).document, null);
        assert.deepEqual(await local.backend.readMeta(baseKey(id)), { version: null, content: null, tombstone: TOMBSTONE });
      } finally { local.close(); }
    }
    // create P refused, delete S: nothing ever reached the authority, so nothing is sent.
    {
      const local = open();
      try {
        const p = (await commitLocal(local, id, create("new\n"))).intent!;
        assert.equal(p.base, null);
        await inFlight(local.backend, p.requestId);
        const s = (await deleteLocal(local, id)).intent!;
        assert.equal(s.after, p.requestId);
        await local.backend.updateIntent(p.requestId, "in_flight", { state: "refused", attempts: 1, refusal: { code: CONTENT.code, message: CONTENT.message } });
        const transport = accepting();
        const report = await push(local, transport, { write: immediate });
        assert.deepEqual(report.rebased, [{ target: id, retired: [p.requestId, s.requestId], requestId: null, refusal: { code: CONTENT.code, message: CONTENT.message } }]);
        assert.deepEqual([report.settled, report.skipped, transport.sent], [[], [], []]);
        assert.deepEqual(await local.backend.readWithJournal(id).then(read => [read.document, read.intents]), [null, []]);
      } finally { local.close(); }
    }
    // delete P refused, write S: a replace at P's base, never a delete and a re-create.
    {
      const { remote, local } = await synced();
      try {
        const p = (await deleteLocal(local, id)).intent!;
        await inFlight(local.backend, p.requestId);
        const s = (await commitLocal(local, id, create("back\n"))).intent!;
        assert.deepEqual([s.base, s.after], [null, p.requestId]);
        await local.backend.updateIntent(p.requestId, "in_flight", { state: "refused", attempts: 1, refusal: { code: CONTENT.code, message: CONTENT.message } });
        const transport = counting(remote.transport);
        const report = await push(local, transport, { remote: remote.remote, write: immediate });
        const fresh = (await local.backend.readIntent(report.rebased![0]!.requestId))!;
        assert.deepEqual([fresh.kind, fresh.base, fresh.after, fresh.recreates, fresh.state], ["document.write", p.base, undefined, undefined, "acknowledged"]);
        assert.deepEqual(transport.sent, [fresh.requestId]);
        assert.equal((await remote.authority.read(id)).doc.body, "back\n");
      } finally { local.close(); }
    }
  });

  test(`${adapter}: a head refused for lost permission, or by a busy authority, is not folded`, async () => {
    // Lost permission: the pause stops push, and resume requeues P by its own identity.
    {
      const { remote, local, p, s } = await wedged("AUTH_REQUIRED");
      try {
        const before = await local.backend.readWithJournal(id);
        const paused = await push(local, remote.transport, { remote: remote.remote, write: immediate });
        assert.deepEqual([paused.paused, paused.rebased], [true, undefined]);
        assert.deepEqual(await local.backend.readWithJournal(id), before, "nothing was written");
        assert.equal((await resume(local)).requeued, 1);
        const transport = counting(remote.transport);
        const report = await push(local, transport, { remote: remote.remote, write: immediate });
        assert.equal(report.rebased, undefined);
        assert.deepEqual(transport.sent, [p.requestId, s.requestId], "P, then the chained edit, under their own identities");
        assert.equal((await remote.authority.read(id)).doc.body, "s\n");
      } finally { local.close(); }
    }
    // Unpaused and refused for lost permission, or refused busy: blocked, nothing written.
    for (const code of ["PERMISSION_DENIED", "concurrent_change"]) {
      const { remote, local, s } = await wedged(code);
      try {
        await local.backend.writeMeta("sync", { paused: false });
        const before = await local.backend.readWithJournal(id);
        const transport = counting(remote.transport);
        const report = await push(local, transport, { remote: remote.remote, write: immediate });
        assert.deepEqual([report.rebased, report.settled, report.skipped], [undefined, [], [{ requestId: s.requestId, target: id, reason: "blocked" }]], code);
        assert.deepEqual(transport.sent, []);
        assert.deepEqual(await local.backend.readWithJournal(id), before, `${code}: nothing was written`);
      } finally { local.close(); }
    }
  });

  test(`${adapter}: a successor that was ever claimed, and a conflicted head, are not folded`, async () => {
    // An attempted successor may have been delivered: it is never retired.
    {
      const { remote, local, s } = await wedged();
      try {
        await local.backend.updateIntent(s.requestId, "pending", { state: "in_flight", attempts: 1 });
        await local.backend.updateIntent(s.requestId, "in_flight", { state: "pending", attempts: 1 });
        const before = await local.backend.readWithJournal(id);
        const transport = counting(remote.transport);
        const report = await push(local, transport, { remote: remote.remote, write: immediate });
        assert.deepEqual([report.rebased, report.skipped.map(row => row.reason), transport.sent], [undefined, ["blocked"], []]);
        assert.deepEqual(await local.backend.readWithJournal(id), before);
      } finally { local.close(); }
    }
    // A conflicted head keeps its explicit resolution.
    {
      const { remote, local } = await synced();
      try {
        const p = (await commitLocal(local, id, edit("mine\n"))).intent!;
        await remote.authority.write(id, doc("theirs\n"));
        const first = await push(local, remote.transport, { remote: remote.remote, write: immediate });
        assert.deepEqual(first.settled.map(row => row.state), ["conflict"]);
        const s = (await commitLocal(local, id, edit("mine again\n"))).intent!;
        assert.equal(s.after, p.requestId);
        const before = await local.backend.readWithJournal(id);
        const transport = counting(remote.transport);
        const report = await push(local, transport, { remote: remote.remote, write: immediate });
        assert.deepEqual([report.rebased, report.skipped.map(row => row.reason), transport.sent], [undefined, ["blocked"], []]);
        assert.deepEqual(await local.backend.readWithJournal(id), before);
      } finally { local.close(); }
    }
  });

  test(`${adapter}: a commit from another realm between the fold's read and its write leaves the journal to that commit and reports blocked; the next push folds it`, async () => {
    const { remote, local, p } = await wedged();
    try {
      let raced = false;
      // The other realm commits just before the fold's guarded write reaches the store.
      const racing = new Proxy(local.backend, { get(inner, key) {
        if (key === "writeJournaled") return async (...args: Parameters<JournaledBackend["writeJournaled"]>) => {
          if (args[2]?.resolveIntents && !raced) { raced = true; await commitLocal(local, id, edit("racing\n")); }
          return inner.writeJournaled(...args);
        };
        const value = Reflect.get(inner, key, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      } }) as JournaledBackend;
      const transport = counting(remote.transport);
      const blocked = await push(racing, transport, { remote: remote.remote, write: immediate });
      assert.ok(raced);
      assert.deepEqual([blocked.rebased, blocked.settled, blocked.skipped.map(row => row.reason), transport.sent], [undefined, [], ["blocked"], []]);
      const chain = await unsettled(local);
      assert.deepEqual(chain.map(row => [row.requestId === p.requestId, row.state, row.after === p.requestId]), [[true, "refused", false], [false, "pending", true]], "only the racing commit's own compose moved the journal");
      assert.equal((await local.backend.read(id)).doc.body, "racing\n");
      const report = await push(local, transport, { remote: remote.remote, write: immediate });
      assert.deepEqual(report.rebased?.map(row => row.retired), [[p.requestId, chain[1]!.requestId]]);
      assert.deepEqual(report.settled.map(row => row.state), ["acknowledged"]);
      assert.equal((await remote.authority.read(id)).doc.body, "racing\n");
    } finally { local.close(); }
  });

  test(`${adapter}: QA: a working document that is not the successor's bytes (or, for a deletion, present) is not folded`, async () => {
    for (const shape of ["write", "delete"] as const) {
      const { remote, local } = await synced();
      try {
        const p = (await commitLocal(local, id, edit("p\n"))).intent!;
        await inFlight(local.backend, p.requestId);
        if (shape === "write") await commitLocal(local, id, edit("s\n")); else await deleteLocal(local, id);
        await local.backend.updateIntent(p.requestId, "in_flight", { state: "refused", attempts: 1, refusal: { code: CONTENT.code, message: CONTENT.message } });
        // A write that journals nothing moves the document under the chain: the fold must not send those bytes.
        const moved = await local.backend.readWithJournal(id);
        await local.backend.writeJournaled(id, doc("stray\n"), { expectedVersion: moved.document?.version ?? (null as unknown as string) });
        const before = await local.backend.readWithJournal(id);
        const transport = counting(remote.transport);
        const report = await push(local, transport, { remote: remote.remote, write: immediate });
        assert.deepEqual([report.rebased, report.settled, report.skipped.map(row => row.reason), transport.sent], [undefined, [], ["blocked"], []], shape);
        assert.deepEqual(await local.backend.readWithJournal(id), before, `${shape}: nothing was written`);
      } finally { local.close(); }
    }
  });

  test(`${adapter}: a folded intent refused again is a lone refused latest, which the next edit supersedes`, async () => {
    const { remote, local, p } = await wedged();
    try {
      const refusing = scripted(() => CONTENT);
      const report = await push(local, refusing, { write: immediate });
      const folded = report.rebased![0]!.requestId!;
      assert.deepEqual(report.settled, [{ requestId: folded, target: id, state: "refused" }]);
      assert.deepEqual(refusing.sent, [folded]);
      const chain = await unsettled(local);
      assert.deepEqual(chain.map(row => [row.requestId, row.state, row.after]), [[folded, "refused", undefined]]);
      // Nothing waits on it, so a push with no new edit sends nothing and folds nothing.
      const idle = await push(local, refusing, { write: immediate });
      assert.deepEqual([idle.rebased, idle.settled, idle.skipped, refusing.sent.length], [undefined, [], [], 1]);
      const next = (await commitLocal(local, id, edit("fixed\n"))).intent!;
      assert.equal(await local.backend.readIntent(folded), undefined, "the refused request is superseded");
      assert.deepEqual([next.base, next.after], [p.base, undefined]);
      const transport = counting(remote.transport);
      const delivered = await push(local, transport, { remote: remote.remote, write: immediate });
      assert.deepEqual([delivered.rebased, delivered.settled.map(row => row.state), transport.sent], [undefined, ["acknowledged"], [next.requestId]]);
      assert.equal((await remote.authority.read(id)).doc.body, "fixed\n");
    } finally { local.close(); }
  });
}
