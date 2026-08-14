/**
 * `agentstate-lite status` — the read-only whole-bundle health report.
 *
 * Runs the command function in-process (no subprocess) against a real temp filesystem bundle,
 * mirroring `kinds.test.ts`'s / `link.test.ts`'s pattern. The `--remote` parity test additionally
 * boots a real `@superbee/server` `serve()` instance, mirroring `kinds.test.ts`'s own
 * `--remote` test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { initBundle, writeBlob, writeDoc, type Bundle } from "@superbee/core";
import { serve, type ServerHandle } from "@superbee/server";

import { status } from "../src/commands/status.js";
import { newCommand } from "../src/commands/new.js";
import { CliError } from "../src/errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const SAMPLE_BUNDLE = path.join(REPO_ROOT, "examples/sample-bundle");

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agentstate-lite-status-test-"));
}

/** Run `status`, capturing its `--json` stdout and parsing the envelope. */
async function runJson(argv: string[]): Promise<Record<string, unknown>> {
  let out = "";
  await status([...argv, "--json"], { stdout: (s) => (out += s) });
  return JSON.parse(out) as Record<string, unknown>;
}

/** Run `status` in the DEFAULT (TOON) render mode, capturing the raw stdout bytes verbatim. */
async function runToon(argv: string[]): Promise<string> {
  let out = "";
  await status(argv, { stdout: (s) => (out += s) });
  return out;
}

/**
 * A fixture bundle exercising every finding class the plan calls for:
 *   - `conventions/widget`   — declares the `Widget` kind (required title+status, an enum-restricted
 *                              `status`, a 1h freshness horizon).
 *   - `conventions/broken`   — a malformed convention (no `governs`) -> a registry warning.
 *   - `widgets/missing-title`— governed, missing the required `title` -> a kind-lint warning.
 *   - `widgets/bad-enum`     — governed, `status` outside the declared enum -> a kind-lint warning.
 *   - `widgets/linker`       — links to a target that doesn't exist -> an unresolved link.
 *   - `widgets/anchor`       — links to `widgets/missing-title`, so THAT doc is not an orphan; but
 *                              nothing links to `anchor` itself, so `anchor` IS an orphan.
 *   - `widgets/orphan`       — no inbound or outbound links at all -> an orphan.
 *   - `widgets/stale-one`    — governed, timestamp 2h old against the kind's 1h horizon -> stale.
 *   - `widgets/no-ts`        — governed, written directly to disk with NO `timestamp` field at all
 *                              (the engine's `writeDoc` always stamps one, so this bypasses it on
 *                              purpose) -> counted `no_timestamp`.
 *   - `widgets/self-linker`  — links ONLY to itself. A self-link must not rescue a doc from orphan
 *                              status (status.ts explicitly excludes `l.to === doc.id` from the
 *                              inbound set), so this doc IS an orphan despite having an outbound link.
 * 10 docs total; every doc except `missing-title` has zero inbound links from an OTHER concept doc
 * (9 orphans).
 */
async function makeFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle = await initBundle(dir);
  const now = new Date().toISOString();

  await writeDoc(bundle, {
    id: "conventions/widget",
    frontmatter: {
      type: "Convention",
      title: "Widget",
      governs: "Widget",
      fields: { required: ["title", "status"], optional: [], values: { status: ["active", "done"] } },
      freshness_horizon: "1h",
      timestamp: now,
    },
    body: "The Widget kind.",
  });
  await writeDoc(bundle, {
    id: "conventions/broken",
    frontmatter: { type: "Convention", title: "Broken", timestamp: now },
    body: "Missing 'governs' — malformed.",
  });
  await writeDoc(bundle, {
    id: "widgets/missing-title",
    frontmatter: { type: "Widget", status: "active", timestamp: now },
    body: "No title.",
  });
  await writeDoc(bundle, {
    id: "widgets/bad-enum",
    frontmatter: { type: "Widget", title: "Bad", status: "cancelled", timestamp: now },
    body: "Status outside the declared enum.",
  });
  await writeDoc(bundle, {
    id: "widgets/linker",
    frontmatter: { type: "Widget", title: "Linker", status: "active", timestamp: now },
    body: "See [ghost](../ghosts/nope.md) for details.",
  });
  await writeDoc(bundle, {
    id: "widgets/anchor",
    frontmatter: { type: "Widget", title: "Anchor", status: "active", timestamp: now },
    body: "Points at [missing-title](missing-title.md).",
  });
  await writeDoc(bundle, {
    id: "widgets/orphan",
    frontmatter: { type: "Widget", title: "Orphan", status: "active", timestamp: now },
    body: "Nobody links here, and this links nowhere.",
  });
  const oldTs = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2h old > 1h horizon
  await writeDoc(bundle, {
    id: "widgets/stale-one",
    frontmatter: { type: "Widget", title: "Stale", status: "active", timestamp: oldTs },
    body: "Old by the declared horizon.",
  });
  // Bypasses writeDoc (which always stamps a timestamp) to produce a governed doc with NO
  // timestamp field at all — the shape a hand-edited external file could take.
  await mkdir(path.join(dir, "widgets"), { recursive: true });
  await writeFile(
    path.join(dir, "widgets", "no-ts.md"),
    "---\ntype: Widget\ntitle: NoTS\nstatus: active\n---\nNo timestamp at all.\n",
  );
  await writeDoc(bundle, {
    id: "widgets/self-linker",
    frontmatter: { type: "Widget", title: "SelfLinker", status: "active", timestamp: now },
    body: "Links to [itself](self-linker.md) — must not rescue itself from orphan status.",
  });

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("status: examples/sample-bundle characterization — a fully clean bundle (pinned values, exit 0, no finding blocks)", async () => {
  const result = await runJson(["--dir", SAMPLE_BUNDLE]);
  assert.equal(result.docs, 4);
  assert.equal(result.kinds, 0);
  assert.equal(result.kind_warnings, 0);
  assert.equal(result.unresolved_links, 0);
  assert.equal(result.orphans, 0);
  assert.equal(result.stale, 0);
  assert.equal(result.no_timestamp, 0);
  assert.equal(result.registry_warnings, 0);
  assert.equal(result.link_type_violations, 0);
  assert.equal(result.missing_expected_links, 0);
  // A clean report omits every row-list block rather than emitting ten empty categories.
  for (const key of [
    "kind_lint",
    "unresolved",
    "orphan_docs",
    "stale_docs",
    "no_timestamp_docs",
    "registry_lint",
    "link_type_violations_rows",
    "missing_expected_links_rows",
  ]) {
    assert.equal(key in result, false, `expected no '${key}' key on a clean report`);
  }
});

test("status: a conventions-free freshly-initialized bundle is equally clean", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const result = await runJson(["--dir", dir]);
    assert.equal(result.docs, 0);
    assert.equal(result.kinds, 0);
    assert.equal(result.kind_warnings, 0);
    assert.equal(result.unresolved_links, 0);
    assert.equal(result.orphans, 0);
    assert.equal(result.stale, 0);
    assert.equal(result.no_timestamp, 0);
    assert.equal(result.registry_warnings, 0);
    assert.equal(result.link_type_violations, 0);
    assert.equal(result.missing_expected_links, 0);
    assert.equal("link_type_violations_rows" in result, false);
    assert.equal("missing_expected_links_rows" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Conformance-debt byte-identity pin (tasks/status-conformance-debt, gate 2/3) ───────────────
//
// A conventions-free bundle's status output must stay BYTE-IDENTICAL after the new
// `conformance_debt`/`conformance_debt_docs` fields are added — those fields are gated on
// `registry.kinds.size > 0`, so a conventions-free bundle (`registry.kinds.size === 0`) must never
// emit them. Both string literals below were captured VERBATIM from the BUILT CLI
// (`dist/agentstate-lite.mjs`) run against these exact two bundle shapes BEFORE this unit's status.ts
// change landed — see the PR description for the exact commands run to capture them. A future
// unrelated status.ts change that alters this exact output shape should update these literals
// deliberately, not accidentally.

test("status BYTE-IDENTITY PIN: examples/sample-bundle (conventions-free), TOON render — captured pre-change, must not shift by one byte", async () => {
  const toon = await runToon(["--dir", SAMPLE_BUNDLE]);
  assert.equal(
    toon,
    "docs: 4\n" +
      "kinds: 0\n" +
      "malformed: 0\n" +
      "kind_warnings: 0\n" +
      "unresolved_links: 0\n" +
      "orphans: 0\n" +
      "stale: 0\n" +
      "no_timestamp: 0\n" +
      "registry_warnings: 0\n" +
      "link_type_violations: 0\n" +
      "missing_expected_links: 0\n",
  );
});

test("status BYTE-IDENTITY PIN: examples/sample-bundle (conventions-free), JSON render — captured pre-change", async () => {
  let raw = "";
  await status(["--dir", SAMPLE_BUNDLE, "--json"], { stdout: (s) => (raw += s) });
  assert.equal(
    raw,
    '{"docs":4,"kinds":0,"malformed":0,"kind_warnings":0,"unresolved_links":0,"orphans":0,"stale":0,' +
      '"no_timestamp":0,"registry_warnings":0,"link_type_violations":0,"missing_expected_links":0}\n',
  );
});

test("status BYTE-IDENTITY PIN: a fresh conventions-free bundle (initBundle — seeds NOTHING), TOON and JSON — captured pre-change", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    const toon = await runToon(["--dir", dir]);
    assert.equal(
      toon,
      "docs: 0\n" +
        "kinds: 0\n" +
        "malformed: 0\n" +
        "kind_warnings: 0\n" +
        "unresolved_links: 0\n" +
        "orphans: 0\n" +
        "stale: 0\n" +
        "no_timestamp: 0\n" +
        "registry_warnings: 0\n" +
        "link_type_violations: 0\n" +
        "missing_expected_links: 0\n",
    );

    let raw = "";
    await status(["--dir", dir, "--json"], { stdout: (s) => (raw += s) });
    assert.equal(
      raw,
      '{"docs":0,"kinds":0,"malformed":0,"kind_warnings":0,"unresolved_links":0,"orphans":0,"stale":0,' +
        '"no_timestamp":0,"registry_warnings":0,"link_type_violations":0,"missing_expected_links":0}\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: fixture bundle exercises every finding class with the correct counts + rows", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const result = await runJson(["--dir", dir]);

    assert.equal(result.docs, 10);
    assert.equal(result.kinds, 1);

    // The Widget kind declares no 'links'/'expects_inbound' — the graph lints stay at zero, no
    // row-list blocks, over a fixture built entirely for the OTHER finding classes.
    assert.equal(result.link_type_violations, 0);
    assert.equal(result.missing_expected_links, 0);
    assert.equal("link_type_violations_rows" in result, false);
    assert.equal("missing_expected_links_rows" in result, false);

    // Kind lint: exactly the missing-title + bad-enum warnings, minimal {id,field,code} rows.
    assert.equal(result.kind_warnings, 2);
    const lint = result.kind_lint as { shown: number; total: number; rows: Record<string, unknown>[] };
    assert.equal(lint.shown, 2);
    assert.equal(lint.total, 2);
    assert.ok(
      lint.rows.some((r) => r.id === "widgets/missing-title" && r.field === "title" && r.code === "KIND_FIELD_MISSING"),
    );
    assert.ok(
      lint.rows.some((r) => r.id === "widgets/bad-enum" && r.field === "status" && r.code === "KIND_FIELD_VALUE"),
    );

    // Conformance debt (tasks/status-conformance-debt): the Widget kind declares no `sections`, so
    // every kind_warnings violation here IS frontmatter-shaped — debt equals the warning count in
    // THIS fixture (the doc-vs-warning and section-exclusion distinctions get their OWN dedicated
    // fixture below).
    assert.equal(result.conformance_debt, 2);
    const debt = result.conformance_debt_docs as {
      shown: number;
      total: number;
      rows: Record<string, unknown>[];
      help: string;
    };
    assert.equal(debt.shown, 2);
    assert.equal(debt.total, 2);
    assert.ok(debt.rows.some((r) => r.id === "widgets/missing-title" && r.type === "Widget"));
    assert.ok(debt.rows.some((r) => r.id === "widgets/bad-enum" && r.type === "Widget"));
    assert.match(debt.help, /doc update/);

    // Unresolved links: exactly the linker's dangling target — "unresolved", not "broken".
    assert.equal(result.unresolved_links, 1);
    const unresolved = result.unresolved as { shown: number; total: number; rows: Record<string, unknown>[] };
    assert.deepEqual(unresolved.rows, [{ from: "widgets/linker", href: "../ghosts/nope.md" }]);

    // Orphans: everything except missing-title (which anchor links to). Self-links never rescue.
    assert.equal(result.orphans, 9);
    const orphans = result.orphan_docs as { shown: number; total: number; rows: Record<string, unknown>[] };
    const orphanIds = orphans.rows.map((r) => r.id);
    assert.ok(orphanIds.includes("widgets/orphan"));
    assert.ok(orphanIds.includes("widgets/anchor")); // links OUT, but nothing links IN
    assert.ok(!orphanIds.includes("widgets/missing-title")); // rescued by anchor's inbound link
    assert.ok(orphanIds.includes("widgets/self-linker")); // links only to ITSELF — does not self-rescue
    // Every orphan row carries {id, type} — the type column is what lets a reader self-identify a
    // Convention doc (schema, not content) among the orphans (F4) without a second lookup.
    for (const row of orphans.rows) {
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.type, "string");
    }
    assert.ok(
      orphans.rows.some((r) => r.id === "conventions/widget" && r.type === "Convention"),
      "an expected, permanent Convention orphan self-identifies via its type column",
    );
    assert.ok(
      orphans.rows.some((r) => r.id === "conventions/broken" && r.type === "Convention"),
    );
    assert.ok(orphans.rows.some((r) => r.id === "widgets/orphan" && r.type === "Widget"));

    // Freshness sweep: stale-one exceeds the 1h horizon; no-ts has no timestamp at all.
    assert.equal(result.stale, 1);
    const stale = result.stale_docs as { shown: number; total: number; rows: Record<string, unknown>[] };
    assert.equal(stale.rows.length, 1);
    assert.equal(stale.rows[0]!.id, "widgets/stale-one");
    assert.equal(stale.rows[0]!.horizon_ms, 3_600_000);
    assert.ok((stale.rows[0]!.age_ms as number) > 3_600_000);

    // no_timestamp now carries its own rows[] block (F5) — {id, type}, capped like every other
    // category, instead of forcing a cross-reference against kind_lint to identify the doc.
    assert.equal(result.no_timestamp, 1);
    const noTimestamp = result.no_timestamp_docs as {
      shown: number;
      total: number;
      rows: Record<string, unknown>[];
    };
    assert.deepEqual(noTimestamp.rows, [{ id: "widgets/no-ts", type: "Widget" }]);

    // Registry warnings: the malformed convention doc, surfaced verbatim from loadKinds.
    assert.equal(result.registry_warnings, 1);
    const registryLint = result.registry_lint as { shown: number; total: number; rows: Record<string, unknown>[] };
    assert.equal(registryLint.rows[0]!.code, "KIND_CONVENTION_MALFORMED");

    const upgrade = result.okf_upgrade as {
      current_version: string;
      target_version: string;
      readiness: string;
      blocker: string;
      recommended_logical_field: string;
      status_field_kinds: number;
      affected_documents: number;
      status_field_rows: { rows: Record<string, unknown>[] };
      note: string;
      help: string[];
    };
    assert.equal(upgrade.current_version, "0.1");
    assert.equal(upgrade.target_version, "0.2");
    assert.equal(upgrade.readiness, "blocked");
    assert.equal(upgrade.blocker, "workflow_status_collision");
    assert.equal(upgrade.recommended_logical_field, "progress_status");
    assert.equal(upgrade.status_field_kinds, 1);
    assert.equal(upgrade.affected_documents, 8);
    assert.deepEqual(upgrade.status_field_rows.rows, [
      {
        kind: "Widget",
        convention: "conventions/widget",
        declaration: "enumerated",
        incompatible_values: ["active", "done"],
        observed_incompatible_values: ["active", "cancelled"],
        affected_documents: 8,
      },
    ]);
    assert.match(upgrade.note, /remains a supported OKF v0\.1 bundle/);
    assert.match(upgrade.help.join(" "), /does not currently perform/);
  } finally {
    await cleanup();
  }
});

test("status: a v0.1 kind using only OKF v0.2 lifecycle status values has no upgrade blocker", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/lifecycle-note",
      frontmatter: {
        type: "Convention",
        title: "Lifecycle Note",
        governs: "Lifecycle Note",
        fields: {
          required: ["title", "status"],
          optional: [],
          values: { status: ["draft", "stable", "deprecated"] },
        },
      },
      body: "Uses the OKF lifecycle field as specified.",
    });
    await writeDoc(bundle, {
      id: "notes/one",
      frontmatter: { type: "Lifecycle Note", title: "One", status: "stable" },
      body: "Compatible.",
    });

    const result = await runJson(["--dir", dir]);
    assert.equal("okf_upgrade" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: actual incompatible values remain blockers when the status enum is absent or already lifecycle-only", async () => {
  for (const variant of ["unbounded", "lifecycle-only"] as const) {
    const dir = await tempDir();
    try {
      const bundle = await initBundle(dir);
      await writeDoc(bundle, {
        id: "conventions/task",
        frontmatter: {
          type: "Convention",
          title: "Task",
          governs: "Task",
          fields: {
            required: ["title", "status"],
            optional: [],
            ...(variant === "lifecycle-only"
              ? { values: { status: ["draft", "stable", "deprecated"] } }
              : {}),
          },
        },
        body: "Task state.",
      });
      await writeDoc(bundle, {
        id: "tasks/legacy",
        frontmatter: { type: "Task", title: "Legacy", status: "todo" },
        body: "Still carries legacy progress state.",
      });

      const result = await runJson(["--dir", dir]);
      const upgrade = result.okf_upgrade as {
        affected_documents: number;
        status_field_rows: { rows: Record<string, unknown>[] };
      };
      assert.equal(upgrade.affected_documents, 1, variant);
      assert.deepEqual(upgrade.status_field_rows.rows[0]!.observed_incompatible_values, ["todo"]);
      assert.equal(
        upgrade.status_field_rows.rows[0]!.declaration,
        variant === "unbounded" ? "unbounded" : "enumerated",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("status: malformed root index is a finding rather than an abort", async () => {
  const dir = await tempDir();
  try {
    await initBundle(dir);
    await writeFile(path.join(dir, "index.md"), "---\nokf_version: [\n---\n# Broken root\n");

    const result = await runJson(["--dir", dir]);
    assert.equal(result.malformed, 1);
    const malformed = result.malformed_docs as { rows: Record<string, unknown>[] };
    assert.equal(malformed.rows[0]!.id, "index.md");
    assert.match(String(malformed.rows[0]!.reason), /malformed frontmatter/);
    assert.equal("okf_upgrade" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Conformance debt (tasks/status-conformance-debt) — DEDICATED fixture ────────────────────────
//
// A SEPARATE fixture (not `makeFixtureBundle()`) so this unit's own assertions never couple to that
// shared fixture's unrelated hardcoded counts (docs/orphans/etc.) — isolates the two distinctions
// `conformance_debt` exists to draw: (1) it counts DOCS, not WARNINGS (a doc with two frontmatter
// violations counts once), and (2) it excludes BODY-SECTION violations entirely (the Task kind here
// declares a `sections: [Notes]` requirement specifically to exercise that exclusion).
async function makeConformanceDebtFixture(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle = await initBundle(dir);
  const now = new Date().toISOString();

  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      fields: { required: ["title", "status"], optional: [], values: { status: ["todo", "done"] } },
      sections: ["Notes"],
      timestamp: now,
    },
    body: "The Task kind.",
  });
  // Frontmatter debt: ONE missing required field.
  await writeDoc(bundle, {
    id: "tasks/missing-status",
    frontmatter: { type: "Task", title: "Missing status", timestamp: now },
    body: "# Notes\n\nfine.",
  });
  // Frontmatter debt: ONE out-of-enum value.
  await writeDoc(bundle, {
    id: "tasks/bad-status",
    frontmatter: { type: "Task", title: "Bad status", status: "bogus", timestamp: now },
    body: "# Notes\n\nfine.",
  });
  // Frontmatter debt: TWO violations on the SAME doc (missing title AND missing status) — must
  // still count as exactly ONE debt doc, unlike `kind_warnings` (which counts 2 here).
  await writeDoc(bundle, {
    id: "tasks/missing-both",
    frontmatter: { type: "Task", timestamp: now },
    body: "# Notes\n\nfine.",
  });
  // NOT frontmatter debt: satisfies title+status, but is missing the declared '# Notes' section —
  // a KIND_SECTION_MISSING-only doc must be EXCLUDED from conformance_debt (it counts in
  // kind_warnings, but there is no `doc update --<field>` that could fix a body heading).
  await writeDoc(bundle, {
    id: "tasks/section-only",
    frontmatter: { type: "Task", title: "Section only", status: "todo", timestamp: now },
    body: "No heading here.",
  });
  // Fully conformant — zero warnings anywhere.
  await writeDoc(bundle, {
    id: "tasks/clean",
    frontmatter: { type: "Task", title: "Clean", status: "done", timestamp: now },
    body: "# Notes\n\nAll good.",
  });

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("status: conformance_debt counts DOCS (not warnings) carrying a FRONTMATTER violation — a multi-violation doc counts once, a section-only violation is excluded", async () => {
  const { dir, cleanup } = await makeConformanceDebtFixture();
  try {
    const result = await runJson(["--dir", dir]);

    // kind_warnings: 1 (missing-status) + 1 (bad-status) + 2 (missing-both) + 1 (section-only) = 5.
    assert.equal(result.kind_warnings, 5);

    // conformance_debt: missing-status, bad-status, missing-both — 3 DOCS, not 4 warnings; clean
    // and section-only are both absent (section-only has a kind_warnings entry but no debt entry).
    assert.equal(result.conformance_debt, 3);
    const debt = result.conformance_debt_docs as {
      shown: number;
      total: number;
      rows: Record<string, unknown>[];
      help: string;
    };
    assert.equal(debt.total, 3);
    const debtIds = debt.rows.map((r) => r.id).sort();
    assert.deepEqual(debtIds, ["tasks/bad-status", "tasks/missing-both", "tasks/missing-status"]);
    for (const row of debt.rows) assert.equal(row.type, "Task");
    // The help hatch points at 'doc update' with a placeholder shape an agent can fill — not just
    // the generic 'kinds' pointer.
    assert.match(debt.help, /doc update <id> --<field> <value>/);
    assert.match(debt.help, /kinds/);
  } finally {
    await cleanup();
  }
});

test("status: conformance_debt is present (even at 0) whenever the bundle declares a kind, but omitted on a conventions-free bundle", async () => {
  // A bundle that declares a kind but has ZERO governed instances at all: conformance_debt must
  // still be present, at 0 — 'present when kinds exist' does not mean 'present only when non-zero'.
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "conventions/task",
      frontmatter: {
        type: "Convention",
        title: "Task",
        governs: "Task",
        fields: { required: ["title"], optional: [], values: {} },
        timestamp: new Date().toISOString(),
      },
      body: "The Task kind.",
    });
    const result = await runJson(["--dir", dir]);
    assert.equal(result.kinds, 1);
    assert.equal(result.conformance_debt, 0);
    assert.equal("conformance_debt_docs" in result, false, "the row block is still omitted when empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // A conventions-free bundle: the field must be ABSENT, not present-at-0 (gate 2/3 byte-identity —
  // see the dedicated BYTE-IDENTITY PIN tests above for the full-output-string version of this).
  const freeDir = await tempDir();
  try {
    await initBundle(freeDir);
    const result = await runJson(["--dir", freeDir]);
    assert.equal(result.kinds, 0);
    assert.equal("conformance_debt" in result, false);
    assert.equal("conformance_debt_docs" in result, false);
  } finally {
    await rm(freeDir, { recursive: true, force: true });
  }
});

test("status: a link to a reserved file (index.md/log.md) is never counted as unresolved (core resolveConceptId drops it before this scan sees it)", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "widgets/reserved-linker",
      frontmatter: { type: "Widget", title: "ReservedLinker" },
      body:
        "See the [changelog](../log.md) and [home](../index.md) for context, " +
        "plus a genuinely [broken](./ghost.md) link.",
    });
    const result = await runJson(["--dir", dir]);
    assert.equal(result.docs, 1);
    // Only the genuinely-broken link counts; the two reserved-file targets are structurally never
    // concept edges (dropped upstream by resolveConceptId), not silently absorbed as "unresolved".
    assert.equal(result.unresolved_links, 1);
    const unresolved = result.unresolved as { shown: number; total: number; rows: Record<string, unknown>[] };
    assert.deepEqual(unresolved.rows, [{ from: "widgets/reserved-linker", href: "./ghost.md" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A GENERIC graph-lints fixture (not Task/Roadmap Item), pinning that nothing is hardcoded:
 *   - `conventions/box`   — declares 'Box', a link SOURCE: `links: {contains: Crate}`.
 *   - `conventions/crate` — declares 'Crate', a link TARGET: `expects_inbound: {contains: Box}`,
 *                            plus a `status` field (queued/active/done) for the triage signal.
 *   - `items/good-box` -> `items/good-crate` (text 'contains'): a CONFORMING edge (Box -> Crate) —
 *     satisfies good-crate's expects_inbound, never a violation.
 *   - `items/box-to-widget` -> `items/rogue` (text 'contains'): wrong TARGET (Box -> Widget, not
 *     Crate) — a link_type_violations row.
 *   - `items/rogue` -> `items/good-crate` (text 'contains'): wrong SOURCE (Widget -> Crate, not
 *     Box -> Crate) — a SECOND link_type_violations row. (`items/rogue` is type 'Widget', an
 *     undeclared kind, so it never itself appears in any kind-governed finding.)
 *   - `items/missing-crate` (status: queued) and `items/done-crate` (status: done) — Crate
 *     instances with NO inbound 'contains' edge from a Box at all -> two missing_expected_links
 *     rows, used to pin the status-in-row + non-done-first sort.
 */
async function makeGraphLintFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle = await initBundle(dir);
  const now = new Date().toISOString();

  await writeDoc(bundle, {
    id: "conventions/box",
    frontmatter: {
      type: "Convention",
      governs: "Box",
      fields: { required: ["title"], optional: [] },
      links: { contains: "Crate" },
      timestamp: now,
    },
    body: "Box declares its typed-edge vocabulary.",
  });
  await writeDoc(bundle, {
    id: "conventions/crate",
    frontmatter: {
      type: "Convention",
      governs: "Crate",
      fields: { required: ["title", "status"], optional: [], values: { status: ["queued", "active", "done"] } },
      expects_inbound: { contains: "Box" },
      timestamp: now,
    },
    body: "Crate declares its inbound-link expectation.",
  });
  await writeDoc(bundle, {
    id: "items/good-box",
    frontmatter: { type: "Box", title: "Good Box", timestamp: now },
    body: "Contains a [contains](good-crate.md).",
  });
  await writeDoc(bundle, {
    id: "items/box-to-widget",
    frontmatter: { type: "Box", title: "Box To Widget", timestamp: now },
    body: "Contains a [contains](rogue.md).",
  });
  await writeDoc(bundle, {
    id: "items/rogue",
    frontmatter: { type: "Widget", title: "Rogue", timestamp: now },
    body: "Contains a [contains](good-crate.md).",
  });
  await writeDoc(bundle, {
    id: "items/good-crate",
    frontmatter: { type: "Crate", title: "Good Crate", status: "active", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "items/missing-crate",
    frontmatter: { type: "Crate", title: "Missing Crate", status: "queued", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "items/done-crate",
    frontmatter: { type: "Crate", title: "Done Crate", status: "done", timestamp: now },
    body: "",
  });

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("status: link_type_violations — every edge violating a declared 'links' vocabulary, bundle-wide (same rule as 'link add's write-time lint)", async () => {
  const { dir, cleanup } = await makeGraphLintFixtureBundle();
  try {
    const result = await runJson(["--dir", dir]);
    assert.equal(result.link_type_violations, 2);
    const violations = result.link_type_violations_rows as {
      shown: number;
      total: number;
      rows: Record<string, unknown>[];
    };
    assert.equal(violations.total, 2);
    assert.ok(
      violations.rows.some(
        (r) => r.from === "items/box-to-widget" && r.to === "items/rogue" && r.text === "contains" && r.expected === "Box -> Crate",
      ),
      "expected the wrong-TARGET violation row",
    );
    assert.ok(
      violations.rows.some(
        (r) => r.from === "items/rogue" && r.to === "items/good-crate" && r.text === "contains" && r.expected === "Box -> Crate",
      ),
      "expected the wrong-SOURCE violation row",
    );
    // The CONFORMING edge (good-box -> good-crate) must never appear as a violation.
    assert.ok(!violations.rows.some((r) => r.from === "items/good-box"));
  } finally {
    await cleanup();
  }
});

test("status: missing_expected_links — Crate instances lacking a conforming inbound 'contains' edge from a Box; status-in-row + non-done-first sort", async () => {
  const { dir, cleanup } = await makeGraphLintFixtureBundle();
  try {
    const result = await runJson(["--dir", dir]);
    assert.equal(result.missing_expected_links, 2);
    const missing = result.missing_expected_links_rows as {
      shown: number;
      total: number;
      rows: Record<string, unknown>[];
    };
    assert.equal(missing.total, 2);
    // Non-done first (missing-crate, status: queued), then done (done-crate) — never plain id order.
    assert.deepEqual(missing.rows.map((r) => r.id), ["items/missing-crate", "items/done-crate"]);
    assert.equal(missing.rows[0]!.status, "queued");
    assert.deepEqual(missing.rows[0]!.missing, ["contains"]);
    assert.equal(missing.rows[1]!.status, "done");
    assert.deepEqual(missing.rows[1]!.missing, ["contains"]);
    // good-crate received a CONFORMING inbound edge (from good-box, a real Box) — it must NOT appear,
    // even though it also received a non-conforming inbound edge (from rogue, a Widget).
    assert.ok(!missing.rows.some((r) => r.id === "items/good-crate"));
  } finally {
    await cleanup();
  }
});

test("status: missing_expected_links omits the 'status' key when the declaring kind has no status field", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    await writeDoc(bundle, {
      id: "conventions/tag",
      frontmatter: { type: "Convention", governs: "Tag", fields: { required: ["title"], optional: [] }, timestamp: now },
      body: "Tag kind — a link SOURCE only.",
    });
    await writeDoc(bundle, {
      id: "conventions/note",
      frontmatter: {
        type: "Convention",
        governs: "Note",
        fields: { required: ["title"], optional: [] }, // no 'status' field declared
        expects_inbound: { "tagged by": "Tag" },
        timestamp: now,
      },
      body: "Note kind — expects an inbound 'tagged by' edge from a Tag; declares no status field.",
    });
    await writeDoc(bundle, {
      id: "items/lonely-note",
      frontmatter: { type: "Note", title: "Lonely", timestamp: now },
      body: "",
    });

    const result = await runJson(["--dir", dir]);
    assert.equal(result.missing_expected_links, 1);
    const missing = result.missing_expected_links_rows as { rows: Record<string, unknown>[] };
    assert.equal(missing.rows.length, 1);
    assert.equal(missing.rows[0]!.id, "items/lonely-note");
    assert.equal("status" in missing.rows[0]!, false, "a kind with no declared status field must not get a status key");
    assert.deepEqual(missing.rows[0]!.missing, ["tagged by"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── tasks/status-terminal-declaration.md: the missing_expected_links sweep's terminal exclusion ──

/**
 * The SAME Box/Crate graph-lint shape as `makeGraphLintFixtureBundle`, except the Crate kind now
 * DECLARES a terminal set (`terminal: { status: ["done"] }`) — pins the sweep's terminal
 * consumer: a terminal instance is excluded from `missing_expected_links` entirely (never a row,
 * never counted), the exclusion is surfaced via a top-level `terminal_skipped`, and a non-
 * terminal instance is unaffected.
 */
async function makeTerminalSweepFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle = await initBundle(dir);
  const now = new Date().toISOString();

  await writeDoc(bundle, {
    id: "conventions/box",
    frontmatter: {
      type: "Convention",
      governs: "Box",
      fields: { required: ["title"], optional: [] },
      links: { contains: "Crate" },
      timestamp: now,
    },
    body: "Box declares its typed-edge vocabulary.",
  });
  await writeDoc(bundle, {
    id: "conventions/crate",
    frontmatter: {
      type: "Convention",
      governs: "Crate",
      fields: {
        required: ["title", "status"],
        optional: [],
        values: { status: ["queued", "active", "done"] },
        terminal: { status: ["done"] },
      },
      expects_inbound: { contains: "Box" },
      timestamp: now,
    },
    body: "Crate declares its inbound-link expectation AND a terminal status.",
  });
  await writeDoc(bundle, {
    id: "items/queued-crate",
    frontmatter: { type: "Crate", title: "Queued Crate", status: "queued", timestamp: now },
    body: "",
  });
  await writeDoc(bundle, {
    id: "items/done-crate",
    frontmatter: { type: "Crate", title: "Done Crate", status: "done", timestamp: now },
    body: "",
  });

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("status: missing_expected_links excludes a TERMINAL instance entirely (declared kind) and reports terminal_skipped beside the count", async () => {
  const { dir, cleanup } = await makeTerminalSweepFixtureBundle();
  try {
    const result = await runJson(["--dir", dir]);
    assert.equal(result.missing_expected_links, 1, "only the non-terminal queued-crate counts");
    assert.equal(result.terminal_skipped, 1, "the done-crate was excluded, not silently dropped");
    const missing = result.missing_expected_links_rows as { total: number; rows: Record<string, unknown>[] };
    assert.equal(missing.total, 1);
    assert.deepEqual(missing.rows.map((r) => r.id), ["items/queued-crate"]);
    assert.ok(
      !missing.rows.some((r) => r.id === "items/done-crate"),
      "the terminal instance must not appear as a row at all",
    );
  } finally {
    await cleanup();
  }
});

test("status: terminal_skipped is ABSENT when zero instances are excluded (a kind with no terminal declaration is unaffected)", async () => {
  const { dir, cleanup } = await makeGraphLintFixtureBundle(); // this fixture's Crate kind declares NO terminal set
  try {
    const result = await runJson(["--dir", dir]);
    assert.equal(result.missing_expected_links, 2, "the pre-existing behavior — done-crate still counts");
    assert.equal("terminal_skipped" in result, false, "no exclusions occurred, so the field must not appear");
  } finally {
    await cleanup();
  }
});

test("status: the terminal exclusion keys off the DECLARED value set, not a hardcoded 'done' string — a kind whose terminal words are 'resolved'/'archived' excludes those, not literal 'done'", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    const now = new Date().toISOString();
    await writeDoc(bundle, {
      id: "conventions/box2",
      frontmatter: {
        type: "Convention",
        governs: "Box2",
        fields: { required: ["title"], optional: [] },
        links: { contains: "Ticket2" },
        timestamp: now,
      },
      body: "",
    });
    await writeDoc(bundle, {
      id: "conventions/ticket2",
      frontmatter: {
        type: "Convention",
        governs: "Ticket2",
        fields: {
          required: ["title", "stage"],
          optional: [],
          values: { stage: ["open", "in_review", "resolved", "archived"] },
          terminal: { stage: ["resolved", "archived"] },
        },
        expects_inbound: { contains: "Box2" },
        timestamp: now,
      },
      body: "A GENERIC (non-status) enum field name, to pin nothing is hardcoded to 'status'/'done'.",
    });
    await writeDoc(bundle, {
      id: "items/open-ticket",
      frontmatter: { type: "Ticket2", title: "Open", stage: "open", timestamp: now },
      body: "",
    });
    await writeDoc(bundle, {
      id: "items/resolved-ticket",
      frontmatter: { type: "Ticket2", title: "Resolved", stage: "resolved", timestamp: now },
      body: "",
    });

    const result = await runJson(["--dir", dir]);
    assert.equal(result.missing_expected_links, 1, "only open-ticket; resolved-ticket is terminal-excluded");
    assert.equal(result.terminal_skipped, 1);
    const missing = result.missing_expected_links_rows as { rows: Record<string, unknown>[] };
    assert.deepEqual(missing.rows.map((r) => r.id), ["items/open-ticket"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── tasks/view-entry-dangling-lint: dangling_view_entries + invalid_view_registrations ─────────
//
// A deliberately CONVENTIONS-FREE fixture (zero Convention docs): recognition rides core's
// `isPageTypeName`/`parseRegistration` (the same predicates the ui launcher/server consume), so
// an externally-authored bundle with no declared kinds must get the exact same signals.
//   - `views-registry/dashboard`    — type View, entry blob WRITTEN -> resolvable, never a row.
//   - `views-registry/ghost`        — type View, entry names a never-promoted blob -> dangling.
//   - `pages-registry/legacy-ghost` — type View at the LEGACY locations, entry blob missing ->
//                                     dangling (legacy-location registrations are covered too).
//   - `pages-registry/retired`      — legacy TYPE Page: no longer a registration at all — it
//                                     must appear in NEITHER View lint (legacy_naming is its
//                                     designated finding, pinned below).
//   - `views-registry/bad-entry`    — type View, entry under a non-entry prefix: fails the entry
//                                     grammar -> invalid registration (leg 'entry').
//   - `notes/view-shaped`           — type View but NOT under a registry prefix: fails the id
//                                     grammar -> invalid registration (leg 'id'), never dangling.
async function makeViewEntryFixtureBundle(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await tempDir();
  const bundle = await initBundle(dir);
  const now = new Date().toISOString();

  await writeDoc(bundle, {
    id: "views-registry/dashboard",
    frontmatter: { type: "View", title: "Dashboard", entry: "views/dashboard.html", timestamp: now },
    body: "A registered View whose entry blob exists.",
  });
  await writeBlob(bundle, "views/dashboard.html", new TextEncoder().encode("<!doctype html>"), "text/html");
  await writeDoc(bundle, {
    id: "views-registry/ghost",
    frontmatter: { type: "View", title: "Ghost", entry: "views/ghost.html", timestamp: now },
    body: "A registered View whose entry blob was never promoted.",
  });
  await writeDoc(bundle, {
    id: "pages-registry/legacy-ghost",
    frontmatter: { type: "View", title: "Legacy Ghost", entry: "pages/legacy-ghost.html", timestamp: now },
    body: "A View registration at the legacy locations, also dangling.",
  });
  await writeDoc(bundle, {
    id: "pages-registry/retired",
    frontmatter: { type: "Page", title: "Retired", entry: "pages/retired.html", timestamp: now },
    body: "A legacy Page-TYPED doc — no longer recognized as a registration at all.",
  });
  await writeDoc(bundle, {
    id: "views-registry/bad-entry",
    frontmatter: { type: "View", title: "Bad Entry", entry: "other/nope.html", timestamp: now },
    body: "Registry id is valid but the entry key fails the entry grammar.",
  });
  await writeDoc(bundle, {
    id: "notes/view-shaped",
    frontmatter: { type: "View", title: "View Shaped", entry: "views/whatever.html", timestamp: now },
    body: "type View but the id fails the registry-id grammar.",
  });

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("status: dangling_view_entries reports recognized View registrations (legacy LOCATIONS included) whose entry blob does not exist; a Page-TYPED doc lands in legacy_naming instead", async () => {
  const { dir, cleanup } = await makeViewEntryFixtureBundle();
  try {
    const result = await runJson(["--dir", dir]);
    // ZERO declared kinds — the signal needs no convention (core-predicate recognition only).
    assert.equal(result.kinds, 0);
    assert.equal(result.dangling_view_entries, 2);
    const dangling = result.dangling_view_entries_rows as {
      shown: number;
      total: number;
      rows: Record<string, unknown>[];
    };
    assert.equal(dangling.shown, 2);
    assert.equal(dangling.total, 2);
    // Exactly the two dangling registrations (current AND legacy-located), each naming
    // id -> entry key; the resolvable registration, the two INVALID View-typed docs, and the
    // retired Page-typed doc never appear here.
    assert.deepEqual(dangling.rows, [
      { id: "pages-registry/legacy-ghost", entry: "pages/legacy-ghost.html" },
      { id: "views-registry/ghost", entry: "views/ghost.html" },
    ]);
    // The invalid docs land in their OWN category, each naming the failing grammar leg.
    assert.equal(result.invalid_view_registrations, 2);
    const invalid = result.invalid_view_registrations_rows as {
      shown: number;
      total: number;
      rows: Record<string, unknown>[];
    };
    assert.deepEqual(invalid.rows, [
      { id: "notes/view-shaped", problem: "id" },
      { id: "views-registry/bad-entry", problem: "entry" },
    ]);
    // RED-PROBE ANCHOR (tasks/remove-legacy-page-bridge-support): the Page-typed doc fell OUT of
    // View-surface recognition — its loud diagnostic is the legacy_naming FINDING, which names
    // it and points at the migration script. Removal must never equal silence.
    const legacy = result.legacy_naming as Record<string, unknown>;
    assert.ok(legacy, "a bundle with Page-typed stock must carry the legacy_naming finding");
    assert.equal(legacy.page_typed_docs, 1);
    assert.deepEqual((legacy.page_typed_rows as { rows: { id: string }[] }).rows, [{ id: "pages-registry/retired" }]);
    assert.match(String(legacy.help), /migrate-legacy-view-names/);
  } finally {
    await cleanup();
  }
});

test("status: dangling_view_entries is PRESENT at 0 (row block omitted) when every registration's entry resolves", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "views-registry/dashboard",
      frontmatter: { type: "View", title: "Dashboard", entry: "views/dashboard.html" },
      body: "",
    });
    await writeBlob(bundle, "views/dashboard.html", new TextEncoder().encode("<!doctype html>"), "text/html");
    const result = await runJson(["--dir", dir]);
    assert.equal(result.dangling_view_entries, 0);
    assert.equal("dangling_view_entries_rows" in result, false, "the row block is still omitted when empty");
    assert.equal(result.invalid_view_registrations, 0);
    assert.equal("invalid_view_registrations_rows" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: both View-surface counters are ABSENT on a bundle with no View-typed docs (byte-identity for view-free bundles)", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "notes/plain",
      frontmatter: { type: "Concept", title: "Plain" },
      body: "No View/Page registrations anywhere.",
    });
    const result = await runJson(["--dir", dir]);
    assert.equal("dangling_view_entries" in result, false);
    assert.equal("dangling_view_entries_rows" in result, false);
    assert.equal("invalid_view_registrations" in result, false);
    assert.equal("invalid_view_registrations_rows" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: invalid_view_registrations catches docs the STRICT authoring path ('new \"View\"' with the canonical convention) accepts silently — both an off-grammar entry and an off-prefix id", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    // The canonical View convention (examples/views/conventions/view.md): required
    // title/entry/access, access enum, auto-prefix path views-registry/. Kind validation checks
    // field PRESENCE and enums — not the registration grammar — which is exactly the gap.
    await writeDoc(bundle, {
      id: "conventions/view",
      frontmatter: {
        type: "Convention",
        title: "View",
        governs: "View",
        path: "views-registry/",
        fields: {
          required: ["title", "entry", "access"],
          optional: ["description"],
          values: { access: ["none", "bundle-read", "bundle-propose"] },
          terminal: {},
        },
        timestamp: new Date().toISOString(),
      },
      body: "The View kind.",
    });
    const silent = { stdout: () => {} };
    // Reproduction (a): a wrong-prefix entry key — strict `new` accepts it without a warning.
    await newCommand(
      ["View", "wrong-entry", "--title", "Wrong Entry", "--entry", "other/missing.html", "--access", "none", "--dir", dir],
      silent,
    );
    // Reproduction (b): --no-prefix puts the id OUTSIDE the registry prefix while the entry blob
    // genuinely exists — unservable despite a perfectly real blob.
    await newCommand(
      ["View", "notes/offpath", "--no-prefix", "--title", "Offpath", "--entry", "views/offpath.html", "--access", "none", "--dir", dir],
      silent,
    );
    await writeBlob(bundle, "views/offpath.html", new TextEncoder().encode("<!doctype html>"), "text/html");

    const result = await runJson(["--dir", dir]);
    // The reviewer-reproduced silence: kind validation is clean on BOTH docs...
    assert.equal(result.kind_warnings, 0);
    assert.equal(result.conformance_debt, 0);
    // ...and THIS lint is now the diagnostic, naming each failing grammar leg.
    assert.equal(result.invalid_view_registrations, 2);
    const invalid = result.invalid_view_registrations_rows as { rows: Record<string, unknown>[] };
    assert.deepEqual(invalid.rows, [
      { id: "notes/offpath", problem: "id" },
      { id: "views-registry/wrong-entry", problem: "entry" },
    ]);
    // Neither doc is a valid registration, so neither can be a dangling row (present at 0).
    assert.equal(result.dangling_view_entries, 0);
    assert.equal("dangling_view_entries_rows" in result, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: a malformed optional entry_version names that exact invalid registration leg", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "views-registry/bad-pin",
      frontmatter: {
        type: "View",
        title: "Bad pin",
        entry: "views/bad-pin.html",
        entry_version: "sha256:not-a-version",
        access: "none",
      },
      body: "",
    });
    const result = await runJson(["--dir", dir]);
    assert.equal(result.invalid_view_registrations, 1);
    const invalid = result.invalid_view_registrations_rows as { rows: Record<string, unknown>[] };
    assert.deepEqual(invalid.rows, [
      { id: "views-registry/bad-pin", problem: "entry_version" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: --limit caps the View-surface row blocks (dangling_view_entries_rows + invalid_view_registrations_rows); counters keep the TOTAL; --limit 0 is unlimited", async () => {
  const { dir, cleanup } = await makeViewEntryFixtureBundle(); // 2 dangling rows + 2 invalid rows
  try {
    const capped = await runJson(["--dir", dir, "--limit", "1"]);
    assert.equal(capped.dangling_view_entries, 2, "the counter reports the total, not the cap");
    assert.equal(capped.invalid_view_registrations, 2);
    for (const key of ["dangling_view_entries_rows", "invalid_view_registrations_rows"]) {
      const block = capped[key] as { shown: number; total: number; rows: unknown[] };
      assert.equal(block.shown, 1, `${key}: shown respects --limit 1`);
      assert.equal(block.total, 2, `${key}: total stays honest under the cap`);
      assert.equal(block.rows.length, 1);
    }

    const unlimited = await runJson(["--dir", dir, "--limit", "0"]);
    for (const key of ["dangling_view_entries_rows", "invalid_view_registrations_rows"]) {
      const block = unlimited[key] as { shown: number; total: number; rows: unknown[] };
      assert.equal(block.shown, 2, `${key}: --limit 0 shows every row`);
      assert.equal(block.total, 2);
      assert.equal(block.rows.length, 2);
    }
  } finally {
    await cleanup();
  }
});

test("status: --limit caps each category's row list with an explicit shown/total; --limit 0 is unlimited", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const capped = await runJson(["--dir", dir, "--limit", "1"]);
    const lint = capped.kind_lint as { shown: number; total: number; rows: unknown[] };
    assert.equal(lint.shown, 1);
    assert.equal(lint.total, 2);
    assert.equal(lint.rows.length, 1);

    const unlimited = await runJson(["--dir", dir, "--limit", "0"]);
    const lintUnlimited = unlimited.kind_lint as { shown: number; total: number; rows: unknown[] };
    assert.equal(lintUnlimited.shown, 2);
    assert.equal(lintUnlimited.total, 2);
  } finally {
    await cleanup();
  }
});

test("status: a malformed --limit is a USAGE error (exit 2)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    await assert.rejects(
      () => status(["--dir", dir, "--limit", "not-a-number", "--json"]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("status: exit is ALWAYS 0 when the analysis runs, findings or not; no bundle is NOT_FOUND (exit 6)", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    // A bundle FULL of findings still resolves without throwing (exit 0) — findings are reports.
    await status(["--dir", dir], { stdout: () => {} });
  } finally {
    await cleanup();
  }

  const emptyDir = await tempDir();
  try {
    await assert.rejects(
      () => status(["--dir", emptyDir]),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "NOT_FOUND");
        assert.equal(err.exitCode, 6);
        return true;
      },
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("status: TOON (agent-facing default, no --json) renders the summary keys", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    let out = "";
    await status(["--dir", dir], { stdout: (s) => (out += s) });
    for (const key of [
      "docs:",
      "kinds:",
      "kind_warnings:",
      "unresolved_links:",
      "orphans:",
      "stale:",
      "no_timestamp:",
      "registry_warnings:",
      "link_type_violations:",
      "missing_expected_links:",
    ]) {
      assert.ok(out.includes(key), `expected TOON output to contain '${key}', got:\n${out}`);
    }
  } finally {
    await cleanup();
  }
});

test("--remote: status against a served bundle is identical to the same bundle read locally", async () => {
  const { dir, cleanup } = await makeFixtureBundle();
  try {
    const local = await runJson(["--dir", dir]);
    const handle: ServerHandle = await serve({ bundle: { root: dir } as Bundle, port: 0 });
    try {
      const url = `http://${handle.host}:${handle.port}`;
      const remote = await runJson(["--remote", url]);
      // Every field is deterministic EXCEPT `stale_docs[].age_ms`, which is `now - timestamp`
      // recomputed at each invocation's own instant — the two calls run moments apart, so the
      // raw ms values legitimately differ. Compare those separately (both exceed the horizon,
      // and are within a generous jitter window of each other) and deep-equal everything else.
      const localStale = (local.stale_docs as { rows: Record<string, unknown>[] } | undefined)?.rows ?? [];
      const remoteStale = (remote.stale_docs as { rows: Record<string, unknown>[] } | undefined)?.rows ?? [];
      assert.equal(remoteStale.length, localStale.length);
      for (let i = 0; i < localStale.length; i++) {
        assert.equal(remoteStale[i]!.id, localStale[i]!.id);
        assert.equal(remoteStale[i]!.horizon_ms, localStale[i]!.horizon_ms);
        assert.ok((localStale[i]!.age_ms as number) > (localStale[i]!.horizon_ms as number));
        assert.ok((remoteStale[i]!.age_ms as number) > (remoteStale[i]!.horizon_ms as number));
        assert.ok(
          Math.abs((remoteStale[i]!.age_ms as number) - (localStale[i]!.age_ms as number)) < 5_000,
          "age_ms should be within a few seconds across the two invocations",
        );
      }
      const stripAge = (v: Record<string, unknown>): Record<string, unknown> => {
        const clone = structuredClone(v);
        if (clone.stale_docs) {
          (clone.stale_docs as { rows: Record<string, unknown>[] }).rows = (
            clone.stale_docs as { rows: Record<string, unknown>[] }
          ).rows.map(({ age_ms, ...rest }) => rest);
        }
        return clone;
      };
      assert.deepEqual(stripAge(remote), stripAge(local));
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup();
  }
});

test("status reports a corrupt doc as the `malformed` finding instead of crashing", async () => {
  const dir = await tempDir();
  try {
    const bundle = await initBundle(dir);
    await writeDoc(bundle, {
      id: "notes/good",
      frontmatter: { type: "Concept", title: "Good", timestamp: "2026-07-01T00:00:00.000Z" },
      body: "",
    });
    // A doc with an unterminated YAML flow sequence — js-yaml cannot parse it.
    await mkdir(path.join(dir, "notes"), { recursive: true });
    await writeFile(path.join(dir, "notes", "bad.md"), "---\ntype: [unclosed\ntitle: bad\n---\nbody\n");

    const out = await runJson(["--dir", dir]);
    // The report runs (exit 0, no crash) and headlines the corrupt doc.
    assert.equal(out.malformed, 1);
    const block = out.malformed_docs as { total: number; rows: Array<{ id: string; reason: string }> };
    assert.equal(block.total, 1);
    assert.equal(block.rows[0]?.id, "notes/bad");
    assert.ok((block.rows[0]?.reason ?? "").length > 0);
    // The healthy doc is still counted in the scan.
    assert.equal(out.docs, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
