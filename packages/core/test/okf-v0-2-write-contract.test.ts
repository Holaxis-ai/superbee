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
function indexFor(okfVersion: "0.1" | "0.2"): string {
  return `---\nokf_version: '${okfVersion}'\n---\n# ${okfVersion} contract\n`;
}

interface Harness {
  name: string;
  bundle: Bundle;
  cleanup: () => Promise<void>;
}

async function harnesses(okfVersion: "0.1" | "0.2" = "0.2"): Promise<Harness[]> {
  const index = indexFor(okfVersion);
  const root = await mkdtemp(path.join(tmpdir(), "superbee-okf-v02-write-"));
  await writeFile(path.join(root, "index.md"), index, "utf8");

  const memoryBackend = new MemoryBackend();
  await memoryBackend.writeReserved("", "index.md", index);

  const serverBackend = new MemoryBackend();
  await serverBackend.writeReserved("", "index.md", index);
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
        now: () => "2026-08-14T10:00:00.000Z",
        buildCandidate: () => ({
          frontmatter: {
            type: "Note",
            title: "Agreement",
            stale_after: "2026-12-31",
          },
          body: "before\n",
        }),
      });
      assert.deepEqual(created.doc.frontmatter.generated, {
        by: "process:superbee",
        at: "2026-08-14T10:00:00.000Z",
      });
      assert.equal(created.doc.frontmatter.superbee_updated_by, "openai/codex");

      const changed = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/agreement",
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "human:reviewer",
        now: () => "2026-08-14T11:00:00.000Z",
        buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after\n" }),
      });
      assert.equal(changed.changed, true);
      assert.deepEqual(changed.doc.frontmatter.generated, {
        by: "process:superbee",
        at: "2026-08-14T11:00:00.000Z",
      });
      assert.equal(changed.doc.frontmatter.superbee_updated_by, "human:reviewer");

      const noop = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/agreement",
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        now: () => "2026-08-14T12:00:00.000Z",
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

test("v0.1 meaningful edits advance timestamp and persist supplied actors across all adapters", async () => {
  const rows: Array<{ name: string; doc: unknown; actor: string | undefined }> = [];
  const adapters = await harnesses("0.1");
  try {
    for (const harness of adapters) {
      const created = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/legacy",
        mode: "create-only",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "alice/codex",
        now: () => "2026-08-14T10:00:00.000Z",
        buildCandidate: () => ({ frontmatter: { type: "Note", title: "Legacy" }, body: "before\n" }),
      });
      const changed = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/legacy",
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "bob/codex",
        now: () => "2026-08-14T11:00:00.000Z",
        buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after\n" }),
      });
      const noop = await mutateDocument({
        bundle: harness.bundle,
        id: "notes/legacy",
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        actor: "carol/codex",
        now: () => "2026-08-14T12:00:00.000Z",
        buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: existing!.body }),
      });

      assert.equal(created.doc.frontmatter.actor, "alice/codex", harness.name);
      assert.equal(changed.doc.frontmatter.actor, "bob/codex", harness.name);
      assert.equal(changed.doc.frontmatter.timestamp, "2026-08-14T11:00:00.000Z", harness.name);
      assert.equal(noop.changed, false, harness.name);
      assert.equal(noop.version, changed.version, harness.name);
      rows.push({
        name: harness.name,
        doc: (await readDocVersioned(harness.bundle, "notes/legacy")).doc,
        actor: (await docVersions(harness.bundle, "notes/legacy"))[0]?.actor,
      });
    }
  } finally {
    await Promise.all(adapters.map((harness) => harness.cleanup()));
  }

  const baseline = rows[0]!;
  for (const row of rows.slice(1)) {
    assert.deepEqual(row.doc, baseline.doc, `${row.name} final document`);
    assert.equal(row.actor, baseline.actor, `${row.name} final actor`);
  }
});
