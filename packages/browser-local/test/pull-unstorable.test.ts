// The working copy's own rule, whichever client drives it: a document whose frontmatter cannot be
// stored is held and named, everything else proceeds, and the next pull reads it again.
import test from "node:test";
import assert from "node:assert/strict";

import { FrontmatterRefusedError } from "@superbee/core/document-codec";
import type { ConceptId, OkfDocument, ReadResult, StorageBackend } from "@superbee/core";
import { headsDigest, sortHeads, type DocumentHead, type RemoteBackend, type WireCapabilities } from "@superbee/core/remote";

import { baseKey, bootstrap, commitLocal, openLocalBundle, pull, syncStatus, type LocalBundle, type PullMarker, type SharedBase } from "../src/local-bundle.ts";
import { createBrowserLocalRuntime } from "../src/platform/browser-local.ts";
import { MemoryJournaledBackend } from "./fixtures/memory-journaled-backend.ts";

const BIG = { type: "Note", title: "Big", blob: "x".repeat(300 * 1024) };

interface Served {
  frontmatter: Record<string, unknown>;
  body: string;
  version: string;
}

/** An authority that serves whatever frontmatter it holds, over the wire verbs a pull uses. */
class Authority {
  readonly docs = new Map<ConceptId, Served>();
  readonly conditional: (string | undefined)[] = [];
  private next = 0;
  private readonly wire: boolean;
  constructor(wire = true) {
    this.wire = wire;
  }
  put(id: ConceptId, frontmatter: Record<string, unknown>, body = "body\n"): string {
    const version = `sha256:${String((this.next += 1)).padStart(64, "0")}`;
    this.docs.set(id, { frontmatter, body, version });
    return version;
  }
  private result(id: ConceptId): ReadResult {
    const served = this.docs.get(id);
    if (!served) throw Object.assign(new Error(`no ${id}`), { code: "ENOENT" });
    return { doc: { id, frontmatter: served.frontmatter, body: served.body } as OkfDocument, version: served.version };
  }
  private listing(): { heads: DocumentHead[]; digest: string } {
    const heads = sortHeads([...this.docs].map(([id, row]) => ({ id, version: row.version })));
    return { heads, digest: headsDigest(heads) };
  }
  get remote(): StorageBackend {
    const base = {
      read: async (id: ConceptId) => this.result(id),
      readMany: async (ids: ConceptId[]) => ids.map((id) => this.result(id)),
      list: async () => [...this.docs.keys()],
      readReserved: async () => null,
    };
    if (!this.wire) return base as unknown as StorageBackend;
    return {
      ...base,
      wireCapabilities: async () => ({ heads: true, snapshot: true }) as WireCapabilities,
      heads: async (options: { ifNoneMatch?: string } = {}) => {
        this.conditional.push(options.ifNoneMatch);
        const answer = this.listing();
        return options.ifNoneMatch === answer.digest ? null : answer;
      },
      snapshot: async () => {
        const answer = this.listing();
        const rows = [...this.docs].map(([id, row]) => ({ id, frontmatter: row.frontmatter, body: row.body, version: row.version }));
        return { header: { digest: answer.digest, count: rows.length }, docs: (async function* () { yield* rows; })() };
      },
    } as unknown as RemoteBackend;
  }
}

function open(backend = new MemoryJournaledBackend()): LocalBundle {
  return openLocalBundle("unstorable", { backend });
}

const lastPull = async (local: LocalBundle) => (await syncStatus(local)).lastPull as PullMarker;

for (const wire of [true, false]) {
  const path = wire ? "heads" : "list";
  test(`pull by ${path}: the document is held and named, the rest refresh, and repair places it`, async () => {
    const authority = new Authority(wire);
    authority.put("notes/a", { type: "Note", title: "A" });
    const local = open();
    await bootstrap(authority.remote, local);
    authority.put("notes/a", { type: "Note", title: "A2" });
    authority.put("notes/big", BIG);

    const first = await pull(local, authority.remote);
    assert.deepEqual(first.refreshed, ["notes/a"]);
    assert.deepEqual(first.held, ["notes/big"]);
    assert.equal(first.unstorable?.[0]?.id, "notes/big");
    assert.equal(first.unstorable?.[0]?.code, "FRONTMATTER_TOO_LARGE");
    assert.deepEqual(first.deleted, []);
    assert.equal(await local.backend.exists("notes/big"), false);
    const marker = await lastPull(local);
    assert.equal(marker.completedAt !== null, true);
    assert.equal(marker.headsDigest, undefined, "no digest: the document must be read again");
    assert.equal(marker.unstorable?.[0]?.code, "FRONTMATTER_TOO_LARGE");

    const second = await pull(local, authority.remote);
    assert.deepEqual(second.unstorable?.map((row) => row.id), ["notes/big"]);
    assert.deepEqual(second.refreshed, []);
    if (wire) assert.equal(authority.conditional.at(-1), undefined, "the next pull asks unconditionally");

    authority.put("notes/big", { type: "Note", title: "Fixed" });
    const repaired = await pull(local, authority.remote);
    assert.deepEqual(repaired.refreshed, ["notes/big"]);
    assert.equal(repaired.unstorable, undefined);
    assert.equal((await lastPull(local)).unstorable, undefined);
    if (wire) assert.equal(typeof (await lastPull(local)).headsDigest, "string", "the digest returns once nothing is held");
  });

  test(`bootstrap by ${wire ? "snapshot" : "list"}: the document is left out and named, and the marker completes with no digest`, async () => {
    const authority = new Authority(wire);
    authority.put("notes/a", { type: "Note", title: "A" });
    authority.put("notes/big", BIG);
    const local = open();
    const marker = await bootstrap(authority.remote, local);
    assert.equal(marker.complete, true);
    assert.equal(marker.headsDigest, undefined);
    assert.deepEqual(marker.unstorable?.map((row) => [row.id, row.code]), [["notes/big", "FRONTMATTER_TOO_LARGE"]]);
    assert.equal(await local.backend.exists("notes/a"), true);
    assert.equal(await local.backend.exists("notes/big"), false);
    const next = await pull(local, authority.remote);
    assert.deepEqual(next.unstorable?.map((row) => row.id), ["notes/big"]);
  });
}

test("a held copy keeps its base, is never deleted, and counts toward nothing", async () => {
  const authority = new Authority();
  authority.put("notes/a", { type: "Note", title: "A" });
  const version = authority.docs.get("notes/a")!.version;
  const local = open();
  await bootstrap(authority.remote, local);
  authority.put("notes/a", BIG);
  const report = await pull(local, authority.remote);
  assert.deepEqual(report.deleted, []);
  assert.equal(report.refused, undefined);
  assert.equal(await local.backend.exists("notes/a"), true);
  assert.equal((await local.backend.readMeta<SharedBase>(baseKey("notes/a")))?.version, version);
});

test("FRONTMATTER_MALFORMED from the store gets the same hold", async () => {
  const authority = new Authority();
  authority.put("notes/a", { type: "Note", title: "A" });
  authority.put("notes/odd", { type: "Note", title: "Odd" });
  const backend = new MemoryJournaledBackend();
  const write = backend.writeJournaled.bind(backend);
  backend.writeJournaled = (async (id: ConceptId, doc: OkfDocument, options: never) => {
    if (id === "notes/odd") throw new FrontmatterRefusedError("FRONTMATTER_MALFORMED", "bad");
    return write(id, doc, options);
  }) as typeof backend.writeJournaled;
  const local = open(backend);
  const marker = await bootstrap(authority.remote, local);
  assert.deepEqual(marker.unstorable?.map((row) => row.code), ["FRONTMATTER_MALFORMED"]);
  const report = await pull(local, authority.remote);
  assert.deepEqual(report.unstorable?.map((row) => row.code), ["FRONTMATTER_MALFORMED"]);
});

test("any other error at the same write still throws, from pull and from bootstrap", async () => {
  const authority = new Authority();
  authority.put("notes/a", { type: "Note", title: "A" });
  const backend = new MemoryJournaledBackend();
  const write = backend.writeJournaled.bind(backend);
  const failing = new Set<ConceptId>(["notes/a"]);
  backend.writeJournaled = (async (id: ConceptId, doc: OkfDocument, options: never) => {
    if (failing.has(id)) throw new RangeError("disk says no");
    return write(id, doc, options);
  }) as typeof backend.writeJournaled;
  const local = open(backend);
  await assert.rejects(bootstrap(authority.remote, local), RangeError);
  failing.clear();
  await bootstrap(authority.remote, local);
  failing.add("notes/a");
  authority.put("notes/a", { type: "Note", title: "A2" });
  await assert.rejects(pull(local, authority.remote), RangeError);
});

test("a local edit of the held old copy stays local through the pull", async () => {
  const authority = new Authority();
  authority.put("notes/a", { type: "Note", title: "A" });
  authority.put("notes/b", { type: "Note", title: "B" });
  const backend = new MemoryJournaledBackend();
  const local = open(backend);
  await bootstrap(authority.remote, local);
  await commitLocal(local, "notes/a", { buildCandidate: (existing: OkfDocument | undefined) => ({ frontmatter: existing!.frontmatter, body: "mine\n" }), now: () => "2026-09-10T12:00:00.000Z" });
  authority.put("notes/a", BIG);
  authority.put("notes/b", BIG);
  const report = await pull(local, authority.remote);
  assert.deepEqual(report.held.sort(), ["notes/a", "notes/b"]);
  assert.deepEqual(report.unstorable?.map((row) => row.id), ["notes/b"], "an edit holds its own document first");
  assert.equal((await local.backend.read("notes/a")).doc.body, "mine\n");
});

test("the browser runtime's sync completes, and its status names the hold until the repair", async () => {
  const authority = new Authority();
  authority.put("notes/a", { type: "Note", title: "A" });
  const local = open();
  await bootstrap(authority.remote, local);
  authority.put("notes/big", BIG);
  const transport = { submit: async () => { throw new Error("nothing to send"); }, lookup: async () => { throw new Error("nothing to send"); } };
  const runtime = createBrowserLocalRuntime({ local, remote: authority.remote, transport: transport as never, write: { sleep: async () => {}, lookupDelayMs: 0 } });
  const held = await runtime.sync!();
  assert.equal(held.lastSync?.ok, true);
  assert.deepEqual(held.lastSync?.unstorable?.map((row) => [row.id, row.code]), [["notes/big", "FRONTMATTER_TOO_LARGE"]]);
  authority.put("notes/big", { type: "Note", title: "Fixed" });
  const repaired = await runtime.sync!();
  assert.equal(repaired.lastSync?.unstorable, undefined);
  assert.equal(await local.backend.exists("notes/big"), true);
});
