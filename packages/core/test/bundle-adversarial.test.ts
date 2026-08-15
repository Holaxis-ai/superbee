import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FilesystemBackend } from "../src/backend.js";
import {
  deleteDoc,
  docVersions,
  initBundle,
  matchesFilter,
  parseLinks,
  query,
  queryEdges,
  queryHeads,
  readBundleOkfVersion,
  readDocVersioned,
  writeDocVersioned,
} from "../src/bundle.js";
import { InvalidInputError } from "../src/errors.js";
import {
  applyV02MutationMetadata,
  isOkfActor,
  normalizeV01DocumentForWrite,
  normalizeV02DocumentForWrite,
  v02MeaningfulContentChanged,
} from "../src/document-write-policy.js";
import { mutateDocument } from "../src/document-mutation.js";
import { MalformedDocumentError, parseMarkdown, stringifyDoc } from "../src/frontmatter.js";
import { GENERATED_INDEX_MARKER } from "../src/index-marker.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { VersionConflict, versionOfBytes } from "../src/versioning.js";
import type {
  Bundle,
  ConceptId,
  HeadResult,
  OkfDocument,
  QueryFilter,
  ReservedFilename,
  Version,
  WriteOptions,
} from "../src/types.js";
import type { KindRegistry } from "../src/kinds.js";

const T = "2026-07-18T00:00:00.000Z";
const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };

function memoryBundle(root = "mem://bundle"): Bundle {
  return { root, backend: new MemoryBackend() };
}

function doc(id: ConceptId, frontmatter: OkfDocument["frontmatter"], body = ""): OkfDocument {
  return { id, frontmatter, body };
}

test("v0.2 write policy is non-inventing, preserves verification, and owns only generated.at", () => {
  const existing = doc("notes/a", {
    type: "Note",
    title: "Before",
    generated: { at: "2026-08-01T00:00:00Z", by: "https://legacy.example/producer" },
    verified: [{ at: "2026-08-02T00:00:00Z", by: "human:reviewer" }],
    stale_after: "2026-12-31",
  }, "body");
  const normalized = normalizeV02DocumentForWrite(
    doc("notes/new", { type: "Note", title: "New" }, "body"),
    "Note",
  );
  assert.deepEqual(normalized.frontmatter, { type: "Note", title: "New" });

  const changed = applyV02MutationMetadata({
    existing,
    candidate: { frontmatter: { type: "Note", title: "After", stale_after: "2026-12-31" }, body: "body" },
    meaningfulChangeAt: "2026-08-03T00:00:00Z",
  });
  assert.deepEqual(changed.frontmatter.generated, {
    at: "2026-08-03T00:00:00Z",
    by: "https://legacy.example/producer",
  });
  assert.deepEqual(changed.frontmatter.verified, existing.frontmatter.verified);
  assert.equal(changed.frontmatter.stale_after, "2026-12-31");

  const verificationOnly = applyV02MutationMetadata({
    existing,
    candidate: {
      frontmatter: { ...existing.frontmatter, verified: [{ at: "2026-08-04T00:00:00Z", by: "human:two" }] },
      body: existing.body,
    },
    meaningfulChangeAt: "2026-08-05T00:00:00Z",
  });
  assert.equal((verificationOnly.frontmatter.generated as { at: string }).at, "2026-08-01T00:00:00Z");
  assert.equal(v02MeaningfulContentChanged(existing, verificationOnly), false);
  assert.equal(isOkfActor("human:mike"), true);
  assert.equal(isOkfActor("superbee/1.0.0"), true);
  assert.equal(isOkfActor("https://legacy.example/producer"), false);
});

test("initBundle writes one deterministic root index with expect-absent CAS and preserves it thereafter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-init-contract-"));
  const original = FilesystemBackend.prototype.writeReserved;
  const writes: Array<{
    dir: string;
    name: ReservedFilename;
    content: string;
    options: WriteOptions | undefined;
  }> = [];
  FilesystemBackend.prototype.writeReserved = async function (dir, name, content, options) {
    writes.push({ dir, name, content, options });
    return original.call(this, dir, name, content, options);
  };

  try {
    const bundle = await initBundle(root, { okfVersion: "0.1" });
    assert.equal(bundle.root, path.resolve(root));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.dir, "");
    assert.equal(writes[0]!.name, "index.md");
    assert.deepEqual(writes[0]!.options, { expectedVersion: null });
    assert.match(writes[0]!.content, /okf_version: ['"]?0\.1['"]?/);
    assert.match(
      writes[0]!.content,
      new RegExp(`${GENERATED_INDEX_MARKER}\\n# ${path.basename(root)}\\n\\nAn Open Knowledge Format bundle\\.\\n$`),
    );

    await initBundle(root, { okfVersion: "0.1" });
    assert.equal(writes.length, 1, "an existing root index must remain byte-untouched");
    const raw = (await new FilesystemBackend(bundle.root).readReserved("", "index.md"))!;
    const parsed = parseMarkdown(raw.content);
    assert.deepEqual({ body: parsed.body, okfVersion: parsed.frontmatter.okf_version }, {
      body: `${GENERATED_INDEX_MARKER}\n# ${path.basename(root)}\n\nAn Open Knowledge Format bundle.\n`,
      okfVersion: "0.1",
    });
  } finally {
    FilesystemBackend.prototype.writeReserved = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("initBundle rejects unsupported authoring-version claims before touching the target", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "okf-init-version-guard-"));
  try {
    const supported = path.join(parent, "supported-v02");
    await initBundle(supported, { okfVersion: "0.2" });
    assert.match(await readFile(path.join(supported, "index.md"), "utf8"), /okf_version: ['"]?0\.2['"]?/);

    for (const requested of ["9.4", ""]) {
      const root = path.join(parent, requested || "blank");
      await assert.rejects(
        () => initBundle(root, { okfVersion: requested }),
        (error: unknown) =>
          error instanceof InvalidInputError &&
          error.message.includes(`'${requested}'`) &&
          /author 0\.1 and 0\.2/.test(error.message) &&
          /read or transported/.test(error.message),
      );
      assert.equal(existsSync(root), false, `unsupported version ${JSON.stringify(requested)} must not create its target`);
    }

    const existing = path.join(parent, "existing-v02");
    const existingIndex = "---\nokf_version: '0.2'\n---\n# External bundle\n";
    await mkdir(existing);
    await writeFile(path.join(existing, "index.md"), existingIndex);
    await initBundle(existing);
    const reopened = await new FilesystemBackend(existing).readReserved("", "index.md");
    assert.equal(reopened?.content, existingIndex, "opening an existing v0.2 bundle must not rewrite it");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("readBundleOkfVersion reads the root edition through filesystem and memory backends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-version-read-"));
  try {
    const filesystemBundle = await initBundle(root);
    assert.equal(await readBundleOkfVersion(filesystemBundle), "0.1");

    const backend = new MemoryBackend();
    const memory = { root: "mem://versioned", backend };
    assert.equal(await readBundleOkfVersion(memory), undefined);
    await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# External\n");
    assert.equal(await readBundleOkfVersion(memory), "0.2");
    await backend.writeReserved("", "index.md", "---\nokf_version: [\n---\n# Broken\n");
    await assert.rejects(() => readBundleOkfVersion(memory), MalformedDocumentError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initBundle swallows only the expect-absent VersionConflict from a winning racer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-init-race-"));
  const original = FilesystemBackend.prototype.writeReserved;
  const sentinel = new Error("disk exploded");

  try {
    FilesystemBackend.prototype.writeReserved = async function (dir, name, content, options) {
      const version = await original.call(this, dir, name, content, options);
      throw new VersionConflict("index.md", null, version);
    };
    const raced = await initBundle(root);
    const raw = (await new FilesystemBackend(raced.root).readReserved("", "index.md"))!;
    assert.equal(parseMarkdown(raw.content).frontmatter.okf_version, "0.1", "the default version remains deterministic");

    await rm(root, { recursive: true, force: true });
    FilesystemBackend.prototype.writeReserved = async function () {
      throw sentinel;
    };
    await assert.rejects(() => initBundle(root), (error: unknown) => error === sentinel);
  } finally {
    FilesystemBackend.prototype.writeReserved = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("writeDocVersioned rejects every empty or non-string type before storage", async () => {
  const bundle = memoryBundle();
  for (const [index, type] of [undefined, null, 0, false, "", "   "].entries()) {
    const id = `bad/${index}`;
    await assert.rejects(
      () => writeDocVersioned(bundle, doc(id, { type } as never)),
      (error: unknown) =>
        error instanceof InvalidInputError &&
        error.message === `OKF §9.2: frontmatter.type is required and must be non-empty (concept '${id}').`,
    );
  }
  assert.deepEqual(await bundle.backend!.list(), []);
});

test("v0.1 write policy deterministically owns timestamp fallback, key ordering, unknown fields, and body defaulting", () => {
  const fallback = "2026-08-08T01:30:00.000Z";
  const nested = { generated: { at: "2026-07-01T00:00:00Z" }, flags: [true, false] };
  const cases: Array<{ name: string; timestamp: unknown; preserveExisting: boolean; expectedTimestamp: string }> = [
    { name: "missing", timestamp: undefined, preserveExisting: false, expectedTimestamp: fallback },
    { name: "blank", timestamp: " ", preserveExisting: false, expectedTimestamp: fallback },
    { name: "number", timestamp: 0, preserveExisting: false, expectedTimestamp: fallback },
    { name: "null", timestamp: null, preserveExisting: false, expectedTimestamp: fallback },
    { name: "existing", timestamp: "  preserved  ", preserveExisting: true, expectedTimestamp: "  preserved  " },
  ];

  for (const { name, timestamp, preserveExisting, expectedTimestamp } of cases) {
    const frontmatter = {
      timestamp,
      title: name,
      type: "Note",
      x_producer: nested,
    } as unknown as OkfDocument["frontmatter"];
    const input = { id: `notes/${name}`, frontmatter, body: undefined } as unknown as OkfDocument;
    const timestampDecision = preserveExisting
      ? { preserveExisting: true as const, existingTimestamp: timestamp as string }
      : { preserveExisting: false as const, fallbackTimestamp: fallback };
    const normalized = normalizeV01DocumentForWrite(input, "Note", timestampDecision);

    assert.deepEqual(Object.keys(normalized.frontmatter), ["type", "title", "x_producer", "timestamp"]);
    assert.deepEqual(normalized.frontmatter, {
      type: "Note",
      title: name,
      x_producer: nested,
      timestamp: expectedTimestamp,
    });
    assert.equal(normalized.frontmatter.x_producer, nested, "unknown nested metadata stays byte-shape preserving");
    assert.equal(normalized.body, "");
    assert.equal(input.body, undefined, "normalization must not mutate the input body");
    assert.equal(input.frontmatter.timestamp, timestamp, "normalization must not mutate input frontmatter");
  }
});

test("a filesystem document mutation preserves top-level and nested date-only scalar shapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-date-shape-"));
  const documentPath = path.join(root, "notes", "dated.md");
  await mkdir(path.dirname(documentPath), { recursive: true });
  await writeFile(documentPath, `---
type: Note
title: Before
timestamp: 2026-07-16T00:00:00Z
stale_after: 2026-12-31
generated:
  at: 2026-07-28T12:34:56Z
sources:
  - resource: https://example.test/source
    last_modified: 2026-07-27
---
body
`);

  try {
    const bundle: Bundle = { root };
    const result = await mutateDocument({
      bundle,
      id: "notes/dated",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      buildCandidate: (existing) => ({
        frontmatter: { ...existing!.frontmatter, title: "After" },
        body: existing!.body,
      }),
    });

    assert.equal(result.changed, true);
    assert.equal(result.doc.frontmatter.stale_after, "2026-12-31");
    assert.deepEqual(result.doc.frontmatter.sources, [{
      resource: "https://example.test/source",
      last_modified: "2026-07-27",
    }]);

    const persisted = await readFile(documentPath, "utf8");
    assert.doesNotMatch(persisted, /(?:2026-12-31|2026-07-27)T/);
    const reread = await readDocVersioned(bundle, "notes/dated");
    assert.equal(reread.doc.frontmatter.stale_after, "2026-12-31");
    assert.deepEqual(reread.doc.frontmatter.sources, result.doc.frontmatter.sources);
    assert.deepEqual(reread.doc.frontmatter.generated, { at: "2026-07-28T12:34:56Z" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeDocVersioned preserves first-read values and does not touch the clock for a usable timestamp", async () => {
  let typeReads = 0;
  let timestampReads = 0;
  let clockReads = 0;
  const frontmatter = { title: "Accessor input" } as OkfDocument["frontmatter"];
  Object.defineProperties(frontmatter, {
    type: {
      enumerable: true,
      get: () => (++typeReads === 1 ? "Note" : "Changed"),
    },
    timestamp: {
      enumerable: true,
      get: () => (++timestampReads === 1 ? T : "changed timestamp"),
    },
  });

  class RecordingBackend extends MemoryBackend {
    override async write(_id: ConceptId, value: OkfDocument): Promise<Version> {
      return versionOfBytes(stringifyDoc(value.frontmatter, value.body));
    }
  }

  const NativeDate = globalThis.Date;
  class CountingDate extends NativeDate {
    constructor(value?: string | number) {
      clockReads++;
      value === undefined ? super("2026-08-08T01:30:00.000Z") : super(value);
    }
  }

  globalThis.Date = CountingDate as DateConstructor;
  try {
    const written = await writeDocVersioned(
      { root: "mem://accessor-parity", backend: new RecordingBackend() },
      { id: "notes/accessor", frontmatter, body: "body" },
    );
    assert.equal(written.doc.frontmatter.type, "Note", "persist the value that passed validation");
    assert.equal(written.doc.frontmatter.timestamp, T, "persist the first timestamp read");
    assert.equal(clockReads, 0, "a usable timestamp must not newly depend on the wall clock");

    const defaulted = await writeDocVersioned(
      { root: "mem://clock-parity", backend: new RecordingBackend() },
      doc("notes/defaulted", { type: "Note" }),
    );
    assert.equal(defaulted.doc.frontmatter.timestamp, "2026-08-08T01:30:00.000Z");
    assert.equal(clockReads, 1, "a missing timestamp reads the wall clock exactly once");
  } finally {
    globalThis.Date = NativeDate;
  }
});

test("writeDocVersioned evaluates timestamp usability once before applying the policy", async () => {
  const timestamp = "unstable timestamp";
  const fallback = "2026-08-08T01:30:00.000Z";
  const nativeTrim = String.prototype.trim;
  const NativeDate = globalThis.Date;
  let timestampTrimReads = 0;

  String.prototype.trim = function (): string {
    if (this.toString() === timestamp) {
      timestampTrimReads++;
      return timestampTrimReads === 1 ? "" : "usable on a second read";
    }
    return nativeTrim.call(this);
  };
  class FixedDate extends NativeDate {
    constructor(value?: string | number) {
      value === undefined ? super(fallback) : super(value);
    }
  }

  globalThis.Date = FixedDate as DateConstructor;
  try {
    const written = await writeDocVersioned(
      memoryBundle(),
      doc("notes/single-timestamp-decision", { type: "Note", timestamp }),
    );
    assert.equal(timestampTrimReads, 1);
    assert.equal(written.doc.frontmatter.timestamp, fallback);
  } finally {
    String.prototype.trim = nativeTrim;
    globalThis.Date = NativeDate;
  }
});

test("writeDocVersioned normalizes ordering, timestamp, and absent body without mutating the input", async () => {
  const bundle = memoryBundle();
  const input = {
    id: "notes/normalized",
    frontmatter: { timestamp: "  preserved  ", title: "N", type: "Note", extra: false },
    body: undefined,
  } as unknown as OkfDocument;
  const written = await writeDocVersioned(bundle, input);
  const policyResult = normalizeV01DocumentForWrite(
    input,
    "Note",
    { preserveExisting: true, existingTimestamp: input.frontmatter.timestamp as string },
  );

  assert.deepEqual(written.doc, policyResult);
  assert.equal(written.version, versionOfBytes(stringifyDoc(policyResult.frontmatter, policyResult.body)));
  assert.deepEqual(Object.keys(written.doc.frontmatter), ["type", "title", "extra", "timestamp"]);
  assert.deepEqual(written.doc.frontmatter, {
    type: "Note",
    title: "N",
    extra: false,
    timestamp: "  preserved  ",
  });
  assert.equal(written.doc.body, "");
  assert.equal(input.body, undefined);

  for (const [id, timestamp] of [["blank", " "], ["number", 0], ["null", null]] as const) {
    const defaulted = await writeDocVersioned(
      bundle,
      doc(`notes/defaulted-${id}`, { type: "Note", timestamp } as never, "body"),
    );
    assert.match(String(defaulted.doc.frontmatter.timestamp), /^\d{4}-\d\d-\d\dT/);
    assert.notEqual(defaulted.doc.frontmatter.timestamp, timestamp);
  }
});

test("write, versioned read, and history all reject reserved ids at the engine boundary", async () => {
  const bundle = memoryBundle();
  const cases = [
    ["index", "index.md"],
    ["nested/log", "nested/log.md"],
  ] as const;

  for (const [id, rel] of cases) {
    await assert.rejects(
      () => writeDocVersioned(bundle, doc(id, { type: "Concept" })),
      (error: unknown) =>
        error instanceof InvalidInputError &&
        error.message === `'${id}' maps to a reserved file (${rel}); use the index/log accessors, not writeDoc.`,
    );
    for (const operation of [
      () => readDocVersioned(bundle, id),
      () => docVersions(bundle, id),
    ]) {
      await assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof InvalidInputError &&
          error.message === `'${id}' is a reserved file (index.md / log.md), not a concept document.`,
      );
    }
  }
});

test("deleteDoc still admits ordinary ids and remains idempotent after enforcing reserved-file guards", async () => {
  const bundle = memoryBundle();
  await writeDocVersioned(bundle, doc("notes/delete-me", { type: "Note", timestamp: T }));
  assert.equal(await deleteDoc(bundle, "notes/delete-me"), true);
  assert.equal(await deleteDoc(bundle, "notes/delete-me"), false);
});

test("filesystem listing rejects a markdown directory that cannot be a canonical concept namespace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-noncanonical-dir-"));
  try {
    await mkdir(path.join(root, "foo.md"));
    await writeFile(path.join(root, "foo.md", "bar.md"), "---\ntype: Note\n---\n", "utf8");
    await assert.rejects(
      () => new FilesystemBackend(root).list(),
      (error: unknown) =>
        error instanceof InvalidInputError &&
        error.message.includes("non-final segment ending in '.md'") &&
        error.message.includes("foo.md/bar"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "filesystem listing rejects a literal backslash filename instead of reinterpreting its identity",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-noncanonical-backslash-"));
    try {
      await writeFile(path.join(root, "odd\\name.md"), "---\ntype: Note\n---\n", "utf8");
      await assert.rejects(
        () => new FilesystemBackend(root).list(),
        (error: unknown) =>
          error instanceof InvalidInputError &&
          error.message.includes("does not round-trip through canonical id 'odd/name'") &&
          error.message.includes("odd\\name.md"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("matchesFilter distinguishes absent facets, empty tag filters, arrays, nulls, and falsey scalars", () => {
  const candidate = {
    id: "tasks/a",
    frontmatter: { type: "Task", tags: "not-an-array", status: ["todo", "done"], zero: 0, flag: false, empty: null },
  };
  assert.equal(matchesFilter(candidate, { tags: [] }), true);
  assert.equal(matchesFilter(candidate, { tags: ["not-an-array"] }), false);
  assert.equal(matchesFilter(candidate, { fields: { status: "done" } }), true);
  assert.equal(matchesFilter(candidate, { fields: { status: "missing" } }), false);
  assert.equal(matchesFilter(candidate, { fields: { zero: "0", flag: "false" } }), true);
  assert.equal(matchesFilter(candidate, { fields: { empty: "null" } }), false);
  assert.equal(matchesFilter(candidate, { fields: { absent: "undefined" } }), false);
  assert.equal(matchesFilter(candidate, { prefix: "tasks/", type: "Task", fields: { status: "done" } }), true);
});

class ReverseListBackend extends MemoryBackend {
  override async list(prefix?: string): Promise<ConceptId[]> {
    return (await super.list(prefix)).reverse();
  }
}

class UnsortedHeadsBackend extends MemoryBackend {
  override async queryHeads(_filter?: QueryFilter): Promise<HeadResult[]> {
    return [
      { id: "z", frontmatter: { type: "Task" }, version: "sha256:" + "3".repeat(64) as Version },
      { id: "ignored", frontmatter: { type: "Note" }, version: "sha256:" + "2".repeat(64) as Version },
      { id: "a", frontmatter: { type: "Task" }, version: "sha256:" + "1".repeat(64) as Version },
    ];
  }
}

class BatchFailureBackend extends MemoryBackend {
  private readonly failure: unknown;

  constructor(failure: unknown) {
    super();
    this.failure = failure;
  }

  override async readMany(_ids: ConceptId[]): Promise<never> {
    throw this.failure;
  }
}

class PerDocFailureBackend extends MemoryBackend {
  readonly failure = new Error("per-doc storage failure");

  override async readMany(_ids: ConceptId[]): Promise<never> {
    throw Object.assign(new Error("listed document vanished"), { code: "ENOENT" });
  }

  override async read(id: ConceptId) {
    if (id === "bad") throw this.failure;
    return super.read(id);
  }
}

test("query owns deterministic id ordering even when a backend returns reversed ids", async () => {
  const backend = new ReverseListBackend();
  const bundle: Bundle = { root: "mem://reverse", backend };
  await backend.write("z", doc("z", { type: "T", timestamp: T }));
  await backend.write("a", doc("a", { type: "T", timestamp: T }));
  await backend.write("m", doc("m", { type: "T", timestamp: T }));
  assert.deepEqual((await query(bundle)).map((entry) => entry.id), ["a", "m", "z"]);
});

test("queryHeads re-applies filtering and deterministic ordering to an over-returning push-down", async () => {
  const bundle: Bundle = { root: "mem://heads", backend: new UnsortedHeadsBackend() };
  const heads = await queryHeads(bundle, { type: "Task" });
  assert.deepEqual(heads.map((entry) => entry.id), ["a", "z"]);
});

test("query never converts arbitrary batch or fallback read failures into vanished/malformed skips", async () => {
  const batchFailure = new Error("batch storage failure");
  const batch = new BatchFailureBackend(batchFailure);
  await batch.write("a", doc("a", { type: "T", timestamp: T }));
  const batchSkips: unknown[] = [];
  await assert.rejects(
    () => query({ root: "mem://batch", backend: batch }, {}, { onSkip: (entry) => batchSkips.push(entry) }),
    (error: unknown) => error === batchFailure,
  );
  assert.deepEqual(batchSkips, []);

  const fallback = new PerDocFailureBackend();
  await fallback.write("bad", doc("bad", { type: "T", timestamp: T }));
  const skipped: unknown[] = [];
  await assert.rejects(
    () => query({ root: "mem://fallback", backend: fallback }, {}, { onSkip: (entry) => skipped.push(entry) }),
    (error: unknown) => error === fallback.failure,
  );
  assert.deepEqual(skipped, []);
});

test("parseLinks remains the public path to the one markdown-link resolver", () => {
  const links = parseLinks(memoryBundle(), doc("notes/a", { type: "Note" }, "[Task](../tasks/t.md) [web](https://example.com)"));
  assert.deepEqual(links, [{ from: "notes/a", to: "tasks/t", text: "Task", href: "../tasks/t.md" }]);
});

test("edge selectors require exact canonical ids and do not strip a terminal markdown extension", async () => {
  const bundle = memoryBundle();
  await writeDocVersioned(bundle, doc("notes/a", { type: "Note", timestamp: T }, "[Task](../tasks/t.md) [Deep](../tasks/t/suffix.md)"));
  assert.deepEqual(
    (await queryEdges(bundle, { from: "notes/a", to: "tasks/t" })).map((edge) => edge.to),
    ["tasks/t"],
  );
  assert.deepEqual(await queryEdges(bundle, { to: "tasks/t.md" }), []);
  await assert.rejects(() => queryEdges(bundle, { from: "/notes/a" }), InvalidInputError);
  await assert.rejects(() => queryEdges(bundle, { to: "tasks/t.md/suffix" }), InvalidInputError);
});
