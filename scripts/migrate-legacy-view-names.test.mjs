// Tests for scripts/migrate-legacy-view-names.mjs (Phase 2a of the legacy-deprecation path).
// Requires built dists (run through `npm run test:scripts` after a repo-root build; a missing
// core dist is built here as a fallback so the suite never manufactures phantom failures).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(repoRoot, "scripts", "migrate-legacy-view-names.mjs");
const CORE_DIST = path.join(repoRoot, "packages", "core", "dist", "index.js");

before(async () => {
  if (existsSync(CORE_DIST)) return;
  const npmCli = process.env.npm_execpath?.trim();
  if (!npmCli) throw new Error("packages/core/dist is missing and npm_execpath is unset — build from the repo root first");
  await execFileAsync(process.execPath, [npmCli, "run", "build", "-w", "@superbee/core"], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
});

// Dynamic imports so the `before` fallback build can run first.
const core = () => import(CORE_DIST);
const script = () => import(SCRIPT);

function isMissingDocument(id) {
  return (error) =>
    error instanceof Error &&
    error.code === "ENOENT" &&
    error.message === `no concept document '${id}'`;
}

function writeRawDoc(dir, relative, content) {
  const target = path.join(dir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * The full fixture matrix from the task spec plus the fix-round additions: a Page-typed valid
 * registration, a Page-typed non-registration doc WITHOUT a timestamp (raw-authored, F4), a
 * bridge-only View, a both-fields View, an access-only View, an invalid bridge value, a
 * NON-View doc with an own `bridge` field (F6 negative scope), a KNOWN PRIOR SHIPPED View
 * convention (the bridge-required form), and a Page-kind convention.
 */
async function makeFixtureBundle() {
  const { initBundle, writeDoc } = await core();
  const { loadPriorShippedViewConventions } = await script();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-fixture-"));
  const bundle = await initBundle(dir, { okfVersion: "0.1" });
  const T = "2026-07-01T00:00:00.000Z";
  await writeDoc(bundle, {
    id: "pages-registry/dash",
    frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", bridge: "bundle-read", timestamp: T },
    body: "A Page-typed VALID registration at a legacy location.\n",
  });
  // Raw-authored (external shape): Page-typed docs WITHOUT a usable timestamp in all three
  // spellings — absent, empty string, and bare YAML null. The engine write stamps each with the
  // current time, and the receipt must report every one (F4 + round-2 variant).
  writeRawDoc(
    dir,
    "notes/scratch-page.md",
    "---\ntype: Page\ntitle: Scratch\n---\nA Page-typed NON-registration doc (no entry, off-prefix, no timestamp).\n",
  );
  writeRawDoc(
    dir,
    "notes/empty-ts.md",
    '---\ntype: Page\ntitle: Empty timestamp\ntimestamp: ""\n---\nAn empty-string timestamp is unusable — stamping must be disclosed.\n',
  );
  writeRawDoc(
    dir,
    "notes/null-ts.md",
    "---\ntype: Page\ntitle: Null timestamp\ntimestamp:\n---\nA bare YAML null timestamp is unusable — stamping must be disclosed.\n",
  );
  await writeDoc(bundle, {
    id: "views-registry/pulse",
    frontmatter: { type: "View", title: "Pulse", entry: "views/pulse.html", bridge: "none", timestamp: T },
    body: "A bridge-only View.\n",
  });
  await writeDoc(bundle, {
    id: "views-registry/board",
    frontmatter: {
      type: "View",
      title: "Board",
      entry: "views/board.html",
      access: "bundle-read",
      bridge: "bundle-propose",
      timestamp: T,
    },
    body: "A both-fields View — access alone decides; bridge is dropped, never merged.\n",
  });
  await writeDoc(bundle, {
    id: "views-registry/roadmap",
    frontmatter: { type: "View", title: "Roadmap", entry: "views/roadmap.html", access: "bundle-read", timestamp: T },
    body: "An access-only View — untouched.\n",
  });
  await writeDoc(bundle, {
    id: "views-registry/weird",
    frontmatter: { type: "View", title: "Weird", entry: "views/weird.html", bridge: "write-everything", timestamp: T },
    body: "An invalid capability value — copied verbatim, warned, never fixed.\n",
  });
  // F6 negative scope: `bridge` is only the View kind's legacy spelling — a doc of any OTHER
  // type carrying an own `bridge` field is out of scope and must never be touched.
  await writeDoc(bundle, {
    id: "notes/bridge-note",
    frontmatter: { type: "Note", title: "Bridge note", bridge: "bundle-read", timestamp: T },
    body: "A Note about a bridge — not a View; the field is ordinary user data here.\n",
  });
  // The View convention as a KNOWN PRIOR SHIPPED form (the bridge-required one) — swaps silently.
  const priorForm = loadPriorShippedViewConventions()[0];
  await writeDoc(bundle, {
    id: "conventions/view",
    frontmatter: priorForm.frontmatter,
    body: priorForm.body,
  });
  await writeDoc(bundle, {
    id: "conventions/page",
    frontmatter: {
      type: "Convention",
      title: "Page",
      governs: "Page",
      path: "pages-registry/",
      fields: { required: ["title", "entry"], optional: ["description"], values: {}, terminal: {} },
      timestamp: T,
    },
    body: "# Page\n\nA convention teaching the dead legacy kind name.\n",
  });
  return { dir, bundle };
}

async function versionMap(bundle) {
  const { query, readDocVersioned } = await core();
  const docs = await query(bundle);
  const map = new Map();
  for (const doc of docs) map.set(doc.id, (await readDocVersioned(bundle, doc.id)).version);
  return map;
}

test("one run migrates the full fixture matrix in place; a second run reports zero changes", async () => {
  const { migrateBundle, loadCanonicalViewConvention } = await script();
  const { query, readDoc, readDocVersioned } = await core();
  const { dir, bundle } = await makeFixtureBundle();
  try {
    const untouchedBefore = (await versionMap(bundle)).get("views-registry/roadmap");
    const bridgeNoteBefore = (await readDocVersioned(bundle, "notes/bridge-note")).version;

    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.dry_run, false);
    assert.equal(receipt.types_flipped, 4, "every Page-typed doc flips, registration-valid or not");
    assert.equal(receipt.bridge_renamed, 3, "dash + pulse + weird");
    assert.equal(receipt.bridge_removed, 1, "board's shadowed bridge is dropped");
    assert.equal(receipt.timestamp_added, 3, "absent, empty-string, AND null timestamps are all REPORTED (F4)");
    assert.deepEqual(receipt.timestamp_added_docs, ["notes/empty-ts", "notes/null-ts", "notes/scratch-page"]);
    assert.equal(receipt.convention_swapped, "swapped", "a known prior shipped form swaps silently");
    assert.deepEqual(receipt.page_conventions_deleted, ["conventions/page"]);
    assert.deepEqual(receipt.skipped_docs, []);
    assert.equal(receipt.warnings.length, 1);
    assert.equal(receipt.warnings[0].id, "views-registry/weird");
    assert.match(receipt.warnings[0].warning, /copied verbatim/);

    // Zero Page types, zero own-bridge fields on View-typed docs — and NO file moves: ids stay put.
    assert.equal((await query(bundle, { type: "Page" })).length, 0);
    for (const doc of await query(bundle)) {
      if (doc.id === "notes/bridge-note") continue; // out of scope by design (F6)
      assert.ok(!Object.hasOwn(doc.frontmatter, "bridge"), `${doc.id} still carries own bridge`);
    }
    const dash = await readDoc(bundle, "pages-registry/dash");
    assert.equal(dash.frontmatter.type, "View");
    assert.equal(dash.frontmatter.access, "bundle-read");
    assert.equal(dash.frontmatter.entry, "pages/dash.html", "blob keys stay exactly where they are");
    for (const id of ["notes/scratch-page", "notes/empty-ts", "notes/null-ts"]) {
      const stamped = await readDoc(bundle, id);
      assert.equal(stamped.frontmatter.type, "View");
      assert.ok(
        typeof stamped.frontmatter.timestamp === "string" && stamped.frontmatter.timestamp.trim() !== "",
        `${id}: the engine stamped a usable timestamp — and the receipt said so`,
      );
    }
    const board = await readDoc(bundle, "views-registry/board");
    assert.equal(board.frontmatter.access, "bundle-read", "a leftover bridge can never widen access");
    const weird = await readDoc(bundle, "views-registry/weird");
    assert.equal(weird.frontmatter.access, "write-everything", "invalid values copy verbatim, never 'fixed'");

    // F6: the non-View doc with an own bridge field is byte/version-stable and keeps its field.
    const bridgeNote = await readDocVersioned(bundle, "notes/bridge-note");
    assert.equal(bridgeNote.version, bridgeNoteBefore, "a non-View doc with own bridge is never written");
    assert.equal(bridgeNote.doc.frontmatter.bridge, "bundle-read");
    assert.equal(bridgeNote.doc.frontmatter.type, "Note");

    // Convention swapped to THE canonical shipped content (single-sourced from the repo file).
    const canonical = loadCanonicalViewConvention();
    const swapped = await readDoc(bundle, "conventions/view");
    assert.deepEqual(swapped.frontmatter, canonical.frontmatter);
    assert.equal(swapped.body, canonical.body);
    await assert.rejects(() => readDoc(bundle, "conventions/page"), isMissingDocument("conventions/page"));

    // The access-only View was never written (same version token).
    assert.equal((await versionMap(bundle)).get("views-registry/roadmap"), untouchedBefore);

    // Idempotence: run 2 is all zeros and writes nothing (byte-identical version map).
    const beforeSecond = await versionMap(bundle);
    const second = await migrateBundle(bundle);
    assert.equal(second.types_flipped, 0);
    assert.equal(second.bridge_renamed, 0);
    assert.equal(second.bridge_removed, 0);
    assert.equal(second.timestamp_added, 0);
    assert.equal(second.convention_swapped, false);
    assert.deepEqual(second.page_conventions_deleted, []);
    assert.deepEqual(second.changed_docs, []);
    assert.deepEqual(second.warnings, []);
    assert.deepEqual(await versionMap(bundle), beforeSecond);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a competing write inside the CAS window is retried from a fresh read and converges", async () => {
  const { migrateBundle } = await script();
  const { readDoc, writeDocVersioned } = await core();
  const { dir, bundle } = await makeFixtureBundle();
  try {
    const target = "pages-registry/dash";
    const attempts = [];
    const receipt = await migrateBundle(bundle, {
      hooks: {
        beforeDocWrite: async (id, attempt) => {
          if (id !== target) return;
          attempts.push(attempt);
          if (attempt === 0) {
            // Competing writer lands between the migration's read and its CAS write.
            const current = await readDoc(bundle, target);
            await writeDocVersioned(bundle, {
              id: target,
              frontmatter: current.frontmatter,
              body: "competing edit\n",
            });
          }
        },
      },
    });
    assert.deepEqual(attempts, [0, 1], "exactly one conflict, one retry");
    const dash = await readDoc(bundle, target);
    assert.equal(dash.frontmatter.type, "View", "the rename still lands");
    assert.equal(dash.frontmatter.access, "bundle-read");
    assert.equal(dash.body, "competing edit\n", "the competing writer's change is preserved, not clobbered");
    assert.equal(receipt.types_flipped, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dry-run writes nothing and reports exactly what a real run would do", async () => {
  const { migrateBundle } = await script();
  const { query, readDoc } = await core();
  const { dir, bundle } = await makeFixtureBundle();
  try {
    const before = await versionMap(bundle);
    const receipt = await migrateBundle(bundle, { dryRun: true });
    assert.equal(receipt.dry_run, true);
    assert.equal(receipt.types_flipped, 4);
    assert.equal(receipt.bridge_renamed, 3);
    assert.equal(receipt.bridge_removed, 1);
    assert.equal(receipt.timestamp_added, 3, "dry-run projects absent, empty, AND null stampings too (F4)");
    assert.deepEqual(receipt.timestamp_added_docs, ["notes/empty-ts", "notes/null-ts", "notes/scratch-page"]);
    assert.equal(receipt.convention_swapped, "would_swap");
    assert.deepEqual(receipt.page_conventions_deleted, ["conventions/page"]);
    assert.equal(receipt.warnings.length, 1);

    assert.deepEqual(await versionMap(bundle), before, "dry-run must not write a byte");
    assert.equal((await query(bundle, { type: "Page" })).length, 4);
    assert.equal((await readDoc(bundle, "conventions/page")).frontmatter.governs, "Page");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F1: a malformed Page-shaped doc never crashes a run — receipt always lands, deletion stays blocked", async () => {
  const { migrateBundle, loadPriorShippedViewConventions } = await script();
  const { initBundle, writeDoc, readDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-broken-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "pages-registry/ok",
      frontmatter: { type: "Page", title: "OK", entry: "pages/ok.html", bridge: "none", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "the readable sibling\n",
    });
    const priorForm = loadPriorShippedViewConventions()[0];
    await writeDoc(bundle, { id: "conventions/view", frontmatter: priorForm.frontmatter, body: priorForm.body });
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: { type: "Convention", title: "Page", governs: "Page", path: "pages-registry/" },
      body: "# Page\n",
    });
    // The reviewer's fixture shape: raw Page-shaped doc with an unterminated YAML flow sequence.
    const brokenRaw = "---\ntype: Page\ntitle: Broken\nentry: [unterminated\n---\nnever parses\n";
    writeRawDoc(dir, "pages-registry/broken.md", brokenRaw);

    // Dry-run: honest — reports the skip, plans NO Page-convention deletion.
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.skipped_docs.length, 1);
    assert.equal(dry.skipped_docs[0].id, "pages-registry/broken");
    assert.deepEqual(dry.page_conventions_deleted, [], "an unreadable doc blocks the deletion plan");
    assert.ok(dry.warnings.some((w) => w.id === "pages-registry/broken" && /unreadable/.test(w.warning)));
    assert.ok(dry.warnings.some((w) => w.id === "conventions/page" && /kept/.test(w.warning)));

    // REAL run: completes with a receipt (the pre-fix crash was the post-write re-query), the
    // readable sibling migrates, the broken doc's bytes are untouched, the Page convention stays.
    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.types_flipped, 1);
    assert.equal(receipt.skipped_docs.length, 1, "skips are DEDUPED across every scan");
    assert.equal(receipt.convention_swapped, "swapped");
    assert.deepEqual(receipt.page_conventions_deleted, []);
    assert.ok(receipt.warnings.some((w) => w.id === "conventions/page" && /kept/.test(w.warning)));
    assert.equal((await readDoc(bundle, "pages-registry/ok")).frontmatter.type, "View");
    assert.equal((await readDoc(bundle, "conventions/page")).frontmatter.governs, "Page");
    assert.equal(await readFile(path.join(dir, "pages-registry", "broken.md"), "utf8"), brokenRaw);

    // And a second run still converges without a crash.
    const second = await migrateBundle(bundle);
    assert.equal(second.types_flipped, 0);
    assert.deepEqual(second.page_conventions_deleted, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F2: a non-bundle directory is refused before any write", async () => {
  const { migrateBundle } = await script();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-nonbundle-"));
  try {
    const raw = "---\ntype: Page\ntitle: Loose\n---\nA Page-typed file in a plain directory.\n";
    writeRawDoc(dir, "loose-page.md", raw);

    await assert.rejects(() => migrateBundle({ root: dir }), /not a bundle root/);

    await assert.rejects(
      () => execFileAsync(process.execPath, [SCRIPT, "--dir", dir], { cwd: repoRoot }),
      (err) => err.code === 2 && /not a bundle root/.test(err.stderr),
    );
    assert.equal(await readFile(path.join(dir, "loose-page.md"), "utf8"), raw, "nothing was written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F3: a customized View convention is never silently destroyed", async () => {
  const { migrateBundle, loadCanonicalViewConvention } = await script();
  const { initBundle, writeDoc, readDoc, readDocVersioned } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-custom-"));
  const exportLeftover = `${dir.replace(/[\\/]+$/, "")}.pre-swap.conventions-view.md`;
  try {
    const bundle = await initBundle(dir);
    const customBody = "# View\n\nRECOVERY-CRITICAL local operating notes that exist nowhere else.\n";
    await writeDoc(bundle, {
      id: "conventions/view",
      frontmatter: {
        type: "Convention",
        title: "View",
        governs: "View",
        path: "views-registry/",
        fields: { required: ["title", "entry", "access", "owner"], optional: [], values: {}, terminal: {} },
        timestamp: "2026-07-01T00:00:00.000Z",
      },
      body: customBody,
    });
    const before = (await readDocVersioned(bundle, "conventions/view")).version;

    // Dry-run, default: reports the skip decision.
    const dryDefault = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dryDefault.convention_swapped, "skipped_customized");
    // Dry-run, with the flag: reports the swap AND the export path it would use.
    const dryFlag = await migrateBundle(bundle, { dryRun: true, overwriteCustomConventions: true });
    assert.equal(dryFlag.convention_swapped, "would_swap_customized");
    assert.equal(typeof dryFlag.convention_export, "string");
    assert.ok(!existsSync(dryFlag.convention_export), "dry-run writes no export file");

    // Real run, default: skip + warning, content untouched.
    const skipped = await migrateBundle(bundle);
    assert.equal(skipped.convention_swapped, "skipped_customized");
    assert.ok(skipped.warnings.some((w) => w.id === "conventions/view" && /customized/.test(w.warning)));
    assert.equal((await readDocVersioned(bundle, "conventions/view")).version, before, "never written by default");

    // Real run, explicit flag: export first, then swap; receipt names the export path.
    const swapped = await migrateBundle(bundle, { overwriteCustomConventions: true });
    assert.equal(swapped.convention_swapped, "swapped_customized");
    assert.equal(typeof swapped.convention_export, "string");
    const exported = await readFile(swapped.convention_export, "utf8");
    // The export must be a REAL OKF markdown doc (frontmatter + body), re-promotable as-is —
    // not a serialized object wrapper. Round-trip it through THE one parser to prove it.
    const { parseMarkdown } = await core();
    const reparsed = parseMarkdown(exported, "export.md");
    assert.equal(reparsed.frontmatter.governs, "View");
    assert.deepEqual(reparsed.frontmatter.fields.required, ["title", "entry", "access", "owner"]);
    assert.equal(reparsed.body, customBody, "the destroyed body survives byte-for-byte in the export");
    const now = await readDoc(bundle, "conventions/view");
    assert.deepEqual(now.frontmatter, loadCanonicalViewConvention().frontmatter);

    // Idempotence: a further run is a no-op.
    const third = await migrateBundle(bundle, { overwriteCustomConventions: true });
    assert.equal(third.convention_swapped, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(exportLeftover, { force: true });
  }
});

// Round-4 finding: a non-Convention doc parked on conventions/view was invisible to the
// type-filtered planning scan — dry-run said would_create, the CAS create was refused SILENTLY,
// and the Page convention was still deleted, leaving migrated View docs ungoverned. Both
// occupant shapes (wrong type, wrong governs) must share one rule: visible at plan time, the
// occupied outcome in the receipt, and the Page convention KEPT with the reason.
test("an occupant on conventions/view blocks creation AND preserves the Page convention — both occupant shapes", async () => {
  const { migrateBundle } = await script();
  const { initBundle, writeDoc, readDoc, readDocVersioned } = await core();
  const occupants = [
    {
      label: "non-Convention occupant (type: Note)",
      frontmatter: { type: "Note", title: "Parked", timestamp: "2026-07-01T00:00:00.000Z" },
    },
    {
      label: "Convention governing something else (governs: Term)",
      frontmatter: { type: "Convention", title: "Term", governs: "Term", timestamp: "2026-07-01T00:00:00.000Z" },
    },
  ];
  for (const occupant of occupants) {
    const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-occupied-"));
    try {
      const bundle = await initBundle(dir);
      await writeDoc(bundle, { id: "conventions/view", frontmatter: occupant.frontmatter, body: "parked content\n" });
      await writeDoc(bundle, {
        id: "conventions/page",
        frontmatter: { type: "Convention", title: "Page", governs: "Page", path: "pages-registry/" },
        body: "# Page\n",
      });
      await writeDoc(bundle, {
        id: "pages-registry/dash",
        frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", timestamp: "2026-07-01T00:00:00.000Z" },
        body: "a legacy registration\n",
      });
      const occupantBefore = (await readDocVersioned(bundle, "conventions/view")).version;

      // Dry-run projects the SAME decision as the real run — occupied, never would_create.
      const dry = await migrateBundle(bundle, { dryRun: true });
      assert.equal(dry.convention_swapped, "skipped_occupied", occupant.label);
      assert.deepEqual(dry.page_conventions_deleted, [], occupant.label);
      assert.ok(
        dry.warnings.some((w) => w.id === "conventions/view" && /left untouched/.test(w.warning)),
        occupant.label,
      );
      assert.ok(
        dry.warnings.some((w) => w.id === "conventions/page" && /ungoverned/.test(w.warning)),
        `${occupant.label}: dry-run must state WHY the Page convention is kept`,
      );

      // Real run: types still flip; occupant untouched; Page convention KEPT with the reason.
      const receipt = await migrateBundle(bundle);
      assert.equal(receipt.types_flipped, 1, occupant.label);
      assert.equal(receipt.convention_swapped, "skipped_occupied", occupant.label);
      assert.deepEqual(receipt.page_conventions_deleted, [], occupant.label);
      assert.ok(
        receipt.warnings.some((w) => w.id === "conventions/view" && /left untouched/.test(w.warning)),
        occupant.label,
      );
      assert.ok(
        receipt.warnings.some((w) => w.id === "conventions/page" && /ungoverned/.test(w.warning)),
        `${occupant.label}: the receipt must state WHY the Page convention is kept`,
      );
      assert.equal((await readDoc(bundle, "pages-registry/dash")).frontmatter.type, "View", occupant.label);
      assert.equal((await readDoc(bundle, "conventions/page")).frontmatter.governs, "Page", occupant.label);
      const after = await readDocVersioned(bundle, "conventions/view");
      assert.equal(after.version, occupantBefore, `${occupant.label}: the occupant is never written`);
      assert.equal(after.doc.frontmatter.type, occupant.frontmatter.type, occupant.label);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// ── REQUIRED POST-REMOVAL PIN (tasks/remove-legacy-page-bridge-support, recorded by Brian) ─────
// Phase 3 removed the runtime's acceptance of the legacy names; the migration script is now the
// ONLY road from legacy stock to a working bundle, so it MUST keep working against the removed
// world. This test runs the real CLI entrypoint (a subprocess, not an in-process import) against
// a full legacy fixture — Page-typed registration doc + own-bridge field + the OLD
// bridge-required shipped convention — and proves the migrated output is what the CURRENT
// runtime accepts (core's own post-removal predicates). The script imports only generic engine
// primitives and its own literals; this pin keeps it that way.
test("POST-REMOVAL PIN: the CLI-invoked migration script fully migrates a legacy fixture, and the migrated docs satisfy the current runtime's predicates", async () => {
  const { initBundle, writeDoc, readDoc, query } = await core();
  const { loadPriorShippedViewConventions, loadCanonicalViewConvention } = await script();
  // Core's CURRENT (post-removal) recognition — the same predicates the ui launcher consumes.
  const { parseRegistration, resolveDeclaredAccess } = await import(
    path.join(repoRoot, "packages", "core", "dist", "page.js")
  );
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-post-removal-"));
  try {
    const bundle = await initBundle(dir);
    const T = "2026-07-01T00:00:00.000Z";
    await writeDoc(bundle, {
      id: "pages-registry/dash",
      frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", bridge: "bundle-read", timestamp: T },
      body: "A Page-typed registration with the legacy capability spelling.\n",
    });
    // The OLD bridge-required shipped convention (prior form #1) — swaps to the canonical one.
    const bridgeRequired = loadPriorShippedViewConventions()[0];
    assert.deepEqual(
      bridgeRequired.frontmatter.fields.required,
      ["title", "entry", "bridge"],
      "prior form #1 is the bridge-required convention this pin needs",
    );
    await writeDoc(bundle, { id: "conventions/view", frontmatter: bridgeRequired.frontmatter, body: bridgeRequired.body });

    // Pre-migration, the CURRENT runtime rejects/downgrades the stock (this is the removal).
    const before = await readDoc(bundle, "pages-registry/dash");
    assert.equal(parseRegistration(before.id, before.frontmatter), null, "a Page-typed doc no longer registers");
    assert.equal(resolveDeclaredAccess(before.frontmatter), "none", "a bridge-only doc resolves none");

    // Run the REAL CLI entrypoint, exactly as the status finding tells the user to.
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "--dir", dir], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const receipt = JSON.parse(stdout).bundles[0];
    assert.equal(receipt.types_flipped, 1);
    assert.equal(receipt.bridge_renamed, 1);
    assert.equal(receipt.convention_swapped, "swapped", "the old bridge-required convention swapped");

    // Post-migration, the SAME docs satisfy the current runtime: type flipped, field renamed,
    // convention swapped to the canonical (access-required) form — in place, ids unmoved.
    const after = await readDoc(bundle, "pages-registry/dash");
    assert.equal(after.frontmatter.type, "View");
    assert.equal(after.frontmatter.access, "bundle-read");
    assert.equal(Object.hasOwn(after.frontmatter, "bridge"), false);
    const registration = parseRegistration(after.id, after.frontmatter);
    assert.ok(registration, "the migrated doc registers under the post-removal grammar");
    assert.equal(registration.entry, "pages/dash.html", "the legacy LOCATION is kept and accepted");
    assert.equal(resolveDeclaredAccess(after.frontmatter), "bundle-read", "the renamed field grants what bridge no longer can");
    const canonical = loadCanonicalViewConvention();
    const swapped = await readDoc(bundle, "conventions/view");
    assert.deepEqual(swapped.frontmatter, canonical.frontmatter);
    assert.deepEqual(canonical.frontmatter.fields.required, ["title", "entry", "access"]);
    assert.equal((await query(bundle, { type: "Page" })).length, 0, "zero Page-typed stock remains");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Review F2: shipped-teaching refresh + superseded legacy reference retirement ──────────────
test("F2: a full historical install's teaching artifacts migrate too — page-authoring reference retired (replacement created), historical review-request refreshed; second run is a no-op", async () => {
  const { migrateBundle, loadCanonicalViewReference, loadCanonicalReviewRequestConvention, loadPriorShippedReviewRequestConventions } =
    await script();
  const { initBundle, writeDoc, readDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-teaching-"));
  try {
    const bundle = await initBundle(dir);
    const T = "2026-07-01T00:00:00.000Z";
    await writeDoc(bundle, {
      id: "pages-registry/dash",
      frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", bridge: "bundle-read", timestamp: T },
      body: "Legacy stock.\n",
    });
    // The HISTORICAL shipped teaching artifacts (frozen snapshots — Page taught as current).
    const priorRR = loadPriorShippedReviewRequestConventions()[0];
    await writeDoc(bundle, { id: "conventions/review-request", frontmatter: priorRR.frontmatter, body: priorRR.body });
    await writeDoc(bundle, {
      id: "references/page-authoring-v0",
      frontmatter: { type: "Reference", title: "Bundle Page authoring — bridge v0", protocol: "v0", timestamp: T },
      body: "# Bundle Page authoring — bridge v0\n\nTeaches type: Page and bridge: as the live contract.\n",
    });

    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.review_request_swapped, "swapped", "the known historical form refreshes");
    assert.equal(receipt.reference_created, true, "the replacement reference is created from the canonical file");
    assert.deepEqual(receipt.legacy_references_deleted, ["references/page-authoring-v0"]);

    // Engine writes stamp a timestamp when the canonical file omits one — content equality
    // ignores it (the same rule the script's own classification applies).
    const minusTimestamp = ({ timestamp: _t, ...rest }) => rest;
    await assert.rejects(
      () => readDoc(bundle, "references/page-authoring-v0"),
      isMissingDocument("references/page-authoring-v0"),
    );
    const replacement = await readDoc(bundle, "references/view-authoring-v0");
    const canonicalRef = loadCanonicalViewReference();
    assert.deepEqual(minusTimestamp(replacement.frontmatter), minusTimestamp(canonicalRef.frontmatter));
    assert.equal(replacement.body, canonicalRef.body);
    const rr = await readDoc(bundle, "conventions/review-request");
    const canonicalRR = loadCanonicalReviewRequestConvention();
    assert.deepEqual(minusTimestamp(rr.frontmatter), minusTimestamp(canonicalRR.frontmatter));
    assert.equal(rr.body, canonicalRR.body);

    // Idempotence: run 2 reports nothing for the teaching artifacts.
    const second = await migrateBundle(bundle);
    assert.equal(second.review_request_swapped, false);
    assert.equal(second.reference_created, false);
    assert.deepEqual(second.legacy_references_deleted, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F2 guards: a customized review-request is never touched; an unreadable doc blocks retirement; a non-Reference occupant on the replacement id refuses it", async () => {
  const { migrateBundle } = await script();
  const { initBundle, writeDoc, readDoc } = await core();
  const T = "2026-07-01T00:00:00.000Z";

  // Guard 1: customized review-request — left untouched, warned.
  const dirA = await mkdtemp(path.join(tmpdir(), "aslite-migrate-teach-custom-"));
  try {
    const bundle = await initBundle(dirA);
    await writeDoc(bundle, {
      id: "conventions/review-request",
      frontmatter: { type: "Convention", title: "Review Request", governs: "Review Request", fields: { required: ["title"], optional: [] }, timestamp: T },
      body: "My own review workflow — customized.\n",
    });
    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.review_request_swapped, "skipped_customized");
    assert.ok(receipt.warnings.some((w) => w.id === "conventions/review-request" && /customized/.test(w.warning)));
    assert.equal((await readDoc(bundle, "conventions/review-request")).body, "My own review workflow — customized.\n");
  } finally {
    await rm(dirA, { recursive: true, force: true });
  }

  // Guard 2: an unreadable doc in the bundle blocks the retirement (it could hide stock).
  const dirB = await mkdtemp(path.join(tmpdir(), "aslite-migrate-teach-skip-"));
  try {
    const bundle = await initBundle(dirB);
    await writeDoc(bundle, {
      id: "references/page-authoring-v0",
      frontmatter: { type: "Reference", title: "Bundle Page authoring — bridge v0", protocol: "v0", timestamp: T },
      body: "Legacy teaching.\n",
    });
    writeRawDoc(dirB, "notes/broken.md", "---\ntype: Note\ntitle: Broken\nentry: [unterminated\n---\nnever parses\n");
    const receipt = await migrateBundle(bundle);
    assert.ok(receipt.skipped_docs.length > 0, "the malformed doc was skipped");
    assert.deepEqual(receipt.legacy_references_deleted, [], "retirement is blocked by skipped docs");
    assert.ok(await readDoc(bundle, "references/page-authoring-v0"), "the legacy reference is kept");
    assert.ok(receipt.warnings.some((w) => w.id === "references/page-authoring-v0" && /kept/.test(w.warning)));
  } finally {
    await rm(dirB, { recursive: true, force: true });
  }

  // Guard 3: a non-Reference occupant on the replacement id refuses retirement — never delete
  // the teaching without its replacement in place.
  const dirC = await mkdtemp(path.join(tmpdir(), "aslite-migrate-teach-occupied-"));
  try {
    const bundle = await initBundle(dirC);
    await writeDoc(bundle, {
      id: "references/page-authoring-v0",
      frontmatter: { type: "Reference", title: "Bundle Page authoring — bridge v0", protocol: "v0", timestamp: T },
      body: "Legacy teaching.\n",
    });
    await writeDoc(bundle, {
      id: "references/view-authoring-v0",
      frontmatter: { type: "Note", title: "Squatter", timestamp: T },
      body: "Not a Reference.\n",
    });
    const receipt = await migrateBundle(bundle);
    assert.deepEqual(receipt.legacy_references_deleted, []);
    assert.ok(await readDoc(bundle, "references/page-authoring-v0"), "the legacy reference is kept");
    assert.equal((await readDoc(bundle, "references/view-authoring-v0")).frontmatter.type, "Note", "the occupant is untouched");
    assert.ok(receipt.warnings.some((w) => w.id === "references/view-authoring-v0" && /refused/.test(w.warning)));
  } finally {
    await rm(dirC, { recursive: true, force: true });
  }
});

// ── Round-2 P1: the known transitional view-authoring reference refreshes at its renamed id ────
test("round-2 P1: a KNOWN shipped transitional references/view-authoring-v0 refreshes to the canonical; customized is untouched; unreadable stock blocks the refresh", async () => {
  const { migrateBundle, loadCanonicalViewReference, loadPriorShippedViewAuthoringReferences } = await script();
  const { initBundle, writeDoc, readDoc } = await core();
  const priorForms = loadPriorShippedViewAuthoringReferences();
  const transitional = priorForms[priorForms.length - 1];

  // Refresh: the mid-vintage form swaps to the canonical under CAS; a second run is a no-op.
  const dirA = await mkdtemp(path.join(tmpdir(), "aslite-migrate-midvintage-"));
  try {
    const bundle = await initBundle(dirA);
    await writeDoc(bundle, { id: "references/view-authoring-v0", frontmatter: transitional.frontmatter, body: transitional.body });
    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.reference_refreshed, "swapped");
    const canonical = loadCanonicalViewReference();
    const after = await readDoc(bundle, "references/view-authoring-v0");
    assert.equal(after.body, canonical.body);
    assert.ok(!/migration window/.test(after.body), "the transitional teaching is gone");
    const second = await migrateBundle(bundle);
    assert.equal(second.reference_refreshed, false, "idempotent — the canonical form classifies current");
  } finally {
    await rm(dirA, { recursive: true, force: true });
  }

  // Customized: never touched, warned — consistent with every other customized surface.
  const dirB = await mkdtemp(path.join(tmpdir(), "aslite-migrate-midvintage-custom-"));
  try {
    const bundle = await initBundle(dirB);
    await writeDoc(bundle, {
      id: "references/view-authoring-v0",
      frontmatter: { type: "Reference", title: "My own view guide", protocol: "v0", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "My customized authoring guide.\n",
    });
    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.reference_refreshed, "skipped_customized");
    assert.ok(receipt.warnings.some((w) => w.id === "references/view-authoring-v0" && /customized/.test(w.warning)));
    assert.equal((await readDoc(bundle, "references/view-authoring-v0")).body, "My customized authoring guide.\n");
  } finally {
    await rm(dirB, { recursive: true, force: true });
  }

});

test("round-3 P2 GUARD SPLIT: an unrelated malformed doc leaves the classify-and-CAS refreshes RUNNING while retirement and deletion stay blocked — in both modes", async () => {
  // The reviewer's combined fixture: unrelated malformed doc + known-shipped review-request
  // convention + legacy page-authoring reference (+ the transitional view-authoring reference
  // and a Page convention, so every guarded/unguarded operation is present at once). Refresh
  // safety comes from exact known-shipped classification + CAS at the target id; hidden stock
  // is material only to REMOVALS.
  const {
    migrateBundle,
    loadCanonicalViewReference,
    loadCanonicalReviewRequestConvention,
    loadPriorShippedReviewRequestConventions,
    loadPriorShippedViewAuthoringReferences,
  } = await script();
  const { initBundle, writeDoc, readDoc } = await core();
  const T = "2026-07-01T00:00:00.000Z";
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-guard-split-"));
  try {
    const bundle = await initBundle(dir);
    const priorRR = loadPriorShippedReviewRequestConventions()[0];
    await writeDoc(bundle, { id: "conventions/review-request", frontmatter: priorRR.frontmatter, body: priorRR.body });
    const priorRefs = loadPriorShippedViewAuthoringReferences();
    const transitional = priorRefs[priorRefs.length - 1];
    await writeDoc(bundle, { id: "references/view-authoring-v0", frontmatter: transitional.frontmatter, body: transitional.body });
    await writeDoc(bundle, {
      id: "references/page-authoring-v0",
      frontmatter: { type: "Reference", title: "Bundle Page authoring — bridge v0", protocol: "v0", timestamp: T },
      body: "Legacy teaching.\n",
    });
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: {
        type: "Convention",
        title: "Page",
        governs: "Page",
        path: "pages-registry/",
        fields: { required: ["title", "entry", "bridge"], optional: ["description"], values: { bridge: ["none", "bundle-read"] }, terminal: {} },
        timestamp: T,
      },
      body: "# Page\n\nThe dead legacy kind.\n",
    });
    writeRawDoc(dir, "notes/broken.md", "---\ntype: Note\ntitle: Broken\nentry: [unterminated\n---\nnever parses\n");

    // Dry-run first: the same split is PROJECTED.
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.ok(dry.skipped_docs.length > 0);
    assert.equal(dry.review_request_swapped, "would_swap", "dry-run: the refresh proceeds despite the unrelated skip");
    assert.equal(dry.reference_refreshed, "would_swap");
    assert.deepEqual(dry.legacy_references_deleted, [], "dry-run: retirement stays blocked");
    assert.deepEqual(dry.page_conventions_deleted, [], "dry-run: deletion stays blocked");

    // Real run: refreshes SWAP with receipts saying so; removals stay blocked with warnings.
    const receipt = await migrateBundle(bundle);
    assert.ok(receipt.skipped_docs.length > 0);
    assert.equal(receipt.review_request_swapped, "swapped");
    assert.equal(receipt.reference_refreshed, "swapped");
    const canonicalRR = loadCanonicalReviewRequestConvention();
    assert.equal((await readDoc(bundle, "conventions/review-request")).body, canonicalRR.body, "the convention no longer teaches Page");
    const canonicalRef = loadCanonicalViewReference();
    assert.equal((await readDoc(bundle, "references/view-authoring-v0")).body, canonicalRef.body);
    assert.deepEqual(receipt.legacy_references_deleted, []);
    assert.ok(await readDoc(bundle, "references/page-authoring-v0"), "retirement blocked — the legacy reference is kept");
    assert.ok(receipt.warnings.some((w) => w.id === "references/page-authoring-v0" && /unreadable docs were skipped/.test(w.warning)));
    assert.deepEqual(receipt.page_conventions_deleted, []);
    assert.ok(await readDoc(bundle, "conventions/page"), "deletion blocked — the Page convention is kept");
    assert.ok(receipt.warnings.some((w) => w.id === "conventions/page" && /kept/.test(w.warning)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("round-2 P1 PROVENANCE TRIPWIRE: the frozen prior-shipped view-authoring reference forms are byte-pinned to their source commits", async () => {
  // Each frozen file was extracted with `git show <commit>:examples/views/references/
  // view-authoring-v0.md`; these sha256 literals pin the BYTES so the frozen forms can never
  // drift silently (the legacy-constants-tripwire discipline, applied to whole files). If a
  // form legitimately needs re-extraction, re-record its hash here in the same change.
  const { createHash } = await import("node:crypto");
  const { loadPriorShippedViewAuthoringReferences } = await script();
  const dir = path.join(repoRoot, "scripts", "prior-shipped-view-authoring-references");
  const pinned = {
    "1-cf4f0d3-initial-view-teaching.md": "d8ede4bc61103713515597b1f7892f7c89b5602da2bfa7e12b2761e98a90a68b",
    "2-ae1dd32-bundle-propose.md": "f96cf46a73d771f6ec7c3c49c123e15724c25983e1daaea36dd08eccf630a25a",
    "3-c6bcd0d-query-alignment.md": "2f4e586349391fcb9d117f4c23f3023c8c30f54ec137d4440eb1b6894a60733a",
    "4-fc9474c-personal-task-system.md": "f66a0f1230cb777bfc86df9ba3a8d6ffc6153641d61551d4372343d538fe3509",
    "5-850a5dc-access-rename.md": "d8b590f991ac81b5a1ec1f3b87d7ed3250f6d1f03fd5e4fa84702e55cae2adc0",
    "6-5d04732-transitional-wording.md": "4605140c2a296f988bcd03a8e6332c9d50ba026f7f3e9d4e2f61fd9b8bba4680",
    "7-2901497-phase2a-transitional.md": "7ef06885357e4627f8bb0a695db0354316a4dd65c08fbf9e95f5544281d92b41",
  };
  const names = (await import("node:fs")).readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  assert.deepEqual(names, Object.keys(pinned), "exactly the recorded frozen forms, no drift in the set");
  for (const [name, expected] of Object.entries(pinned)) {
    const bytes = await readFile(path.join(dir, name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${name}: bytes drifted from the source commit`);
  }
  // And the newest frozen forms really are the transitional teaching this fix exists for —
  // wrong bytes (e.g. accidentally the canonical content) fail here too.
  const forms = loadPriorShippedViewAuthoringReferences();
  assert.equal(forms.length, 7);
  assert.match(forms[6].body, /migration window/);
  assert.match(forms[5].body, /migration window/);
});

test("CLI surface: --dry-run over --dir emits the receipt with the normalization note; no --dir exits 2", async () => {
  const { NORMALIZATION_NOTE } = await script();
  const { dir } = await makeFixtureBundle();
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "--dir", dir, "--dry-run"], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.note, NORMALIZATION_NOTE);
    assert.match(parsed.note, /re-serialize whole documents to canonical form/);
    assert.equal(parsed.bundles.length, 1);
    assert.equal(parsed.bundles[0].bundle, dir);
    assert.equal(parsed.bundles[0].types_flipped, 4);
    assert.equal(parsed.bundles[0].timestamp_added, 3);

    await assert.rejects(
      () => execFileAsync(process.execPath, [SCRIPT], { cwd: repoRoot }),
      (err) => err.code === 2 && /usage:/.test(err.stderr),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conventions-free bundle gains no conventions; docs still rename", async () => {
  const { migrateBundle } = await script();
  const { initBundle, writeDoc, query, readDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-bare-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "pages-registry/solo",
      frontmatter: { type: "Page", title: "Solo", entry: "pages/solo.html", bridge: "none" },
      body: "Legacy doc in a conventions-free bundle.\n",
    });
    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.types_flipped, 1);
    assert.equal(receipt.bridge_renamed, 1);
    assert.equal(receipt.convention_swapped, false, "kind usage stays opt-in per bundle");
    assert.deepEqual(receipt.page_conventions_deleted, []);
    assert.equal((await readDoc(bundle, "pages-registry/solo")).frontmatter.type, "View");
    assert.equal((await query(bundle, { prefix: "conventions/", type: "Convention" })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bundle whose only View convention was the Page one gets the shipped View convention as its replacement", async () => {
  const { migrateBundle, loadCanonicalViewConvention } = await script();
  const { initBundle, writeDoc, readDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-pageconv-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: {
        type: "Convention",
        title: "Page",
        governs: "Page",
        path: "pages-registry/",
        fields: { required: ["title", "entry"], optional: [], values: {}, terminal: {} },
      },
      body: "# Page\n",
    });
    await writeDoc(bundle, {
      id: "pages-registry/dash",
      frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html" },
      body: "governed by the Page convention\n",
    });
    const receipt = await migrateBundle(bundle);
    assert.equal(receipt.convention_swapped, "created", "governance continuity: the View convention replaces the deleted Page one");
    assert.deepEqual(receipt.page_conventions_deleted, ["conventions/page"]);
    const created = await readDoc(bundle, "conventions/view");
    assert.deepEqual(created.frontmatter, loadCanonicalViewConvention().frontmatter);
    await assert.rejects(() => readDoc(bundle, "conventions/page"), isMissingDocument("conventions/page"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Receipt `result` verdict (product-owner finding, 2026-07-24): an all-zeros receipt must ────
// distinguish "already clean / never needed migration" from "the script didn't really look",
// and a dry run must state hypotheticals as conditionals, not completed-action grammar.

test("receipt result: an all-clean bundle says nothing to migrate AND that the scan really looked", async () => {
  const { migrateBundle } = await script();
  const { initBundle, writeDoc } = await core();

  // Case 1 — never needed migration: a bundle with no legacy names at all.
  const cleanDir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-clean-"));
  try {
    const cleanBundle = await initBundle(cleanDir);
    await writeDoc(cleanBundle, {
      id: "notes/plain",
      frontmatter: { type: "Note", title: "Plain", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "no legacy names anywhere\n",
    });
    await writeDoc(cleanBundle, {
      id: "views-registry/modern",
      frontmatter: { type: "View", title: "Modern", entry: "views/modern.html", access: "none", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "already the current spelling\n",
    });
    const dry = await migrateBundle(cleanBundle, { dryRun: true });
    assert.equal(dry.result, "nothing to migrate — no legacy names found in 2 docs (all readable)");
    const real = await migrateBundle(cleanBundle);
    assert.equal(real.result, "nothing to migrate — no legacy names found in 2 docs (all readable)");
  } finally {
    await rm(cleanDir, { recursive: true, force: true });
  }

  // Case 2 — already migrated: the full fixture after a real run reports the same verdict.
  const { dir, bundle } = await makeFixtureBundle();
  try {
    await migrateBundle(bundle);
    const after = await migrateBundle(bundle, { dryRun: true });
    assert.equal(after.result, "nothing to migrate — no legacy names found in 10 docs (all readable)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt result: dry-run speaks in conditionals, the real run in past tense — same fixture", async () => {
  const { migrateBundle } = await script();
  const { dir, bundle } = await makeFixtureBundle();
  try {
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(
      dry.result,
      "would migrate 7 docs (4 type renames, 3 field renames, 1 shadowed field drop), " +
        "swap the View convention, delete 1 Page convention; 1 warning",
    );
    const real = await migrateBundle(bundle);
    assert.equal(
      real.result,
      "migrated 7 docs (4 type renames, 3 field renames, 1 shadowed field drop), " +
        "swapped the View convention, deleted 1 Page convention; 1 warning",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt result: unreadable docs surface in the zero-action verdict, not a clean-scan claim", async () => {
  const { migrateBundle } = await script();
  const { initBundle, writeDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-skipcaveat-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "notes/plain",
      frontmatter: { type: "Note", title: "Plain", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "clean\n",
    });
    writeRawDoc(dir, "notes/broken.md", "---\ntype: Note\ntitle: Broken\nbad: [unterminated\n---\nnever parses\n");
    // A skipped doc is a warning, so this is NOT a clean scan — no "no legacy names found"
    // claim (review P1); the sentence leads with the attention state instead.
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.result, "no changes made, but attention needed — 1 warning: 1 doc unreadable — see skipped_docs");
    const real = await migrateBundle(bundle);
    assert.equal(real.result, "no changes made, but attention needed — 1 warning: 1 doc unreadable — see skipped_docs");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt result: the sentence is derived from the counters and leads the receipt", async () => {
  const { migrateBundle, describeReceipt } = await script();
  const { dir, bundle } = await makeFixtureBundle();
  try {
    const dry = await migrateBundle(bundle, { dryRun: true });
    const real = await migrateBundle(bundle);
    for (const receipt of [dry, real]) {
      assert.equal(Object.keys(receipt)[0], "result", "the verdict is the receipt's leading field");
      assert.equal(describeReceipt(receipt), receipt.result, "sentence and counters agree — no second bookkeeping");
    }
    // Mutating any counter the sentence claims must change the sentence — the builder READS the
    // counters, it does not carry its own tallies.
    assert.notEqual(describeReceipt({ ...real, types_flipped: real.types_flipped + 1 }), real.result);
    assert.notEqual(describeReceipt({ ...real, changed_docs: [...real.changed_docs, "extra/doc"] }), real.result);
    assert.notEqual(describeReceipt({ ...real, warnings: [] }), real.result);
    // Mode-awareness: the SAME counters under the other mode flag read as a different grammar.
    assert.notEqual(describeReceipt({ ...real, dry_run: true }), real.result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review P1 (empirical, two CLI reproductions): a zero-action receipt that carries warnings —
// legacy content skipped or deliberately retained — must never claim "no legacy names found".
// The clean-scan sentence is reserved for warnings === 0; otherwise the verdict leads with the
// dominant reason and its remedy.
test("receipt result: warned zero-action states never claim a clean scan (review P1)", async () => {
  const { migrateBundle, loadCanonicalViewConvention } = await script();
  const { initBundle, writeDoc } = await core();

  // (a) A customized legacy View convention is skipped: legacy content remains, warnings: 1.
  const customDir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-p1a-"));
  try {
    const bundle = await initBundle(customDir);
    await writeDoc(bundle, {
      id: "conventions/view",
      frontmatter: {
        type: "Convention",
        title: "View",
        governs: "View",
        path: "views-registry/",
        fields: { required: ["title", "entry", "access", "owner"], optional: [], values: {}, terminal: {} },
        timestamp: "2026-07-01T00:00:00.000Z",
      },
      body: "# View\n\nLocal customization the migration must not destroy.\n",
    });
    const expected =
      "no changes made, but attention needed — 1 warning: " +
      "customized View convention skipped (re-run with --overwrite-custom-conventions)";
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.result, expected);
    const real = await migrateBundle(bundle);
    assert.equal(real.result, expected);
  } finally {
    await rm(customDir, { recursive: true, force: true });
  }

  // (b) A readable Page convention is deliberately retained because an unreadable doc blocks
  // its deletion: warnings: 2 (the skip + the retention), zero actions.
  const keptDir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-p1b-"));
  try {
    const bundle = await initBundle(keptDir);
    const canonical = loadCanonicalViewConvention();
    await writeDoc(bundle, { id: "conventions/view", frontmatter: canonical.frontmatter, body: canonical.body });
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: { type: "Convention", title: "Page", governs: "Page", path: "pages-registry/" },
      body: "# Page\n",
    });
    writeRawDoc(keptDir, "notes/broken.md", "---\ntype: Note\ntitle: Broken\nbad: [unterminated\n---\nnever parses\n");
    const expected =
      "no changes made, but attention needed — 2 warnings: " +
      "1 Page convention retained (1 doc unreadable — see skipped_docs)";
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.result, expected);
    const real = await migrateBundle(bundle);
    assert.equal(real.result, expected);
  } finally {
    await rm(keptDir, { recursive: true, force: true });
  }
});

// ── Rebase reconciliation (PR #158 x phase-3): refresh actions are visible to the verdict ──────
// A run that ONLY refreshed a teaching artifact (counters 0, warnings 0) must never claim
// "nothing to migrate — no legacy names found": that is exactly the false-clean class the
// receipt-verdict review outlawed.

test("receipt result: a refresh-ONLY run states the refresh in mode-aware grammar — never the clean-scan claim", async () => {
  const { migrateBundle, loadPriorShippedViewAuthoringReferences } = await script();
  const { initBundle, writeDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-verdict-refresh-"));
  try {
    const bundle = await initBundle(dir);
    const priorRefs = loadPriorShippedViewAuthoringReferences();
    const transitional = priorRefs[priorRefs.length - 1];
    await writeDoc(bundle, { id: "references/view-authoring-v0", frontmatter: transitional.frontmatter, body: transitional.body });

    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.result, "would refresh the View authoring reference");
    const real = await migrateBundle(bundle);
    assert.equal(real.result, "refreshed the View authoring reference");
    // Once refreshed, the NEXT run really is clean — and only then may it say so.
    const after = await migrateBundle(bundle);
    assert.equal(after.result, "nothing to migrate — no legacy names found in 1 doc (all readable)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt result: refresh + doc work compose into ONE mode-aware sentence", async () => {
  const { migrateBundle, loadPriorShippedViewAuthoringReferences, loadPriorShippedReviewRequestConventions } =
    await script();
  const { initBundle, writeDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-verdict-combined-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "pages-registry/dash",
      frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", bridge: "bundle-read", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "legacy stock\n",
    });
    const priorRefs = loadPriorShippedViewAuthoringReferences();
    const transitional = priorRefs[priorRefs.length - 1];
    await writeDoc(bundle, { id: "references/view-authoring-v0", frontmatter: transitional.frontmatter, body: transitional.body });
    const priorRR = loadPriorShippedReviewRequestConventions()[0];
    await writeDoc(bundle, { id: "conventions/review-request", frontmatter: priorRR.frontmatter, body: priorRR.body });

    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(
      dry.result,
      "would migrate 1 doc (1 type rename, 1 field rename), refresh the Review Request convention, " +
        "refresh the View authoring reference",
    );
    const real = await migrateBundle(bundle);
    assert.equal(
      real.result,
      "migrated 1 doc (1 type rename, 1 field rename), refreshed the Review Request convention, " +
        "refreshed the View authoring reference",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt result: the absent-replacement retirement pins BOTH the create and retire clauses, dry and real (delta-review P2)", async () => {
  // Reviewer's finding: forcing the retire clause silent left all focused tests green — a real
  // migration could delete the legacy reference while the verdict omitted it. Exact sentences.
  const { migrateBundle } = await script();
  const { initBundle, writeDoc } = await core();
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-verdict-retire-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "references/page-authoring-v0",
      frontmatter: { type: "Reference", title: "Bundle Page authoring — bridge v0", protocol: "v0", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "legacy teaching\n",
    });
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.result, "would create the View authoring reference, retire 1 legacy Page-authoring reference");
    const real = await migrateBundle(bundle);
    assert.equal(real.result, "created the View authoring reference, retired 1 legacy Page-authoring reference");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt result: the ALL-ACTION fixture pins the fully-composed sentence INCLUDING clause order, dry and real (delta-review P2)", async () => {
  const { migrateBundle, loadPriorShippedViewConventions, loadPriorShippedReviewRequestConventions, loadPriorShippedViewAuthoringReferences } =
    await script();
  const { initBundle, writeDoc } = await core();
  const T = "2026-07-01T00:00:00.000Z";
  const dir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-verdict-composed-"));
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "pages-registry/dash",
      frontmatter: { type: "Page", title: "Dash", entry: "pages/dash.html", bridge: "bundle-read", timestamp: T },
      body: "legacy stock\n",
    });
    const priorView = loadPriorShippedViewConventions()[0];
    await writeDoc(bundle, { id: "conventions/view", frontmatter: priorView.frontmatter, body: priorView.body });
    await writeDoc(bundle, {
      id: "conventions/page",
      frontmatter: {
        type: "Convention",
        title: "Page",
        governs: "Page",
        path: "pages-registry/",
        fields: { required: ["title", "entry", "bridge"], optional: ["description"], values: { bridge: ["none", "bundle-read"] }, terminal: {} },
        timestamp: T,
      },
      body: "# Page\n",
    });
    const priorRR = loadPriorShippedReviewRequestConventions()[0];
    await writeDoc(bundle, { id: "conventions/review-request", frontmatter: priorRR.frontmatter, body: priorRR.body });
    const priorRefs = loadPriorShippedViewAuthoringReferences();
    const transitional = priorRefs[priorRefs.length - 1];
    await writeDoc(bundle, { id: "references/view-authoring-v0", frontmatter: transitional.frontmatter, body: transitional.body });
    await writeDoc(bundle, {
      id: "references/page-authoring-v0",
      frontmatter: { type: "Reference", title: "Bundle Page authoring — bridge v0", protocol: "v0", timestamp: T },
      body: "legacy teaching\n",
    });

    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(
      dry.result,
      "would migrate 1 doc (1 type rename, 1 field rename), swap the View convention, " +
        "delete 1 Page convention, refresh the Review Request convention, " +
        "refresh the View authoring reference, retire 1 legacy Page-authoring reference",
    );
    const real = await migrateBundle(bundle);
    assert.equal(
      real.result,
      "migrated 1 doc (1 type rename, 1 field rename), swapped the View convention, " +
        "deleted 1 Page convention, refreshed the Review Request convention, " +
        "refreshed the View authoring reference, retired 1 legacy Page-authoring reference",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt result: blocked/skipped refresh states surface through the attention verdict, never a clean scan", async () => {
  const { migrateBundle } = await script();
  const { initBundle, writeDoc } = await core();

  // (a) A CUSTOMIZED view-authoring reference: zero actions, one warning — named reason.
  const customDir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-verdict-custom-"));
  try {
    const bundle = await initBundle(customDir);
    await writeDoc(bundle, {
      id: "references/view-authoring-v0",
      frontmatter: { type: "Reference", title: "My own guide", protocol: "v0", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "customized\n",
    });
    const expected = "no changes made, but attention needed — 1 warning: customized View authoring reference skipped";
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.result, expected);
    const real = await migrateBundle(bundle);
    assert.equal(real.result, expected);
  } finally {
    await rm(customDir, { recursive: true, force: true });
  }

  // (b) Retirement blocked by unreadable stock: the retained legacy reference is a named reason
  // beside the skip note.
  const blockedDir = await mkdtemp(path.join(tmpdir(), "aslite-migrate-verdict-blocked-"));
  try {
    const bundle = await initBundle(blockedDir);
    await writeDoc(bundle, {
      id: "references/page-authoring-v0",
      frontmatter: { type: "Reference", title: "Bundle Page authoring — bridge v0", protocol: "v0", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "legacy teaching\n",
    });
    writeRawDoc(blockedDir, "notes/broken.md", "---\ntype: Note\ntitle: Broken\nbad: [unterminated\n---\nnever parses\n");
    const expected =
      "no changes made, but attention needed — 2 warnings: 1 doc unreadable — see skipped_docs; " +
      "1 legacy Page-authoring reference retained (see warnings)";
    const dry = await migrateBundle(bundle, { dryRun: true });
    assert.equal(dry.result, expected);
    const real = await migrateBundle(bundle);
    assert.equal(real.result, expected);
  } finally {
    await rm(blockedDir, { recursive: true, force: true });
  }
});
