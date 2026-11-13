import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FilesystemBackend } from "../src/backend.js";
import {
  initializeQualifiedBundle,
  installQualifiedRecipes,
  createQualifiedDocument,
  updateQualifiedDocument,
  qualifiedKinds,
  addLocalQualifiedKind,
  exportQualifiedBundle,
  importQualifiedBundle,
} from "../src/qualified-filesystem.js";
import { qualifiedArtifactDigest } from "../src/qualified-kinds.js";

const actor = "openai/codex";
function recipe(repository_id: string, field: string) {
  const artifact = {
    format: "superbee-recipe/v2" as const,
    identity: {
      authority: "github.com" as const,
      repository_id,
      recipe_id: "decisions",
    },
    release: "1.0.0",
    commit: "a".repeat(40),
    owner_id: repository_id,
    kinds: [
      {
        kind_id: "decision",
        doc: {
          id: "conventions/decision",
          frontmatter: {
            type: "Convention",
            governs: "Decision",
            fields: { required: [field], types: { [field]: "integer" } },
          },
          body: "# Decision\n",
        },
      },
    ],
  };
  return {
    artifact,
    approval: {
      repository_id,
      owner_id: repository_id,
      commit: artifact.commit,
      release: artifact.release,
      source_revision: qualifiedArtifactDigest(artifact),
      actor,
      approved_at: "2026-11-13T12:00:00Z",
    },
  };
}
test("filesystem A/B composition preserves exact schemas, local extension and portable origin", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-contract-"));
  const copy = await mkdtemp(path.join(os.tmpdir(), "qualified-copy-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    await installQualifiedRecipes(backend, [
      recipe("100", "votes"),
      recipe("200", "cost"),
    ]);
    const kinds = await qualifiedKinds(backend);
    assert.equal(kinds.length, 2);
    assert.notEqual(kinds[0]!.selector, kinds[1]!.selector);
    await assert.rejects(
      createQualifiedDocument(backend, {
        selector: "Decision",
        id: "ambiguous",
        fields: { votes: 1 },
        actor,
      }),
      /ambiguous/i,
    );
    await createQualifiedDocument(backend, {
      selector: kinds[0]!.selector,
      id: "decisions/a",
      fields: { votes: 1 },
      actor,
    });
    await assert.rejects(
      createQualifiedDocument(backend, {
        selector: kinds[1]!.selector,
        id: "wrong",
        fields: { votes: 1 },
        actor,
      }),
      /cost/i,
    );
    await createQualifiedDocument(backend, {
      selector: kinds[1]!.selector,
      id: "decisions/b",
      fields: { cost: 2 },
      actor,
    });
    const local = await addLocalQualifiedKind(backend, {
      kind_id: "local",
      doc: {
        id: "conventions/local",
        frontmatter: {
          type: "Convention",
          governs: "Decision",
          fields: { required: ["reason"] },
        },
        body: "",
      },
      actor,
    });
    await createQualifiedDocument(backend, {
      selector: local.selector,
      id: "decisions/c",
      fields: { reason: "local" },
      actor,
    });
    const derived = await addLocalQualifiedKind(backend, {
      kind_id: "derived",
      from: kinds[0]!.selector,
      actor,
    });
    assert.notEqual(derived.selector, kinds[0]!.selector);
    const before = await backend.read("decisions/a");
    await updateQualifiedDocument(backend, {
      id: "decisions/a",
      fields: { votes: 3 },
      actor,
      expectedVersion: before.version,
    });
    const after = await backend.read("decisions/a");
    assert.deepEqual(
      after.doc.frontmatter.superbee_kind_ref,
      before.doc.frontmatter.superbee_kind_ref,
    );
    await assert.rejects(
      updateQualifiedDocument(backend, {
        id: "decisions/a",
        fields: { superbee_kind_ref: after.doc.frontmatter.superbee_kind_ref },
        actor,
        expectedVersion: after.version,
      }),
      /managed/i,
    );
    await assert.rejects(
      backend.write("unsafe", {
        id: "unsafe",
        frontmatter: { type: "Decision" },
        body: "",
      }),
      /qualified/i,
    );
    await assert.rejects(backend.delete("decisions/a"), /qualified/i);
    const portable = await exportQualifiedBundle(backend);
    await importQualifiedBundle(new FilesystemBackend(copy), portable);
    assert.deepEqual(
      await exportQualifiedBundle(new FilesystemBackend(copy)),
      portable,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(copy, { recursive: true, force: true });
  }
});

test("generation CAS rejects stale writers and competing installers without partial activation", async () => {
  const { loadQualifiedRegistry } = await import("../src/qualified-storage.js");
  const { approvedRecipeEntries } = await import("../src/qualified-kinds.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-race-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    await installQualifiedRecipes(backend, [recipe("100", "votes")]);
    const [kind] = await qualifiedKinds(backend);
    await createQualifiedDocument(backend, {
      selector: kind!.selector,
      id: "a",
      fields: { votes: 1 },
      actor,
    });
    const old = await loadQualifiedRegistry(backend);
    const a = recipe("200", "cost"),
      b = recipe("300", "score");
    const make = (r: ReturnType<typeof recipe>) => ({
      expectedRoot: old.qualified!.rootVersion,
      lock: {
        ...old.qualified!.lock,
        entries: [
          ...old.qualified!.lock.entries,
          ...approvedRecipeEntries(r.artifact, r.approval),
        ],
      },
    });
    const results = await Promise.allSettled([
      backend.commitQualifiedGeneration(make(a)),
      backend.commitQualifiedGeneration(make(b)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const before = await backend.read("a");
    await assert.rejects(
      backend.write(
        "a",
        { ...before.doc, frontmatter: { ...before.doc.frontmatter, votes: 2 } },
        {
          expectedVersion: before.version,
          qualifiedGeneration: old.qualified!.rootVersion,
        },
      ),
      /stale admitted generation/,
    );
    assert.equal((await backend.read("a")).version, before.version);
    assert.equal((await qualifiedKinds(backend)).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("raw corruption, malformed explicit reference and marker removal never fall back to labels", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { readQualifiedDocument } =
    await import("../src/qualified-filesystem.js");
  const { stringifyDoc } = await import("../src/frontmatter.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-damage-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    await installQualifiedRecipes(backend, [recipe("100", "votes")]);
    const [kind] = await qualifiedKinds(backend);
    await createQualifiedDocument(backend, {
      selector: kind!.selector,
      id: "a",
      fields: { votes: 1 },
      actor,
    });
    const before = await backend.read("a");
    await writeFile(
      path.join(dir, "a.md"),
      stringifyDoc(
        { ...before.doc.frontmatter, superbee_kind_ref: { invalid: true } },
        before.doc.body,
      ),
    );
    await assert.rejects(readQualifiedDocument(backend, "a"), /reference/);
    const root = await readFile(path.join(dir, "index.md"), "utf8");
    await writeFile(
      path.join(dir, "index.md"),
      '---\nokf_version: "0.2"\n---\n',
    );
    await assert.rejects(qualifiedKinds(backend), /evidence without profile/);
    await assert.rejects(
      backend.write("plain", {
        id: "plain",
        frontmatter: { type: "Decision" },
        body: "",
      }),
      /evidence without profile/,
    );
    await writeFile(path.join(dir, "index.md"), root);
    const registry = await (
      await import("../src/qualified-storage.js")
    ).loadQualifiedRegistry(backend);
    const definition = registry.qualified!.lock.entries[0]!.doc.id;
    await writeFile(
      path.join(dir, definition + ".md"),
      "---\ntype: Convention\ngoverns: Decision\n---\ncorrupt\n",
    );
    await assert.rejects(
      qualifiedKinds(backend),
      /corrupt admitted definition/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupted staging is inert; missing active assets refuse semantic readiness", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { approvedRecipeEntries } = await import("../src/qualified-kinds.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-stage-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    const root = await backend.readReserved("", "index.md");
    const a = recipe("100", "votes"),
      b = recipe("200", "cost");
    const blocked = approvedRecipeEntries(b.artifact, b.approval)[0]!.doc.id;
    await mkdir(path.dirname(path.join(dir, blocked)), { recursive: true });
    await writeFile(
      path.join(dir, blocked + ".md"),
      "unrelated occupied bytes",
    );
    await assert.rejects(
      installQualifiedRecipes(backend, [a, b]),
      /immutable staged path collision/,
    );
    assert.equal(
      (await backend.readReserved("", "index.md"))!.version,
      root!.version,
    );
    assert.deepEqual(await qualifiedKinds(backend), []);
    await rm(path.join(dir, blocked + ".md"));
    await installQualifiedRecipes(backend, [a, b]);
    const missing = approvedRecipeEntries(a.artifact, a.approval)[0]!.doc.id;
    await rm(path.join(dir, missing + ".md"));
    await assert.rejects(qualifiedKinds(backend));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("admission rejects unapproved bytes, incompatible standard fields and unsupported relationships", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-admission-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    const a = recipe("100", "votes");
    await assert.rejects(
      installQualifiedRecipes(backend, [
        { ...a, approval: { ...a.approval, owner_id: "different" } },
      ]),
      /approval/,
    );
    await assert.rejects(
      addLocalQualifiedKind(backend, {
        kind_id: "status",
        actor,
        doc: {
          id: "conventions/status",
          frontmatter: {
            type: "Convention",
            governs: "Decision",
            fields: { values: { status: ["todo"] } },
          },
          body: "",
        },
      }),
      /OKF v0.2 lifecycle/,
    );
    await assert.rejects(
      addLocalQualifiedKind(backend, {
        kind_id: "links",
        actor,
        doc: {
          id: "conventions/link",
          frontmatter: {
            type: "Convention",
            governs: "Decision",
            links: { needs: "Decision" },
          },
          body: "",
        },
      }),
      /unsupported definition operator/,
    );
    assert.deepEqual(await qualifiedKinds(backend), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy label semantics remain unchanged; unsupported backends cannot persist qualified records", async () => {
  const { MemoryBackend } = await import("../src/memory-backend.js");
  const { buildKindRegistry } = await import("../src/kinds.js");
  const { writeDoc } = await import("../src/engine.js");
  const a = recipe("100", "votes").artifact.kinds[0]!.doc;
  const b = {
    ...recipe("200", "cost").artifact.kinds[0]!.doc,
    id: "conventions/decision-b",
  };
  const legacy = buildKindRegistry([a, b], [], { okfVersion: "0.2" });
  assert.equal(legacy.kinds.size, 1);
  assert.deepEqual(legacy.kinds.get("Decision")!.fields.required, ["votes"]);
  assert.equal(legacy.warnings[0]!.code, "KIND_DUPLICATE_GOVERNS");
  await assert.rejects(
    writeDoc(new MemoryBackend(), {
      id: "a",
      frontmatter: { type: "Decision", superbee_kind_ref: {} },
      body: "",
    }),
    /unsupported backend/,
  );
});

test("legacy writes use fixed evidence reads, never a bundle inventory scan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-legacy-fast-"));
  try {
    const backend = new FilesystemBackend(dir);
    backend.list = async () => {
      throw new Error("legacy mutation scanned the inventory");
    };
    await backend.writeReserved(
      "",
      "index.md",
      '---\nokf_version: "0.2"\n---\n',
    );
    await backend.write("a", {
      id: "a",
      frontmatter: { type: "Concept" },
      body: "legacy",
    });
    await backend.delete("a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all ordinary filesystem mutation channels refuse a qualified root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-matrix-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    for (const operation of [
      () =>
        backend.write("a", {
          id: "a",
          frontmatter: { type: "Concept" },
          body: "",
        }),
      () => backend.delete("a"),
      () => backend.writeReserved("", "index.md", "legacy downgrade"),
      () => backend.writeReserved("", "log.md", "unsupported"),
      () =>
        backend.writeBlob(
          "assets/a.txt",
          new TextEncoder().encode("unsupported"),
        ),
      () => backend.deleteBlob("assets/a.txt"),
    ])
      await assert.rejects(operation, /Qualified profile/);
    const { replaceFilesystemFile } = await import("../src/backend.js");
    await assert.rejects(
      replaceFilesystemFile(
        backend,
        "assets/raw.txt",
        new TextEncoder().encode("downgrade"),
        null,
      ),
      /Qualified profile/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation request refuses getters without executing them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-data-"));
  try {
    const backend = new FilesystemBackend(dir);
    let invoked = false;
    await assert.rejects(
      backend.commitQualifiedGeneration({
        expectedRoot: null,
        get lock() {
          invoked = true;
          throw new Error("executed");
        },
      }),
      /accessors/,
    );
    assert.equal(invoked, false);
    assert.equal(await backend.readReserved("", "index.md"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable admission cannot omit a publisher declaration or derivation source", async () => {
  const { approvedRecipeEntries, qualifiedRegistry } =
    await import("../src/qualified-kinds.js");
  const a = recipe("100", "votes");
  a.artifact.kinds.push({ ...a.artifact.kinds[0]!, kind_id: "second" });
  a.approval.source_revision = qualifiedArtifactDigest(a.artifact);
  const entries = approvedRecipeEntries(a.artifact, a.approval);
  assert.throws(
    () =>
      qualifiedRegistry(
        {
          format: "qualified-registry/v1",
          origin: "12345678-1234-1234-1234-123456789012",
          entries: [entries[0]!],
        },
        "root",
      ),
    /incomplete recipe inventory/,
  );
});

test("v2 preflight composes independent same-ID recipes and refuses duplicate stable identity", async () => {
  const { preflightRecipeSetV2 } =
    await import("../src/recipe-set-preflight-v2.js");
  const origin = "12345678-1234-1234-1234-123456789012";
  const good = preflightRecipeSetV2({
    format: "recipe-set-preflight/v2",
    origin,
    selections: [recipe("100", "votes"), recipe("200", "cost")],
  });
  assert.equal(good.valid, true);
  if (good.valid) assert.equal(good.lock.entries.length, 2);
  const bad = preflightRecipeSetV2({
    format: "recipe-set-preflight/v2",
    origin,
    selections: [recipe("100", "votes"), recipe("100", "votes")],
  });
  assert.equal(bad.valid, false);
  assert.match(bad.diagnostics.join(";"), /already installed/);
});

test("qualified write validates the captured document, reference and options before awaiting", async () => {
  const { loadQualifiedRegistry } = await import("../src/qualified-storage.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-write-capture-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    await installQualifiedRecipes(backend, [
      recipe("100", "votes"),
      recipe("200", "cost"),
    ]);
    const [a, b] = await qualifiedKinds(backend);
    const generation = (await loadQualifiedRegistry(backend)).qualified!
      .rootVersion;
    const invalid = {
      id: "invalid",
      frontmatter: {
        type: "Decision",
        superbee_kind_ref: a!.reference,
        votes: "invalid" as unknown,
      },
      body: "",
    };
    const invalidWrite = backend.write(invalid.id, invalid, {
      qualifiedGeneration: generation,
      expectedVersion: null,
    });
    invalid.frontmatter.votes = 1;
    await assert.rejects(invalidWrite, /safe integer/);
    await assert.rejects(backend.read("invalid"), /ENOENT/);

    const valid = {
      id: "valid",
      frontmatter: {
        type: "Decision",
        superbee_kind_ref: a!.reference,
        votes: 1 as unknown,
      },
      body: "",
    };
    const validWrite = backend.write(valid.id, valid, {
      qualifiedGeneration: generation,
      expectedVersion: null,
    });
    valid.frontmatter.votes = "invalid";
    await validWrite;
    const before = await backend.read("valid");
    assert.equal(before.doc.frontmatter.votes, 1);

    const rebound = {
      id: "valid",
      frontmatter: {
        type: "Decision",
        superbee_kind_ref: structuredClone(b!.reference),
        votes: 1,
        cost: 1,
      },
      body: "",
    };
    const reboundWrite = backend.write("valid", rebound, {
      qualifiedGeneration: generation,
      expectedVersion: before.version,
    });
    rebound.frontmatter.superbee_kind_ref = structuredClone(a!.reference);
    await assert.rejects(reboundWrite, /cannot rebind/);
    assert.equal((await backend.read("valid")).version, before.version);

    const staleOptions = {
      qualifiedGeneration: generation,
      expectedVersion: "sha256:" + "0".repeat(64),
    };
    const staleWrite = backend.write("valid", before.doc, staleOptions);
    staleOptions.expectedVersion = before.version;
    await assert.rejects(staleWrite, /version conflict/i);

    const removedAdmission: {
      qualifiedGeneration?: string;
      expectedVersion: null;
    } = { qualifiedGeneration: generation, expectedVersion: null };
    const unchecked = {
      ...invalid,
      id: "unchecked",
      frontmatter: { ...invalid.frontmatter, votes: "invalid" },
    };
    const removedWrite = backend.write(
      "unchecked",
      unchecked,
      removedAdmission,
    );
    delete removedAdmission.qualifiedGeneration;
    await assert.rejects(removedWrite, /safe integer/);
    await assert.rejects(backend.read("unchecked"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("qualified write binds the actual target and excludes every reserved record location", async () => {
  const { loadQualifiedRegistry } = await import("../src/qualified-storage.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-write-target-"));
  try {
    const backend = new FilesystemBackend(dir);
    await initializeQualifiedBundle(backend, { actor });
    await installQualifiedRecipes(backend, [recipe("100", "votes")]);
    const [kind] = await qualifiedKinds(backend);
    const generation = (await loadQualifiedRegistry(backend)).qualified!
      .rootVersion;
    const doc = {
      id: "records/a",
      frontmatter: {
        type: "Decision",
        superbee_kind_ref: kind!.reference,
        votes: 1,
      },
      body: "",
    };
    for (const [target, candidate] of [
      ["conventions/qualified/orphan", doc],
      ["records/b", doc],
      [
        "conventions/qualified/orphan",
        { ...doc, id: "conventions/qualified/orphan" },
      ],
      ["records/index", { ...doc, id: "records/index" }],
      ["records/log", { ...doc, id: "records/log" }],
    ] as const) {
      await assert.rejects(
        backend.write(target, candidate, {
          qualifiedGeneration: generation,
          expectedVersion: null,
        }),
        /target|reserved|immutable/i,
      );
    }
    assert.deepEqual((await exportQualifiedBundle(backend)).records, []);
    assert.equal(await backend.readReserved("records", "index.md"), null);
    assert.equal(await backend.readReserved("records", "log.md"), null);
    await assert.rejects(
      backend.read("conventions/qualified/orphan"),
      /ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("qualified write capture refuses accessors without invocation and leaves legacy serialization intact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-write-data-"));
  try {
    const backend = new FilesystemBackend(dir);
    const legacy = {
      id: "legacy-source-id",
      frontmatter: {
        type: "Concept",
        extension_date: new Date("2026-11-13T12:00:00Z"),
      },
      body: "original",
    };
    const pending = backend.write("legacy-target-id", legacy, {
      qualifiedGeneration: undefined,
    });
    legacy.body = "later";
    await pending;
    assert.equal(
      (await backend.read("legacy-target-id")).doc.body.trim(),
      "original",
    );
    let invoked = false;
    const options = {
      get qualifiedGeneration(): string {
        invoked = true;
        return "untrusted";
      },
    };
    await assert.rejects(
      backend.write(
        "a",
        { id: "a", frontmatter: { type: "Concept" }, body: "" },
        options,
      ),
      /accessors/,
    );
    assert.equal(invoked, false);
    const accessorDoc = {
      id: "a",
      get frontmatter() {
        invoked = true;
        return { type: "Concept" };
      },
      body: "",
    };
    await assert.rejects(
      backend.write("a", accessorDoc, { qualifiedGeneration: "untrusted" }),
      /accessors/,
    );
    assert.equal(invoked, false);
    await assert.rejects(backend.read("a"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("portable import refuses reserved record targets before staging any assets", async (t) => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "qualified-import-source-"));
  try {
    const source = new FilesystemBackend(sourceDir);
    await initializeQualifiedBundle(source, { actor });
    await installQualifiedRecipes(source, [recipe("100", "votes")]);
    const portable = await exportQualifiedBundle(source);
    const [kind] = await qualifiedKinds(source);
    for (const id of ["index", "log", "records/index", "records/log", "records/nested/index", "records/nested/log", "conventions/qualified/orphan"]) {
      await t.test(id, async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "qualified-import-target-"));
        try {
          const target = new FilesystemBackend(dir);
          const record = { id, frontmatter: { type: "Decision", superbee_kind_ref: kind!.reference, votes: 1 }, body: "Preserve this record" };
          await assert.rejects(importQualifiedBundle(target, {
            ...portable,
            records: [{ ...record, id: "records/valid" }, record],
          }), /reserved|immutable/i);
          for (const prefix of ["", "records", "records/nested", "conventions/qualified"]) {
            assert.equal(await target.readReserved(prefix, "index.md"), null);
            assert.equal(await target.readReserved(prefix, "log.md"), null);
          }
          assert.deepEqual(await target.list(), []);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
});
