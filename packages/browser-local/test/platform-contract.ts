/**
 * The platform contract kit: one synthetic bundle, one row table, two execution modes. Every
 * row names a verb, its inputs, and the expected outcome per mode; the runner executes each row
 * against a fresh session of each mode and, for rows whose outcome must be identical, asserts
 * the observations equal across modes. After every row the runner sweeps every document and
 * checks the provenance invariant: a result is `shared-confirmed` only when no unsettled intent
 * exists for that id, `local-pending` or `local-conflict` only when one does and names it,
 * `local-conflict` whenever any conflict intent exists for the id, and nothing is unconfirmed.
 *
 * Token spaces: `version` is each runtime's own premise token and `acknowledged` the
 * authority's. Parity rows compare documents and `acknowledged` across modes; they also compare
 * `version`, which is equal across modes only because the kit's harnesses seed a memory
 * authority that mints the working copy's own token. The case where the two differ (a
 * filesystem authority over hand-authored files) is proved by the filesystem-authority test in
 * `platform-contract.test.ts`, not by a parity row.
 *
 * The kit is a module, not a test file: the Node proof (`platform-contract.test.ts`) runs every
 * row over fake-indexeddb and the in-process fixture; the Chromium proof
 * (`platform.browser.spec.ts`) runs the model rows through a page's runtime, so the same
 * expectations hold for the proof page's presentation. A harness supplies sessions; the kit
 * never touches a store, a transport, or a fixture directly.
 */

import assert from "node:assert/strict";

import type { OkfDocument, StorageBackend, Version } from "@superbee/core";
import type { ExecutionMode, PlatformDocument, PlatformRuntime, Provenance } from "@superbee/core/platform";

export const MODES: readonly ExecutionMode[] = ["request-driven", "browser-local"];

/** A fixed clock for every commit, so both modes mint the same version for the same edit. */
export const CONTRACT_NOW = "2026-09-10T12:00:00.000Z";
export const CONTRACT_ACTOR = "process:contract-kit";

// ── the synthetic bundle ───────────────────────────────────────────────────────────────────

/** Two kinds, each with a required field beyond `title`; four records, two of them linked. */
export function syntheticBundle(): OkfDocument[] {
  return [
    {
      id: "conventions/note",
      frontmatter: { type: "Convention", title: "Note", governs: "Note", fields: { required: ["title", "status"], optional: ["tags"], values: { status: ["draft", "final"] } } },
      body: "A note carries a status.\n",
    },
    {
      id: "conventions/task",
      frontmatter: { type: "Convention", title: "Task", governs: "Task", fields: { required: ["title", "owner"], optional: ["tags"] } },
      body: "A task names its owner.\n",
    },
    { id: "notes/alpha", frontmatter: { type: "Note", title: "Alpha", status: "draft", tags: ["proof", "alpha"] }, body: "alpha v1, see [beta](../notes/beta.md).\n" },
    { id: "notes/beta", frontmatter: { type: "Note", title: "Beta", status: "final", tags: ["proof"] }, body: "beta v1\n" },
    { id: "tasks/one", frontmatter: { type: "Task", title: "Task one", tags: ["proof"] }, body: "task one has no owner\n" },
    { id: "tasks/two", frontmatter: { type: "Task", title: "Task two", owner: "human:mike", tags: ["proof"] }, body: "task two, see [alpha](../notes/alpha.md).\n" },
  ];
}

export const SYNTHETIC_IDS: readonly string[] = syntheticBundle().map((doc) => doc.id).sort();

export async function seedSyntheticBundle(authority: StorageBackend): Promise<void> {
  for (const doc of syntheticBundle()) await authority.write(doc.id, doc);
}

// ── the harness contract ───────────────────────────────────────────────────────────────────

export type WriteKnob = "unauthorized" | "dropAfterApply" | "failBeforeApply";

export interface AuthorityHandle {
  read(id: string): Promise<{ version: Version; body: string }>;
  /** A body edit applied directly at the authority, as another client would make it. */
  write(id: string, body: string): Promise<Version>;
  /**
   * A deletion applied directly at the authority, as another client would make it. The
   * harness records the id: the invariant sweep accepts absence only for ids deleted this way.
   */
  delete(id: string): Promise<void>;
}

/**
 * The authority handle over one fixture's `MemoryBackend`, recording every id it deletes into
 * `absent`. Both harnesses (Node, and the Chromium page session) build theirs here so the
 * sweep's notion of expected absence is one definition.
 */
export function authorityHandle(authority: StorageBackend, absent: Set<string>): AuthorityHandle {
  return {
    read: async (id) => {
      const { doc, version } = await authority.read(id);
      return { version, body: doc.body };
    },
    write: async (id, body) => {
      const { doc, version } = await authority.read(id);
      return authority.write(id, { ...doc, body }, { expectedVersion: version });
    },
    delete: async (id) => {
      await authority.delete(id);
      absent.add(id);
    },
  };
}

export interface UnsettledIntent {
  requestId: string;
  state: string;
}

/** One client of one mode over one freshly seeded authority. */
export interface ContractSession {
  mode: ExecutionMode;
  runtime: PlatformRuntime;
  authority: AuthorityHandle;
  /** A second client of the same mode over the same authority. */
  secondClient(): Promise<PlatformRuntime>;
  /** Cut the client off from the authority (or reconnect it). */
  setOffline(flag: boolean): Promise<void>;
  /** Flip one of the authority's write faults. */
  setKnob(name: WriteKnob, flag: boolean): Promise<void>;
  /** Unsettled intents journaled for `id`; always empty in request-driven mode. */
  unsettled(id: string): Promise<UnsettledIntent[]>;
  /** The ids this session deleted at the authority through its handle: the only ids the sweep accepts as absent. */
  expectedAbsent(): readonly string[];
  /** Back online with every knob cleared; the invariant sweep runs after this. */
  restore(): Promise<void>;
  close(): Promise<void>;
}

export interface ContractHarness {
  open(mode: ExecutionMode): Promise<ContractSession>;
}

// ── rows ───────────────────────────────────────────────────────────────────────────────────

export interface ContractRow {
  verb: string;
  name: string;
  inputs: Record<string, unknown>;
  /** The expected outcome per mode, in words; the assertions in `run` are its executable form. */
  outcome: Record<ExecutionMode, string>;
  /** The observation `run` returns must be deepEqual across modes. */
  parity: boolean;
  /** `model` rows need only a runtime; `sync` rows also drive the authority and its faults. */
  scope: "model" | "sync";
  run(session: ContractSession): Promise<unknown>;
}

interface NamedError {
  name: string;
  code?: string;
  status?: number;
}

async function rejection(work: () => Promise<unknown>): Promise<NamedError> {
  try {
    await work();
  } catch (error) {
    const err = error as { name?: unknown; code?: unknown; status?: unknown };
    return {
      name: typeof err?.name === "string" ? err.name : "Error",
      ...(typeof err?.code === "string" ? { code: err.code } : {}),
      ...(typeof err?.status === "number" ? { status: err.status } : {}),
    };
  }
  throw new Error("expected a rejection");
}

function expectState<S extends Provenance["state"]>(provenance: Provenance, state: S, label: string): Extract<Provenance, { state: S }> {
  assert.equal(provenance.state, state, `${label}: provenance`);
  return provenance as Extract<Provenance, { state: S }>;
}

/** An edit in words for the row's outcome column. */
const carrier = "rejects with the carrier error";

export function platformContractRows(): ContractRow[] {
  return [
    {
      verb: "read",
      name: "reads one record",
      inputs: { id: "notes/alpha" },
      outcome: {
        "request-driven": "the authority's document, shared-confirmed with version and acknowledged the authority's token",
        "browser-local": "the working copy's document, shared-confirmed with acknowledged the authority's token and version the working copy's (equal here only because the memory authority mints the same token)",
      },
      parity: true,
      scope: "model",
      async run({ runtime, authority }) {
        const result = await runtime.read("notes/alpha");
        const shared = expectState(result.provenance, "shared-confirmed", "read");
        assert.equal(shared.acknowledged, (await authority.read("notes/alpha")).version, "acknowledged is the authority's token");
        return result;
      },
    },
    {
      verb: "query",
      name: "queries by type",
      inputs: { filter: { type: "Note" } },
      outcome: { "request-driven": "the two notes in id order, shared-confirmed", "browser-local": "the same two rows, shared-confirmed" },
      parity: true,
      scope: "model",
      async run({ runtime }) {
        const rows = await runtime.query({ type: "Note" });
        assert.deepEqual(rows.map((row) => row.id), ["notes/alpha", "notes/beta"]);
        for (const row of rows) {
          expectState(row.provenance, "shared-confirmed", row.id);
          assert.equal(row.version, row.provenance.version, `${row.id}: the row's version is the runtime's own premise token`);
        }
        return rows;
      },
    },
    {
      verb: "query",
      name: "queries by tag",
      inputs: { filter: { tags: ["proof"] } },
      outcome: { "request-driven": "every tagged record in id order, shared-confirmed", "browser-local": "the same rows, shared-confirmed" },
      parity: true,
      scope: "model",
      async run({ runtime }) {
        const rows = await runtime.query({ tags: ["proof"] });
        assert.deepEqual(rows.map((row) => row.id), ["notes/alpha", "notes/beta", "tasks/one", "tasks/two"]);
        return rows;
      },
    },
    {
      verb: "validate",
      name: "validates a record that violates its kind",
      inputs: { id: "tasks/one" },
      outcome: { "request-driven": "one KIND_FIELD_MISSING warning for owner", "browser-local": "the identical warning" },
      parity: true,
      scope: "model",
      async run({ runtime }) {
        const result = await runtime.validate("tasks/one");
        assert.deepEqual(result.warnings.map((warning) => [warning.code, warning.field]), [["KIND_FIELD_MISSING", "owner"]]);
        expectState(result.provenance, "shared-confirmed", "validate");
        return result;
      },
    },
    {
      verb: "validate",
      name: "validates a conforming record",
      inputs: { id: "notes/alpha" },
      outcome: { "request-driven": "no warnings", "browser-local": "no warnings" },
      parity: true,
      scope: "model",
      async run({ runtime }) {
        const result = await runtime.validate("notes/alpha");
        assert.deepEqual(result.warnings, []);
        return result;
      },
    },
    {
      verb: "commit",
      name: "commits online",
      inputs: { id: "notes/alpha", body: "alpha v2\n" },
      outcome: {
        "request-driven": "shared-confirmed at the new version at once; a second client reads it",
        "browser-local": "local-pending with a requestId; after sync, shared-confirmed at the version the authority holds; a second client reads it after its own sync",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const second = await session.secondClient();
        const before = await runtime.read("notes/alpha");
        const commit = await runtime.commit("notes/alpha", { body: "alpha v2\n", expectedVersion: before.provenance.version });
        assert.equal(commit.changed, true);
        if (mode === "request-driven") {
          const shared = expectState(commit.provenance, "shared-confirmed", "commit");
          assert.equal((await authority.read("notes/alpha")).version, shared.version);
        } else {
          const pending = expectState(commit.provenance, "local-pending", "commit");
          assert.ok(pending.requestId.length > 0, "the journaled intent's requestId");
          assert.equal(pending.base, before.provenance.version);
          assert.equal((await authority.read("notes/alpha")).body, "alpha v1, see [beta](../notes/beta.md).\n", "the authority is untouched by a local commit");
          expectState((await runtime.read("notes/alpha")).provenance, "local-pending", "read before sync");
          assert.equal((await runtime.syncStatus()).pending, 1);
          const status = await runtime.sync();
          assert.equal(status.pending, 0);
          assert.equal(status.online, true);
        }
        const after = await runtime.read("notes/alpha");
        const shared = expectState(after.provenance, "shared-confirmed", "read after commit");
        const held = await authority.read("notes/alpha");
        assert.equal(shared.acknowledged, held.version);
        assert.equal(after.doc.body, "alpha v2\n");
        assert.equal(held.body, "alpha v2\n");

        await second.sync();
        const observed = await second.read("notes/alpha");
        assert.equal(observed.doc.body, "alpha v2\n");
        assert.equal(expectState(observed.provenance, "shared-confirmed", "second client").acknowledged, held.version);
        return { version: held.version, body: held.body };
      },
    },
    {
      verb: "commit",
      name: "commits offline",
      inputs: { id: "notes/beta", body: "beta v2 (offline)\n" },
      outcome: {
        "request-driven": `${carrier}; the authority is unchanged`,
        "browser-local": "local-pending; read returns the local body as local-pending; one pending intent; the authority is unchanged",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const before = await authority.read("notes/beta");
        await session.setOffline(true);
        if (mode === "request-driven") {
          const error = await rejection(() => runtime.commit("notes/beta", { body: "beta v2 (offline)\n" }));
          assert.equal(error.name, "TypeError", "the carrier's own error");
          assert.equal((await runtime.syncStatus()).online, false);
        } else {
          const commit = await runtime.commit("notes/beta", { body: "beta v2 (offline)\n" });
          expectState(commit.provenance, "local-pending", "commit");
          const read = await runtime.read("notes/beta");
          assert.equal(read.doc.body, "beta v2 (offline)\n");
          expectState(read.provenance, "local-pending", "read");
          assert.equal((await runtime.syncStatus()).pending, 1);
          const status = await runtime.sync();
          assert.equal(status.pending, 1, "a sync that cannot reach the authority leaves the intent pending");
          assert.equal(status.online, false);
          expectState((await runtime.read("notes/beta")).provenance, "local-pending", "read after failed sync");
        }
        assert.deepEqual(await authority.read("notes/beta"), before, "the authority is unchanged");
        return null;
      },
    },
    {
      verb: "commit",
      name: "commits over a premise the authority has moved past",
      inputs: { id: "notes/alpha", body: "alpha local edit\n", premise: "the version read before the remote edit" },
      outcome: {
        "request-driven": "rejects with VersionConflict at commit time; the authority keeps the remote edit",
        "browser-local": "local-pending at commit; after sync the document is local-conflict with remote at the authority's version and the local body retained",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const premise = (await runtime.read("notes/alpha")).provenance.version;
        if (mode === "request-driven") {
          const moved = await authority.write("notes/alpha", "alpha remote edit\n");
          const error = await rejection(() => runtime.commit("notes/alpha", { body: "alpha local edit\n", expectedVersion: premise }));
          assert.equal(error.name, "VersionConflict");
          assert.equal((await authority.read("notes/alpha")).version, moved);
          expectState((await runtime.read("notes/alpha")).provenance, "shared-confirmed", "read after conflict");
        } else {
          const commit = await runtime.commit("notes/alpha", { body: "alpha local edit\n", expectedVersion: premise });
          const pending = expectState(commit.provenance, "local-pending", "commit");
          const moved = await authority.write("notes/alpha", "alpha remote edit\n");
          const status = await runtime.sync();
          assert.equal(status.conflicts, 1);
          assert.equal(status.pending, 0);
          const read = await runtime.read("notes/alpha");
          const conflict = expectState(read.provenance, "local-conflict", "read after sync");
          assert.equal(conflict.remote, moved);
          assert.equal(conflict.base, premise);
          assert.equal(conflict.requestId, pending.requestId);
          assert.equal(read.doc.body, "alpha local edit\n", "the local body is retained");
          assert.equal((await authority.read("notes/alpha")).body, "alpha remote edit\n", "nothing overwrote the authority");
        }
        return null;
      },
    },
    {
      verb: "commit",
      name: "commits again over a document in conflict",
      inputs: { id: "notes/alpha", first: "alpha local edit\n", second: "alpha local edit, again\n" },
      outcome: {
        "request-driven": "the first commit rejects with VersionConflict at its stale premise; the second, at the premise the read reports, lands shared-confirmed; nothing is pending",
        "browser-local": "after sync the document is local-conflict; a second commit at the version the read reports is accepted but the document stays local-conflict with the conflict intent's remote and requestId, with conflicts 1 and pending 1",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const premise = (await runtime.read("notes/alpha")).provenance.version;
        if (mode === "request-driven") {
          await authority.write("notes/alpha", "alpha remote edit\n");
          assert.equal((await rejection(() => runtime.commit("notes/alpha", { body: "alpha local edit\n", expectedVersion: premise }))).name, "VersionConflict");
          const fresh = await runtime.read("notes/alpha");
          const commit = await runtime.commit("notes/alpha", { body: "alpha local edit, again\n", expectedVersion: fresh.provenance.version });
          assert.equal(expectState(commit.provenance, "shared-confirmed", "second commit").acknowledged, (await authority.read("notes/alpha")).version);
          assert.equal((await runtime.syncStatus()).pending, 0);
        } else {
          const first = expectState((await runtime.commit("notes/alpha", { body: "alpha local edit\n", expectedVersion: premise })).provenance, "local-pending", "first commit");
          const moved = await authority.write("notes/alpha", "alpha remote edit\n");
          await runtime.sync();
          const inConflict = expectState((await runtime.read("notes/alpha")).provenance, "local-conflict", "read after sync");
          assert.equal(inConflict.requestId, first.requestId);
          const second = await runtime.commit("notes/alpha", { body: "alpha local edit, again\n", expectedVersion: inConflict.version });
          assert.equal(second.changed, true);
          const conflict = expectState(second.provenance, "local-conflict", "second commit");
          const read = await runtime.read("notes/alpha");
          assert.equal(read.doc.body, "alpha local edit, again\n", "the second edit is in the working copy");
          const still = expectState(read.provenance, "local-conflict", "read after second commit");
          assert.equal(still.remote, moved, "remote is the conflict intent's shared head");
          assert.equal(still.requestId, first.requestId, "the conflict intent, not the chained edit, names the document");
          assert.equal(conflict.requestId, first.requestId);
          const status = await runtime.syncStatus();
          assert.equal(status.conflicts, 1);
          assert.equal(status.pending, 1, "the chained edit waits behind the conflict");
          assert.deepEqual((await session.unsettled("notes/alpha")).map((row) => row.state), ["conflict", "pending"]);
          assert.equal((await authority.read("notes/alpha")).body, "alpha remote edit\n", "nothing overwrote the authority");
        }
        return null;
      },
    },
    {
      verb: "commit",
      name: "commits after access is revoked",
      inputs: { id: "tasks/two", body: "task two after revocation\n" },
      outcome: {
        "request-driven": "rejects with the 401 refusal; the authority is unchanged",
        "browser-local": "local-pending; sync pauses with the refusal as its reason and the intent refused; read shows the retained local body, never shared-confirmed",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const before = await authority.read("tasks/two");
        await session.setKnob("unauthorized", true);
        if (mode === "request-driven") {
          const error = await rejection(() => runtime.commit("tasks/two", { body: "task two after revocation\n" }));
          assert.deepEqual(error, { name: "RemoteError", code: "AUTH_REQUIRED", status: 401 });
          assert.equal((await runtime.syncStatus()).online, true, "the authority answered");
        } else {
          const commit = await runtime.commit("tasks/two", { body: "task two after revocation\n" });
          const pending = expectState(commit.provenance, "local-pending", "commit");
          const status = await runtime.sync();
          assert.equal(status.paused, true);
          assert.match(status.pausedReason ?? "", /AUTH_REQUIRED/);
          assert.equal(status.refused, 1);
          assert.equal(status.pending, 0);
          assert.deepEqual(await session.unsettled("tasks/two"), [{ requestId: pending.requestId, state: "refused" }]);
          const read = await runtime.read("tasks/two");
          assert.equal(read.doc.body, "task two after revocation\n");
          assert.equal(expectState(read.provenance, "local-pending", "read after refusal").requestId, pending.requestId);
        }
        assert.deepEqual(await authority.read("tasks/two"), before, "the authority is unchanged");
        return null;
      },
    },
    {
      verb: "sync",
      name: "settles a write whose acknowledgement was lost",
      inputs: { id: "notes/beta", body: "beta v2 (lost ack)\n", knob: "dropAfterApply" },
      outcome: {
        "request-driven": `${carrier} although the authority applied the write; the mode cannot tell`,
        "browser-local": "sync settles the intent through lookup; read is shared-confirmed at the authority's version; nothing is pending",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const before = await authority.read("notes/beta");
        if (mode === "request-driven") {
          await session.setKnob("dropAfterApply", true);
          const error = await rejection(() => runtime.commit("notes/beta", { body: "beta v2 (lost ack)\n" }));
          assert.equal(error.name, "TypeError");
          const held = await authority.read("notes/beta");
          assert.notEqual(held.version, before.version, "the authority applied the write the client could not confirm");
          assert.equal(held.body, "beta v2 (lost ack)\n");
          await session.setKnob("dropAfterApply", false);
          expectState((await runtime.read("notes/beta")).provenance, "shared-confirmed", "a later read confirms it");
        } else {
          const commit = await runtime.commit("notes/beta", { body: "beta v2 (lost ack)\n" });
          expectState(commit.provenance, "local-pending", "commit");
          await session.setKnob("dropAfterApply", true);
          const status = await runtime.sync();
          assert.equal(status.pending, 0);
          assert.equal(status.conflicts, 0);
          const held = await authority.read("notes/beta");
          assert.equal(held.body, "beta v2 (lost ack)\n");
          const read = await runtime.read("notes/beta");
          assert.equal(expectState(read.provenance, "shared-confirmed", "read after sync").acknowledged, held.version);
          assert.deepEqual(await session.unsettled("notes/beta"), []);
        }
        return null;
      },
    },
    {
      verb: "sync",
      name: "keeps a write the carrier dropped before the authority saw it",
      inputs: { id: "notes/beta", body: "beta v2 (never arrived)\n", knob: "failBeforeApply" },
      outcome: {
        "request-driven": `${carrier}; the authority is unchanged`,
        "browser-local": "sync leaves the intent pending; read stays local-pending; one pending intent; the authority is unchanged",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const before = await authority.read("notes/beta");
        if (mode === "request-driven") {
          await session.setKnob("failBeforeApply", true);
          const error = await rejection(() => runtime.commit("notes/beta", { body: "beta v2 (never arrived)\n" }));
          assert.equal(error.name, "TypeError");
        } else {
          const commit = await runtime.commit("notes/beta", { body: "beta v2 (never arrived)\n" });
          const pending = expectState(commit.provenance, "local-pending", "commit");
          await session.setKnob("failBeforeApply", true);
          const status = await runtime.sync();
          assert.equal(status.pending, 1);
          const read = await runtime.read("notes/beta");
          assert.equal(read.doc.body, "beta v2 (never arrived)\n");
          assert.equal(expectState(read.provenance, "local-pending", "read after sync").requestId, pending.requestId);
          assert.equal((await runtime.syncStatus()).pending, 1);
        }
        assert.deepEqual(await authority.read("notes/beta"), before, "the authority is unchanged");
        return null;
      },
    },
    {
      verb: "sync",
      name: "reconciles a document the authority deleted",
      inputs: { deleted: "tasks/one", edited: "notes/beta", body: "beta v2 (over a deletion)\n" },
      outcome: {
        "request-driven": "read of the deleted document rejects ENOENT and query omits it; a commit at the premise read before the deletion rejects; nothing is pending",
        "browser-local": "after sync the deleted document is gone from the working copy (read rejects ENOENT, query omits it); the document with a pending edit is retained as local-conflict with remote null and its body kept",
      },
      parity: false,
      scope: "sync",
      async run(session) {
        const { runtime, authority, mode } = session;
        const premise = (await runtime.read("notes/beta")).provenance.version;
        let pending: string | null = null;
        if (mode === "browser-local") {
          const commit = await runtime.commit("notes/beta", { body: "beta v2 (over a deletion)\n", expectedVersion: premise });
          pending = expectState(commit.provenance, "local-pending", "commit").requestId;
        }
        await authority.delete("tasks/one");
        await authority.delete("notes/beta");
        const status = await runtime.sync();
        const absent = await rejection(() => runtime.read("tasks/one"));
        assert.equal(absent.code, "ENOENT", "the deleted document reads as absent");
        assert.deepEqual((await runtime.query({ type: "Task" })).map((row) => row.id), ["tasks/two"], "query omits the deleted document");
        if (mode === "request-driven") {
          assert.equal(status.pending, 0);
          const error = await rejection(() => runtime.commit("notes/beta", { body: "beta v2 (over a deletion)\n", expectedVersion: premise }));
          assert.equal(error.name, "DocumentNotFoundError", "a commit at a premise the authority deleted from under rejects");
          assert.equal((await rejection(() => runtime.read("notes/beta"))).code, "ENOENT");
        } else {
          assert.equal(status.conflicts, 1);
          assert.equal(status.pending, 0);
          const read = await runtime.read("notes/beta");
          const conflict = expectState(read.provenance, "local-conflict", "read after sync");
          assert.equal(conflict.remote, null, "the authority holds nothing for the id");
          assert.equal(conflict.base, premise);
          assert.equal(conflict.requestId, pending);
          assert.equal(read.doc.body, "beta v2 (over a deletion)\n", "the local edit is retained");
          assert.deepEqual((await runtime.query({ type: "Note" })).map((row) => [row.id, row.provenance.state]), [["notes/alpha", "shared-confirmed"], ["notes/beta", "local-conflict"]]);
        }
        return null;
      },
    },
    {
      verb: "errors",
      name: "rejects an invalid id and an absent id with the same typed errors",
      inputs: { invalid: ["", "/absolute"], absent: "notes/missing" },
      outcome: { "request-driven": "InvalidInputError for the invalid ids, ENOENT for the absent read, DocumentNotFoundError for the absent commit", "browser-local": "the same error classes" },
      parity: true,
      scope: "model",
      async run({ runtime }) {
        return {
          readEmpty: await rejection(() => runtime.read("")),
          readAbsolute: await rejection(() => runtime.read("/absolute")),
          validateEmpty: await rejection(() => runtime.validate("")),
          commitAbsolute: await rejection(() => runtime.commit("/absolute", { body: "x\n" })),
          readAbsent: await rejection(() => runtime.read("notes/missing")),
          validateAbsent: await rejection(() => runtime.validate("notes/missing")),
          commitAbsent: await rejection(() => runtime.commit("notes/missing", { body: "x\n" })),
        };
      },
    },
  ];
}

// ── the runner ─────────────────────────────────────────────────────────────────────────────

/**
 * The provenance invariant over every document: `shared-confirmed` only with no unsettled
 * intent for the id; `local-pending` or `local-conflict` only with one, and naming it; and,
 * whatever state was derived, `local-conflict` exactly when a conflict intent exists for the
 * id. A document the runtime no longer holds is absent only if the row deleted it at the
 * authority (the session records those ids), and then has no unsettled intent, since a held
 * document is never removed; any other absence is a document the runtime lost. Nothing in the
 * working copy is unconfirmed.
 */
export async function assertProvenanceInvariant(session: ContractSession): Promise<void> {
  const expectedAbsent = new Set(session.expectedAbsent());
  for (const id of SYNTHETIC_IDS) {
    let document: PlatformDocument;
    try {
      document = await session.runtime.read(id);
    } catch (error) {
      assert.equal((error as { code?: unknown }).code, "ENOENT", `${session.mode} '${id}': read rejected with something other than absence`);
      assert.ok(expectedAbsent.has(id), `${session.mode} '${id}': absent, but the row never deleted it at the authority`);
      assert.deepEqual(await session.unsettled(id), [], `${session.mode} '${id}': absent with an unsettled intent`);
      continue;
    }
    const { provenance } = document;
    const unsettled = await session.unsettled(id);
    const conflicted = unsettled.some((row) => row.state === "conflict");
    assert.equal(provenance.state === "local-conflict", conflicted, `${session.mode} '${id}': ${provenance.state} with ${conflicted ? "a" : "no"} conflict intent`);
    if (provenance.state === "shared-confirmed") {
      assert.deepEqual(unsettled, [], `${session.mode} '${id}': shared-confirmed with an unsettled intent`);
    } else {
      assert.ok(unsettled.length > 0, `${session.mode} '${id}': ${provenance.state} with no unsettled intent`);
      assert.ok(unsettled.some((row) => row.requestId === provenance.requestId), `${session.mode} '${id}': ${provenance.state} names an intent the journal does not hold`);
    }
  }
  assert.equal((await session.runtime.syncStatus()).unconfirmed, 0, `${session.mode}: unconfirmed documents in the working copy`);
}

/** Run one row against one mode: a fresh session, the row, the invariant sweep, and cleanup. */
export async function runRowInMode(harness: ContractHarness, row: ContractRow, mode: ExecutionMode): Promise<unknown> {
  const session = await harness.open(mode);
  try {
    const observation = await row.run(session);
    await session.restore();
    await assertProvenanceInvariant(session);
    return observation;
  } finally {
    await session.close();
  }
}

/** Run one row against both modes and, for a parity row, assert the observations equal. */
export async function runRow(harness: ContractHarness, row: ContractRow): Promise<Record<ExecutionMode, unknown>> {
  const observations = {} as Record<ExecutionMode, unknown>;
  for (const mode of MODES) observations[mode] = await runRowInMode(harness, row, mode);
  if (row.parity) {
    assert.deepEqual(observations["browser-local"], observations["request-driven"], `${row.verb}: ${row.name}: the two modes disagree`);
  }
  return observations;
}
