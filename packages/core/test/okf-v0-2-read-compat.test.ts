/**
 * A hand-authored OKF v0.2 bundle pins AgentState Lite's permissive read/transport posture without
 * claiming v0.2 authoring support. These tests never mutate the fixture: they exercise the local
 * filesystem path and the reference router through RemoteBackend, then compare their projections.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createRouter } from "@superbee/server";

import {
  backendFor,
  query,
  queryEdges,
  queryHeads,
  readDocVersioned,
} from "../src/bundle.js";
import { RemoteBackend } from "../src/remote-backend.js";
import type { Bundle } from "../src/types.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/okf-v0.2", import.meta.url));
const localBundle: Bundle = { root: fixtureRoot };

function remoteBundle(): Bundle {
  const router = createRouter(localBundle);
  return {
    root: "wire://okf-v0.2-fixture",
    backend: new RemoteBackend({
      baseUrl: "http://wire.local",
      bundle: "fixture",
      fetchImpl: router,
    }),
  };
}

/** Compare values after the same JSON boundary the wire transport necessarily applies. */
function wireShape<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("OKF v0.2 fixture: root version and ordinary documents read identically through local and reference-server paths", async () => {
  const remote = remoteBundle();
  const localIndex = await backendFor(localBundle).readReserved("", "index.md");
  const remoteIndex = await backendFor(remote).readReserved("", "index.md");

  assert.ok(localIndex);
  assert.deepEqual(remoteIndex, localIndex);
  assert.match(localIndex.content, /okf_version: '0\.2'/);

  const local = await readDocVersioned(localBundle, "concepts/revenue");
  const transported = await readDocVersioned(remote, "concepts/revenue");
  assert.deepEqual(wireShape(transported), wireShape(local));

  const shaped = wireShape(local.doc) as {
    frontmatter: Record<string, unknown>;
    body: string;
  };
  assert.equal(shaped.frontmatter.status, "stable");
  const generated = shaped.frontmatter.generated as { at: string; by: string };
  assert.equal(Date.parse(generated.at), Date.parse("2026-07-28T12:34:56Z"));
  assert.equal(generated.by, "https://producer.example/agents/finance");
  const verified = shaped.frontmatter.verified as Array<{ at: string; by: string; method: string }>;
  assert.equal(Date.parse(verified[0]!.at), Date.parse("2026-07-29T09:15:00Z"));
  assert.equal(verified[0]!.by, "https://producer.example/people/reviewer");
  assert.equal(verified[0]!.method, "human-review");
  const sources = shaped.frontmatter.sources as Array<{ resource: string; last_modified: string }>;
  assert.equal(sources[0]!.resource, "https://warehouse.example/revenue");
  assert.equal(sources[0]!.last_modified, "2026-07-27");
  assert.equal(shaped.frontmatter.stale_after, "2026-12-31");
  assert.deepEqual(shaped.frontmatter.x_producer, {
    confidence: 0.94,
    labels: ["finance", "monthly"],
  });
  assert.match(shaped.body, /\[source dataset\]\(source-data\.md\)/);
});

test("OKF v0.2 fixture: document, head, filter, and graph projections agree across local and reference-server paths", async () => {
  const remote = remoteBundle();

  const [localDocs, remoteDocs, localHeads, remoteHeads, localStable, remoteStable, localEdges, remoteEdges] =
    await Promise.all([
      query(localBundle),
      query(remote),
      queryHeads(localBundle),
      queryHeads(remote),
      queryHeads(localBundle, { fields: { status: "stable" } }),
      queryHeads(remote, { fields: { status: "stable" } }),
      queryEdges(localBundle),
      queryEdges(remote),
    ]);

  assert.deepEqual(wireShape(remoteDocs), wireShape(localDocs));
  assert.deepEqual(wireShape(remoteHeads), wireShape(localHeads));
  assert.deepEqual(wireShape(remoteStable), wireShape(localStable));
  assert.deepEqual(remoteEdges, localEdges);
  assert.deepEqual(localDocs.map((doc) => doc.id), ["concepts/revenue", "concepts/source-data"]);
  assert.deepEqual(localStable.map((head) => head.id), ["concepts/revenue"]);
  assert.deepEqual(
    localEdges.map(({ from, to, text }) => ({ from, to, text })),
    [
      { from: "concepts/revenue", to: "concepts/source-data", text: "source dataset" },
      { from: "concepts/source-data", to: "concepts/revenue", text: "revenue metric" },
    ],
  );
});

test("OKF v0.2 fixture: compatibility probes leave the external bundle byte-untouched", async () => {
  const revenuePath = fileURLToPath(new URL("./fixtures/okf-v0.2/concepts/revenue.md", import.meta.url));
  const before = await readFile(revenuePath);

  await query(localBundle);
  await queryHeads(remoteBundle());
  await queryEdges(remoteBundle());

  assert.deepEqual(await readFile(revenuePath), before);
});
