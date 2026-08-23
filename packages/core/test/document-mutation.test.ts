import assert from "node:assert/strict";
import { test } from "node:test";

import { readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import {
  DocumentNotFoundError,
  KindConformanceError,
  mutateDocument,
} from "../src/document-mutation.js";
import { InvalidInputError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { validateAgainstKind } from "../src/kinds.js";
import { defaultActor, VersionConflict } from "../src/versioning.js";
import type { KindConvention, KindRegistry } from "../src/kinds.js";
import type { MutateDocumentOptions } from "../src/document-mutation.js";
import type { Bundle, ConceptId, OkfDocument, Version, WriteOptions } from "../src/types.js";

const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };
const FRESH_KIND: KindConvention = {
  id: "conventions/fresh",
  title: "Fresh",
  governs: "Fresh",
  freshnessHorizon: "30d",
  fields: {
    required: ["title"],
    optional: ["timestamp"],
    values: {},
    terminal: {},
    descriptions: {},
  },
};
const FRESH_REGISTRY: KindRegistry = {
  kinds: new Map([[FRESH_KIND.governs, FRESH_KIND]]),
  warnings: [],
};

function bundleFor(backend: MemoryBackend): Bundle {
  return { root: "/unused", backend };
}

async function v02BundleFor(backend = new MemoryBackend()): Promise<Bundle> {
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  return bundleFor(backend);
}

function candidate(title: string, body: string, timestamp = "2026-07-16T00:00:00.000Z") {
  return { frontmatter: { type: "Note", title, timestamp }, body };
}

class RaceOnceBackend extends MemoryBackend {
  private race?: { id: ConceptId; doc: OkfDocument };

  raceNextWrite(id: ConceptId, doc: OkfDocument): void {
    this.race = { id, doc };
  }

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (this.race?.id === id) {
      const race = this.race;
      this.race = undefined;
      await super.write(id, race.doc, { expectedVersion: options.expectedVersion, actor: "competitor" });
    }
    return super.write(id, doc, options);
  }
}

class RaceEveryWriteBackend extends MemoryBackend {
  private racing = false;
  writeAttempts = 0;

  startRacing(): void {
    this.racing = true;
  }

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (this.racing && id === "notes/a") {
      this.writeAttempts++;
      const current = await this.read(id);
      await super.write(id, {
        ...current.doc,
        body: `${current.doc.body}|competitor-${this.writeAttempts}`,
      }, { expectedVersion: options.expectedVersion, actor: "competitor" });
    }
    return super.write(id, doc, options);
  }
}

class ReadFailureBackend extends MemoryBackend {
  private readonly failure: unknown;

  constructor(failure: unknown) {
    super();
    this.failure = failure;
  }

  override async read(_id: ConceptId): Promise<never> {
    throw this.failure;
  }
}

test("create-only is an expect-absent CAS and reports the winning head after a concurrent create", async () => {
  const backend = new RaceOnceBackend();
  const bundle = bundleFor(backend);
  backend.raceNextWrite("notes/a", { id: "notes/a", ...candidate("Competitor", "theirs") });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "notes/a",
      mode: "create-only",
      registry: EMPTY_REGISTRY,
      strict: false,
      buildCandidate: () => candidate("Mine", "mine"),
    }),
    VersionConflict,
  );

  assert.equal((await readDocVersioned(bundle, "notes/a")).doc.body, "theirs");
  assert.equal((await backend.versions("notes/a")).length, 1);
});

test("ordinary patch re-reads, re-decides, and merges after a benign CAS race", async () => {
  const backend = new RaceOnceBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "base") });
  backend.raceNextWrite("notes/a", { id: "notes/a", ...candidate("A", "base|theirs") });

  const seen: string[] = [];
  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    buildCandidate: (existing) => {
      seen.push(existing!.body);
      return { frontmatter: { ...existing!.frontmatter }, body: `${existing!.body}|mine` };
    },
  });

  assert.deepEqual(seen, ["base", "base|theirs"]);
  assert.equal(result.doc.body, "base|theirs|mine");
  assert.equal(result.version, (await readDocVersioned(bundle, "notes/a")).version);
  assert.equal((await backend.versions("notes/a")).length, 3);
});

test("explicit expectedVersion is a hard single-shot CAS checked before no-op convergence", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const stale = (await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "v1") })).version;
  const current = await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "v2") });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "notes/a",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      expectedVersion: stale,
      buildCandidate: (existing) => ({
        frontmatter: { ...existing!.frontmatter },
        body: existing!.body,
      }),
    }),
    (error: unknown) => error instanceof VersionConflict && error.actual === current.version,
  );

  assert.equal((await backend.versions("notes/a")).length, 2);
});

test("semantic patch no-op ignores an auto-refreshed timestamp and returns the unchanged final receipt", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const initial = await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "same") });

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "mike/codex",
    persistActor: true,
    buildCandidate: (existing) => ({
      frontmatter: { ...existing!.frontmatter, timestamp: "2026-07-17T00:00:00.000Z" },
      body: existing!.body,
    }),
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, initial.version);
  assert.equal(result.doc.frontmatter.actor, undefined);
  assert.equal((await backend.versions("notes/a")).length, 1);
});

test("v0.2 mutation persists portable mutation attribution and its standard meaningful-change clock", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "openai/codex",
    persistActor: true,
    now: () => "2026-08-14T12:00:00Z",
    buildCandidate: () => ({ frontmatter: { type: "Note", title: "A" }, body: "body" }),
  });

  assert.deepEqual(result.doc.frontmatter, {
    type: "Note",
    title: "A",
    superbee_updated_by: "openai/codex",
    generated: { by: "process:superbee", at: "2026-08-14T12:00:00Z" },
  });
  assert.equal((await backend.versions("notes/a"))[0]!.actor, "openai/codex");
});

test("v0.2 creation gives every freshness-governed kind one standard meaningful-change clock", async () => {
  const modes = ["create-only", "overwrite", "patch"] as const;

  for (const mode of modes) {
    const backend = new MemoryBackend();
    const bundle = await v02BundleFor(backend);
    const result = await mutateDocument({
      bundle,
      id: `tasks/${mode}`,
      mode,
      registry: FRESH_REGISTRY,
      strict: true,
      ...(mode === "patch" ? { onAbsent: "create" as const } : {}),
      now: () => "2026-08-20T13:15:00.000Z",
      buildCandidate: () => ({
        frontmatter: { type: "Fresh", title: mode },
        body: "",
      }),
    });

    assert.deepEqual(result.doc.frontmatter.generated, {
      by: "process:superbee",
      at: "2026-08-20T13:15:00.000Z",
    });
    assert.equal(result.doc.frontmatter.timestamp, undefined);
  }
});

test("freshness clock creation stays edition-aware and does not add v0.2 provenance to v0.1", async () => {
  const backend = new MemoryBackend();
  const result = await mutateDocument({
    bundle: bundleFor(backend),
    id: "tasks/v01",
    mode: "create-only",
    registry: FRESH_REGISTRY,
    strict: true,
    now: () => "2026-08-20T13:15:00.000Z",
    buildCandidate: () => ({
      frontmatter: { type: "Fresh", title: "V01" },
      body: "",
    }),
  });

  assert.equal(result.doc.frontmatter.timestamp, "2026-08-20T13:15:00.000Z");
  assert.equal(result.doc.frontmatter.generated, undefined);
});

test("v0.2 freshness Kinds requiring timestamp retain that extension alongside the standard clock", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const kind: KindConvention = {
    ...FRESH_KIND,
    fields: {
      ...FRESH_KIND.fields,
      required: ["title", "timestamp"],
      optional: [],
    },
  };
  const registry: KindRegistry = { kinds: new Map([[kind.governs, kind]]), warnings: [] };
  const result = await mutateDocument({
    bundle,
    id: "context-notes/required-clock",
    mode: "create-only",
    registry,
    strict: true,
    now: () => "2026-08-20T13:15:00.000Z",
    buildCandidate: () => ({
      frontmatter: { type: kind.governs, title: "Required clock" },
      body: "# Summary\n",
    }),
  });

  assert.equal(result.doc.frontmatter.timestamp, "2026-08-20T13:15:00.000Z");
  assert.deepEqual(result.doc.frontmatter.generated, {
    by: "process:superbee",
    at: "2026-08-20T13:15:00.000Z",
  });
});

test("v0.2 freshness creation preserves an explicit usable legacy clock alongside standard provenance", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const result = await mutateDocument({
    bundle,
    id: "context-notes/parity",
    mode: "create-only",
    registry: FRESH_REGISTRY,
    strict: true,
    now: () => "2026-08-20T13:15:00.000Z",
    buildCandidate: () => ({
      frontmatter: {
        type: "Fresh",
        title: "Parity",
        timestamp: "2026-07-01T00:00:00.000Z",
      },
      body: "# Summary\n",
    }),
  });

  assert.equal(result.doc.frontmatter.timestamp, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(result.doc.frontmatter.generated, {
    by: "process:superbee",
    at: "2026-08-20T13:15:00.000Z",
  });
});

test("mutation edition is authoritative from the bundle root and cannot be overridden by a caller hint", async () => {
  const v01Backend = new MemoryBackend();
  await v01Backend.writeReserved("", "index.md", "---\nokf_version: '0.1'\n---\n# Bundle\n");
  const v01 = await mutateDocument({
    bundle: bundleFor(v01Backend),
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "body" }),
    // Runtime callers can always supply undeclared object keys; the authority must ignore them.
    okfVersion: "0.2",
  } as MutateDocumentOptions & { okfVersion: string });
  assert.equal(typeof v01.doc.frontmatter.timestamp, "string");

  const futureBackend = new MemoryBackend();
  await futureBackend.writeReserved("", "index.md", "---\nokf_version: '0.3'\n---\n# Bundle\n");
  await assert.rejects(
    () => mutateDocument({
      bundle: bundleFor(futureBackend),
      id: "notes/a",
      mode: "create-only",
      registry: EMPTY_REGISTRY,
      strict: false,
      buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "body" }),
      okfVersion: "0.2",
    } as MutateDocumentOptions & { okfVersion: string }),
    (error: unknown) => error instanceof Error && /Unsupported OKF mutation version '0\.3'/.test(error.message),
  );
});

test("v0.2 substantive mutation advances generated.at while preserving producer, verification, and date scalars", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const initial = await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: {
      type: "Note",
      title: "A",
      generated: { at: "2026-08-01T00:00:00Z", by: "https://legacy.example/producer" },
      verified: [{ at: "2026-08-02T00:00:00Z", by: "human:reviewer" }],
      stale_after: "2026-12-31",
      sources: [{ resource: "https://example.test/source", last_modified: "2026-07-27" }],
    },
    body: "before",
  });

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "openai/codex",
    persistActor: true,
    now: () => "2026-08-14T12:00:00Z",
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after" }),
  });

  assert.equal(result.changed, true);
  assert.notEqual(result.version, initial.version);
  assert.deepEqual(result.doc.frontmatter.generated, {
    at: "2026-08-14T12:00:00Z",
    by: "https://legacy.example/producer",
  });
  assert.deepEqual(result.doc.frontmatter.verified, [
    { at: "2026-08-02T00:00:00Z", by: "human:reviewer" },
  ]);
  assert.equal(result.doc.frontmatter.stale_after, "2026-12-31");
  assert.deepEqual(result.doc.frontmatter.sources, [
    { resource: "https://example.test/source", last_modified: "2026-07-27" },
  ]);
  assert.equal(result.doc.frontmatter.timestamp, undefined);
  assert.equal(result.doc.frontmatter.actor, undefined);
});

test("v0.2 verification-only writes preserve generated.at and clock-only patches are no-ops", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const initial = await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: {
      type: "Note",
      title: "A",
      generated: { at: "2026-08-01T00:00:00Z", by: "producer/1" },
      verified: [{ at: "2026-08-02T00:00:00Z", by: "human:first" }],
    },
    body: "body",
  });

  const verified = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    now: () => "2026-08-14T12:00:00Z",
    buildCandidate: (existing) => ({
      frontmatter: {
        ...existing!.frontmatter,
        verified: [
          ...(existing!.frontmatter.verified as unknown[]),
          { at: "2026-08-14T11:00:00Z", by: "human:second" },
        ],
      },
      body: existing!.body,
    }),
  });
  assert.equal(verified.changed, true);
  assert.equal((verified.doc.frontmatter.generated as { at: string }).at, "2026-08-01T00:00:00Z");

  const clockOnly = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    now: () => "2026-08-15T12:00:00Z",
    buildCandidate: (existing) => ({
      frontmatter: {
        ...existing!.frontmatter,
        generated: { ...(existing!.frontmatter.generated as object), at: "2099-01-01T00:00:00Z" },
      },
      body: existing!.body,
    }),
  });
  assert.equal(clockOnly.changed, false);
  assert.equal(clockOnly.version, verified.version);
  assert.notEqual(clockOnly.version, initial.version);
  assert.equal((clockOnly.doc.frontmatter.generated as { at: string }).at, "2026-08-01T00:00:00Z");
});

test("v0.2 permits explicit valid producer replacement but rejects a newly supplied invalid identity", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: {
      type: "Note",
      generated: { at: "2026-08-01T00:00:00Z", by: "https://legacy.example/producer" },
    },
    body: "body",
  });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "notes/a",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      now: () => "2026-08-14T12:00:00Z",
      buildCandidate: (existing) => ({
        frontmatter: { ...existing!.frontmatter, generated: { at: "x", by: "not-an-actor" } },
        body: "changed",
      }),
    }),
    (error: unknown) => error instanceof Error && /generated\.by/.test(error.message),
  );

  const changed = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    now: () => "2026-08-14T12:00:00Z",
    buildCandidate: (existing) => ({
      frontmatter: { ...existing!.frontmatter, generated: { by: "superbee/1.0.0" } },
      body: "changed",
    }),
  });
  assert.deepEqual(changed.doc.frontmatter.generated, {
    at: "2026-08-14T12:00:00Z",
    by: "superbee/1.0.0",
  });
});

test("v0.2 bundle-local Kinds may explicitly retain required timestamp and actor extensions", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const kind: KindConvention = {
    id: "conventions/note",
    title: "Note",
    governs: "Note",
    fields: {
      required: ["title", "timestamp", "actor"],
      optional: [],
      values: {},
      terminal: {},
      descriptions: {},
    },
  };
  const registry: KindRegistry = { kinds: new Map([["Note", kind]]), warnings: [] };
  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "create-only",
    registry,
    strict: true,
    actor: "openai/codex",
    persistActor: true,
    now: () => "2026-08-14T12:00:00Z",
    buildCandidate: () => ({ frontmatter: { type: "Note", title: "A" }, body: "body" }),
  });
  assert.equal(result.doc.frontmatter.timestamp, "2026-08-14T12:00:00Z");
  assert.equal(result.doc.frontmatter.actor, "openai/codex");
  assert.equal(result.doc.frontmatter.superbee_updated_by, "openai/codex");
});

test("strict kind rejection is typed, happens after timestamp defaulting, and performs no write", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const noteKind: KindConvention = {
    id: "conventions/note",
    title: "Note",
    governs: "Note",
    fields: {
      required: ["title", "timestamp", "status"],
      optional: [],
      values: {},
      terminal: {},
      descriptions: {},
    },
  };
  const registry: KindRegistry = { kinds: new Map([["Note", noteKind]]), warnings: [] };

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "notes/a",
      mode: "create-only",
      registry,
      strict: true,
      buildCandidate: () => ({ frontmatter: { type: "Note", title: "A" }, body: "body" }),
    }),
    (error: unknown) =>
      error instanceof KindConformanceError
      && error.violations.some((warning) => warning.field === "status")
      && !error.violations.some((warning) => warning.field === "timestamp"),
  );

  assert.deepEqual(await backend.list(), []);
});

test("writes propagate actor attribution and return the actual persisted head version", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "mike/codex",
    persistActor: true,
    buildCandidate: () => candidate("A", "body"),
  });

  const head = await readDocVersioned(bundle, "notes/a");
  const history = await backend.versions("notes/a");
  assert.equal(result.changed, true);
  assert.equal(result.version, head.version);
  assert.equal(result.doc.frontmatter.actor, "mike/codex");
  assert.equal(history[0]!.actor, "mike/codex");
});

test("overwrite re-reads after a CAS race and returns its final persisted receipt", async () => {
  const backend = new RaceOnceBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "base") });
  backend.raceNextWrite("notes/a", { id: "notes/a", ...candidate("A", "base|theirs") });

  const seen: string[] = [];
  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "mike/codex",
    buildCandidate: (existing) => {
      seen.push(existing!.body);
      return candidate("A", `${existing!.body}|mine`);
    },
  });

  const head = await readDocVersioned(bundle, "notes/a");
  assert.deepEqual(seen, ["base", "base|theirs"]);
  assert.equal(result.changed, true);
  assert.equal(result.doc.body, "base|theirs|mine");
  assert.equal(result.version, head.version);
  assert.deepEqual(result.warnings, []);
  assert.equal((await backend.versions("notes/a"))[0]?.actor, "mike/codex");
});

test("overwrite returns changed:false and preserves the head when the normalized candidate is identical", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const initial = await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "same") });

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    buildCandidate: (existing) => ({
      frontmatter: structuredClone(existing!.frontmatter),
      body: existing!.body,
    }),
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, initial.version);
  assert.equal((await backend.versions("notes/a")).length, 1);
  assert.deepEqual(result.warnings, []);
});

test("overwrite does not create a revision solely to change advisory actor attribution", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const initial = await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: { ...candidate("A", "same").frontmatter, actor: "alice" },
    body: "same",
  }, { actor: "alice" });

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "bob",
    persistActor: true,
    buildCandidate: () => candidate("A", "same"),
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, initial.version);
  assert.equal(result.doc.frontmatter.actor, "alice");
  assert.equal((await backend.versions("notes/a")).length, 1);
});

test("v0.2 overwrite ignores automatic attribution and clock changes only when all authored content is unchanged", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const created = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "alice",
    persistActor: true,
    now: () => "2026-08-19T00:00:00.000Z",
    buildCandidate: () => ({
      frontmatter: { type: "Note", title: "A", generated: { by: "process:superbee" } },
      body: "same",
    }),
  });

  const noop = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "bob",
    persistActor: true,
    now: () => "2026-08-20T00:00:00.000Z",
    buildCandidate: () => ({
      frontmatter: { type: "Note", title: "A", generated: { by: "process:superbee" } },
      body: "same",
    }),
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.version, created.version);
  assert.equal(noop.doc.frontmatter.superbee_updated_by, "alice");
  assert.deepEqual(noop.doc.frontmatter.generated, {
    by: "process:superbee",
    at: "2026-08-19T00:00:00.000Z",
  });

  const changed = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "bob",
    persistActor: true,
    now: () => "2026-08-20T00:00:00.000Z",
    buildCandidate: () => ({
      frontmatter: { type: "Note", title: "B", generated: { by: "process:superbee" } },
      body: "same",
    }),
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.doc.frontmatter.superbee_updated_by, "bob");
  assert.deepEqual(changed.doc.frontmatter.generated, {
    by: "process:superbee",
    at: "2026-08-20T00:00:00.000Z",
  });
});

test("overwrite compares an explicitly supplied timestamp but ignores an automatic default", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const initial = await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "same") });

  const automatic = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    now: () => "2026-08-20T00:00:00.000Z",
    buildCandidate: () => ({ frontmatter: { type: "Note", title: "A" }, body: "same" }),
  });
  assert.equal(automatic.changed, false);
  assert.equal(automatic.version, initial.version);

  const equivalentExplicit = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    compareTimestamp: true,
    buildCandidate: () => candidate("A", "same", "2026-07-16T00:00:00Z"),
  });
  assert.equal(equivalentExplicit.changed, false);
  assert.equal(equivalentExplicit.version, initial.version);

  const explicit = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    compareTimestamp: true,
    buildCandidate: () => candidate("A", "same", "2026-08-20T00:00:00.000Z"),
  });
  assert.equal(explicit.changed, true);
  assert.notEqual(explicit.version, initial.version);
});

test("v0.2 overwrite compares equivalent explicit timestamp spellings by instant", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const initial = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    now: () => "2026-08-20T00:00:00.000Z",
    buildCandidate: () => candidate("A", "same", "2026-07-16T00:00:00.000Z"),
  });

  const equivalent = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "overwrite",
    registry: EMPTY_REGISTRY,
    strict: false,
    compareTimestamp: true,
    now: () => "2026-08-21T00:00:00.000Z",
    buildCandidate: () => candidate("A", "same", "2026-07-16T00:00:00Z"),
  });

  assert.equal(equivalent.changed, false);
  assert.equal(equivalent.version, initial.version);
  assert.equal((await backend.versions("notes/a")).length, 1);
});

test("onAbsent:create retries an expect-absent patch against a concurrent creator", async () => {
  const backend = new RaceOnceBackend();
  const bundle = bundleFor(backend);
  backend.raceNextWrite("notes/a", { id: "notes/a", ...candidate("A", "theirs") });

  const seen: Array<string | undefined> = [];
  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    onAbsent: "create",
    buildCandidate: (existing) => {
      seen.push(existing?.body);
      return candidate("A", existing ? `${existing.body}|mine` : "mine");
    },
  });

  assert.deepEqual(seen, [undefined, "theirs"]);
  assert.equal(result.doc.body, "theirs|mine");
  assert.equal(result.version, (await readDocVersioned(bundle, "notes/a")).version);
});

test("maxAttempts bounds ordinary document retries", async () => {
  const backend = new RaceEveryWriteBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "base") });
  backend.startRacing();

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "notes/a",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      maxAttempts: 2,
      buildCandidate: (existing) => candidate("A", `${existing!.body}|mine`),
    }),
    VersionConflict,
  );

  assert.equal(backend.writeAttempts, 2);
});

test("non-ENOENT read failures propagate unchanged", async () => {
  for (const failure of [new Error("backend unavailable"), null]) {
    const bundle = bundleFor(new ReadFailureBackend(failure));
    await assert.rejects(
      () => mutateDocument({
        bundle,
        id: "notes/a",
        mode: "patch",
        registry: EMPTY_REGISTRY,
        strict: false,
        buildCandidate: () => candidate("A", "body"),
      }),
      (error: unknown) => error === failure,
    );
  }
});

test("array-valued frontmatter participates structurally in patch no-op detection", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: {
      type: "Note",
      title: "A",
      tags: ["alpha", "beta"],
      emptyArray: [],
      secondEmptyArray: [],
      thirdEmptyArray: [],
      metadata: {},
      timestamp: "2026-07-16T00:00:00.000Z",
    },
    body: "same",
  });

  const patchFrontmatter = (update: (frontmatter: Record<string, unknown>) => void) =>
    mutateDocument({
      bundle,
      id: "notes/a",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      buildCandidate: (existing) => {
        const frontmatter = structuredClone(existing!.frontmatter) as Record<string, unknown>;
        update(frontmatter);
        return { frontmatter, body: existing!.body };
      },
    });

  const equal = await patchFrontmatter(() => undefined);
  assert.equal(equal.changed, false);
  assert.deepEqual(equal.warnings, []);

  const oneElementChanged = await patchFrontmatter((frontmatter) => {
    frontmatter.tags = ["alpha", "gamma"];
  });
  assert.equal(oneElementChanged.changed, true);

  const lengthChanged = await patchFrontmatter((frontmatter) => {
    frontmatter.tags = ["alpha"];
  });
  assert.equal(lengthChanged.changed, true);

  const arrayToObject = await patchFrontmatter((frontmatter) => {
    frontmatter.tags = {};
  });
  assert.equal(arrayToObject.changed, true);

  const emptyArrayToEmptyObject = await patchFrontmatter((frontmatter) => {
    frontmatter.emptyArray = {};
  });
  assert.equal(emptyArrayToEmptyObject.changed, true);

  const emptyArrayToNonemptyArray = await patchFrontmatter((frontmatter) => {
    frontmatter.secondEmptyArray = ["new"];
  });
  assert.equal(emptyArrayToNonemptyArray.changed, true);

  const emptyArrayToArrayLikeObject = await patchFrontmatter((frontmatter) => {
    frontmatter.thirdEmptyArray = { length: 0 };
  });
  assert.equal(emptyArrayToArrayLikeObject.changed, true);

  const objectToPrimitive = await patchFrontmatter((frontmatter) => {
    frontmatter.metadata = 1;
  });
  assert.equal(objectToPrimitive.changed, true);
});

test("persistActor without an actor does not synthesize an actor field", async () => {
  const backend = new MemoryBackend();
  const result = await mutateDocument({
    bundle: bundleFor(backend),
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    persistActor: true,
    buildCandidate: () => candidate("A", "body"),
  });

  assert.equal(Object.prototype.hasOwnProperty.call(result.doc.frontmatter, "actor"), false);
});

test("v0.2 persistActor without an actor does not synthesize either attribution spelling", async () => {
  const backend = new MemoryBackend();
  const result = await mutateDocument({
    bundle: await v02BundleFor(backend),
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    persistActor: true,
    buildCandidate: () => ({ frontmatter: { type: "Note", title: "A" }, body: "body" }),
  });

  assert.equal(Object.prototype.hasOwnProperty.call(result.doc.frontmatter, "actor"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.doc.frontmatter, "superbee_updated_by"), false);
});

test("an unattributed v0.2 mutation preserves existing portable attribution and no-op bytes", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const created = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "alice",
    persistActor: true,
    buildCandidate: () => ({ frontmatter: { type: "Note", title: "A" }, body: "before" }),
  });

  const noop = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    persistActor: true,
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: existing!.body }),
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.version, created.version);
  assert.equal(noop.doc.frontmatter.superbee_updated_by, "alice");

  const changed = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    persistActor: true,
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after" }),
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.doc.frontmatter.superbee_updated_by, "alice");
  assert.equal((await backend.versions("notes/a"))[0]?.actor, defaultActor());
});

test("typed document mutation failures carry stable consumer-facing metadata", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "notes/missing",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      buildCandidate: () => candidate("A", "body"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DocumentNotFoundError);
      assert.equal(error.name, "DocumentNotFoundError");
      assert.equal(error.id, "notes/missing");
      assert.equal(error.message, "no concept document at id 'notes/missing'");
      return true;
    },
  );

  const noteKind: KindConvention = {
    id: "conventions/note",
    title: "Note",
    governs: "Note",
    fields: {
      required: ["title", "timestamp", "status"],
      optional: [],
      values: {},
      terminal: {},
      descriptions: {},
    },
  };
  const registry: KindRegistry = { kinds: new Map([["Note", noteKind]]), warnings: [] };
  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "notes/invalid",
      mode: "create-only",
      registry,
      strict: true,
      buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "body" }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof KindConformanceError);
      assert.equal(error.name, "KindConformanceError");
      assert.equal(error.id, "notes/invalid");
      assert.equal(error.governs, "Note");
      assert.ok(error.violations.length >= 2);
      assert.equal(
        error.message,
        `'notes/invalid' does not satisfy the 'Note' kind: ${error.violations.map((warning) => warning.message).join("; ")}`,
      );
      return true;
    },
  );
});

test("non-strict patch returns kind warnings from the winning write decision", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "base") });
  const noteKind: KindConvention = {
    id: "conventions/note",
    title: "Note",
    governs: "Note",
    fields: {
      required: ["title", "timestamp", "status"],
      optional: [],
      values: {},
      terminal: {},
      descriptions: {},
    },
  };

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: { kinds: new Map([["Note", noteKind]]), warnings: [] },
    strict: false,
    buildCandidate: (existing) => {
      const frontmatter = { ...existing!.frontmatter };
      delete frontmatter.title;
      return { frontmatter, body: "changed" };
    },
  });

  assert.equal(result.changed, true);
  assert.ok(result.warnings.some((warning) => warning.field === "title"));
  assert.ok(result.warnings.some((warning) => warning.field === "status"));
});

// ── mutation-survivor pins (core-survivor-triage unit) ────────────────────────
// Red-proven pins for Stryker survivors from the first full core mutation report.

// kills: document-mutation.ts:148:20 LogicalOperator #853
// kills: document-mutation.ts:148:37 StringLiteral #854
// kills: document-mutation.ts:199:11 ConditionalExpression #899
test("pin: a patch of a MISSING doc fails typed by default (onAbsent defaults to 'fail') and writes nothing", async () => {
  const { DocumentNotFoundError } = await import("../src/document-mutation.js");
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "missing/doc",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      buildCandidate: () => candidate("X", "x"),
    }),
    DocumentNotFoundError,
  );
  assert.deepEqual(await backend.list(), []);
});

// kills: document-mutation.ts:118:7 ConditionalExpression #830
// kills: document-mutation.ts:149:28 LogicalOperator #855
// kills: document-mutation.ts:228:34 BooleanLiteral #928
test("pin: compareTimestamp:true makes a timestamp-only refresh a REAL write", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "same") });

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    compareTimestamp: true,
    buildCandidate: (existing) => ({
      frontmatter: { ...existing!.frontmatter, timestamp: "2026-07-17T00:00:00.000Z" },
      body: existing!.body,
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.doc.frontmatter.timestamp, "2026-07-17T00:00:00.000Z");
  assert.equal((await backend.versions("notes/a")).length, 2);
});

// kills: document-mutation.ts:129:7 LogicalOperator #834
// kills: document-mutation.ts:150:45 BooleanLiteral #858
test("core defaults persist a supplied actor into frontmatter without a caller opt-in", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "alice",
    buildCandidate: () => candidate("A", "body"),
  });
  assert.equal(result.doc.frontmatter.actor, "alice");
  assert.equal((await backend.versions("notes/a"))[0]?.actor, "alice"); // attribution still rides the WRITE, not the doc
});

test("compatibility metadata mode explicitly preserves legacy actor and clock behavior", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: { type: "Note", title: "A", timestamp: "2026-07-16T00:00:00.000Z" },
    body: "before",
  });

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "alice/codex",
    metadataMode: "compatibility",
    now: () => "2026-08-14T12:00:00.000Z",
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after" }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.doc.frontmatter.actor, undefined);
  assert.equal(result.doc.frontmatter.timestamp, "2026-07-16T00:00:00.000Z");
  assert.equal((await backend.versions("notes/a"))[0]?.actor, "alice/codex");
});

test("compatibility metadata mode preserves a v0.2 document without generated or portable actor metadata", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: { type: "Note", title: "A" },
    body: "before",
  });

  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "alice/codex",
    metadataMode: "compatibility",
    now: () => "2026-08-14T12:00:00.000Z",
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after" }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.doc.frontmatter.superbee_updated_by, undefined);
  assert.equal(result.doc.frontmatter.generated, undefined);
});

test("preserve-v01-timestamp retains v0.1 clocks but follows v0.2 core defaults", async () => {
  const v01Backend = new MemoryBackend();
  const v01Bundle = bundleFor(v01Backend);
  await writeDocVersioned(v01Bundle, {
    id: "notes/a",
    frontmatter: { type: "Note", title: "A", timestamp: "2026-07-16T00:00:00.000Z" },
    body: "before",
  });
  const v01 = await mutateDocument({
    bundle: v01Bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "alice/codex",
    metadataMode: "preserve-v01-timestamp",
    now: () => "2026-08-14T12:00:00.000Z",
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after" }),
  });
  assert.equal(v01.doc.frontmatter.timestamp, "2026-07-16T00:00:00.000Z");
  assert.equal(v01.doc.frontmatter.actor, "alice/codex");
  assert.equal((await v01Backend.versions("notes/a"))[0]?.actor, "alice/codex");

  const v02Backend = new MemoryBackend();
  const v02Bundle = await v02BundleFor(v02Backend);
  await writeDocVersioned(v02Bundle, {
    id: "notes/a",
    frontmatter: { type: "Note", title: "A" },
    body: "before",
  });
  const v02 = await mutateDocument({
    bundle: v02Bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "alice/codex",
    metadataMode: "preserve-v01-timestamp",
    now: () => "2026-08-14T12:00:00.000Z",
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "after" }),
  });
  assert.equal(v02.doc.frontmatter.superbee_updated_by, "alice/codex");
  assert.deepEqual(v02.doc.frontmatter.generated, {
    by: "process:superbee",
    at: "2026-08-14T12:00:00.000Z",
  });
  assert.equal((await v02Backend.versions("notes/a"))[0]?.actor, "alice/codex");
});

test("protocol-identity metadata preserves actor attribution without generating a v0.2 clock", async () => {
  const backend = new MemoryBackend();
  const bundle = await v02BundleFor(backend);
  const result = await mutateDocument({
    bundle,
    id: "views-registry/protocol",
    mode: "create-only",
    registry: EMPTY_REGISTRY,
    strict: true,
    actor: "openai/codex",
    metadataMode: "protocol-identity",
    now: () => "2026-08-14T12:00:00.000Z",
    buildCandidate: () => ({
      frontmatter: {
        type: "View",
        title: "Protocol View",
        entry: "views/protocol.html",
        entry_version: "sha256:0123456789012345678901234567890123456789012345678901234567890123",
        access: "none",
      },
      body: "",
    }),
  });

  assert.deepEqual(result.doc.frontmatter, {
    type: "View",
    title: "Protocol View",
    entry: "views/protocol.html",
    entry_version: "sha256:0123456789012345678901234567890123456789012345678901234567890123",
    access: "none",
    superbee_updated_by: "openai/codex",
  });
  assert.equal((await backend.versions("views-registry/protocol"))[0]?.actor, "openai/codex");
});

test("unknown metadata mode is rejected before the mutation reads or writes", async () => {
  const backend = new MemoryBackend();
  await assert.rejects(
    () => mutateDocument({
      bundle: bundleFor(backend),
      id: "notes/a",
      mode: "create-only",
      registry: EMPTY_REGISTRY,
      strict: false,
      metadataMode: "unexpected" as never,
      buildCandidate: () => candidate("A", "body"),
    }),
    (error: unknown) => error instanceof InvalidInputError && /metadata mode/.test(error.message),
  );
  assert.deepEqual(await backend.list(), []);
});

// kills: document-mutation.ts:203:22 ConditionalExpression #910
test("pin: hard CAS with the CURRENT head version succeeds in one shot", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const current = (await writeDocVersioned(bundle, { id: "notes/a", ...candidate("A", "v1") })).version;
  const result = await mutateDocument({
    bundle,
    id: "notes/a",
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    expectedVersion: current,
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "v2" }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.doc.body, "v2");
});

// kills: document-mutation.ts:97:7 ConditionalExpression #781
// kills: document-mutation.ts:97:7 EqualityOperator #783
// kills: document-mutation.ts:102:7 ConditionalExpression #802
// kills: document-mutation.ts:102:7 ConditionalExpression #807
// kills: document-mutation.ts:102:7 LogicalOperator #808
// kills: document-mutation.ts:102:17 ConditionalExpression #809
// kills: document-mutation.ts:107:12 ConditionalExpression #816
// kills: document-mutation.ts:107:12 ConditionalExpression #819
// kills: document-mutation.ts:107:45 MethodExpression #821
test("pin: a frontmatter-only structural change is a REAL change — added keys, one-of-two changed, null→{} and 1→{}", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  const ts = "2026-07-16T00:00:00.000Z";
  await writeDocVersioned(bundle, {
    id: "notes/a",
    frontmatter: { type: "Note", title: "A", timestamp: ts, extra: null, num: 1 },
    body: "same",
  });

  const patch = (mutate: (fm: Record<string, unknown>) => void) =>
    mutateDocument({
      bundle,
      id: "notes/a",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      buildCandidate: (existing) => {
        const fm = { ...existing!.frontmatter } as Record<string, unknown>;
        mutate(fm);
        return { frontmatter: fm, body: existing!.body };
      },
    });

  const added = await patch((fm) => { fm.added = "new"; });
  assert.equal(added.changed, true);
  assert.equal(added.doc.frontmatter.added, "new");

  const oneOfTwo = await patch((fm) => { fm.title = "B"; });
  assert.equal(oneOfTwo.changed, true);
  assert.equal(oneOfTwo.doc.frontmatter.title, "B");

  const nullToObject = await patch((fm) => { fm.extra = {}; });
  assert.equal(nullToObject.changed, true);
  assert.deepEqual(nullToObject.doc.frontmatter.extra, {});

  const numToObject = await patch((fm) => { fm.num = {}; });
  assert.equal(numToObject.changed, true);
  assert.deepEqual(numToObject.doc.frontmatter.num, {});
});

// kills: document-mutation.ts:140:7 LogicalOperator #844
// kills: document-mutation.ts:140:7 LogicalOperator #846
// kills: document-mutation.ts:140:25 ConditionalExpression #847
// kills: document-mutation.ts:140:25 EqualityOperator #848
test("pin: the strict kind gate only throws for strict AND governed AND violating — conforming strict writes and non-strict violations pass", async () => {
  const noteKind: KindConvention = {
    id: "conventions/note",
    title: "Note",
    governs: "Note",
    fields: { required: ["title", "timestamp"], optional: [], values: {}, terminal: {}, descriptions: {} },
  };
  const registry: KindRegistry = { kinds: new Map([["Note", noteKind]]), warnings: [] };

  // strict + governed + CONFORMING → succeeds.
  {
    const backend = new MemoryBackend();
    const bundle = bundleFor(backend);
    const result = await mutateDocument({
      bundle,
      id: "notes/ok",
      mode: "create-only",
      registry,
      strict: true,
      buildCandidate: () => candidate("A", "body"),
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.warnings, []);
  }

  // NON-strict + governed + VIOLATING → warns, never throws.
  {
    const backend = new MemoryBackend();
    const bundle = bundleFor(backend);
    const result = await mutateDocument({
      bundle,
      id: "notes/warned",
      mode: "create-only",
      registry,
      strict: false,
      buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "no title" }),
    });
    assert.equal(result.changed, true);
    assert.ok(result.warnings.length > 0);
  }
});

// ── monotone conformance ratchet on overwrite (tasks/overwrite-monotone-ratchet) ─────────────
//
// Probe: tasks/overwrite-ratchet-survey (1494 pass / 1 fail against main). Rule: in the
// OVERWRITE branch's `decide`, when NOT strict AND an existing doc is present AND that
// existing doc already conforms to ITS OWN governing kind (zero warnings), a candidate that
// violates ITS OWN — possibly retyped — kind throws `KindConformanceError` instead of writing
// with warnings. A never-conformed existing keeps today's lenient staging behavior. `promote`'s
// CAS-overwrite path (direct `writeDocVersioned`, gated by its own `--expected-version`/
// `--strict`) is a documented escape and stays out of this rule — see `promote.ts`'s own comment.

const TASK_KIND: KindConvention = {
  id: "conventions/task",
  title: "Task",
  governs: "Task",
  fields: {
    required: ["title", "status"],
    optional: ["assignee"],
    values: {},
    terminal: {},
    descriptions: {},
  },
};

const NOTE_KIND: KindConvention = {
  id: "conventions/note",
  title: "Note",
  governs: "Note",
  fields: { required: ["title", "timestamp"], optional: [], values: {}, terminal: {}, descriptions: {} },
};

const TASK_NOTE_REGISTRY: KindRegistry = {
  kinds: new Map([["Task", TASK_KIND], ["Note", NOTE_KIND]]),
  warnings: [],
};

// (a) conforming existing + regressing candidate → KindConformanceError.
// RED-PROOF: commenting out the ratchet's `if (!opts.strict && existing && warnings.length > 0
// && conforms(existing, opts.registry))` throw in document-mutation.ts's overwrite `decide` makes
// this test fail (the write would silently succeed with a warning instead of throwing).
test("overwrite ratchet: a candidate that drops a REQUIRED field off an already-conforming existing Task is REFUSED, not warned", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "tasks/a",
    frontmatter: { type: "Task", title: "T", status: "todo", timestamp: "2026-07-16T00:00:00.000Z" },
    body: "b",
  });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "tasks/a",
      mode: "overwrite",
      registry: TASK_NOTE_REGISTRY,
      strict: false,
      buildCandidate: () => ({
        frontmatter: { type: "Task", title: "T", timestamp: "2026-07-17T00:00:00.000Z" },
        body: "b",
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof KindConformanceError);
      assert.equal(error.governs, "Task");
      assert.ok(error.violations.some((warning) => warning.field === "status"));
      return true;
    },
  );

  // Refused: the existing conforming doc is untouched.
  const after = await readDocVersioned(bundle, "tasks/a");
  assert.equal(after.doc.frontmatter.status, "todo");
  assert.equal((await backend.versions("tasks/a")).length, 1);
});

// (b) never-conformed existing + still-nonconforming candidate → writes with warnings (staging pin).
test("overwrite ratchet: a NEVER-conforming existing Task (missing status from the start) keeps lenient staging — still-nonconforming candidate writes with warnings", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "tasks/b",
    frontmatter: { type: "Task", title: "T1", timestamp: "2026-07-16T00:00:00.000Z" }, // status missing — never conformed
    body: "b",
  });

  const result = await mutateDocument({
    bundle,
    id: "tasks/b",
    mode: "overwrite",
    registry: TASK_NOTE_REGISTRY,
    strict: false,
    buildCandidate: () => ({
      frontmatter: { type: "Task", title: "T2", timestamp: "2026-07-17T00:00:00.000Z" }, // still no status
      body: "b2",
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.doc.frontmatter.title, "T2");
  assert.ok(result.warnings.some((warning) => warning.field === "status"));
});

// (c) conforming existing + candidate dropping only OPTIONAL fields → writes, no throw.
// `assignee` is declared OPTIONAL on Task — validateAgainstKind never warns on a missing optional
// field, so the candidate still conforms fully (warnings stay empty) and the ratchet never fires.
test("overwrite ratchet: dropping only an OPTIONAL field off a conforming Task writes cleanly — conformance survives, the ratchet never fires", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "tasks/c",
    frontmatter: {
      type: "Task",
      title: "T",
      status: "todo",
      assignee: "alice",
      timestamp: "2026-07-16T00:00:00.000Z",
    },
    body: "b",
  });

  const result = await mutateDocument({
    bundle,
    id: "tasks/c",
    mode: "overwrite",
    registry: TASK_NOTE_REGISTRY,
    strict: false,
    buildCandidate: () => ({
      // assignee (optional) dropped; title + status (both required) still present.
      frontmatter: { type: "Task", title: "T", status: "todo", timestamp: "2026-07-17T00:00:00.000Z" },
      body: "b",
    }),
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(Object.prototype.hasOwnProperty.call(result.doc.frontmatter, "assignee"), false);
});

// (d) retype conforming-governed → UNGOVERNED type → writes (the documented escape pin).
test("overwrite ratchet: retyping a conforming Task to an UNGOVERNED type is a visible escape — writes, no throw", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "tasks/d",
    frontmatter: { type: "Task", title: "T", status: "todo", timestamp: "2026-07-16T00:00:00.000Z" },
    body: "b",
  });

  const result = await mutateDocument({
    bundle,
    id: "tasks/d",
    mode: "overwrite",
    registry: TASK_NOTE_REGISTRY,
    strict: false,
    buildCandidate: () => ({
      frontmatter: { type: "Freeform", note: "no kind governs this" }, // ungoverned — no convention declares "Freeform"
      body: "b2",
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.doc.frontmatter.type, "Freeform");
  assert.deepEqual(result.warnings, []);
});

// (e) retype conforming-A → nonconforming-B → refuses.
test("overwrite ratchet: retyping a conforming Task into a NON-conforming Note (dropping Note's own required title) is refused", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "tasks/e",
    frontmatter: { type: "Task", title: "T", status: "todo", timestamp: "2026-07-16T00:00:00.000Z" },
    body: "b",
  });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "tasks/e",
      mode: "overwrite",
      registry: TASK_NOTE_REGISTRY,
      strict: false,
      buildCandidate: () => ({
        frontmatter: { type: "Note", timestamp: "2026-07-17T00:00:00.000Z" }, // Note requires title too — missing
        body: "b2",
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof KindConformanceError);
      assert.equal(error.governs, "Note");
      assert.ok(error.violations.some((warning) => warning.field === "title"));
      return true;
    },
  );

  const after = await readDocVersioned(bundle, "tasks/e");
  assert.equal(after.doc.frontmatter.type, "Task");
});

// Conventions-free byte-identity: the rule needs a non-empty registry to ever fire (`conforms`
// always returns false when no kind is declared) — a bundle with NO kind conventions gets
// byte-identical overwrite behavior to before this unit, even for a "regressing" candidate.
test("overwrite ratchet: a conventions-free registry never fires the ratchet — byte-identical lenient overwrite behavior", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "tasks/f",
    frontmatter: { type: "Task", title: "T", status: "todo", timestamp: "2026-07-16T00:00:00.000Z" },
    body: "b",
  });

  const result = await mutateDocument({
    bundle,
    id: "tasks/f",
    mode: "overwrite",
    registry: EMPTY_REGISTRY, // no Convention docs loaded — a cheap list-of-nothing
    strict: false,
    buildCandidate: () => ({
      frontmatter: { type: "Task", title: "T", timestamp: "2026-07-17T00:00:00.000Z" }, // drops "status" too
      body: "b2",
    }),
  });

  assert.equal(result.changed, true);
  assert.equal(result.doc.frontmatter.title, "T");
  assert.equal(Object.prototype.hasOwnProperty.call(result.doc.frontmatter, "status"), false);
  assert.deepEqual(result.warnings, []);
});

// `doc write --strict` behavior unchanged: strict already threw (inside validateCandidate, before
// the ratchet's own check ever runs — guarded by `!opts.strict`) — pin one strict overwrite case
// against an ALREADY-CONFORMING existing doc to prove no double-throw and no changed message
// versus the pre-existing strict contract (`strict kind rejection is typed...` test above, same
// message shape for create-only).
test("overwrite ratchet: --strict over an already-conforming existing doc still throws the ORIGINAL strict-path error — one throw, unchanged message", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  await writeDocVersioned(bundle, {
    id: "tasks/g",
    frontmatter: { type: "Task", title: "T", status: "todo", timestamp: "2026-07-16T00:00:00.000Z" },
    body: "b",
  });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "tasks/g",
      mode: "overwrite",
      registry: TASK_NOTE_REGISTRY,
      strict: true,
      buildCandidate: () => ({
        frontmatter: { type: "Task", title: "T", timestamp: "2026-07-17T00:00:00.000Z" }, // drops status
        body: "b2",
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof KindConformanceError);
      assert.equal(error.name, "KindConformanceError");
      assert.equal(error.id, "tasks/g");
      assert.equal(error.governs, "Task");
      assert.equal(
        error.message,
        `'tasks/g' does not satisfy the 'Task' kind: ${error.violations.map((warning) => warning.message).join("; ")}`,
      );
      return true;
    },
  );

  // No write happened at all (strict throws before the write attempt, exactly as pre-unit).
  assert.equal((await backend.versions("tasks/g")).length, 1);
});

// ── raw-conformance alignment (tasks/conforms-raw-alignment) ─────────────────────────────────
//
// PR #119 review finding 1 (MEDIUM, empirical): the ratchet's `conforms()` used to validate a
// write-normalized clone of `existing` (timestamp defaulted per kinds.ts's one-validator rule)
// while `status`'s `conformance_debt` validates the RAW frontmatter — so an externally-authored
// doc missing a kind-required timestamp counted as DEBT to `status` yet CONFORMING to the
// ratchet, earning an over-strict refusal where staging leniency should apply. `conforms()` now
// validates the raw existing frontmatter (no timestamp defaulting); the candidate side is
// unaffected (still write-normalized, per `validateCandidate`).

// Reviewer's exact probe: an externally-authored doc missing a kind-required timestamp, then a
// dropping overwrite → writes with warnings, NOT refused (staging leniency restored).
// RED-PROOF: restoring the ratchet's old defaulting behavior (calling
// `defaultTimestampAndValidateAgainstRegistry` on a clone of `existing` inside `conforms()`,
// instead of `validateAgainstKind` on the raw frontmatter) makes this test fail — the defaulted
// clone would look conforming (timestamp back-filled), the ratchet would fire, and the write
// would throw `KindConformanceError` instead of succeeding with warnings.
test("overwrite ratchet: an externally-authored existing doc missing a kind-required timestamp keeps lenient staging on a dropping overwrite", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  // Externally-authored: written straight to the BACKEND, bypassing `writeDocVersioned`'s
  // bundle-level timestamp guarantee (bundle.ts:131-139 defaults `timestamp` on every engine
  // write) — the same raw, never-normalized shape a hand-authored bundle doc arrives in.
  await backend.write("notes/ext", {
    id: "notes/ext",
    frontmatter: { type: "Note", title: "External" }, // timestamp MISSING — raw, never defaulted
    body: "b",
  });

  const result = await mutateDocument({
    bundle,
    id: "notes/ext",
    mode: "overwrite",
    registry: TASK_NOTE_REGISTRY,
    strict: false,
    buildCandidate: () => ({
      frontmatter: { type: "Note" }, // drops title too — still nonconforming, but a WRITE, not a throw
      body: "b2",
    }),
  });

  assert.equal(result.changed, true);
  assert.ok(result.warnings.some((warning) => warning.field === "title"));
});

// Cross-surface agreement pin: the SAME fixture that counts as debt to `status`'s
// `conformance_debt` (validateAgainstKind on the raw doc, packages/cli/src/commands/status.ts)
// also gets ratchet leniency — the two surfaces no longer disagree about this doc.
test("cross-surface agreement: a fixture that counts as status's conformance_debt also gets ratchet leniency, not an over-strict refusal", async () => {
  const backend = new MemoryBackend();
  const bundle = bundleFor(backend);
  // Written straight to the backend (see the probe test above) — bypasses `writeDocVersioned`'s
  // bundle-level timestamp guarantee so the fixture stays raw/never-normalized.
  await backend.write("notes/agree", {
    id: "notes/agree",
    frontmatter: { type: "Note", title: "External" }, // timestamp MISSING — raw external fixture
    body: "b",
  });

  // status's own mechanism: validateAgainstKind on the RAW read doc, no timestamp defaulting —
  // a doc failing this is exactly what status counts toward conformance_debt.
  const { doc: rawDoc } = await readDocVersioned(bundle, "notes/agree");
  const statusWarnings = validateAgainstKind(rawDoc, NOTE_KIND);
  assert.ok(statusWarnings.some((warning) => warning.field === "timestamp"));

  // The SAME fixture must get ratchet leniency: a dropping overwrite writes with warnings, not
  // a refusal — proving the two surfaces now agree about this exact doc.
  const result = await mutateDocument({
    bundle,
    id: "notes/agree",
    mode: "overwrite",
    registry: TASK_NOTE_REGISTRY,
    strict: false,
    buildCandidate: () => ({ frontmatter: { type: "Note" }, body: "b2" }), // drops title too
  });
  assert.equal(result.changed, true);
  assert.ok(result.warnings.some((warning) => warning.field === "title"));
});
