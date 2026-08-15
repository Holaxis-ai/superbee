/**
 * A hand-authored, producer-conforming OKF v0.2 bundle pins Superbee's read/transport posture.
 * Ordinary compatibility tests never mutate the fixture: they exercise the local filesystem path
 * and the reference router through RemoteBackend, then compare their projections. A separate,
 * explicitly labeled test pins permissive preservation of unusual legacy actor spellings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRouter } from "@superbee/server";

import {
  backendFor,
  query,
  queryEdges,
  queryHeads,
  readDocVersioned,
} from "../src/bundle.js";
import { mutateDocument } from "../src/document-mutation.js";
import { RemoteBackend } from "../src/remote-backend.js";
import type { KindRegistry } from "../src/kinds.js";
import type { Bundle } from "../src/types.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/okf-v0.2", import.meta.url));
const localBundle: Bundle = { root: fixtureRoot };
const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

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
  assert.equal(generated.by, "finance_agent/1.0");
  const verified = shaped.frontmatter.verified as Array<{ at: string; by: string; method: string }>;
  assert.equal(Date.parse(verified[0]!.at), Date.parse("2026-07-29T09:15:00Z"));
  assert.equal(verified[0]!.by, "human:reviewer");
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

  const sourceData = await readDocVersioned(localBundle, "concepts/source-data");
  assert.deepEqual(sourceData.doc.frontmatter.generated, {
    at: "2026-07-27T23:00:00Z",
    by: "process:finance-nightly",
  });
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

test("OKF v0.2 fixture: a trusted mutation preserves external provenance, verification, and date-only values", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "superbee-okf-v02-fixture-"));
  const root = path.join(parent, "bundle");
  await cp(fixtureRoot, root, { recursive: true });
  try {
    const result = await mutateDocument({
      bundle: { root },
      id: "concepts/revenue",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      actor: "openai/codex",
      persistActor: true,
      now: () => "2026-08-14T12:00:00Z",
      buildCandidate: (existing) => ({
        frontmatter: { ...existing!.frontmatter, description: "Updated revenue definition." },
        body: existing!.body,
      }),
    });

    assert.deepEqual(result.doc.frontmatter.generated, {
      at: "2026-08-14T12:00:00Z",
      by: "finance_agent/1.0",
    });
    assert.deepEqual(result.doc.frontmatter.verified, [{
      at: "2026-07-29T09:15:00Z",
      by: "human:reviewer",
      method: "human-review",
    }]);
    assert.deepEqual(result.doc.frontmatter.sources, [{
      resource: "https://warehouse.example/revenue",
      last_modified: "2026-07-27",
    }]);
    assert.equal(result.doc.frontmatter.stale_after, "2026-12-31");
    assert.equal(result.doc.frontmatter.timestamp, undefined);
    assert.equal(result.doc.frontmatter.actor, undefined);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("OKF v0.2 permissive consumer: mutation preserves unusual legacy actor spellings", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "superbee-okf-v02-legacy-actor-"));
  const root = path.join(parent, "bundle");
  await cp(fixtureRoot, root, { recursive: true });
  const legacyPath = path.join(root, "concepts", "legacy-actor.md");
  await writeFile(legacyPath, `---
type: Reference
title: Imported legacy actor
generated:
  at: 2026-07-28T12:34:56Z
  by: https://producer.example/agents/finance
verified:
  - at: 2026-07-29T09:15:00Z
    by: https://producer.example/people/reviewer
---
# Imported legacy actor
`);
  try {
    const result = await mutateDocument({
      bundle: { root },
      id: "concepts/legacy-actor",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      actor: "openai/codex",
      persistActor: true,
      now: () => "2026-08-14T12:00:00Z",
      buildCandidate: (existing) => ({
        frontmatter: { ...existing!.frontmatter, description: "Preserved imported identity." },
        body: existing!.body,
      }),
    });

    assert.deepEqual(result.doc.frontmatter.generated, {
      at: "2026-08-14T12:00:00Z",
      by: "https://producer.example/agents/finance",
    });
    assert.deepEqual(result.doc.frontmatter.verified, [{
      at: "2026-07-29T09:15:00Z",
      by: "https://producer.example/people/reviewer",
    }]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
