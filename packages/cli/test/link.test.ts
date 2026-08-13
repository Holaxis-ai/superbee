/**
 * `link add` timestamp-refresh semantics (external review finding P2).
 *
 * `timestamp` means "last meaningful change" (OKF + VISION). The engine
 * (`writeDoc`/`writeDocVersioned`) stays caller-controlled and preserves an existing
 * `frontmatter.timestamp` — that is proven in `@superbee/core`'s own tests and is
 * NOT re-tested here. What IS tested here is the CLI's `link add`, which is the bug this
 * finding identified: appending a cross-link is a meaningful change, so by default it must
 * refresh the timestamp on its outgoing write, EXCEPT on the idempotent no-op path (the
 * source already carries the same target + exact text) where nothing is written at all.
 *
 * Runs the command function in-process (no subprocess) against a real temp filesystem
 * bundle, mirroring `packages/core/test`'s node:test + ts-loader pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  initBundle,
  writeDoc,
  readDoc,
  readDocVersioned,
  docVersions,
  parseLinks,
  MemoryBackend,
  type Bundle,
  type OkfDocument,
  type Version,
} from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";
import { link, addLink } from "../src/commands/link.js";
import { CliError } from "../src/errors.js";

const OLD_TS = "2020-01-01T00:00:00.000Z";

async function withActorEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, "AGENTSTATE_LITE_ACTOR");
  const previous = process.env.AGENTSTATE_LITE_ACTOR;
  if (value === undefined) delete process.env.AGENTSTATE_LITE_ACTOR;
  else process.env.AGENTSTATE_LITE_ACTOR = value;
  try {
    return await run();
  } finally {
    if (had) process.env.AGENTSTATE_LITE_ACTOR = previous;
    else delete process.env.AGENTSTATE_LITE_ACTOR;
  }
}

/** A fresh temp OKF bundle with `concepts/a` and `concepts/b`, both stamped at OLD_TS. */
async function makeFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  const bundle = await initBundle(dir);
  await writeDoc(bundle, {
    id: "concepts/a",
    frontmatter: { type: "Concept", title: "A", timestamp: OLD_TS },
    body: "Body A.",
  });
  await writeDoc(bundle, {
    id: "concepts/b",
    frontmatter: { type: "Concept", title: "B", timestamp: OLD_TS },
    body: "Body B.",
  });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Run `link add` in-process against `dir`, capturing stdout and decoding the `--json` envelope. */
async function linkAdd(dir: string, args: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await link(["add", ...args, "--dir", dir, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out);
}

/** Run `link show` in-process against `dir`, capturing stdout and decoding the `--json` envelope. */
async function linkShow(dir: string, args: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await link(["show", ...args, "--dir", dir, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out);
}

/** Run `link list` in-process against `dir`, capturing stdout and decoding the `--json` envelope. */
async function linkList(dir: string, args: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await link(["list", ...args, "--dir", dir, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out);
}

test("link add: refreshes the source timestamp by default (freshness reflects the change)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const before = new Date().getTime();
    const result = await linkAdd(dir, ["concepts/a", "concepts/b"]);
    assert.equal(result.changed, true);
    assert.equal(result.link, "added");

    const doc = await readDoc({ root: dir }, "concepts/a");
    const ts = doc.frontmatter.timestamp as string;
    assert.notEqual(ts, OLD_TS, "timestamp must advance past the stale value");
    const tsMs = Date.parse(ts);
    assert.ok(tsMs >= before, "refreshed timestamp must be ~now, not the old value");
    assert.match(doc.body, /\[concepts\/b\]\(b\.md\)/);
  } finally {
    await cleanup();
  }
});

test("link add --keep-timestamp: preserves the source's existing timestamp", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const result = await linkAdd(dir, ["concepts/a", "concepts/b", "--keep-timestamp"]);
    assert.equal(result.changed, true);

    const doc = await readDoc({ root: dir }, "concepts/a");
    assert.equal(doc.frontmatter.timestamp, OLD_TS);
    assert.match(doc.body, /\[concepts\/b\]\(b\.md\)/);
  } finally {
    await cleanup();
  }
});

test("link add: a reserved-filename target (index/log) is rejected with a structured USAGE error, not silently written", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    for (const target of ["index", "log", "sub/index", "sub/log.md"]) {
      await assert.rejects(
        () => link(["add", "concepts/a", target, "--dir", dir, "--json"], { stdout: () => {} }),
        (err: unknown) => {
          assert.ok(err instanceof CliError, `expected a CliError for target '${target}'`);
          assert.equal(err.code, "USAGE");
          assert.equal(err.exitCode, 2);
          return true;
        },
      );
    }
    // The source doc was never touched by any of the rejected attempts.
    const doc = await readDoc({ root: dir }, "concepts/a");
    assert.equal(doc.body, "Body A.\n");
  } finally {
    await cleanup();
  }
});

test("link add: re-adding an already-present link is an idempotent no-op (no write, no timestamp refresh)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    // First add: this legitimately refreshes the timestamp (a real body change).
    const first = await linkAdd(dir, ["concepts/a", "concepts/b"]);
    assert.equal(first.changed, true);
    const afterFirst = await readDoc({ root: dir }, "concepts/a");
    const refreshedTs = afterFirst.frontmatter.timestamp;

    // Second add of the SAME link: must converge to changed:false and must NOT touch the
    // timestamp again — re-adding an existing link is a true no-op.
    const second = await linkAdd(dir, ["concepts/a", "concepts/b"]);
    assert.equal(second.changed, false);
    assert.equal(second.link, "exists");

    const afterSecond = await readDoc({ root: dir }, "concepts/a");
    assert.equal(afterSecond.frontmatter.timestamp, refreshedTs);
    assert.equal(afterSecond.body, afterFirst.body);
  } finally {
    await cleanup();
  }
});

test("link add: different exact text to the same target creates a second semantic edge; exact repeats remain no-ops", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const cites = await linkAdd(dir, ["concepts/a", "concepts/b", "--text", "cites"]);
    assert.equal(cites.changed, true);

    const dependsOn = await linkAdd(dir, ["concepts/a", "concepts/b", "--text", "depends on"]);
    assert.equal(dependsOn.changed, true, "different text to the same target is a distinct edge");

    const exactRepeat = await linkAdd(dir, ["concepts/a", "concepts/b", "--text", "depends on"]);
    assert.equal(exactRepeat.changed, false, "the exact target + text edge remains idempotent");

    const doc = await readDoc({ root: dir }, "concepts/a");
    assert.deepEqual(
      parseLinks({ root: dir }, doc).map((link) => ({ to: link.to, text: link.text })),
      [
        { to: "concepts/b", text: "cites" },
        { to: "concepts/b", text: "depends on" },
      ],
    );
  } finally {
    await cleanup();
  }
});

test("link add: equivalent target spellings share one normalized target + exact-text identity", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    assert.equal((await linkAdd(dir, ["concepts/a", "concepts/b", "--text", "cites"])).changed, true);
    assert.equal(
      (await linkAdd(dir, ["concepts/a", "./concepts/b", "--text", "cites"])).changed,
      false,
    );
    assert.equal(
      (await linkAdd(dir, ["concepts/a", "/concepts/b.md", "--text", "cites"])).changed,
      false,
    );

    const doc = await readDoc({ root: dir }, "concepts/a");
    assert.deepEqual(
      parseLinks({ root: dir }, doc).map((link) => ({ to: link.to, text: link.text })),
      [{ to: "concepts/b", text: "cites" }],
    );
  } finally {
    await cleanup();
  }
});

test("link add: environment attribution reaches local+remote content/history; a no-op never rewrites actor", async () => {
  const local = await makeFixtureBundle();
  const remoteBundle: Bundle = { root: "mem://link-actor-env", backend: new MemoryBackend() };
  await writeDoc(remoteBundle, {
    id: "concepts/a",
    frontmatter: { type: "Concept", title: "A", actor: "old", timestamp: OLD_TS },
    body: "Body A.",
  });
  await writeDoc(remoteBundle, {
    id: "concepts/b",
    frontmatter: { type: "Concept", title: "B", timestamp: OLD_TS },
    body: "Body B.",
  });
  const handle: ServerHandle = await serve({ bundle: remoteBundle, port: 0 });
  const url = `http://${handle.host}:${handle.port}`;
  try {
    await withActorEnv(" env-link ", async () => {
      assert.equal((await linkAdd(local.dir, ["concepts/a", "concepts/b"])).changed, true);
      let out = "";
      await link(["add", "concepts/a", "concepts/b", "--remote", url, "--json"], {
        stdout: (s) => (out += s),
      });
      assert.equal((JSON.parse(out) as { changed: boolean }).changed, true);
    });
    assert.equal((await readDoc({ root: local.dir }, "concepts/a")).frontmatter.actor, "env-link");
    assert.equal((await readDoc(remoteBundle, "concepts/a")).frontmatter.actor, "env-link");
    assert.equal((await docVersions(remoteBundle, "concepts/a"))[0]!.actor, "env-link");

    const beforeNoOp = await readDocVersioned(remoteBundle, "concepts/a");
    const historyLength = (await docVersions(remoteBundle, "concepts/a")).length;
    let noOpOut = "";
    await withActorEnv("ignored-env", () =>
      link(
        ["add", "concepts/a", "concepts/b", "--actor", "flag-must-not-rewrite", "--remote", url, "--json"],
        { stdout: (s) => (noOpOut += s) },
      ),
    );
    assert.equal((JSON.parse(noOpOut) as { changed: boolean }).changed, false);
    const afterNoOp = await readDocVersioned(remoteBundle, "concepts/a");
    assert.equal(afterNoOp.version, beforeNoOp.version);
    assert.equal(afterNoOp.doc.frontmatter.actor, "env-link");
    assert.equal((await docVersions(remoteBundle, "concepts/a")).length, historyLength);
  } finally {
    await handle.close();
    await local.cleanup();
  }
});

// ── `addLink` onto the shared `versionedMutation` primitive: concurrent-writer racer tests ────────
//
// `addLink` (the core link-add mutation `link add`/`new --link` both call) now rides core's shared
// read-decide-CAS-retry primitive instead of a hand-rolled loop (CLAUDE.md gate 3). These tests
// exercise it directly against a `MemoryBackend` bundle (real enforced CAS), with a `backend.write`
// wrapper that injects a competing write exactly when our own write attempts to land — the same
// mechanism `doc.test.ts`'s coupleRead racer tests use for `mutateDoc`.

test("link add: a competing writer adds the SAME link before our own write lands — converges to changed:false, no duplicate link, no timestamp re-refresh on the retry", async () => {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://link-add-same-race", backend };
  await writeDoc(bundle, {
    id: "a",
    frontmatter: { type: "Concept", timestamp: OLD_TS },
    body: "Intro.\n",
  });
  await writeDoc(bundle, { id: "b", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "" });

  // The FIRST time our own write attempts a real CAS write for 'a', inject a race: a separate
  // writer adds the EXACT SAME link first (using our own read's version, so it wins), leaving our
  // own write's token stale.
  const originalWrite = backend.write.bind(backend);
  let injected = false;
  backend.write = (async (id: string, d: OkfDocument, options?: { expectedVersion?: Version | null }) => {
    if (id === "a" && !injected && options?.expectedVersion) {
      injected = true;
      const current = await backend.read("a");
      await originalWrite(
        "a",
        { ...current.doc, body: `${current.doc.body.replace(/\s*$/, "")}\n\n[b](b.md)\n` },
        { expectedVersion: options.expectedVersion },
      );
    }
    return originalWrite(id, d, options);
  }) as typeof backend.write;

  const result = await addLink(bundle, "a", "b", { text: "b" });

  // Converged to changed:false — the competing writer already made the exact change we wanted, so
  // our retry's idempotency check sees it and never writes a duplicate link.
  assert.equal(result.changed, false);
  const after = await readDoc(bundle, "a");
  assert.equal(parseLinks(bundle, after).filter((l) => l.to === "b").length, 1);
});

test("link add: a competing writer makes an UNRELATED change before our own write lands — our link lands on the retry, and the competing change survives (not silently clobbered)", async () => {
  const backend = new MemoryBackend();
  const bundle: Bundle = { root: "mem://link-add-unrelated-race", backend };
  await writeDoc(bundle, {
    id: "a",
    frontmatter: { type: "Concept", title: "Old title", timestamp: OLD_TS },
    body: "Intro.\n",
  });
  await writeDoc(bundle, { id: "b", frontmatter: { type: "Concept", timestamp: OLD_TS }, body: "" });

  // The FIRST time our own write attempts a real CAS write for 'a', inject an UNRELATED competing
  // change (a title edit, nothing to do with links) using our own read's version, so it wins.
  const originalWrite = backend.write.bind(backend);
  let injected = false;
  backend.write = (async (id: string, d: OkfDocument, options?: { expectedVersion?: Version | null }) => {
    if (id === "a" && !injected && options?.expectedVersion) {
      injected = true;
      const current = await backend.read("a");
      await originalWrite(
        "a",
        { ...current.doc, frontmatter: { ...current.doc.frontmatter, title: "Raced title" } },
        { expectedVersion: options.expectedVersion },
      );
    }
    return originalWrite(id, d, options);
  }) as typeof backend.write;

  const result = await addLink(bundle, "a", "b", { text: "b" });

  assert.equal(result.changed, true);
  const after = await readDoc(bundle, "a");
  // Our link landed on the retry...
  assert.equal(parseLinks(bundle, after).some((l) => l.to === "b"), true);
  // ...and the competing writer's title change was NOT silently clobbered — the retry's write
  // built its candidate from the FRESH (post-race) doc, which already carried the raced title.
  assert.equal(after.frontmatter.title, "Raced title");
});

// The ENOSPC-stays-RUNTIME probe lives in test/error-boundary.test.ts with the rest of the
// public error matrix (tasks/error-classification-boundary).

test("link show --limit caps the outbound/backlink lists; counts stay the true totals (A5)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, { id: "hub", frontmatter: { type: "Concept", title: "Hub", timestamp: OLD_TS }, body: "" });
    for (let i = 0; i < 4; i++) {
      await writeDoc(bundle, { id: `t${i}`, frontmatter: { type: "Concept", title: `T${i}`, timestamp: OLD_TS }, body: "" });
      await link(["add", "hub", `t${i}`, "--dir", dir, "--json"], { stdout: () => {} });
    }
    let out = "";
    await link(["show", "hub", "--limit", "2", "--dir", dir, "--json"], { stdout: (s) => (out += s) });
    const shown = JSON.parse(out) as Record<string, unknown>;
    assert.equal(shown.outbound_count, 4, "count is the true total");
    assert.equal((shown.outbound as unknown[]).length, 2, "outbound page is capped");
    const help = shown.help as string[];
    assert.ok(help.some((h) => /showing 2\/4 outbound/.test(h) && /--limit 0/.test(h)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link show: backlink rows carry the citing link's text (typed-edge reading v0, rung a)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, { id: "target", frontmatter: { type: "Concept", title: "Target", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "citer", frontmatter: { type: "Concept", title: "Citer", timestamp: OLD_TS }, body: "" });
    await linkAdd(dir, ["citer", "target", "--text", "depends on"]);

    const shown = await linkShow(dir, ["target"]);
    assert.equal(shown.backlink_count, 1);
    assert.deepEqual(shown.backlinks, [{ from: "citer", text: "depends on" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link show --text: filters BOTH outbound links and backlinks to an exact text match; counts are the filtered totals (typed-edge reading v0, rung b)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    for (const id of ["hub", "t0", "t1", "citer"]) {
      await writeDoc(bundle, { id, frontmatter: { type: "Concept", title: id, timestamp: OLD_TS }, body: "" });
    }
    await linkAdd(dir, ["hub", "t0", "--text", "prereq"]);
    await linkAdd(dir, ["hub", "t1", "--text", "see also"]);
    await linkAdd(dir, ["citer", "hub", "--text", "prereq"]);

    const filtered = await linkShow(dir, ["hub", "--text", "prereq"]);
    assert.equal(filtered.text_filter, "prereq");
    assert.equal(filtered.outbound_count, 1, "outbound_count is the FILTERED total, not the true total (2)");
    assert.deepEqual((filtered.outbound as { to: string }[]).map((l) => l.to), ["t0"]);
    assert.equal(filtered.backlink_count, 1);
    assert.deepEqual(filtered.backlinks, [{ from: "citer", text: "prereq" }]);

    // A substring of "prereq" must NOT match — exact match only.
    const substring = await linkShow(dir, ["hub", "--text", "pre"]);
    assert.equal(substring.outbound_count, 0);
    assert.equal(substring.backlink_count, 0);

    // A filter matching nothing in either direction is a DEFINITIVE empty result, not an error.
    const empty = await linkShow(dir, ["hub", "--text", "no-such-relation"]);
    assert.equal(empty.outbound_count, 0);
    assert.deepEqual(empty.outbound, []);
    assert.equal(empty.backlink_count, 0);
    assert.deepEqual(empty.backlinks, []);
    const help = empty.help as string[];
    assert.ok(help.some((h) => /no links matched --text 'no-such-relation'/.test(h)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link show --text zero-match: help names the distinct link texts present (near-miss hint); a linkless doc keeps the plain definitive-empty message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    for (const id of ["hub", "t0", "t1", "citer", "lone"]) {
      await writeDoc(bundle, { id, frontmatter: { type: "Concept", title: id, timestamp: OLD_TS }, body: "" });
    }
    await linkAdd(dir, ["hub", "t0", "--text", "prereq"]);
    await linkAdd(dir, ["hub", "t1", "--text", "see also"]);
    await linkAdd(dir, ["citer", "hub", "--text", "prereq"]);

    // A near-miss ('prereqs' for 'prereq') matches nothing, but the help line names what IS there
    // (distinct, sorted, both directions pooled) instead of reading as an empty graph.
    const miss = await linkShow(dir, ["hub", "--text", "prereqs"]);
    assert.equal(miss.outbound_count, 0);
    assert.equal(miss.backlink_count, 0);
    const help = miss.help as string[];
    assert.ok(
      help.some((h) => /no links matched --text 'prereqs'/.test(h) && /link texts present here: 'prereq', 'see also'/.test(h)),
      `near-miss help should name the texts present, got: ${JSON.stringify(help)}`,
    );

    // A doc with NO links at all has no texts to name — the plain definitive-empty message stays.
    const lone = await linkShow(dir, ["lone", "--text", "anything"]);
    const loneHelp = lone.help as string[];
    assert.ok(loneHelp.some((h) => /definitive empty result, not an error/.test(h)));
    assert.ok(!loneHelp.some((h) => /link texts present here/.test(h)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link show --text '' (empty/blank value): USAGE error, exit 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => link(["show", "hub", "--text", "  ", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── link-add-target-honesty: dangling links stay LEGAL, but the receipt now says so ────────────
//
// Cold-start usability probe finding 1 (2026-07-19): `link add` to a TYPO'D target returned the
// identical success envelope as a deliberate forward-declaration. Dangling links stay allowed
// (`link --help` already says so); the fix is receipt HONESTY — a `warnings[]` entry (the SAME
// convention the graph-lint tests above pin), never a refusal.

test("link add: an absent target attaches a LINK_TARGET_ABSENT warning to the success envelope (RED PROOF: dropping the signal fails this)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    // Reproduces the probe's exact transcript: 'concepts/ghots' is a typo for an id that was
    // never written (no doc at that id in this fixture bundle).
    const result = await linkAdd(dir, ["concepts/a", "concepts/ghots", "--text", "cites"]);
    assert.equal(result.changed, true);
    assert.equal(result.link, "added");
    const warnings = result.warnings as Array<Record<string, unknown>>;
    assert.ok(warnings, "expected a warnings array for a link to an absent target");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, "LINK_TARGET_ABSENT");
    assert.equal(warnings[0]!.severity, "warning");
    assert.equal(warnings[0]!.field, "to");
    assert.match(warnings[0]!.message as string, /'concepts\/ghots' has no document yet/);
    assert.match(warnings[0]!.message as string, /forward-declaration/);
    assert.match(warnings[0]!.message as string, /doc write concepts\/ghots --type <t>/);

    // The link itself IS written — forward-declaration stays legal, never refused.
    const doc = await readDoc({ root: dir }, "concepts/a");
    assert.match(doc.body, /\[cites\]\(ghots\.md\)/);
  } finally {
    await cleanup();
  }
});

test("link add: a PRESENT target's success receipt is byte-identical to the pre-fix envelope (no warnings key at all)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const result = await linkAdd(dir, ["concepts/a", "concepts/b"]);
    // Pinned from the actual pre-change CLI output (captured before this fix landed):
    // {"link":"added","from":"concepts/a","to":"concepts/b","href":"b.md","text":"concepts/b",
    //  "changed":true,"help":["... link show concepts/b"]} — no `warnings` key.
    assert.deepEqual(Object.keys(result).sort(), ["changed", "from", "help", "href", "link", "text", "to"]);
    assert.equal(result.link, "added");
    assert.equal(result.from, "concepts/a");
    assert.equal(result.to, "concepts/b");
    assert.equal(result.href, "b.md");
    assert.equal(result.text, "concepts/b");
    assert.equal(result.changed, true);
    assert.ok(!("warnings" in result), "a link to an existing target must never attach a warnings key");
  } finally {
    await cleanup();
  }
});

test("link add: the idempotent no-op path (changed:false) never attaches LINK_TARGET_ABSENT, even when the target is still absent (mirrors the graph-lint idempotent-path skip — one convention, not two)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const first = await linkAdd(dir, ["concepts/a", "concepts/ghost", "--text", "cites"]);
    assert.equal(first.changed, true);
    assert.ok(first.warnings, "first add of an absent-target edge should warn");

    // Re-adding the EXACT SAME edge (same target + same text) while the target is STILL absent:
    // converges to changed:false, and the no-op path performs no target-existence check at all.
    const second = await linkAdd(dir, ["concepts/a", "concepts/ghost", "--text", "cites"]);
    assert.equal(second.changed, false);
    assert.equal(second.link, "exists");
    assert.ok(!("warnings" in second), "the idempotent no-op path must never attach a warnings key");
  } finally {
    await cleanup();
  }
});

test("link add: once the target is written, re-adding the same edge stays changed:false with no warning (the absent-target signal reflects state AT LINK TIME, not stale)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const first = await linkAdd(dir, ["concepts/a", "concepts/ghost", "--text", "cites"]);
    assert.equal(first.changed, true);
    assert.ok(first.warnings, "first add of an absent-target edge should warn");

    await writeDoc({ root: dir }, { id: "concepts/ghost", frontmatter: { type: "Concept", title: "Ghost" }, body: "" });

    const second = await linkAdd(dir, ["concepts/a", "concepts/ghost", "--text", "cites"]);
    assert.equal(second.changed, false, "the edge already exists — the no-op path never re-checks target existence");
    assert.ok(!("warnings" in second));
  } finally {
    await cleanup();
  }
});

test("link add: target-existence honesty is LOCAL-bundle only — a --remote link add to an absent target never carries the warning (no extra network round trip)", async () => {
  const remoteBundle: Bundle = { root: "mem://link-target-honesty-remote", backend: new MemoryBackend() };
  await writeDoc(remoteBundle, {
    id: "concepts/a",
    frontmatter: { type: "Concept", title: "A", timestamp: OLD_TS },
    body: "Body A.",
  });
  const handle: ServerHandle = await serve({ bundle: remoteBundle, port: 0 });
  const url = `http://${handle.host}:${handle.port}`;
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    requestCount++;
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    let out = "";
    await link(["add", "concepts/a", "concepts/ghost", "--remote", url, "--json"], {
      stdout: (s) => (out += s),
    });
    const result = JSON.parse(out) as Record<string, unknown>;
    assert.equal(result.changed, true);
    assert.ok(
      !("warnings" in result),
      "a --remote link add to an absent target must never carry a target-existence warning",
    );
    // Exactly the same request count a --remote link add to a PRESENT target costs (below) — proof
    // that no extra round trip was added for the absent-target case.
    const requestsForAbsentTarget = requestCount;

    // A direct in-process writeDoc against `remoteBundle`'s MemoryBackend, NOT through HTTP — sets
    // up the present-target comparison below without spending any of its own fetch calls.
    await writeDoc(remoteBundle, {
      id: "concepts/b",
      frontmatter: { type: "Concept", title: "B", timestamp: OLD_TS },
      body: "Body B.",
    });
    requestCount = 0;
    let out2 = "";
    await link(["add", "concepts/a", "concepts/b", "--remote", url, "--json"], {
      stdout: (s) => (out2 += s),
    });
    assert.equal(requestCount, requestsForAbsentTarget, "no extra HTTP request for an absent vs. present target");
  } finally {
    globalThis.fetch = originalFetch;
    await handle.close();
  }
});

test("link add: a reserved-filename target is still rejected before any target-existence check runs (USAGE error, not a dangling-link warning)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    await assert.rejects(
      () => link(["add", "concepts/a", "index", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("link add: an absent target ALSO carries a type-conformance warning when --text matches a declared type — both warnings coexist in the SAME warnings[] array (one convention, not two)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/box",
      frontmatter: {
        type: "Convention",
        governs: "Box",
        fields: { required: ["title"], optional: [] },
        links: { contains: "Crate" },
        timestamp: OLD_TS,
      },
      body: "Box declares its typed-edge vocabulary.",
    });
    await writeDoc(bundle, { id: "box-1", frontmatter: { type: "Box", title: "Box1", timestamp: OLD_TS }, body: "" });

    // 'crate-1' is never written: the target is BOTH absent AND (once written) would need to be a
    // Crate for 'contains' to conform — but since it's unresolved, the type-conformance half of the
    // check is skipped (existing `lintLinkType` behavior) while the target-absent check still fires.
    const result = await linkAdd(dir, ["box-1", "crate-1", "--text", "contains"]);
    assert.equal(result.changed, true);
    const warnings = result.warnings as Array<Record<string, unknown>>;
    assert.ok(warnings, "expected a warnings array");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, "LINK_TARGET_ABSENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link add: a wrong-kind violation (source AND target type mismatches against a declared 'links' vocabulary) attaches a warnings[] to the success envelope, exit 0 (the link is already written)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    // A GENERIC vocabulary (not Task/Roadmap Item), pinning that nothing is hardcoded: 'Box'
    // declares 'contains' -> 'Crate'.
    await writeDoc(bundle, {
      id: "conventions/box",
      frontmatter: {
        type: "Convention",
        governs: "Box",
        fields: { required: ["title"], optional: [] },
        links: { contains: "Crate" },
        timestamp: OLD_TS,
      },
      body: "Box declares its typed-edge vocabulary.",
    });
    await writeDoc(bundle, { id: "box-1", frontmatter: { type: "Box", title: "Box1", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "crate-1", frontmatter: { type: "Crate", title: "Crate1", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "widget-1", frontmatter: { type: "Widget", title: "Widget1", timestamp: OLD_TS }, body: "" });

    // Wrong SOURCE: a Widget (not a Box) using the 'contains' text against a conforming target.
    const wrongSource = await linkAdd(dir, ["widget-1", "crate-1", "--text", "contains"]);
    assert.equal(wrongSource.changed, true);
    const sourceWarnings = wrongSource.warnings as Array<Record<string, unknown>>;
    assert.ok(sourceWarnings, "expected a warnings array for a wrong-source edge");
    assert.equal(sourceWarnings.length, 1);
    assert.equal(sourceWarnings[0]!.code, "LINK_TYPE_VIOLATION");
    assert.equal(sourceWarnings[0]!.severity, "warning");
    assert.match(
      sourceWarnings[0]!.message as string,
      /'contains' is declared by 'Box' -> Crate; this link is Widget -> Crate\./,
    );

    // Wrong TARGET: a conforming Box source, but the target is a Widget instead of a Crate.
    const wrongTarget = await linkAdd(dir, ["box-1", "widget-1", "--text", "contains"]);
    assert.equal(wrongTarget.changed, true);
    const targetWarnings = wrongTarget.warnings as Array<Record<string, unknown>>;
    assert.ok(targetWarnings, "expected a warnings array for a wrong-target edge");
    assert.equal(targetWarnings[0]!.code, "LINK_TYPE_VIOLATION");
    assert.match(
      targetWarnings[0]!.message as string,
      /'contains' is declared by 'Box' -> Crate; this link is Box -> Widget\./,
    );

    // A CONFORMING edge (Box -> Crate) never warns.
    const conforming = await linkAdd(dir, ["box-1", "crate-1", "--text", "contains"]);
    assert.equal(conforming.changed, true);
    assert.ok(!("warnings" in conforming), "a conforming typed edge must never attach a warnings key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link add: a same-spelling-different-case link type warns naming the declared spelling (case-variant near miss) — no edit-distance matching", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/box",
      frontmatter: {
        type: "Convention",
        governs: "Box",
        fields: { required: ["title"], optional: [] },
        links: { contains: "Crate" },
        timestamp: OLD_TS,
      },
      body: "Box declares its typed-edge vocabulary.",
    });
    await writeDoc(bundle, { id: "box-1", frontmatter: { type: "Box", title: "Box1", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "crate-1", frontmatter: { type: "Crate", title: "Crate1", timestamp: OLD_TS }, body: "" });

    // 'Contains' (capital C) is a case-variant of the declared 'contains' — a near miss, not an
    // exact match, even though the source/target kinds here would otherwise conform.
    const result = await linkAdd(dir, ["box-1", "crate-1", "--text", "Contains"]);
    assert.equal(result.changed, true);
    const warnings = result.warnings as Array<Record<string, unknown>>;
    assert.ok(warnings, "expected a case-variant warning");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.code, "LINK_TYPE_CASE_VARIANT");
    assert.match(
      warnings[0]!.message as string,
      /'Contains' is a case-variant of the declared link type 'contains' — did you mean --text 'contains'\?/,
    );

    // An unrelated near-miss text (edit-distance close, but NOT a case variant) never warns —
    // this lint does ONLY exact-match + case-insensitive-match, never edit-distance matching.
    await writeDoc(bundle, { id: "crate-2", frontmatter: { type: "Crate", title: "Crate2", timestamp: OLD_TS }, body: "" });
    const editDistance = await linkAdd(dir, ["box-1", "crate-2", "--text", "contain"]);
    assert.equal(editDistance.changed, true);
    assert.ok(!("warnings" in editDistance), "an edit-distance near miss (not a case variant) must never warn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link add: an untyped link (text matching no declared type, in any casing) never warns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/box",
      frontmatter: {
        type: "Convention",
        governs: "Box",
        fields: { required: ["title"], optional: [] },
        links: { contains: "Crate" },
        timestamp: OLD_TS,
      },
      body: "Box declares its typed-edge vocabulary.",
    });
    await writeDoc(bundle, { id: "box-1", frontmatter: { type: "Box", title: "Box1", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "widget-1", frontmatter: { type: "Widget", title: "Widget1", timestamp: OLD_TS }, body: "" });

    const result = await linkAdd(dir, ["box-1", "widget-1", "--text", "see also"]);
    assert.equal(result.changed, true);
    assert.ok(!("warnings" in result), "an untyped link must never attach a warnings key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link add: the idempotent no-op path (changed:false) performs no registry load and no type-conformance check — no warnings key even for an already-violating edge", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/box",
      frontmatter: {
        type: "Convention",
        governs: "Box",
        fields: { required: ["title"], optional: [] },
        links: { contains: "Crate" },
        timestamp: OLD_TS,
      },
      body: "Box declares its typed-edge vocabulary.",
    });
    await writeDoc(bundle, { id: "widget-1", frontmatter: { type: "Widget", title: "Widget1", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "crate-1", frontmatter: { type: "Crate", title: "Crate1", timestamp: OLD_TS }, body: "" });

    const first = await linkAdd(dir, ["widget-1", "crate-1", "--text", "contains"]);
    assert.equal(first.changed, true);
    assert.ok(first.warnings, "first add of a wrong-source edge should warn");

    const second = await linkAdd(dir, ["widget-1", "crate-1", "--text", "contains"]);
    assert.equal(second.changed, false);
    assert.equal(second.link, "exists");
    assert.ok(!("warnings" in second), "the idempotent no-op path must never attach a warnings key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link add: a conventions-free bundle (no kind declares any links) never warns, regardless of --text", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const result = await linkAdd(dir, ["concepts/a", "concepts/b", "--text", "contains"]);
    assert.equal(result.changed, true);
    assert.ok(!("warnings" in result), "a conventions-free bundle must never attach a warnings key");
  } finally {
    await cleanup();
  }
});

test("link show --text (no value at all): USAGE error, exit 2 — a bare parseArgs failure, not a bare TypeError", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-test-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => link(["show", "hub", "--dir", dir, "--json", "--text"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── link list (graph-query-v0): the whole-bundle derived edge list, filtered ──────────────────

/** A fixture with a small but representative edge graph: a prefix family (tasks/*), a
 * cross-prefix citer (roadmap-items/x), a dangling target, and two differently-worded literal
 * links between the same from/to (per-literal-link counting). */
async function makeEdgeFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  const bundle = await initBundle(dir);
  await writeDoc(bundle, {
    id: "tasks/a",
    frontmatter: { type: "Task", title: "A", timestamp: OLD_TS },
    body: "[first](b.md) [second](b.md) [dangling](../ghost.md)",
  });
  await writeDoc(bundle, { id: "tasks/b", frontmatter: { type: "Task", title: "B", timestamp: OLD_TS }, body: "" });
  await writeDoc(bundle, {
    id: "roadmap-items/x",
    frontmatter: { type: "Roadmap Item", title: "X", timestamp: OLD_TS },
    body: "[contains](../tasks/a.md)",
  });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("link list (no filter): every edge in the bundle, sorted (from, to, text), count matches the row count", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, []);
    assert.equal(result.count, 4);
    const edges = result.edges as { from: string; to: string; text: string }[];
    assert.deepEqual(edges, [
      { from: "roadmap-items/x", to: "tasks/a", text: "contains" },
      { from: "tasks/a", to: "ghost", text: "dangling" },
      { from: "tasks/a", to: "tasks/b", text: "first" },
      { from: "tasks/a", to: "tasks/b", text: "second" },
    ]);
  } finally {
    await cleanup();
  }
});

test("link list --to <prefix/>: trailing-slash prefix matches every id starting with that literal string", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, ["--to", "tasks/"]);
    assert.equal(result.count, 3);
    const edges = result.edges as { to: string }[];
    assert.ok(edges.every((e) => e.to.startsWith("tasks/")));
  } finally {
    await cleanup();
  }
});

test("the prefix rule is confined to `link list` and never leaks into `link show`'s backlinks: `link show tasks/` reports backlink_count 0 (exact-match, byte-identical to pre-generalization), while `link list --to tasks/` on the SAME bundle still prefix-matches", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const shown = await linkShow(dir, ["tasks/"]);
    assert.equal(shown.exists, false, "'tasks/' is not itself a written concept id");
    assert.equal(shown.backlink_count, 0, "no prefix leak — 'tasks/' must NOT match every tasks/* edge");
    assert.deepEqual(shown.backlinks, []);

    // The SAME bundle's `link list --to tasks/` still prefix-matches — the capability lives there,
    // confirming the fix scopes the guard to `backlinks`/`link show` only, not to queryEdges itself.
    const listed = await linkList(dir, ["--to", "tasks/"]);
    assert.equal(listed.count, 3);
  } finally {
    await cleanup();
  }
});

// review finding (round 2): the FIRST fix ("strip the trailing slash, then delegate the bare id")
// was itself wrong — it ALIASES 'tasks/' to the bare id 'tasks', so a bundle that ALSO has a doc
// literally named `tasks` would wrongly report ITS backlinks under `link show tasks/` (main
// returns [] regardless of whether such a doc exists). The test above never caught this because
// its fixture had no doc literally named `tasks`. This fixture adds one, with its own real
// incoming edge, disjoint from the tasks/* family.
test("link show tasks/ stays backlink_count 0 even when a doc literally named 'tasks' exists with real incoming edges (no alias); link show tasks returns THOSE backlinks; link list --to tasks/ still prefix-matches the tasks/* family only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, { id: "tasks", frontmatter: { type: "Task", title: "Tasks (bare)", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "tasks/a", frontmatter: { type: "Task", title: "A", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, {
      id: "citer-of-bare-tasks",
      frontmatter: { type: "T", title: "Citer", timestamp: OLD_TS },
      body: "[the tasks doc itself](tasks.md)",
    });
    await writeDoc(bundle, {
      id: "citer-of-tasks-a",
      frontmatter: { type: "T", title: "Citer A", timestamp: OLD_TS },
      body: "[a task](tasks/a.md)",
    });

    // (a) The trailing-slash form must NOT return the bare 'tasks' doc's real backlinks.
    const shownSlash = await linkShow(dir, ["tasks/"]);
    assert.equal(shownSlash.backlink_count, 0, "'tasks/' must never alias to the bare 'tasks' doc's backlinks");
    assert.deepEqual(shownSlash.backlinks, []);

    // (b) The bare exact id DOES return its real backlinks — proving the exact-match path itself
    // is unaffected by the trailing-slash guard.
    const shownBare = await linkShow(dir, ["tasks"]);
    assert.equal(shownBare.backlink_count, 1);
    assert.deepEqual(shownBare.backlinks, [{ from: "citer-of-bare-tasks", text: "the tasks doc itself" }]);

    // (c) `link list --to tasks/` still prefix-matches the tasks/* family — and, being a strict
    // string-prefix rule, does NOT also sweep in the bare 'tasks' doc's edge.
    const listed = await linkList(dir, ["--to", "tasks/"]);
    assert.equal(listed.count, 1);
    assert.deepEqual(listed.edges, [{ from: "citer-of-tasks-a", to: "tasks/a", text: "a task" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list --to <id>: exact match only, not a prefix", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, ["--to", "tasks/a"]);
    assert.equal(result.count, 1);
    assert.deepEqual(result.edges, [{ from: "roadmap-items/x", to: "tasks/a", text: "contains" }]);
  } finally {
    await cleanup();
  }
});

test("link list --to (repeatable): union (OR) across repeats, not AND", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, ["--to", "tasks/a", "--to", "ghost"]);
    assert.equal(result.count, 2);
    const tos = (result.edges as { to: string }[]).map((e) => e.to).sort();
    assert.deepEqual(tos, ["ghost", "tasks/a"]);
  } finally {
    await cleanup();
  }
});

test("link list --from and --to together: AND, not union", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    // roadmap-items/x -> tasks/a exists; tasks/a -> tasks/b exists (x2); tasks/a -> ghost exists.
    // Restricting to from=tasks/ AND to=tasks/b must exclude the roadmap-items/x edge entirely.
    const result = await linkList(dir, ["--from", "tasks/", "--to", "tasks/b"]);
    assert.equal(result.count, 2);
    const edges = result.edges as { from: string; to: string }[];
    assert.ok(edges.every((e) => e.from === "tasks/a" && e.to === "tasks/b"));
  } finally {
    await cleanup();
  }
});

test("link list --text: exact match only; a zero-match result carries a near-miss hint naming the texts present (scoped to the same --from/--to)", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const exact = await linkList(dir, ["--text", "contains"]);
    assert.equal(exact.count, 1);

    const substring = await linkList(dir, ["--text", "contain"]);
    assert.equal(substring.count, 0);
    const help = substring.help as string[];
    assert.ok(
      help.some((h) => /no links matched --text 'contain'/.test(h) && /link texts present here:/.test(h)),
      `expected a near-miss hint, got: ${JSON.stringify(help)}`,
    );
    // The whole-bundle near-miss hint names every distinct text present.
    assert.ok(help.some((h) => /'contains'/.test(h) && /'first'/.test(h) && /'second'/.test(h) && /'dangling'/.test(h)));

    // Scoped near-miss: restricting --to tasks/b first, the hint must name ONLY texts present
    // within that scope (first/second), not the whole bundle's 'contains'/'dangling'.
    const scoped = await linkList(dir, ["--to", "tasks/b", "--text", "nope"]);
    assert.equal(scoped.count, 0);
    const scopedHelp = scoped.help as string[];
    assert.ok(scopedHelp.some((h) => /'first'/.test(h) && /'second'/.test(h) && !/'contains'/.test(h)));
  } finally {
    await cleanup();
  }
});

test("link list: per-literal-link counting — two differently-worded links between the SAME from/to are TWO rows", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, ["--from", "tasks/a", "--to", "tasks/b"]);
    assert.equal(result.count, 2);
    assert.deepEqual((result.edges as { text: string }[]).map((e) => e.text).sort(), ["first", "second"]);
  } finally {
    await cleanup();
  }
});

test("link list: dangling edges (target has no document) are included", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, ["--to", "ghost"]);
    assert.equal(result.count, 1);
    assert.deepEqual(result.edges, [{ from: "tasks/a", to: "ghost", text: "dangling" }]);
  } finally {
    await cleanup();
  }
});

test("link list --limit: caps the returned rows; count stays the true total; a truncated result carries a --limit 0 help hint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, { id: "hub", frontmatter: { type: "T", timestamp: OLD_TS }, body: "" });
    let body = "";
    for (let i = 0; i < 5; i++) {
      await writeDoc(bundle, { id: `t${i}`, frontmatter: { type: "T", timestamp: OLD_TS }, body: "" });
      body += `[to t${i}](t${i}.md)\n`;
    }
    await writeDoc(bundle, { id: "hub", frontmatter: { type: "T", timestamp: OLD_TS }, body });

    const result = await linkList(dir, ["--limit", "2"]);
    assert.equal(result.count, 5, "count is the true total");
    assert.equal((result.edges as unknown[]).length, 2, "rows are capped");
    assert.equal(result.shown, 2);
    const help = result.help as string[];
    assert.ok(help.some((h) => /showing 2 of 5/.test(h) && /--limit 0/.test(h)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list --limit 0: unlimited (no cap, no truncation help)", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, ["--limit", "0"]);
    assert.equal(result.count, 4);
    assert.equal((result.edges as unknown[]).length, 4);
    assert.equal(result.shown, undefined);
  } finally {
    await cleanup();
  }
});

test("link list --text '' (empty/blank value): USAGE error, exit 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => link(["list", "--text", "  ", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list --from '' (empty/blank value): USAGE error, exit 2 — never silently matches nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => link(["list", "--from", "  ", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list --to '' (empty/blank value): USAGE error, exit 2 — never silently matches nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => link(["list", "--to", "", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list --from/--to: whitespace is trimmed off a real value (not just detected as blank)", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const result = await linkList(dir, ["--to", "  tasks/a  "]);
    assert.equal(result.count, 1);
    assert.deepEqual(result.edges, [{ from: "roadmap-items/x", to: "tasks/a", text: "contains" }]);
  } finally {
    await cleanup();
  }
});

test("link list resolves .md convenience before exact core filtering, preserving distinct canonical ids", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-id-test-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "hub",
      frontmatter: { type: "T", timestamp: OLD_TS },
      body: "[plain](x.md) [literal](x.md.md)",
    });
    await writeDoc(bundle, { id: "x", frontmatter: { type: "T", timestamp: OLD_TS }, body: "" });
    await writeDoc(bundle, { id: "x.md", frontmatter: { type: "T", timestamp: OLD_TS }, body: "" });

    assert.deepEqual((await linkList(dir, ["--to", "x"])).edges, [
      { from: "hub", to: "x", text: "plain" },
    ]);
    assert.deepEqual((await linkList(dir, ["--to", "x.md"])).edges, [
      { from: "hub", to: "x.md", text: "literal" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list --text zero-match over --remote: exactly ONE round trip (2 HTTP requests: list + read-many), not two round trips (4) — the near-miss hint reuses the already-fetched scoped edges rather than re-scanning", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const handle: ServerHandle = await serve({ bundle: { root: dir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    // `globalThis.fetch` is what the CLI's --remote transport (bundle.ts's `wrapTransportErrors`)
    // calls at request time — a plain mutable global, unlike a frozen ESM namespace export, so
    // wrapping it for the duration of one test (and restoring it in `finally`) is safe here.
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      requestCount++;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      let out = "";
      await link(["list", "--text", "no-such-text", "--remote", url, "--json"], { stdout: (s) => (out += s) });
      const result = JSON.parse(out) as Record<string, unknown>;
      assert.equal(result.count, 0);
      assert.ok((result.help as string[])?.some((h) => /no links matched --text 'no-such-text'/.test(h)));
    } finally {
      globalThis.fetch = originalFetch;
      await handle.close();
    }
    // ONE queryEdges call == ONE query()/readMany round trip == 2 HTTP requests (GET the doc-id
    // list, then POST the batch read). The pre-fix double-scan would show 4.
    assert.equal(requestCount, 2, "a zero-match --text query must cost exactly one round trip, not two");
  } finally {
    await cleanup();
  }
});

test("link list --limit not-a-number: USAGE error, exit 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => link(["list", "--limit", "abc", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list on an empty bundle: count 0, empty edges array, no error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    await initBundle(dir);
    const result = await linkList(dir, []);
    assert.equal(result.count, 0);
    assert.deepEqual(result.edges, []);
    assert.equal(result.help, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("link list over --remote: same result set as --dir against a live serve() (client-side over the existing readMany batch, no wire change)", async () => {
  const { dir, cleanup } = await makeEdgeFixtureBundle();
  try {
    const handle: ServerHandle = await serve({ bundle: { root: dir }, port: 0 });
    const url = `http://${handle.host}:${handle.port}`;
    try {
      const local = await linkList(dir, ["--to", "tasks/"]);
      let out = "";
      await link(["list", "--to", "tasks/", "--remote", url, "--json"], { stdout: (s) => (out += s) });
      const remote = JSON.parse(out);
      assert.deepEqual(remote, local);
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup();
  }
});

test("link list unknown subcommand message names 'list' among the known subcommands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentstate-lite-link-list-test-"));
  try {
    await initBundle(dir);
    await assert.rejects(
      () => link(["bogus", "--dir", dir, "--json"], { stdout: () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.match(err.message, /add\|show\|list/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── probe-help-surface-fixes finding 3: `link --help` / `link add --help` / `link show --help` /
// `link list --help` no longer print the identical full block ──────────────────────────────────
//
// Cold-start usability probe (2026-07-19): all four calls printed byte-identical text — three
// distinct calls yielding zero new information. Sliced per-subcommand (mirrors `doc`'s existing
// family-index + focused-verb-help split): bare `link`/`link --help` stays a short INDEX pointing
// at `link <verb> --help`; each verb gets its own focused help. Every previously-documented fact
// must still be reachable SOMEWHERE across the four surfaces.

async function captureHelp(argv: string[]): Promise<string> {
  let out = "";
  await link(argv, { stdout: (s) => (out += s) });
  return out;
}

test("link --help / link add --help / link show --help / link list --help are four DISTINCT texts, not one repeated block", async () => {
  const [bare, add, show, list] = await Promise.all([
    captureHelp(["--help"]),
    captureHelp(["add", "--help"]),
    captureHelp(["show", "--help"]),
    captureHelp(["list", "--help"]),
  ]);
  const texts = { bare, add, show, list };
  const entries = Object.entries(texts);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [nameA, textA] = entries[i]!;
      const [nameB, textB] = entries[j]!;
      assert.notEqual(textA, textB, `'${nameA}' help and '${nameB}' help must not be byte-identical`);
    }
  }
});

test("link --help (bare) is a short INDEX: names all three subcommands and points at 'link <verb> --help', without the full option manuals", async () => {
  const text = await captureHelp(["--help"]);
  assert.match(text, /link add\b/);
  assert.match(text, /link show\b/);
  assert.match(text, /link list\b/);
  assert.match(text, /link <verb> --help/);
  // The full-detail-only facts (a specific verb's own flags) are NOT in the index.
  assert.doesNotMatch(text, /--keep-timestamp/, "the index must not carry link add's own flag detail");
  assert.doesNotMatch(text, /--from <id\|prefix\/>/, "the index must not carry link list's own flag detail");
});

test("link add --help: focused on 'add' — carries its own flags (--text, --keep-timestamp, --actor) and the idempotency + graph-lint facts, but not link list's --from/--to/--limit-100 semantics", async () => {
  const text = await captureHelp(["add", "--help"]);
  assert.match(text, /link add —/);
  assert.match(text, /--keep-timestamp/);
  assert.match(text, /--actor <name>/);
  assert.match(text, /Idempotent: re-adding the same target/);
  assert.match(text, /Graph lint:/);
  assert.match(text, /LINK_TARGET_ABSENT/, "link add help preserves the missing-target receipt signal");
  assert.match(text, /--remote link-add receipt never carries this signal/);
  assert.doesNotMatch(text, /link show —/);
  assert.doesNotMatch(text, /link list —/);
  assert.doesNotMatch(text, /--from <id\|prefix\/>/, "link add help must not carry link list's flags");
});

test("link show --help: focused on 'show' — carries --text/--limit's per-concept semantics and the outbound/backlink facts, but not link add's idempotency/graph-lint prose or link list's --from/--to", async () => {
  const text = await captureHelp(["show", "--help"]);
  assert.match(text, /link show —/);
  assert.match(text, /outbound links/);
  assert.match(text, /backlinks/);
  assert.match(text, /--limit <n>/);
  assert.doesNotMatch(text, /link add —/);
  assert.doesNotMatch(text, /link list —/);
  assert.doesNotMatch(text, /Idempotent: re-adding the same target/, "link show help must not carry link add's idempotency prose");
  assert.doesNotMatch(text, /--from <id\|prefix\/>/, "link show help must not carry link list's flags");
});

test("link list --help: focused on 'list' — carries the whole-bundle-scan facts (--from/--to prefix+union+AND rule, dangling edges included), but not link add's/link show's own option detail", async () => {
  const text = await captureHelp(["list", "--help"]);
  assert.match(text, /link list —/);
  assert.match(text, /--from <id\|prefix\/>/);
  assert.match(text, /--to <id\|prefix\/>/);
  assert.match(text, /trailing-slash prefix/);
  assert.match(text, /Dangling edges/);
  assert.doesNotMatch(text, /link add —/);
  assert.doesNotMatch(text, /link show —/);
  assert.doesNotMatch(text, /--keep-timestamp/, "link list help must not carry link add's flags");
});

test("every previously-documented fact from the old single combined block is reachable SOMEWHERE across the four help surfaces (nothing silently dropped by the slice)", async () => {
  const combined = [
    await captureHelp(["--help"]),
    await captureHelp(["add", "--help"]),
    await captureHelp(["show", "--help"]),
    await captureHelp(["list", "--help"]),
  ].join("\n---\n");

  const mustAppearSomewhere = [
    /Idempotent: re-adding the same target with the same exact display text is a no-op/,
    /Different text to the same target is a\s+distinct semantic edge and is added/,
    /Graph lint:/,
    /a mismatch or a same-spelling-different-case near miss attaches a 'warnings' array/,
    /An untyped --text \(no declared match, any casing\)\s+or a conventions-free bundle never warns/,
    /Queries the WHOLE bundle's derived edge list/,
    /a trailing-slash prefix \('tasks\/' matches every id starting with that/,
    /giving BOTH --from and --to ANDs them/,
    /Dangling edges \(a link to a doc that doesn't exist yet\) are\s+included/,
    /Filter outbound links AND backlinks to those whose text is EXACTLY <t>/,
    /Cap each of the outbound\/backlink lists \(default: 50; 0 = unlimited\)/,
    /Falls back to SUPERBEE_ACTOR \(or legacy AGENTSTATE_LITE_ACTOR\); an existing\s+link remains a true no-op/,
    /Cap the returned edge rows \(default: 100; 0 = unlimited\)/,
  ];
  for (const re of mustAppearSomewhere) {
    assert.match(combined, re, `expected this pre-slice fact to still be reachable somewhere: ${re}`);
  }
});
