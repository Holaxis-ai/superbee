import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilesystemBackend, withFilesystemRootMutationLock } from "../src/backend.js";
import {
  initializeQualifiedBundle,
  installQualifiedRecipes,
  qualifiedKinds,
  addLocalQualifiedKind,
  createQualifiedDocument,
  updateQualifiedDocument,
  readQualifiedDocument,
  listQualifiedDocuments,
  exportQualifiedBundle,
  importQualifiedBundle,
  qualifiedArtifactDigest,
} from "../src/qualified-filesystem.js";
import { stringifyDoc } from "../src/frontmatter.js";
import { preflightRecipeSetV2 } from "../src/recipe-set-preflight-v2.js";
import type { QualifiedArtifact } from "../src/qualified-kinds.js";

const actor = "openai/codex";
function recipe(repository_id: string) {
  const artifact: QualifiedArtifact = {
    format: "superbee-recipe/v2",
    identity: {
      authority: "github.com",
      repository_id,
      recipe_id: "decisions",
    },
    owner_id: repository_id,
    release: "1.0.0",
    commit: "a".repeat(40),
    kinds: [
      {
        kind_id: "question",
        doc: {
          id: "conventions/question",
          frontmatter: {
            type: "Convention",
            governs: "Question",
            fields: { required: ["title"] },
            links: { options: { targets: [{ kind_id: "option" }] } },
          },
          body: "",
        },
      },
      {
        kind_id: "option",
        doc: {
          id: "conventions/option",
          frontmatter: {
            type: "Convention",
            governs: "Option",
            fields: { required: ["title"] },
            links: { question: { targets: [{ kind_id: "question" }] } },
          },
          body: "",
        },
      },
      {
        kind_id: "decision",
        doc: {
          id: "conventions/decision",
          frontmatter: {
            type: "Convention",
            governs: "Decision",
            fields: { required: ["title"] },
            links: {
              question: { targets: [{ kind_id: "question" }] },
              options: { targets: [{ kind_id: "option" }] },
            },
          },
          body: "",
        },
      },
    ],
  };
  return {
    artifact,
    approval: {
      repository_id,
      owner_id: repository_id,
      release: artifact.release,
      commit: artifact.commit,
      source_revision: qualifiedArtifactDigest(artifact),
      actor,
      approved_at: "2026-11-13T12:00:00Z",
    },
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "qualified-relations-"));
  const backend = new FilesystemBackend(path.join(root, "bundle"));
  await initializeQualifiedBundle(backend, { actor });
  await installQualifiedRecipes(backend, [recipe("100"), recipe("200")]);
  const kinds = await qualifiedKinds(backend);
  const select = (publisher: string, kind: string) =>
    kinds.find(
      (k) =>
        k.identity.authority === "github.com" &&
        k.identity.repository_id === publisher &&
        k.identity.kind_id === kind,
    )!;
  for (const publisher of ["100", "200"]) {
    await createQualifiedDocument(backend, {
      id: `questions/${publisher}`,
      selector: select(publisher, "question").selector,
      fields: { title: "Question" },
      actor,
    });
    await createQualifiedDocument(backend, {
      id: `options/${publisher}`,
      selector: select(publisher, "option").selector,
      fields: { title: "Option" },
      body: `[question](../questions/${publisher}.md)`,
      actor,
    });
  }
  return {
    root,
    backend,
    select,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("mutual recipe definitions resolve exact publisher links and local derivations retain their targets", async () => {
  const f = await fixture();
  try {
    const decision = f.select("100", "decision");
    assert.equal(decision.reference.materializer, "qualified-v2");
    assert.equal(
      decision.relationships!.question!.targets[0]!.selector,
      f.select("100", "question").selector,
    );
    const body =
      "[question](../questions/100.md)\n[options](../options/100.md)";
    await createQualifiedDocument(f.backend, {
      id: "decisions/a",
      selector: decision.selector,
      fields: { title: "Receipt" },
      body,
      actor,
    });
    const local = await addLocalQualifiedKind(f.backend, {
      kind_id: "local-decision",
      from: decision.selector,
      actor,
    });
    await createQualifiedDocument(f.backend, {
      id: "decisions/local",
      selector: local.selector,
      fields: { title: "Local receipt" },
      body,
      actor,
    });
    const question = await readQualifiedDocument(f.backend, "questions/100");
    await updateQualifiedDocument(f.backend, {
      id: "questions/100",
      fields: {},
      body: "[options](../options/100.md)",
      actor,
      expectedVersion: question.version,
    });
    const portable = await exportQualifiedBundle(f.backend);
    const target = new FilesystemBackend(path.join(f.root, "copy"));
    await importQualifiedBundle(target, {
      ...portable,
      records: [...portable.records].reverse(),
    });
    assert.deepEqual(await exportQualifiedBundle(target), portable);
  } finally {
    await f.cleanup();
  }
});
test("same-label foreign, missing, unsupported and wrong-revision targets refuse without persistence", async () => {
  const f = await fixture();
  try {
    for (const href of [
      "../questions/200.md",
      "../questions/missing.md",
      "https://example.com/question.md",
      "okf://remote/questions/100.md",
      "#fragment",
      "../questions/index.md",
      "../questions/100.txt",
    ]) {
      await assert.rejects(
        createQualifiedDocument(f.backend, {
          id: "decisions/bad",
          selector: f.select("100", "decision").selector,
          fields: { title: "Wrong" },
          body: `[question](${href})`,
          actor,
        }),
        /relationship|target/i,
      );
      await assert.rejects(f.backend.read("decisions/bad"), /ENOENT/);
    }
    const existing = await f.backend.read("questions/100");
    const ref = structuredClone(
      existing.doc.frontmatter.superbee_kind_ref,
    ) as Record<string, unknown>;
    ref.source_revision = "sha256:" + "0".repeat(64);
    await writeFile(
      path.join(f.root, "bundle/questions/100.md"),
      stringifyDoc(
        { ...existing.doc.frontmatter, superbee_kind_ref: ref },
        existing.doc.body,
      ),
    );
    await assert.rejects(
      createQualifiedDocument(f.backend, {
        id: "decisions/bad",
        selector: f.select("100", "decision").selector,
        fields: { title: "Wrong revision" },
        body: "[question](../questions/100.md)",
        actor,
      }),
      /reference|binding|target/i,
    );
  } finally {
    await f.cleanup();
  }
});
test("write, import, read, list and export use the same relationship admission", async () => {
  const f = await fixture();
  try {
    await createQualifiedDocument(f.backend, {
      id: "decisions/a",
      selector: f.select("100", "decision").selector,
      fields: { title: "Receipt" },
      body: "[question](../questions/100.md)",
      actor,
    });
    const good = await exportQualifiedBundle(f.backend);
    const bad = structuredClone(good);
    bad.records.find((r) => r.id === "decisions/a")!.body =
      "[question](../questions/200.md)";
    const copy = new FilesystemBackend(path.join(f.root, "invalid-import"));
    await assert.rejects(
      importQualifiedBundle(copy, bad),
      /relationship|target/i,
    );
    assert.equal(await copy.readReserved("", "index.md"), null);
    assert.equal(
      await copy.readReserved("conventions/qualified", "index.md"),
      null,
    );
    assert.deepEqual(await copy.list(), []);
    const row = bad.records.find((r) => r.id === "decisions/a")!;
    await writeFile(
      path.join(f.root, "bundle/decisions/a.md"),
      stringifyDoc(row.frontmatter, row.body),
    );
    await assert.rejects(
      readQualifiedDocument(f.backend, "decisions/a"),
      /relationship|target/i,
    );
    await assert.rejects(
      listQualifiedDocuments(f.backend),
      /relationship|target/i,
    );
    await assert.rejects(
      exportQualifiedBundle(f.backend),
      /relationship|target/i,
    );
  } finally {
    await f.cleanup();
  }
});
test("preflight refuses unsupported relationship declarations and preserves v1 materialization", () => {
  const origin = "12345678-1234-1234-1234-123456789012";
  for (const links of [
    { question: "Question" },
    { question: { targets: [] } },
    { question: { targets: [{ kind_id: "missing" }] } },
    { question: { targets: [{ kind_id: "question", latest: true }] } },
  ]) {
    const selected = recipe("100");
    selected.artifact.kinds[2]!.doc.frontmatter.links = links;
    selected.approval.source_revision = qualifiedArtifactDigest(
      selected.artifact,
    );
    assert.equal(
      preflightRecipeSetV2({
        format: "recipe-set-preflight/v2",
        origin,
        selections: [selected],
      }).valid,
      false,
    );
  }
  const selected = recipe("100");
  for (const row of selected.artifact.kinds) delete row.doc.frontmatter.links;
  selected.approval.source_revision = qualifiedArtifactDigest(
    selected.artifact,
  );
  const result = preflightRecipeSetV2({
    format: "recipe-set-preflight/v2",
    origin,
    selections: [selected],
  });
  assert.equal(result.valid, true);
  if (result.valid)
    assert.equal(
      result.lock.entries.every((e) => e.ref.materializer === "qualified-v1"),
      true,
    );
});

test("v1 golden binding is unchanged by relationship support", async () => {
  const { approvedRecipeEntries } = await import("../src/qualified-kinds.js");
  const artifact: QualifiedArtifact = {
    format: "superbee-recipe/v2",
    identity: {
      authority: "github.com",
      repository_id: "100",
      recipe_id: "golden",
    },
    owner_id: "100",
    release: "1.0.0",
    commit: "a".repeat(40),
    kinds: [
      {
        kind_id: "decision",
        doc: {
          id: "conventions/decision",
          frontmatter: {
            type: "Convention",
            governs: "Decision",
            fields: { required: ["title"] },
          },
          body: "",
        },
      },
    ],
  };
  const source_revision = qualifiedArtifactDigest(artifact);
  const [entry] = approvedRecipeEntries(artifact, {
    repository_id: "100",
    owner_id: "100",
    release: artifact.release,
    commit: artifact.commit,
    source_revision,
    actor,
    approved_at: "2026-11-13T12:00:00Z",
  });
  assert.equal(
    source_revision,
    "sha256:3c8e57114bdeaa9d966b9eb87c3919a15a965fd859b13f3deb09c460a36b8d63",
  );
  assert.equal(
    entry!.doc.id,
    "conventions/qualified/54c46653698f29c4b399d297223a9947e693622bd8bb6954f9f77c81f66cbb0e",
  );
  assert.equal(
    entry!.ref.definition_digest,
    "sha256:b5953792ad3579208f7b038443193649104bc0fa51d7c7efdbf578b6b9ee1630",
  );
});
test("strict typed paths reuse resolution, skip code, and local selectors bind explicitly", async () => {
  const f = await fixture();
  try {
    const localQuestion = await addLocalQualifiedKind(f.backend, {
      kind_id: "local-question",
      actor,
      doc: {
        id: "conventions/local-question",
        frontmatter: {
          type: "Convention",
          governs: "Question",
          fields: { required: ["title"] },
        },
        body: "",
      },
    });
    await createQualifiedDocument(f.backend, {
      id: "questions/local",
      selector: localQuestion.selector,
      fields: { title: "Local question" },
      actor,
    });
    const localDecision = await addLocalQualifiedKind(f.backend, {
      kind_id: "local-binding",
      actor,
      doc: {
        id: "conventions/local-decision",
        frontmatter: {
          type: "Convention",
          governs: "Decision",
          fields: { required: ["title"] },
          links: {
            question: { targets: [{ selector: localQuestion.selector }] },
          },
        },
        body: "",
      },
    });
    await createQualifiedDocument(f.backend, {
      id: "decisions/local",
      selector: localDecision.selector,
      fields: { title: "Local decision" },
      body: "[question](../questions/./local.md#section)",
      actor,
    });
    await assert.rejects(
      createQualifiedDocument(f.backend, {
        id: "decisions/wrong-local",
        selector: f.select("100", "decision").selector,
        fields: { title: "Wrong local" },
        body: "[question](../questions/local.md)",
        actor,
      }),
      /wrong exact/,
    );
    await createQualifiedDocument(f.backend, {
      id: "decisions/code",
      selector: f.select("100", "decision").selector,
      fields: { title: "Example only" },
      body: "```md\n[question](../questions/missing.md)\n```\n`[question](../questions/missing.md)`",
      actor,
    });
    for (const href of [
      "../../questions/100.md",
      "../questions/100.md?latest=1",
      "../conventions/qualified/orphan.md",
    ])
      await assert.rejects(
        createQualifiedDocument(f.backend, {
          id: "decisions/escape",
          selector: f.select("100", "decision").selector,
          fields: { title: "No" },
          body: `[question](${href})`,
          actor,
        }),
        /target|immutable/,
      );
  } finally {
    await f.cleanup();
  }
});
test("self targets resolve to the captured candidate and stale relationship writers refuse", async () => {
  const { loadQualifiedRegistry } = await import("../src/qualified-storage.js");
  const f = await fixture();
  try {
    const selfRecipe = recipe("300");
    selfRecipe.artifact.kinds[0]!.doc.frontmatter.links = {
      self: { targets: [{ kind_id: "question" }] },
    };
    selfRecipe.approval.source_revision = qualifiedArtifactDigest(
      selfRecipe.artifact,
    );
    await installQualifiedRecipes(f.backend, [selfRecipe]);
    const question = (await qualifiedKinds(f.backend)).find(
      (k) =>
        k.identity.authority === "github.com" &&
        k.identity.repository_id === "300" &&
        k.identity.kind_id === "question",
    )!;
    await createQualifiedDocument(f.backend, {
      id: "questions/self",
      selector: question.selector,
      fields: { title: "Self" },
      body: "[self](self.md)",
      actor,
    });
    const old = await loadQualifiedRegistry(f.backend);
    await addLocalQualifiedKind(f.backend, {
      kind_id: "next-generation",
      from: f.select("100", "decision").selector,
      actor,
    });
    const current = await f.backend.read("questions/self");
    await assert.rejects(
      f.backend.write(current.doc.id, current.doc, {
        qualifiedGeneration: old.qualified!.rootVersion,
        expectedVersion: current.version,
      }),
      /stale admitted generation/,
    );
    assert.equal(
      (await f.backend.read("questions/self")).version,
      current.version,
    );
  } finally {
    await f.cleanup();
  }
});


test("queued writes recheck exact targets under the root lock", async () => {
  const f = await fixture();
  try {
    const original = await f.backend.read("options/100");
    const target = await f.backend.read("questions/100");
    const { loadQualifiedRegistry } = await import("../src/qualified-storage.js");
    const registry = await loadQualifiedRegistry(f.backend);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withFilesystemRootMutationLock(path.join(f.root, "bundle"), async () => {
      entered();
      await gate;
      target.doc.frontmatter.superbee_kind_ref = f.select("200", "question").reference;
      await writeFile(path.join(f.root, "bundle/questions/100.md"), stringifyDoc(target.doc.frontmatter, target.doc.body));
    });
    await ready;
    const writing = f.backend.write(original.doc.id, original.doc, {
      expectedVersion: original.version,
      qualifiedGeneration: registry.qualified!.rootVersion,
    });
    const refused = assert.rejects(writing, /wrong exact Kind binding/);
    release();
    await held;
    await refused;
    assert.equal((await f.backend.read(original.doc.id)).version, original.version);
  } finally { await f.cleanup(); }
});
