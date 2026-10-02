// The engine's journaled deletion (`document.delete`) and the "deleted remotely" tombstone:
// composing a deletion like a write, settling its tombstone into the base, the working copy's own
// later re-create acknowledging it, `keep-local` on someone else's deletion acknowledging exactly
// the reviewed one, and a deletion in conflict resolved by keep or take.
import test from "node:test";
import assert from "node:assert/strict";
import type { OkfDocument, StorageBackend } from "@superbee/core";
import { DELETION_VERSION } from "@superbee/core/journaled-backend";
import type { OperationIntent, OperationTransport, Outcome } from "@superbee/core/uncertain-write";
import { versionOfBytes } from "@superbee/core/versioning";
import { stringifyDoc } from "@superbee/core/document-codec";
import { baseKey, commitLocal, deleteLocal, inspectConflict, openLocalBundle, push, resolveConflict, type SharedBase } from "../src/local-bundle.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";

const id = "notes/gone";
const TOMBSTONE = "sha256:" + "7".repeat(64);
const NEWER = "sha256:" + "8".repeat(64);
const immediate = { sleep: async () => {}, lookupDelayMs: 0, settlement: "recorded-only" as const };
const note = (body: string): OkfDocument => ({ id, frontmatter: { type: "Note", title: "Gone" }, body });

/** A remote whose head the test sets; only `read` is used by push and conflict review. */
function remoteOf(state: { head: OkfDocument | null }): StorageBackend {
  return {
    async read(target: string) {
      if (!state.head || target !== id) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      const raw = stringifyDoc(state.head.frontmatter, state.head.body ?? "");
      return { doc: state.head, version: versionOfBytes(raw) };
    },
  } as unknown as StorageBackend;
}

function scripted(answer: (intent: OperationIntent) => Outcome): OperationTransport & { sent: OperationIntent[] } {
  const sent: OperationIntent[] = [];
  return { sent, async submit(intent) { sent.push(intent); return answer(intent); }, async lookup() { return null; } };
}

/** A working copy holding `id` at a shared base, as a pull leaves it. */
async function synced(body = "shared\n") {
  const backend = new MemoryJournaledBackend();
  const local = openLocalBundle(`delete-${crypto.randomUUID()}`, { backend });
  const written = await backend.writeJournaled(id, note(body), { meta: ({ version, raw }) => [{ key: baseKey(id), value: { version, content: raw } }] });
  return { backend, local, base: written.version };
}

test("a deletion of a synced document is journaled against its base, settles its tombstone, and the working copy's own re-create acknowledges it", async () => {
  const { backend, local, base } = await synced();
  const deleted = await deleteLocal(local, id);
  assert.equal(deleted.deleted, true);
  assert.deepEqual([deleted.intent?.kind, deleted.intent?.base, deleted.intent?.local, deleted.intent?.content], ["document.delete", base, DELETION_VERSION, ""]);
  assert.equal((await backend.readWithJournal(id)).document, null);
  const transport = scripted(() => ({ kind: "committed", version: TOMBSTONE }));
  await push(local, transport, { remote: remoteOf({ head: null }), write: immediate });
  assert.equal((await backend.readIntent(deleted.intent!.requestId))?.state, "acknowledged");
  assert.deepEqual(await backend.readMeta<SharedBase>(baseKey(id)), { version: null, content: null, tombstone: TOMBSTONE });
  // Writing it again later is a create that acknowledges this working copy's own deletion.
  const again = await commitLocal(local, id, { mode: "replace-document", onAbsent: "create", buildCandidate: () => note("back\n") });
  assert.deepEqual([again.intent?.base, again.intent?.recreates], [null, TOMBSTONE]);
  assert.deepEqual(await deleteLocal(local, "notes/never"), { deleted: false, intent: null }, "an absent document is not an error");
});

test("a deletion collapses over changes that never left: a never-sent create leaves nothing, a write after a never-sent delete is a replace", async () => {
  const backend = new MemoryJournaledBackend();
  const local = openLocalBundle(`delete-${crypto.randomUUID()}`, { backend });
  await commitLocal(local, id, { mode: "replace-document", onAbsent: "create", buildCandidate: () => note("draft\n") });
  const dropped = await deleteLocal(local, id);
  assert.deepEqual([dropped.deleted, dropped.intent], [true, null]);
  assert.deepEqual(await backend.listIntents(["pending"]), [], "nothing is left to send");

  const { backend: b2, local: l2, base } = await synced();
  await deleteLocal(l2, id);
  const rewritten = await commitLocal(l2, id, { mode: "replace-document", onAbsent: "create", buildCandidate: () => note("changed my mind\n") });
  const pending = await b2.listIntents(["pending"]);
  assert.deepEqual(pending.map((row) => [row.kind, row.base]), [["document.write", base]], "one replace against the base, never a delete and a create");
  assert.equal(rewritten.intent?.recreates, undefined);
});

test("keep-local on a 'deleted remotely' conflict re-creates acknowledging exactly the reviewed tombstone; a newer deletion is a conflict again", async () => {
  const { backend, local } = await synced();
  await commitLocal(local, id, { mode: "replace-document", buildCandidate: () => note("mine\n") });
  const remote = remoteOf({ head: null });
  await push(local, scripted(() => ({ kind: "conflict", actual: null, tombstone: TOMBSTONE })), { remote, write: immediate });
  const conflicted = (await backend.listIntents(["conflict"]))[0]!;
  assert.deepEqual(conflicted.remote, { version: null, content: null, tombstone: TOMBSTONE });
  const review = await inspectConflict(local, remote, id);
  assert.deepEqual(review.remote, { version: null, content: null, tombstone: TOMBSTONE });
  const kept = await resolveConflict(local, remote, review, { kind: "keep-local" });
  assert.deepEqual([kept.intent?.base, kept.intent?.recreates], [null, TOMBSTONE]);
  // The authority deleted it again meanwhile: the stale acknowledgement is refused into a new conflict.
  const transport = scripted(() => ({ kind: "conflict", actual: null, tombstone: NEWER }));
  await push(local, transport, { remote, write: immediate });
  assert.equal(transport.sent[0]!.recreates, TOMBSTONE);
  const again = await inspectConflict(local, remote, id);
  assert.equal(again.remote.tombstone, NEWER);
  await assert.rejects(resolveConflict(local, remote, { ...again, remote: { ...again.remote, tombstone: TOMBSTONE } }, { kind: "keep-local" }), { name: "ConflictReviewStaleError" });
});

test("a deletion in conflict: keep deletes the shared head as it is now, take brings it back, revise is refused", async () => {
  for (const choice of ["keep-local", "take-remote", "revise"] as const) {
    const { backend, local } = await synced();
    await deleteLocal(local, id);
    const state = { head: note("theirs\n") as OkfDocument | null };
    const remote = remoteOf(state);
    const theirs = (await remote.read(id)).version;
    await push(local, scripted(() => ({ kind: "conflict", actual: theirs })), { remote, write: immediate });
    const review = await inspectConflict(local, remote, id);
    assert.equal(review.local.deleted, true);
    assert.equal(review.remote.version, theirs);
    if (choice === "revise") {
      await assert.rejects(resolveConflict(local, remote, review, { kind: "revise", body: "x\n" }), { name: "InvalidInputError" });
      continue;
    }
    const result = await resolveConflict(local, remote, review, { kind: choice });
    if (choice === "keep-local") {
      assert.deepEqual([result.intent?.kind, result.intent?.base], ["document.delete", theirs]);
      assert.equal((await backend.readWithJournal(id)).document, null);
    } else {
      assert.equal(result.intent, null);
      assert.equal((await backend.read(id)).doc.body, "theirs\n");
      assert.deepEqual(await backend.listIntents(["pending", "conflict"]), []);
    }
  }
});

test("a successor chained behind an acknowledged predecessor takes the authority's committed version (QA L1) or its tombstone (review S3)", async () => {
  // An edit the authority committed at its own serialization, then a delete chained behind it.
  const { backend, local } = await synced();
  await commitLocal(local, id, { mode: "replace-document", buildCandidate: () => note("mine\n") });
  const lost = scripted(() => ({ kind: "unknown" }));
  await push(local, lost, { remote: remoteOf({ head: null }), write: { ...immediate, maxSubmissions: 1, maxLookups: 1 } });
  const chained = await deleteLocal(local, id);
  const edit = (await backend.listIntents(["pending"])).find((row) => row.kind === "document.write")!;
  assert.equal(chained.intent?.base, edit.local);
  const HOSTED = "sha256:" + "5".repeat(64);
  const sent: OperationIntent[] = [];
  const answer: OperationTransport = {
    async submit(intent) { sent.push(intent); return intent.kind === "document.delete" ? { kind: "committed", version: TOMBSTONE } : { kind: "committed", version: HOSTED }; },
    async lookup(requestId) { return requestId === edit.requestId ? { kind: "committed", version: HOSTED } : null; },
  };
  await push(local, answer, { remote: remoteOf({ head: null }), write: immediate });
  const deletion = sent.find((row) => row.kind === "document.delete")!;
  assert.equal(deletion.base, HOSTED, "the delete is against what the authority committed, not the local serialization");

  // A re-create chained behind the working copy's own in-flight delete acknowledges its tombstone.
  const second = await synced();
  const own = await deleteLocal(second.local, id);
  await push(second.local, scripted(() => ({ kind: "unknown" })), { remote: remoteOf({ head: null }), write: { ...immediate, maxSubmissions: 1, maxLookups: 1 } });
  await commitLocal(second.local, id, { mode: "replace-document", onAbsent: "create", buildCandidate: () => note("back\n") });
  const creates: OperationIntent[] = [];
  await push(second.local, {
    async submit(intent) { creates.push(intent); return { kind: "committed", version: HOSTED }; },
    async lookup(requestId) { return requestId === own.intent!.requestId ? { kind: "committed", version: TOMBSTONE } : null; },
  }, { remote: remoteOf({ head: null }), write: immediate });
  assert.deepEqual(creates.map((row) => [row.base, row.recreates]), [[null, TOMBSTONE]]);
});
