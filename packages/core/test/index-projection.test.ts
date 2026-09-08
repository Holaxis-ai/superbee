import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FilesystemBackend } from "../src/backend.js";
import { parseMarkdown, stringifyWithData } from "../src/frontmatter.js";
import {
  GENERATED_INDEX_MARKER,
  IndexProjectionWriteError,
  applyIndexProjection,
  planIndexProjection,
  prepareIndexProjection,
  type IndexProjectionPlan,
  type ReadyIndexProjection,
} from "../src/index-projection.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { VersionConflict } from "../src/versioning.js";
import type {
  Bundle,
  HeadResult,
  ReservedFilename,
  Version,
  WriteOptions,
} from "../src/types.js";

const V = (digit: string): Version => `sha256:${digit.repeat(64)}`;

function head(
  id: string,
  type: unknown,
  title?: unknown,
  description?: unknown,
  version = V("1"),
): HeadResult {
  return {
    id,
    frontmatter: { type, ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) } as never,
    version,
  };
}

function byDir(plan: IndexProjectionPlan, dir: string): string {
  const target = plan.targets.find((candidate) => candidate.dir === dir);
  assert.ok(target, `missing planned target '${dir || "<root>"}'`);
  return target.body;
}

class RecordingMemoryBackend extends MemoryBackend {
  writes: Array<{ dir: string; content: string; options: WriteOptions }> = [];
  failDir?: string;
  failWith?: unknown;
  raceDir?: string;

  override async writeReserved(
    dir: string,
    name: ReservedFilename,
    content: string,
    options: WriteOptions = {},
  ): Promise<Version> {
    if (dir === this.raceDir) {
      this.raceDir = undefined;
      await super.writeReserved(dir, name, "# competing human index\n");
    }
    if (dir === this.failDir) {
      this.failDir = undefined;
      throw this.failWith;
    }
    const version = await super.writeReserved(dir, name, content, options);
    this.writes.push({ dir, content, options });
    return version;
  }
}

function recursivePlan(): IndexProjectionPlan {
  return planIndexProjection("Project Atlas", [
    head("root", "Reference", "Root"),
    head("child/item", "Note", "Child"),
    head("child/grand/deep", "Design", "Deep"),
  ]);
}

test("planner recursively covers every child link from one head set and is order-independent", () => {
  const heads = [
    head("space dir/grand/item one", "  Note\nType  ", "A [thing]", " one\nline ", V("3")),
    head("z", "Zeta", "Zulu", undefined, V("2")),
    head("a", 7, " ", 9, V("1")),
  ];
  const forward = planIndexProjection("  My\nBundle  ", heads);
  const reverse = planIndexProjection("  My\nBundle  ", [...heads].reverse());
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.targets.map((target) => target.dir), ["", "space dir", "space dir/grand"]);

  const root = byDir(forward, "");
  assert.ok(root.startsWith(`${GENERATED_INDEX_MARKER}\n# My Bundle\n`));
  assert.match(root, /# Concept\n\n\* \[a\]\(a\.md\)/);
  assert.match(root, /\* \[space dir\]\(space%20dir\/index\.md\)/);

  const child = byDir(forward, "space dir/grand");
  assert.match(child, /# Note Type/);
  assert.ok(child.includes("* [A \\[thing\\]](item%20one.md) - one line"));

  const plannedDirs = new Set(forward.targets.map((target) => target.dir));
  for (const target of forward.targets) {
    for (const match of target.body.matchAll(/\]\(([^)]+)\/index\.md\)/g)) {
      const decodedChild = decodeURIComponent(match[1]!);
      const childDir = target.dir === "" ? decodedChild : `${target.dir}/${decodedChild}`;
      assert.ok(plannedDirs.has(childDir), `link from '${target.dir}' has no planned '${childDir}' target`);
    }
  }
});

test("planner always emits a marked root and never emits nested frontmatter", () => {
  const plan = planIndexProjection("Empty", []);
  assert.deepEqual(plan.targets.map((target) => target.dir), [""]);
  assert.equal(byDir(plan, ""), `${GENERATED_INDEX_MARKER}\n# Empty\n`);

  const nested = byDir(recursivePlan(), "child");
  const parsed = parseMarkdown(nested);
  assert.deepEqual(parsed.frontmatter, {});
  assert.equal(parsed.body, nested);
});

test("one unmarked target refuses the whole preparation before any write; force exposes adoption", async () => {
  const backend = new RecordingMemoryBackend();
  const bundle: Bundle = { root: "mem://ownership", backend };
  await backend.writeReserved("", "index.md", stringifyWithData({ okf_version: "7.2" }, "# Curated intro\n"));
  backend.writes = [];

  const refused = await prepareIndexProjection(bundle, recursivePlan());
  assert.equal(refused.ready, false);
  assert.deepEqual(refused.refused.map(({ dir, reason }) => ({ dir, reason })), [{ dir: "", reason: "unmarked" }]);
  assert.equal(backend.writes.length, 0, "preparation must never write even when other targets are missing");
  await assert.rejects(
    () => applyIndexProjection(bundle, refused as unknown as ReadyIndexProjection),
    /Cannot apply a refused index projection/,
  );
  assert.equal(backend.writes.length, 0);

  const forced = await prepareIndexProjection(bundle, recursivePlan(), { force: true });
  assert.equal(forced.ready, true);
  assert.equal(forced.targets.find((target) => target.dir === "")?.disposition, "adopted");
  assert.deepEqual(
    forced.targets.filter((target) => target.dir !== "").map((target) => target.disposition),
    ["missing", "missing"],
  );

  const applied = await applyIndexProjection(bundle, forced, { actor: "mike/codex" });
  assert.deepEqual(applied.completed.map((target) => target.dir), ["child/grand", "child", ""]);
  assert.deepEqual(backend.writes.map((write) => write.options.actor), ["mike/codex", "mike/codex", "mike/codex"]);
  const root = (await backend.readReserved("", "index.md"))!.content;
  const parsedRoot = parseMarkdown(root);
  assert.equal(parsedRoot.frontmatter.okf_version, "7.2");
  assert.ok(parsedRoot.body.startsWith(GENERATED_INDEX_MARKER));
  assert.deepEqual(parseMarkdown((await backend.readReserved("child", "index.md"))!.content).frontmatter, {});
});

test("marker ownership is exact: moved, changed, duplicate, and nested-frontmatter shapes refuse", async () => {
  const backend = new RecordingMemoryBackend();
  const bundle: Bundle = { root: "mem://markers", backend };
  const plan = planIndexProjection("Markers", [
    head("moved/x", "T"),
    head("changed/x", "T"),
    head("duplicate/x", "T"),
    head("nested-frontmatter/x", "T"),
  ]);
  const rootBody = byDir(plan, "");
  await backend.writeReserved("", "index.md", stringifyWithData({ okf_version: "0.4" }, rootBody));
  await backend.writeReserved("moved", "index.md", `# Intro\n${GENERATED_INDEX_MARKER}\n`);
  await backend.writeReserved("changed", "index.md", "<!-- agentstate-lite:generated-index:v2 -->\n# changed\n");
  await backend.writeReserved("duplicate", "index.md", `${GENERATED_INDEX_MARKER}\n${GENERATED_INDEX_MARKER}\n`);
  await backend.writeReserved(
    "nested-frontmatter",
    "index.md",
    stringifyWithData({ unexpected: true }, byDir(plan, "nested-frontmatter")),
  );
  backend.writes = [];

  const prepared = await prepareIndexProjection(bundle, plan);
  assert.equal(prepared.ready, false);
  assert.deepEqual(
    prepared.refused.map(({ dir, reason }) => ({ dir, reason })),
    [
      { dir: "changed", reason: "malformed-marker" },
      { dir: "duplicate", reason: "duplicate-marker" },
      { dir: "moved", reason: "malformed-marker" },
      { dir: "nested-frontmatter", reason: "nested-frontmatter" },
    ],
  );
  assert.equal(backend.writes.length, 0);
});

test("ordinary generated metadata may mention the marker token without revoking ownership", async () => {
  const backend = new RecordingMemoryBackend();
  const bundle: Bundle = { root: "mem://marker-text", backend };
  const plan = planIndexProjection("Marker text", [
    head("note", "Note", "Marker vocabulary", "mentions agentstate-lite:generated-index literally"),
  ]);
  const first = await prepareIndexProjection(bundle, plan);
  assert.equal(first.ready, true);
  await applyIndexProjection(bundle, first);

  const second = await prepareIndexProjection(bundle, plan);
  assert.equal(second.ready, true);
  assert.deepEqual(second.targets.map((target) => target.disposition), ["unchanged"]);
});

test("invalid root metadata and malformed nested YAML are refused unless explicitly adopted", async () => {
  const plan = recursivePlan();
  const invalidRoots = [
    stringifyWithData({ okf_version: 7 }, byDir(plan, "")),
  ];

  for (const rootContent of invalidRoots) {
    const backend = new RecordingMemoryBackend();
    const bundle: Bundle = { root: "mem://invalid-root", backend };
    await backend.writeReserved("", "index.md", rootContent);
    backend.writes = [];
    const refused = await prepareIndexProjection(bundle, plan);
    assert.equal(refused.ready, false);
    assert.equal(refused.refused.find((target) => target.dir === "")?.reason, "malformed-root");
    assert.equal(backend.writes.length, 0);
  }

  const backend = new RecordingMemoryBackend();
  const bundle: Bundle = { root: "mem://malformed-nested", backend };
  await backend.writeReserved("", "index.md", stringifyWithData({ okf_version: "0.8" }, byDir(plan, "")));
  await backend.writeReserved("child", "index.md", "---\nbroken: [\n---\n");
  backend.writes = [];
  const refused = await prepareIndexProjection(bundle, plan);
  assert.equal(refused.ready, false);
  assert.equal(refused.refused.find((target) => target.dir === "child")?.reason, "nested-frontmatter");
  assert.equal(backend.writes.length, 0);

  const adopted = await prepareIndexProjection(bundle, plan, { force: true });
  assert.equal(adopted.ready, true);
  assert.equal(adopted.targets.find((target) => target.dir === "child")?.disposition, "adopted");
});

test("byte-identical preparation is a no-op with no write or actor attribution", async () => {
  const backend = new RecordingMemoryBackend();
  const bundle: Bundle = { root: "mem://noop", backend };
  const plan = recursivePlan();
  const first = await prepareIndexProjection(bundle, plan);
  assert.equal(first.ready, true);
  await applyIndexProjection(bundle, first, { actor: "first" });
  backend.writes = [];

  const second = await prepareIndexProjection(bundle, plan);
  assert.equal(second.ready, true);
  assert.ok(second.targets.every((target) => target.disposition === "unchanged"));
  const result = await applyIndexProjection(bundle, second, { actor: "must-not-write" });
  assert.equal(result.completed.length, 0);
  assert.deepEqual(result.unchanged, ["", "child", "child/grand"]);
  assert.equal(backend.writes.length, 0);
});

test("a racing edit produces a typed CAS cause and is never overwritten", async () => {
  const backend = new RecordingMemoryBackend();
  const bundle: Bundle = { root: "mem://race", backend };
  const prepared = await prepareIndexProjection(bundle, recursivePlan());
  assert.equal(prepared.ready, true);
  backend.raceDir = "child/grand";

  await assert.rejects(
    () => applyIndexProjection(bundle, prepared),
    (error: unknown) => {
      assert.ok(error instanceof IndexProjectionWriteError);
      assert.ok(error.cause instanceof VersionConflict);
      assert.equal(error.failed, "child/grand");
      assert.deepEqual(error.completed, []);
      assert.deepEqual(error.pending, ["child", ""]);
      return true;
    },
  );
  assert.equal((await backend.readReserved("child/grand", "index.md"))!.content, "# competing human index\n");
});

test("a partial failure reports completed/pending paths and a fresh rerun does not rewrite completed children", async () => {
  const backend = new RecordingMemoryBackend();
  const bundle: Bundle = { root: "mem://resume", backend };
  const prepared = await prepareIndexProjection(bundle, recursivePlan());
  assert.equal(prepared.ready, true);
  const sentinel = new Error("root unavailable");
  backend.failDir = "";
  backend.failWith = sentinel;

  await assert.rejects(
    () => applyIndexProjection(bundle, prepared),
    (error: unknown) => {
      assert.ok(error instanceof IndexProjectionWriteError);
      assert.equal(error.cause, sentinel);
      assert.equal(error.failed, "");
      assert.deepEqual(error.completed.map((target) => target.dir), ["child/grand", "child"]);
      assert.deepEqual(error.pending, []);
      return true;
    },
  );

  backend.writes = [];
  const retry = await prepareIndexProjection(bundle, recursivePlan());
  assert.equal(retry.ready, true);
  assert.deepEqual(
    retry.targets.map(({ dir, disposition }) => ({ dir, disposition })),
    [
      { dir: "", disposition: "missing" },
      { dir: "child", disposition: "unchanged" },
      { dir: "child/grand", disposition: "unchanged" },
    ],
  );
  await applyIndexProjection(bundle, retry);
  assert.deepEqual(backend.writes.map((write) => write.dir), [""]);
});

test("filesystem and memory adapters persist identical planned bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aslite-index-projection-"));
  try {
    const plan = recursivePlan();
    const memory = new MemoryBackend();
    const bundles: Bundle[] = [
      { root: "mem://agreement", backend: memory },
      { root, backend: new FilesystemBackend(root) },
    ];
    const snapshots: string[][] = [];
    for (const bundle of bundles) {
      const prepared = await prepareIndexProjection(bundle, plan);
      assert.equal(prepared.ready, true);
      await applyIndexProjection(bundle, prepared);
      const backend = bundle.backend!;
      snapshots.push(
        await Promise.all(plan.targets.map(async (target) => (await backend.readReserved(target.dir, "index.md"))!.content)),
      );
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
