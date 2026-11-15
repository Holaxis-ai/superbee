/**
 * `queryEdges` (graph-query-v0): the whole-bundle derived edge list, filtered — the atom
 * `backlinks`/`link show`/the CLI's `link list` all reduce to. Pinning the semantics the plan
 * called out as needing worked examples: prefix vs exact-id selectors, within-flag union vs
 * cross-flag AND, exact-text matching, dangling edges, per-literal-link counting, deterministic
 * `(from, to, text)` sort, and that `backlinks` stays byte-identical post-generalization.
 *
 * Runs against a real temp-dir `FilesystemBackend` bundle (mirrors `dual-backend.test.ts`'s
 * pattern); `dual-backend.test.ts`/`wire-protocol.test.ts` separately prove the SAME scenario
 * (via `scenario.ts`) holds identically over MemoryBackend and RemoteBackend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, backlinks, queryEdges } from "../src/bundle.js";
import { FilesystemBackend } from "../src/backend.js";
import { readRelationshipPage } from "../src/bundle-ops.js";
import type { FilesystemHostPolicy } from "../src/filesystem-host.js";
import type { Bundle } from "../src/types.js";

const T = "2026-07-01T00:00:00.000Z";

async function withBundle(fn: (bundle: Bundle) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-query-edges-"));
  try {
    const bundle = await initBundle(dir);
    await fn(bundle);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A small fixture bundle exercising prefix/union/text/dangling all at once. */
async function seedFixture(bundle: Bundle): Promise<void> {
  await writeDoc(bundle, {
    id: "tasks/a",
    frontmatter: { type: "Task", title: "A", timestamp: T },
    body: "Contains [b](b.md). Also [dangling](../ghost.md).",
  });
  await writeDoc(bundle, {
    id: "tasks/b",
    frontmatter: { type: "Task", title: "B", timestamp: T },
    body: "See [also a](../tasks/a.md).",
  });
  await writeDoc(bundle, {
    id: "roadmap-items/x",
    frontmatter: { type: "Roadmap Item", title: "X", timestamp: T },
    body: "[contains](../tasks/a.md) and [supersedes](../tasks/b.md).",
  });
}

test("queryEdges: no filter returns EVERY edge in the bundle, sorted (from, to, text), including dangling targets", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle);
    const edges = await queryEdges(bundle);
    // tasks/a -> b, tasks/a -> ../ghost (dangling), tasks/b -> tasks/a, roadmap-items/x -> tasks/a, roadmap-items/x -> tasks/b
    const shaped = edges.map((e) => ({ from: e.from, to: e.to, text: e.text }));
    assert.deepEqual(shaped, [
      { from: "roadmap-items/x", to: "tasks/a", text: "contains" },
      { from: "roadmap-items/x", to: "tasks/b", text: "supersedes" },
      { from: "tasks/a", to: "ghost", text: "dangling" },
      { from: "tasks/a", to: "tasks/b", text: "b" },
      { from: "tasks/b", to: "tasks/a", text: "also a" },
    ]);
  });
});

test("queryEdges --to <id>: exact match only (not a prefix) — a longer sibling id is excluded", async () => {
  await withBundle(async (bundle) => {
    await writeDoc(bundle, { id: "hub", frontmatter: { type: "T", timestamp: T }, body: "[x](tasks/a.md) [y](tasks/ab.md)" });
    await writeDoc(bundle, { id: "tasks/a", frontmatter: { type: "T", timestamp: T }, body: "" });
    await writeDoc(bundle, { id: "tasks/ab", frontmatter: { type: "T", timestamp: T }, body: "" });
    const edges = await queryEdges(bundle, { to: "tasks/a" });
    assert.deepEqual(edges.map((e) => e.to), ["tasks/a"]);
  });
});

test("queryEdges --to <prefix/>: trailing slash means prefix — matches every id starting with the literal prefix", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle);
    const edges = await queryEdges(bundle, { to: "tasks/" });
    assert.deepEqual(
      edges.map((e) => ({ from: e.from, to: e.to })),
      [
        { from: "roadmap-items/x", to: "tasks/a" },
        { from: "roadmap-items/x", to: "tasks/b" },
        { from: "tasks/a", to: "tasks/b" },
        { from: "tasks/b", to: "tasks/a" },
      ],
    );
  });
});

test("queryEdges: an array of selectors on ONE flag is a union (OR) — matching ANY entry is sufficient", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle);
    // Union of an exact id ("tasks/a", matched by 2 edges) and a disjoint prefix nothing targets
    // ("roadmap-items/" — no doc in the fixture links INTO roadmap-items/x) — the union must still
    // equal the exact-id selector alone, not double-count or drop anything.
    const edges = await queryEdges(bundle, { to: ["tasks/a", "roadmap-items/"] });
    const tos = edges.map((e) => e.to).sort();
    assert.deepEqual(tos, ["tasks/a", "tasks/a"]);
  });
});

test("queryEdges: from AND to together — cross-flag AND, not union", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle);
    // roadmap-items/x -> tasks/a exists; roadmap-items/x -> tasks/b also exists; tasks/b -> tasks/a exists.
    // Restrict to edges FROM roadmap-items/ AND TO tasks/a specifically: only one should survive.
    const edges = await queryEdges(bundle, { from: "roadmap-items/", to: "tasks/a" });
    assert.deepEqual(edges.map((e) => ({ from: e.from, to: e.to })), [{ from: "roadmap-items/x", to: "tasks/a" }]);
  });
});

test("queryEdges --text: EXACT match only — a substring never matches", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle);
    const exact = await queryEdges(bundle, { text: "contains" });
    assert.deepEqual(exact.map((e) => e.text), ["contains"]);

    const substring = await queryEdges(bundle, { text: "contain" });
    assert.deepEqual(substring, []);
  });
});

test("queryEdges preserves boundary-space ids and relation text without aliasing an exact id to a prefix", async () => {
  await withBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: " reviews/leading",
      frontmatter: { type: "Review", timestamp: T },
      body: "[leading](/targets/one.md)",
    });
    await writeDoc(bundle, {
      id: "reviews/trailing ",
      frontmatter: { type: "Review", timestamp: T },
      body: "[trailing](/targets/one.md)",
    });
    await writeDoc(bundle, {
      id: "reviews/plain",
      frontmatter: { type: "Review", timestamp: T },
      body: "[ exact relation ](/targets/one.md) and [other](/reviews/other.md)",
    });

    assert.deepEqual(
      (await queryEdges(bundle, { from: " reviews/leading" })).map(({ from, to, text }) => ({ from, to, text })),
      [{ from: " reviews/leading", to: "targets/one", text: "leading" }],
    );
    assert.deepEqual(
      (await queryEdges(bundle, { from: "reviews/trailing " })).map(({ from, to, text }) => ({ from, to, text })),
      [{ from: "reviews/trailing ", to: "targets/one", text: "trailing" }],
    );
    assert.deepEqual(
      (await queryEdges(bundle, { to: "reviews/ " })).map(({ from, to, text }) => ({ from, to, text })),
      [],
      "a boundary-space exact id must not widen to the reviews/ prefix",
    );
    assert.deepEqual(
      (await queryEdges(bundle, { text: " exact relation " })).map(({ from, to, text }) => ({ from, to, text })),
      [{ from: "reviews/plain", to: "targets/one", text: " exact relation " }],
    );
    assert.deepEqual(
      await queryEdges(bundle, { text: "exact relation" }),
      [],
      "relation text is exact, including boundary spaces",
    );
    assert.equal(
      (await queryEdges(bundle, { from: [" reviews/leading", " reviews/leading"] })).length,
      1,
      "duplicate selectors do not multiply a literal edge",
    );
  });
});

test("queryEdges: per-literal-link counting — two literal links between the same from/to (different text) are TWO edges", async () => {
  await withBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "a",
      frontmatter: { type: "T", timestamp: T },
      body: "[first](b.md) and also [second](b.md).",
    });
    await writeDoc(bundle, { id: "b", frontmatter: { type: "T", timestamp: T }, body: "" });
    const edges = await queryEdges(bundle, { from: "a", to: "b" });
    assert.equal(edges.length, 2);
    assert.deepEqual(edges.map((e) => e.text).sort(), ["first", "second"]);
  });
});

test("queryEdges: a reserved-file target (index.md/log.md) is never a concept edge — it never appears as `to`", async () => {
  await withBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "a",
      frontmatter: { type: "T", timestamp: T },
      body: "[root index](index.md) [nested log](sub/log.md)",
    });
    const edges = await queryEdges(bundle, { from: "a" });
    assert.deepEqual(edges, []);
  });
});

test("queryEdges: an empty filter object behaves exactly like no filter at all", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle);
    const withEmpty = await queryEdges(bundle, {});
    const withNone = await queryEdges(bundle);
    assert.deepEqual(withEmpty, withNone);
  });
});

test("backlinks(bundle, target) stays byte-identical post-generalization (a thin { to: target } call into queryEdges)", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle);
    const viaBacklinks = await backlinks(bundle, "tasks/a");
    const viaQueryEdges = await queryEdges(bundle, { to: "tasks/a" });
    assert.deepEqual(viaBacklinks, viaQueryEdges);
    assert.deepEqual(
      viaBacklinks.map((l) => ({ from: l.from, text: l.text })),
      [
        { from: "roadmap-items/x", text: "contains" },
        { from: "tasks/b", text: "also a" },
      ],
    );
  });
});

test("backlinks(bundle, 'tasks/') (a trailing slash) does NOT leak queryEdges' prefix rule — it stays EXACT-match, byte-identical to pre-generalization: [] here, not the 4 rows a prefix scan over tasks/* would return", async () => {
  await withBundle(async (bundle) => {
    await seedFixture(bundle); // roadmap-items/x -> tasks/a, roadmap-items/x -> tasks/b, tasks/a -> tasks/b, tasks/b -> tasks/a, tasks/a -> ghost
    const withTrailingSlash = await backlinks(bundle, "tasks/");
    assert.deepEqual(withTrailingSlash, [], "a trailing slash must NOT turn backlinks into a prefix scan");

    // Meanwhile queryEdges({ to: "tasks/" }) itself STILL prefix-matches — the capability lives
    // there (and in the CLI's `link list`), just never leaks into the exact-match `backlinks` API.
    const prefixQuery = await queryEdges(bundle, { to: "tasks/" });
    assert.equal(prefixQuery.length, 4, "queryEdges' OWN prefix rule must be unaffected by backlinks' guard");
  });
});

// ── review finding: the FIRST fix here (strip the trailing slash, then delegate `{ to: "tasks" }`
// into queryEdges) was itself wrong — it ALIASES "tasks/" to the bare id "tasks", so on a bundle
// that ALSO has a doc literally named `tasks`, backlinks("tasks/") would wrongly return `tasks`'s
// own backlinks (main returns [] regardless). The prior test above never caught this because its
// fixture had no doc literally named `tasks`. This fixture adds one, with its own incoming edge,
// disjoint from the tasks/* family — proving `backlinks`/`queryEdges({to:...})` treat "tasks" and
// "tasks/" as two entirely different, non-aliasing selectors.
async function seedFixtureWithBareTasksDoc(bundle: Bundle): Promise<void> {
  await seedFixture(bundle); // tasks/a, tasks/b, roadmap-items/x (see seedFixture's own edge map)
  await writeDoc(bundle, {
    id: "tasks",
    frontmatter: { type: "Task", title: "Tasks (bare)", timestamp: T },
    body: "",
  });
  await writeDoc(bundle, {
    id: "citer-of-bare-tasks",
    frontmatter: { type: "T", title: "Citer", timestamp: T },
    body: "[the tasks doc itself](tasks.md)",
  });
}

test("backlinks('tasks/') stays [] even when a doc literally named 'tasks' exists and has real incoming edges — no alias from the stripped-slash form to the bare id", async () => {
  await withBundle(async (bundle) => {
    await seedFixtureWithBareTasksDoc(bundle);

    // (a) The trailing-slash form must stay [] — NOT tasks's own backlinks.
    const trailingSlash = await backlinks(bundle, "tasks/");
    assert.deepEqual(trailingSlash, [], "'tasks/' must never alias to the bare 'tasks' doc's backlinks");

    // (b) The bare exact id DOES return its real backlinks — the exact-match path is unaffected.
    const bare = await backlinks(bundle, "tasks");
    assert.deepEqual(bare.map((l) => ({ from: l.from, text: l.text })), [
      { from: "citer-of-bare-tasks", text: "the tasks doc itself" },
    ]);

    // (c) queryEdges({ to: "tasks/" }) (the CLI's `link list --to tasks/`) still prefix-matches the
    // tasks/* family — and, being a strict string-prefix rule (one rule, no glob), does NOT also
    // sweep in the bare 'tasks' doc's edge (which has no '/' to match against). Prefix and exact
    // selectors stay cleanly disjoint: adding a 'tasks' doc perturbs neither.
    const prefixQuery = await queryEdges(bundle, { to: "tasks/" });
    assert.equal(prefixQuery.length, 4, "the tasks/* prefix family is unaffected by the bare 'tasks' doc");
    assert.ok(
      prefixQuery.every((e) => e.to !== "tasks"),
      "a strict 'tasks/' prefix must not also match the bare id 'tasks'",
    );
  });
});

test("queryEdges exact selectors keep canonical x and x.md distinct and reject aliases", async () => {
  await withBundle(async (bundle) => {
    await writeDoc(bundle, {
      id: "hub",
      frontmatter: { type: "T", timestamp: T },
      body: "[plain](x.md) [literal](x.md.md)",
    });
    assert.deepEqual((await queryEdges(bundle, { to: "x" })).map((edge) => edge.text), ["plain"]);
    assert.deepEqual((await queryEdges(bundle, { to: "x.md" })).map((edge) => edge.text), ["literal"]);
    await assert.rejects(() => queryEdges(bundle, { to: "./x" }), /Concept id must be canonical/);
    await assert.rejects(() => queryEdges(bundle, { to: "x//" }), /Concept id must be canonical/);
  });
});

test("the filesystem relationship cache reopens files and refreshes from direct edits, Git, and repair", async (t) => {
  const runtime = await fs.mkdtemp(path.join(tmpdir(), "superbee-edge-test-"));
  t.after(() => fs.rm(runtime, { recursive: true, force: true }));
  const root = path.join(runtime, "bundle");
  const policy: FilesystemHostPolicy = {
    runtimeLockParent: () => runtime,
    runtimeOwnerKey: () => "test",
    enforcePrivateMode: true,
    isTransientOpenError: () => false,
    isReplacementConflict: () => false,
    isDirectoryContentionError: () => false,
  };
  const bundle = () => ({ root, backend: new FilesystemBackend(root, { hostPolicy: policy }) });
  const source = path.join(root, "source.md");
  const target = path.join(root, "target.md");
  const frontmatter = "---\ntype: Note\ntitle: Example\n---\n\n";
  const original = frontmatter + "[first](target.md) [first](/target.md) [dangling](absent.md)";
  await fs.mkdir(root);
  await fs.writeFile(source, original);
  await fs.writeFile(target, frontmatter);
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git(["init", "-q"]);
  git(["add", "--", "source.md"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + 4_000);

  let restrictContentWitnesses = false;
  const actualStatfs = fs.statfs;
  t.mock.method(fs, "statfs", async (candidate: Parameters<typeof fs.statfs>[0]) => {
    const info = await actualStatfs(candidate);
    if (typeof candidate !== "string" || !candidate.startsWith("/proc/self/fd/")) return info;
    // The fixture supplies the admitted ext filesystem observation independently of the test host.
    return { ...info, type: restrictContentWitnesses ? 0x6969 : 0xef53 };
  });
  const actualLstat = fs.lstat;
  t.mock.method(fs, "lstat", (...args: Parameters<typeof fs.lstat>) => {
    if (restrictContentWitnesses && args[0] === "/System/Volumes/Data") {
      return Promise.reject(Object.assign(new Error("unidentified system volume"), { code: "ENOENT" }));
    }
    return actualLstat(...args);
  });

  let documentBodyReads = 0;
  let denySource = false;
  const actualOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (denySource && args[0] === source) throw Object.assign(new Error("private host path"), { code: "EACCES" });
    const handle = await actualOpen(...args);
    if (args[0] === source || args[0] === target) {
      const read = handle.readFile.bind(handle);
      handle.readFile = (...options: Parameters<typeof read>) => {
        documentBodyReads++;
        return read(...options);
      };
    }
    return handle;
  });
  const readEdges = () => backlinks(bundle(), "target");
  const expected = await readEdges();
  assert.deepEqual(expected.map(row => [row.text, row.href]), [["first", "target.md"], ["first", "/target.md"]]);
  assert.equal(documentBodyReads, 2);
  documentBodyReads = 0;
  assert.deepEqual(await readEdges(), expected);
  assert.equal(documentBodyReads, 0, "a fresh backend uses the persisted facts without reading document bodies");

  restrictContentWitnesses = true;
  documentBodyReads = 0;
  assert.deepEqual(await readEdges(), expected);
  assert.equal(documentBodyReads, 2, "an unidentified mount reads bodies even when cache stamps match");
  documentBodyReads = 0;
  await fs.writeFile(source, original.replaceAll("first", "other"));
  assert.deepEqual((await readEdges()).map(row => row.text), ["other", "other"]);
  assert.equal(documentBodyReads, 2, "an unidentified mount observes the directly edited bytes");
  restrictContentWitnesses = false;
  git(["restore", "--", "source.md"]);
  assert.deepEqual(await readEdges(), expected);

  const skipped: { id: string; reason: string }[] = [];
  denySource = true;
  assert.deepEqual(await backlinks(bundle(), "target", { onSkip: row => skipped.push(row) }), []);
  assert.deepEqual(skipped.map(row => row.id), ["source"]);
  assert.doesNotMatch(skipped[0]!.reason, /private host path/);
  await assert.rejects(readEdges(), { code: "EACCES" });
  denySource = false;
  assert.deepEqual(await readEdges(), expected);

  documentBodyReads = 0;
  const times = await fs.stat(source);
  await fs.writeFile(source, original.replaceAll("first", "other"));
  await fs.utimes(source, times.atime, times.mtime);
  assert.deepEqual((await readEdges()).map(row => row.text), ["other", "other"]);
  assert.equal(documentBodyReads, 1);
  git(["restore", "--", "source.md"]);
  assert.deepEqual(await readEdges(), expected);

  const page = await readRelationshipPage(bundle(), "target", 30);
  assert.equal(page.status, "ready");
  if (page.status === "ready") {
    assert.deepEqual(page.rows.map(row => [row.documentId, row.label]), [["source", "first"]]);
  }
  assert.equal((await readRelationshipPage(bundle(), "absent", 30)).status, "not_found");
  assert.equal((await backlinks(bundle(), "absent")).length, 1, "raw queries retain unresolved authored links");

  const cacheDir = path.join(runtime, "agentstate-lite-mutation-locks-test");
  const cacheFile = path.join(cacheDir, (await fs.readdir(cacheDir)).find(name => name.endsWith(".relationships.json"))!);
  await fs.writeFile(cacheFile, "{");
  documentBodyReads = 0;
  assert.deepEqual(await readEdges(), expected);
  assert.equal(documentBodyReads, 2, "corrupt derived state is rebuilt from Markdown");
  const wrongGeneration = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  await fs.writeFile(cacheFile, JSON.stringify({ ...wrongGeneration, parser: "links/old" }));
  documentBodyReads = 0;
  assert.deepEqual(await readEdges(), expected);
  assert.equal(documentBodyReads, 2, "a different parser generation is rebuilt");
  await fs.unlink(cacheFile);
  await fs.writeFile(cacheFile + ".abandoned.tmp", "{");
  documentBodyReads = 0;
  assert.deepEqual(await readEdges(), expected);
  assert.equal(documentBodyReads, 2, "an interrupted write cannot stand in for the missing cache");
  await fs.unlink(source);
  assert.deepEqual(await readEdges(), []);
  await fs.writeFile(source, "---\ntype: [\n---\n");
  const malformed: string[] = [];
  assert.deepEqual(await backlinks(bundle(), "target", { onSkip: row => malformed.push(row.id) }), []);
  assert.deepEqual(malformed, ["source"]);
  await fs.writeFile(source + ".replacement", original);
  await fs.rename(source + ".replacement", source);
  assert.deepEqual(await readEdges(), expected);

  const withoutPrivateCache = new FilesystemBackend(root, { hostPolicy: { ...policy, enforcePrivateMode: false } });
  assert.equal(await withoutPrivateCache.relationshipSources(), undefined);
  assert.deepEqual(await backlinks({ root, backend: withoutPrivateCache }, "target"), expected);
});
