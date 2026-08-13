/**
 * `queryHeads` — the head-projection scan (frontmatter-projection pass).
 *
 * Three claims, each pinned here:
 *
 *   1. PARITY: `queryHeads(bundle, f)` ≡ `query(bundle, f)` minus bodies — same ids,
 *      same frontmatter, same sort — across FilesystemBackend / MemoryBackend (the
 *      engine's fallback path) AND RemoteBackend (the push-down path), with every
 *      head's `version` byte-identical to the version the write produced.
 *   2. THINNESS: over the wire, a filtered scan is `GET /docs?fields=frontmatter&…`
 *      round-trips whose responses carry NO `body` key, and `/docs:read-many` is never
 *      called — transport-captured, not inferred.
 *   3. SEMANTICS STAY IN CORE: a backend whose push-down over-returns (ignores the
 *      filter entirely) still produces exactly the filtered result, because the engine
 *      re-applies the ONE canonical predicate (`matchesFilter`) to whatever came back.
 *
 * Plus the fallback path's malformed-doc resilience (`onSkip`) and the cursor loop
 * across the router's 50-row default page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRouter } from "@superbee/server";
import { MemoryBackend as ServerMemoryBackend } from "@superbee/core";

import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { MalformedDocumentError } from "../src/frontmatter.js";
import {
  initBundle,
  matchesFilter,
  query,
  queryHeads,
  writeDocVersioned,
} from "../src/bundle.js";
import type {
  Bundle,
  ConceptId,
  HeadResult,
  OkfDocument,
  QueryFilter,
  StorageBackend,
  Version,
} from "../src/types.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const SEED_DOCS: OkfDocument[] = [
  {
    id: "tasks/a",
    frontmatter: {
      type: "Task",
      title: "A",
      timestamp: "2026-07-01T00:00:00.000Z",
      tags: ["work"],
      status: "done",
      priority: 1,
    },
    body: "# A\n\nbody-a\n",
  },
  {
    id: "tasks/b",
    frontmatter: {
      type: "Task",
      title: "B",
      timestamp: "2026-07-02T00:00:00.000Z",
      tags: ["work", "urgent"],
      status: "todo",
    },
    body: "# B\n\nbody-b\n",
  },
  {
    id: "notes/c",
    frontmatter: { type: "Note", title: "C", timestamp: "2026-07-03T00:00:00.000Z" },
    body: "# C\n\nbody-c\n",
  },
];

/** Every filter shape the scan surface exercises, incl. the not-pushed-down `fields` facet. */
const FILTERS: QueryFilter[] = [
  {},
  { type: "Task" },
  { tags: ["work", "urgent"] },
  { prefix: "tasks/" },
  { fields: { status: "done" } },
  { fields: { priority: "1" } }, // string-coerced match of an unquoted YAML number
  { type: "Task", fields: { status: "todo" } },
  { type: "NoSuchType" },
];

async function seed(bundle: Bundle): Promise<Map<string, Version>> {
  const versions = new Map<string, Version>();
  for (const d of SEED_DOCS) {
    versions.set(d.id, (await writeDocVersioned(bundle, d)).version);
  }
  return versions;
}

function freshMemoryBundle(): Bundle {
  return { root: "mem://heads", backend: new MemoryBackend() };
}

async function freshFsBundle(): Promise<Bundle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aslite-heads-"));
  return initBundle(dir);
}

/** A `RemoteBackend` over an in-process router (no sockets), with every request path
 * and response body captured so the tests can assert what actually crossed the "wire".
 * The server-side backend and the raw router are exposed for the tests that inject
 * server-side state changes (a mid-scan delete) or drive pagination request by request. */
function recordingWireBundle(serverBackend: StorageBackend = new ServerMemoryBackend()): {
  bundle: Bundle;
  requests: string[];
  responses: string[];
  serverBackend: StorageBackend;
  router: (req: Request) => Promise<Response>;
} {
  const router = createRouter({ root: "mem://wire-heads", backend: serverBackend });
  const requests: string[] = [];
  const responses: string[] = [];
  const transport = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const res = await router(req);
    responses.push(await res.clone().text());
    return res;
  };
  const remote = new RemoteBackend({
    baseUrl: "http://wire.local",
    bundle: "test",
    fetchImpl: transport,
  });
  return {
    bundle: { root: "wire://heads-client", backend: remote },
    requests,
    responses,
    serverBackend,
    router,
  };
}

async function assertParity(bundle: Bundle, seededVersions: Map<string, Version>): Promise<void> {
  for (const filter of FILTERS) {
    const docs = await query(bundle, filter);
    const heads = await queryHeads(bundle, filter);
    assert.deepEqual(
      heads.map((h) => ({ id: h.id, frontmatter: h.frontmatter })),
      docs.map((d) => ({ id: d.id, frontmatter: d.frontmatter })),
      `heads ≠ query for filter ${JSON.stringify(filter)}`,
    );
    for (const h of heads) {
      assert.equal(
        h.version,
        seededVersions.get(h.id),
        `head version for '${h.id}' must be the write's version token`,
      );
      assert.ok(!("body" in h), "a HeadResult must not carry a body");
    }
  }
}

// ── 1. parity across all three backends ───────────────────────────────────────

test("queryHeads ≡ query minus bodies on MemoryBackend (fallback path)", async () => {
  const bundle = freshMemoryBundle();
  await assertParity(bundle, await seed(bundle));
});

test("queryHeads ≡ query minus bodies on FilesystemBackend (fallback path)", async () => {
  const bundle = await freshFsBundle();
  await assertParity(bundle, await seed(bundle));
});

test("queryHeads ≡ query minus bodies over RemoteBackend (push-down path)", async () => {
  const { bundle } = recordingWireBundle();
  await assertParity(bundle, await seed(bundle));
});

// ── 2. thinness: what actually crosses the wire ───────────────────────────────

test("a remote heads scan is fields=frontmatter round-trips carrying no bodies", async () => {
  const { bundle, requests, responses } = recordingWireBundle();
  await seed(bundle);
  const afterSeed = requests.length;

  const heads = await queryHeads(bundle, { type: "Task" });
  assert.equal(heads.length, 2);

  const scanRequests = requests.slice(afterSeed);
  const scanResponses = responses.slice(afterSeed);
  // One page suffices for 3 docs: exactly ONE round trip, on the list route with the
  // frontmatter projection and the pushed type filter — and never /docs:read-many.
  assert.equal(scanRequests.length, 1, `expected one scan round-trip, saw: ${scanRequests.join(", ")}`);
  assert.match(scanRequests[0]!, /GET .*\/docs\?/);
  assert.match(scanRequests[0]!, /fields=frontmatter/);
  assert.match(scanRequests[0]!, /type=Task/);
  assert.ok(!scanRequests.some((r) => r.includes("read-many")), "bodies route must not be called");
  // The response rows carry id/version/frontmatter — no `body` key anywhere.
  assert.ok(!scanResponses[0]!.includes('"body"'), "scan response must not carry bodies");
  // Sanity: the frontmatter genuinely crossed (not just ids).
  assert.ok(scanResponses[0]!.includes('"status"'));
});

test("tag facets are pushed as repeated tag params; fields equality is engine-side", async () => {
  const { bundle, requests } = recordingWireBundle();
  await seed(bundle);
  const afterSeed = requests.length;

  const byTags = await queryHeads(bundle, { tags: ["work", "urgent"] });
  assert.deepEqual(byTags.map((h) => h.id), ["tasks/b"]);
  assert.match(requests[afterSeed]!, /tag=work&tag=urgent/);

  // `fields` equality is NOT pushed (the wire's `fields` param is the projection
  // selector): the server over-returns every Task head and the engine's re-filter
  // narrows — correct result, still no bodies on the wire.
  const byField = await queryHeads(bundle, { fields: { status: "done" } });
  assert.deepEqual(byField.map((h) => h.id), ["tasks/a"]);
});

test("the cursor loop pages past the router's 50-row default page", async () => {
  const { bundle, requests } = recordingWireBundle();
  for (let i = 0; i < 120; i++) {
    await writeDocVersioned(bundle, {
      id: `p/${String(i).padStart(3, "0")}`,
      frontmatter: { type: "Page", timestamp: "2026-07-01T00:00:00.000Z" },
      body: `body ${i}\n`,
    });
  }
  const afterSeed = requests.length;
  const heads = await queryHeads(bundle, { type: "Page" });
  assert.equal(heads.length, 120);
  // 120 rows at the router's 50-row default page = exactly 3 GETs (50 + 50 + 20).
  assert.equal(requests.slice(afterSeed).length, 3);
  // Order and content survive pagination.
  assert.equal(heads[0]!.id, "p/000");
  assert.equal(heads[119]!.id, "p/119");
});

// ── 3. semantics stay in core: over-returning push-down is re-filtered ────────

class OverReturningBackend extends MemoryBackend {
  /** A deliberately lawless push-down: ignores the filter entirely (maximal over-return). */
  async queryHeads(_filter?: QueryFilter): Promise<HeadResult[]> {
    const ids = await this.list();
    const reads = await this.readMany(ids);
    return reads.map((r) => ({ id: r.doc.id, frontmatter: r.doc.frontmatter, version: r.version }));
  }
}

test("engine re-filters an over-returning backend push-down (gate 3)", async () => {
  const bundle: Bundle = { root: "mem://over", backend: new OverReturningBackend() };
  await seed(bundle);
  for (const filter of FILTERS) {
    const heads = await queryHeads(bundle, filter);
    const expected = (await query(bundle, filter)).map((d) => d.id);
    assert.deepEqual(
      heads.map((h) => h.id),
      expected,
      `over-returned rows must be re-filtered for ${JSON.stringify(filter)}`,
    );
  }
});

// ── fallback resilience + the predicate itself ─────────────────────────────────

test("fallback path honors onSkip for a malformed doc; loud without it", async () => {
  const bundle = await freshFsBundle();
  await seed(bundle);
  fs.writeFileSync(path.join(bundle.root, "broken.md"), "---\ntype: [oops\n---\nbody\n");

  const skipped: { id: string; reason: string }[] = [];
  const heads = await queryHeads(bundle, {}, { onSkip: (s) => skipped.push(s) });
  assert.deepEqual(skipped.map((s) => s.id), ["broken"]);
  assert.ok(!heads.some((h) => h.id === "broken"));
  assert.equal(heads.length, SEED_DOCS.length);

  await assert.rejects(() => queryHeads(bundle, {}), MalformedDocumentError);
});

// ── wire-scan resilience (router-side fixes from this unit's review) ───────────

/** Simulates the listed-then-gone race server-side: `list` reports an id whose
 * document is already gone by the time the batch read runs. */
class StaleListBackend extends MemoryBackend {
  ghost: ConceptId | null = null;
  override async list(prefix?: string): Promise<ConceptId[]> {
    const ids = await super.list(prefix);
    return this.ghost ? [...ids, this.ghost] : ids;
  }
}

test("wire scan tolerates a doc deleted between server-side list and batch read", async () => {
  const stale = new StaleListBackend();
  const { bundle } = recordingWireBundle(stale);
  await seed(bundle);
  stale.ghost = "ghost/vanished"; // listed on every scan, readable never
  // Without handleList's readManyExisting, the server's readMany rejects ENOENT and the
  // whole scan 404s; with it, the vanished doc is skipped and every real doc survives.
  const heads = await queryHeads(bundle, {});
  assert.deepEqual(
    heads.map((h) => h.id),
    ["notes/c", "tasks/a", "tasks/b"],
  );
});

test("vanished-cursor fallback uses the sort's comparator — no duplicate/skipped rows", async () => {
  // Ids chosen so localeCompare order (a < B < c) diverges from code-unit order (B < a < c).
  const { serverBackend, router } = recordingWireBundle();
  const serverBundle: Bundle = { root: "mem://cursor-fallback", backend: serverBackend };
  for (const id of ["a", "B", "c"]) {
    await writeDocVersioned(serverBundle, {
      id,
      frontmatter: { type: "X", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "",
    });
  }
  const page = async (qs: string) => {
    const res = await router(new Request(`http://wire.local/v0/bundles/test/docs?${qs}`));
    assert.equal(res.status, 200);
    return (await res.json()) as { docs: Array<{ id: string }>; next_cursor: string | null };
  };
  const p1 = await page("limit=1");
  assert.deepEqual(p1.docs.map((d) => d.id), ["a"]);
  const p2 = await page(`limit=1&cursor=${encodeURIComponent(p1.next_cursor!)}`);
  assert.deepEqual(p2.docs.map((d) => d.id), ["B"]);
  // The cursor doc vanishes between pages — the fallback must resume in LOCALE order.
  await serverBackend.delete("B");
  const p3 = await page("limit=1&cursor=B");
  // A code-unit `>` fallback would re-emit 'a' here ('a' > 'B' in UTF-16), duplicating a row.
  assert.deepEqual(p3.docs.map((d) => d.id), ["c"]);
  assert.equal(p3.next_cursor, null);
});

test("matchesFilter: every facet, ANDed, with string coercion", () => {
  const doc = {
    id: "tasks/a",
    frontmatter: { type: "Task", tags: ["work"], status: "done", priority: 1 },
  };
  assert.equal(matchesFilter(doc, {}), true);
  assert.equal(matchesFilter(doc, { prefix: "tasks/" }), true);
  assert.equal(matchesFilter(doc, { prefix: "notes/" }), false);
  assert.equal(matchesFilter(doc, { type: "Task" }), true);
  assert.equal(matchesFilter(doc, { type: "Note" }), false);
  assert.equal(matchesFilter(doc, { tags: ["work"] }), true);
  assert.equal(matchesFilter(doc, { tags: ["work", "urgent"] }), false);
  assert.equal(matchesFilter(doc, { fields: { status: "done" } }), true);
  assert.equal(matchesFilter(doc, { fields: { priority: "1" } }), true); // String-coerced
  assert.equal(matchesFilter(doc, { fields: { status: "todo" } }), false);
  assert.equal(matchesFilter(doc, { fields: { missing: "x" } }), false); // absent field never matches
  assert.equal(matchesFilter(doc, { type: "Task", fields: { status: "todo" } }), false); // ANDed
});
