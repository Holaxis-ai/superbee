/**
 * Adversarial suite for `mutateDocument`'s field preconditions — the guard that makes a claim a
 * decision instead of a last-writer-wins overwrite. The per-backend one-winner row lives in the
 * shared adapter contract kit; these rows attack the mechanic itself: that a refusal is terminal
 * rather than a retry, that the assertion is re-derived from every attempt's own fresh read, and
 * that it is settled before any convergence or version comparison can swallow it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readDocVersioned, writeDocVersioned } from "../src/bundle.js";
import { mutateDocument } from "../src/document-mutation.js";
import { PreconditionFailed } from "../src/document-precondition.js";
import { InvalidInputError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { VersionConflict } from "../src/versioning.js";
import type { FieldPrecondition } from "../src/document-precondition.js";
import type { KindRegistry } from "../src/kinds.js";
import type {
  Bundle,
  ConceptId,
  Frontmatter,
  OkfDocument,
  ReadResult,
  Version,
  WriteOptions,
} from "../src/types.js";

const EMPTY_REGISTRY: KindRegistry = { kinds: new Map(), warnings: [] };
const TASK = "tasks/contended-claim";
const OWNER = "assignee";
const OWNER_ABSENT: FieldPrecondition[] = [{ field: OWNER, expect: "absent" }];

function taskDoc(extra: Frontmatter = {}): { frontmatter: Frontmatter; body: string } {
  return {
    frontmatter: {
      type: "Task",
      title: "Contended",
      superbee_progress_status: "todo",
      ...extra,
    },
    body: "Do the work.",
  };
}

async function bundleOf(backend: MemoryBackend): Promise<Bundle> {
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
  return { root: "mem://precondition", backend };
}

/** Counts the seam traffic one mutation actually issues, so "never retried" is observed, not argued. */
class CountingBackend extends MemoryBackend {
  reads = 0;
  writes = 0;

  resetCounts(): void {
    this.reads = 0;
    this.writes = 0;
  }

  override async read(id: ConceptId): Promise<ReadResult> {
    this.reads++;
    return super.read(id);
  }

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    this.writes++;
    return super.write(id, doc, options);
  }
}

/** Lets exactly one competing write land ahead of the next mutation write, on that write's own CAS basis. */
class RaceOnceBackend extends MemoryBackend {
  private race?: { id: ConceptId; doc: OkfDocument };

  raceNextWrite(id: ConceptId, doc: OkfDocument): void {
    this.race = { id, doc };
  }

  override async write(id: ConceptId, doc: OkfDocument, options: WriteOptions = {}): Promise<Version> {
    if (this.race?.id === id) {
      const race = this.race;
      this.race = undefined;
      await super.write(id, race.doc, { expectedVersion: options.expectedVersion, actor: "claimant-a" });
    }
    return super.write(id, doc, options);
  }
}

test("a failing precondition is terminal: one read, no write, and the retry budget untouched", async () => {
  const backend = new CountingBackend();
  const bundle = await bundleOf(backend);
  const claimed = await writeDocVersioned(bundle, {
    id: TASK,
    ...taskDoc({ [OWNER]: "claimant-a", superbee_progress_status: "in_progress" }),
  });
  backend.resetCounts();
  let builds = 0;

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      maxAttempts: 5,
      preconditions: OWNER_ABSENT,
      buildCandidate: (existing) => {
        builds++;
        return { frontmatter: { ...existing!.frontmatter, [OWNER]: "claimant-b" }, body: existing!.body };
      },
    }),
    (error: unknown) =>
      error instanceof PreconditionFailed
      && error.id === TASK
      && error.field === OWNER
      && error.expected === "absent"
      && error.actual === "claimant-a"
      && error.observedVersion === claimed.version,
  );

  assert.equal(backend.reads, 1, "a refused claimant must not burn a retry re-reading");
  assert.equal(backend.writes, 0);
  assert.equal(builds, 0, "the refusal must settle before any candidate is built");
  assert.equal((await backend.versions(TASK)).length, 1);
  assert.equal((await readDocVersioned(bundle, TASK)).version, claimed.version);
});

test("the precondition is re-derived from each attempt's fresh read, so a CAS conflict cannot become a win", async () => {
  const backend = new RaceOnceBackend();
  const bundle = await bundleOf(backend);
  const unclaimed = await writeDocVersioned(bundle, { id: TASK, ...taskDoc() });
  // Attempt 1 reads the task unclaimed and its CAS write loses to this one; attempt 2 must decide
  // over the state that actually won, not re-issue the decision it already made.
  backend.raceNextWrite(TASK, {
    id: TASK,
    ...taskDoc({ [OWNER]: "claimant-a", superbee_progress_status: "in_progress" }),
  });
  const seen: unknown[] = [];

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      maxAttempts: 5,
      preconditions: OWNER_ABSENT,
      buildCandidate: (existing) => {
        seen.push(existing!.frontmatter[OWNER]);
        return { frontmatter: { ...existing!.frontmatter, [OWNER]: "claimant-b" }, body: existing!.body };
      },
    }),
    (error: unknown) =>
      error instanceof PreconditionFailed && error.field === OWNER && error.actual === "claimant-a",
  );

  const final = await readDocVersioned(bundle, TASK);
  assert.deepEqual(seen, [undefined], "attempt 2 must refuse before rebuilding the claim");
  assert.equal(final.doc.frontmatter[OWNER], "claimant-a");
  assert.notEqual(final.version, unclaimed.version);
  assert.equal((await backend.versions(TASK)).length, 2, "the losing claimant wrote no bytes");
});

test("the refusal reports the version of the attempt it was evaluated against", async () => {
  const backend = new RaceOnceBackend();
  const bundle = await bundleOf(backend);
  await writeDocVersioned(bundle, { id: TASK, ...taskDoc() });
  backend.raceNextWrite(TASK, { id: TASK, ...taskDoc({ [OWNER]: "claimant-a" }) });

  const failure = await mutateDocument({
    bundle,
    id: TASK,
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    preconditions: OWNER_ABSENT,
    buildCandidate: (existing) => ({
      frontmatter: { ...existing!.frontmatter, [OWNER]: "claimant-b" },
      body: existing!.body,
    }),
  }).then(() => undefined, (error: unknown) => error);

  assert.ok(failure instanceof PreconditionFailed);
  assert.equal(failure.observedVersion, (await readDocVersioned(bundle, TASK)).version);
});

test("an idempotent re-claim whose preconditions hold converges with no write and an unchanged version", async () => {
  const backend = new CountingBackend();
  const bundle = await bundleOf(backend);
  const claimed = await writeDocVersioned(bundle, {
    id: TASK,
    ...taskDoc({
      [OWNER]: "claimant-a",
      superbee_progress_status: "in_progress",
      superbee_updated_by: "claimant-a",
    }),
  });
  backend.resetCounts();

  const result = await mutateDocument({
    bundle,
    id: TASK,
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    actor: "claimant-a",
    persistActor: true,
    preconditions: [
      { field: OWNER, expect: { equals: "claimant-a" } },
      { field: "superbee_progress_status", expect: { oneOf: ["todo", "in_progress"] } },
    ],
    buildCandidate: (existing) => ({
      frontmatter: { ...existing!.frontmatter, [OWNER]: "claimant-a", superbee_progress_status: "in_progress" },
      body: existing!.body,
    }),
  });

  assert.equal(result.changed, false);
  assert.equal(result.version, claimed.version);
  assert.equal(backend.writes, 0);
  assert.equal((await backend.versions(TASK)).length, 1);
  assert.deepEqual((await readDocVersioned(bundle, TASK)).doc, result.doc);
});

test("a failing precondition refuses a patch that would otherwise converge as a no-op", async () => {
  const backend = new MemoryBackend();
  const bundle = await bundleOf(backend);
  const claimed = await writeDocVersioned(bundle, { id: TASK, ...taskDoc({ [OWNER]: "claimant-a" }) });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      preconditions: [{ field: OWNER, expect: { equals: "claimant-b" } }],
      buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: existing!.body }),
    }),
    (error: unknown) => error instanceof PreconditionFailed && error.actual === "claimant-a",
  );

  assert.equal((await readDocVersioned(bundle, TASK)).version, claimed.version);
});

test("a failing precondition is reported ahead of a stale expectedVersion, never as a version conflict", async () => {
  const backend = new MemoryBackend();
  const bundle = await bundleOf(backend);
  const stale = (await writeDocVersioned(bundle, { id: TASK, ...taskDoc() })).version;
  await writeDocVersioned(bundle, { id: TASK, ...taskDoc({ [OWNER]: "claimant-a" }) });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      expectedVersion: stale,
      preconditions: OWNER_ABSENT,
      buildCandidate: (existing) => ({
        frontmatter: { ...existing!.frontmatter, [OWNER]: "claimant-b" },
        body: existing!.body,
      }),
    }),
    (error: unknown) => error instanceof PreconditionFailed && !(error instanceof VersionConflict),
  );
});

test("overwrite honors preconditions against its own fresh read", async () => {
  const backend = new MemoryBackend();
  const bundle = await bundleOf(backend);
  const claimed = await writeDocVersioned(bundle, { id: TASK, ...taskDoc({ [OWNER]: "claimant-a" }) });

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "overwrite",
      registry: EMPTY_REGISTRY,
      strict: false,
      preconditions: OWNER_ABSENT,
      buildCandidate: () => taskDoc({ [OWNER]: "claimant-b" }),
    }),
    (error: unknown) => error instanceof PreconditionFailed && error.observedVersion === claimed.version,
  );

  assert.equal((await backend.versions(TASK)).length, 1);
});

test("create-only refuses a precondition rather than accepting a guard it cannot evaluate", async () => {
  const backend = new MemoryBackend();
  const bundle = await bundleOf(backend);

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "create-only",
      registry: EMPTY_REGISTRY,
      strict: false,
      preconditions: OWNER_ABSENT,
      buildCandidate: () => taskDoc(),
    }),
    (error: unknown) => error instanceof InvalidInputError && /create-only/.test(error.message),
  );

  assert.equal(await backend.exists(TASK), false);
});

test("an absent document satisfies absent and fails every value expectation", async () => {
  const backend = new MemoryBackend();
  const bundle = await bundleOf(backend);

  const created = await mutateDocument({
    bundle,
    id: TASK,
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    onAbsent: "create",
    preconditions: OWNER_ABSENT,
    buildCandidate: () => taskDoc({ [OWNER]: "claimant-a" }),
  });
  assert.equal(created.changed, true);

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: "tasks/never-written",
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      onAbsent: "create",
      preconditions: [{ field: OWNER, expect: { equals: "claimant-a" } }],
      buildCandidate: () => taskDoc(),
    }),
    (error: unknown) =>
      error instanceof PreconditionFailed && error.actual === undefined && error.observedVersion === null,
  );
});

test("expectations read the raw storage coordinate: null is absent, and a non-string value satisfies nothing", async () => {
  const backend = new MemoryBackend();
  const bundle = await bundleOf(backend);
  await writeDocVersioned(bundle, { id: TASK, ...taskDoc({ [OWNER]: null, tags: ["claimant-a"] }) });

  const claimed = await mutateDocument({
    bundle,
    id: TASK,
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    preconditions: OWNER_ABSENT,
    buildCandidate: (existing) => ({
      frontmatter: { ...existing!.frontmatter, [OWNER]: "claimant-b" },
      body: existing!.body,
    }),
  });
  assert.equal(claimed.changed, true);

  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      preconditions: [{ field: "tags", expect: { equals: "claimant-a" } }],
      buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "changed" }),
    }),
    (error: unknown) => error instanceof PreconditionFailed && error.field === "tags",
  );
});

test("preconditions are ANDed and refuse on the first unsatisfied member in caller order", async () => {
  const backend = new MemoryBackend();
  const bundle = await bundleOf(backend);
  await writeDocVersioned(bundle, { id: TASK, ...taskDoc({ [OWNER]: "claimant-a" }) });

  const order: FieldPrecondition[] = [
    { field: "superbee_progress_status", expect: { oneOf: ["done"] } },
    { field: OWNER, expect: "absent" },
  ];
  await assert.rejects(
    () => mutateDocument({
      bundle,
      id: TASK,
      mode: "patch",
      registry: EMPTY_REGISTRY,
      strict: false,
      preconditions: order,
      buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "changed" }),
    }),
    (error: unknown) => error instanceof PreconditionFailed && error.field === "superbee_progress_status",
  );

  const passing = await mutateDocument({
    bundle,
    id: TASK,
    mode: "patch",
    registry: EMPTY_REGISTRY,
    strict: false,
    preconditions: [
      { field: OWNER, expect: { equals: "claimant-a" } },
      { field: "superbee_progress_status", expect: { oneOf: ["todo", "in_progress"] } },
    ],
    buildCandidate: (existing) => ({ frontmatter: { ...existing!.frontmatter }, body: "changed" }),
  });
  assert.equal(passing.changed, true);
  assert.equal(passing.doc.body.trimEnd(), "changed");
});
