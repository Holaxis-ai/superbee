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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initBundle, writeDoc, backlinks, queryEdges } from "../src/bundle.js";
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
