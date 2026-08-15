import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRouter } from "@superbee/server";

import { docVersions, readDocVersioned } from "../src/bundle.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { RemoteBackend } from "../src/remote-backend.js";
import { VersionConflict } from "../src/versioning.js";
import type { KindRegistry } from "../src/kinds.js";
import type { Bundle } from "../src/types.js";

const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };
const INDEX = "---\nokf_version: '0.2'\n---\n# v0.2 contract\n";

interface Harness {
  name: string;
  bundle: Bundle;
  cleanup: () => Promise<void>;
}

async function harnesses(): Promise<Harness[]> {
  const root = await mkdtemp(path.join(tmpdir(), "superbee-okf-v02-write-"));
  await writeFile(path.join(root, "index.md"), INDEX, "utf8");

  const memoryBackend = new MemoryBackend();
  await memoryBackend.writeReserved("", "index.md", INDEX);

  const serverBackend = new MemoryBackend();
  await serverBackend.writeReserved("", "index.md", INDEX);
  const serverBundle: Bundle = { root: "mem://okf-v02-server", backend: serverBackend };
  const router = createRouter(serverBundle);
  const remote = new RemoteBackend({
    baseUrl: "http://wire.local",
    bundle: "okf-v02",
    fetchImpl: router,
  });

  return [
    { name: "filesystem", bundle: { root }, cleanup: () => rm(root, { recursive: true, force: true }) },
    { name: "memory", bundle: { root: "mem://okf-v02", backend: memoryBackend }, cleanup: async () => {} },
    { name: "reference-server", bundle: { root: "wire://okf-v02", backend: remote }, cleanup: async () => {} },
  ];
}

test("v0.2 create, mutate, no-op, conflict, and final receipts agree across all storage adapters", async () => {
  const rows: Array<{ name: string; doc: unknown; created: string; changed: string; final: string }> = [];
  const adapters = await harnesses();
  try {
    for (const harness of adapters) {
      const created = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/agreement",
        mode: "create-only",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "openai/codex",
        persistActor: true,
        now: () => "2026-08-14T10:00:00Z",
        buildCandidate: () => ({
          frontmatter: {
            type: "Note",
            title: "Agreement",
            generated: { by: "superbee/1.0.0" },
            stale_after: "2026-12-31",
          },
          body: "before\n",
        }),
      });
      assert.deepEqual(created.doc.frontmatter.generated, {
        by: "superbee/1.0.0",
        at: "2026-08-14T10:00:00Z",
      });

      const changed = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/agreement",
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        now: () => "2026-08-14T11:00:00Z",
        buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after\n" }),
      });
      assert.equal(changed.changed, true);

      const noop = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/agreement",
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        now: () => "2026-08-14T12:00:00Z",
        buildCandidate: (existing) => ({
          frontmatter: {
            ...existing!.frontmatter,
            generated: { ...(existing!.frontmatter.generated as object), at: "2099-01-01T00:00:00Z" },
          },
          body: existing!.body,
        }),
      });
      assert.equal(noop.changed, false);
      assert.equal(noop.version, changed.version);

      await assert.rejects(
        () => mutateDocument({
          bundle: harness.bundle,
          id: "notes/agreement",
          mode: "patch",
          registry: EMPTY_REGISTRY,
          strict: false,
          expectedVersion: created.version,
          buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: existing!.body }),
        }),
        VersionConflict,
      );

      const final = await readDocVersioned(harness.bundle, "notes/agreement");
      assert.equal(final.version, changed.version);
      rows.push({
        name: harness.name,
        doc: final.doc,
        created: created.version,
        changed: changed.version,
        final: final.version,
      });
    }
  } finally {
    await Promise.all(adapters.map((harness) => harness.cleanup()));
  }

  const baseline = rows[0]!;
  for (const row of rows.slice(1)) {
    assert.deepEqual(row.doc, baseline.doc, `${row.name} final document`);
    assert.equal(row.created, baseline.created, `${row.name} create version`);
    assert.equal(row.changed, baseline.changed, `${row.name} changed version`);
    assert.equal(row.final, baseline.final, `${row.name} final receipt`);
  }
});

test("v0.2 mutation attribution agrees across retained history and the filesystem projection", async () => {
  const adapters = await harnesses();
  try {
    for (const harness of adapters) {
      const result = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/attributed",
        mode: "create-only",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "alice",
        persistActor: true,
        buildCandidate: () => ({ frontmatter: { type: "Note", title: "Attributed" }, body: "body\n" }),
      });

      assert.equal(result.doc.frontmatter.superbee_updated_by, "alice", harness.name);
      assert.equal(result.doc.frontmatter.actor, undefined, harness.name);
      assert.equal((await docVersions(harness.bundle, "notes/attributed"))[0]?.actor, "alice", harness.name);
    }
  } finally {
    await Promise.all(adapters.map((harness) => harness.cleanup()));
  }
});
