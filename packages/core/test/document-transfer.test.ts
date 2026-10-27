import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDocumentRefresh,
  applyDocumentTransfer,
  planDocumentRefresh,
  planDocumentTransfer,
  resumeDocumentTransfer,
  TransferConflictError,
  TransferInterrupted,
  TransferPlanChanged,
  TransferResumeConflict,
  type LinkRewrite,
  type RefreshRequest,
  type TransferRequest,
} from "../src/document-transfer.js";
import { emitLinkHref } from "../src/link-emit.js";
import { extractMarkdownLinkSpans, extractMarkdownLinks, resolveConceptId, rewriteMarkdownLinks } from "../src/links.js";
import { MemoryBackend } from "../src/memory-backend.js";
import { parseQualifiedHref } from "../src/qualified-links.js";
import { InvalidInputError } from "../src/errors.js";
import type { BundleBinding } from "../src/cross-bundle.js";
import type { ConceptId, DeleteOptions, Frontmatter, OkfDocument, Version, WriteOptions } from "../src/types.js";

/** Every target in these tests refuses deletes: no transfer path may ever delete a document. */
class NoDeleteBackend extends MemoryBackend {
  deletes = 0;
  override async delete(id: ConceptId, options?: DeleteOptions): Promise<boolean> {
    this.deletes++;
    throw new Error(`document transfer must never delete (asked to delete '${id}' ${JSON.stringify(options ?? {})})`);
  }
}

const SOURCE_ID = "wave-bundle";
const TARGET_ID = "board-bundle";

async function put(backend: MemoryBackend, id: ConceptId, frontmatter: Frontmatter, body = ""): Promise<Version> {
  return backend.write(id, { id, frontmatter, body });
}

async function edition(backend: MemoryBackend): Promise<void> {
  await backend.writeReserved("", "index.md", "---\nokf_version: '0.2'\n---\n# Bundle\n");
}

interface Fixture {
  source: MemoryBackend;
  target: NoDeleteBackend;
  binding: BundleBinding;
  request: (overrides?: Partial<TransferRequest>) => TransferRequest;
}

async function fixture(options: { themeBody?: string; targetGovernsTheme?: boolean; target?: NoDeleteBackend } = {}): Promise<Fixture> {
  const source = new MemoryBackend();
  await edition(source);
  await put(source, "docs/bundle", { type: "Bundle Name", title: "Wave", bundle_id: SOURCE_ID });
  await put(source, "docs/dependencies", {
    type: "Bundle Dependencies",
    dependencies: {
      other: { bundle_id: "other-bundle" },
      same: { bundle_id: "same-bundle" },
      home: { bundle_id: TARGET_ID },
      ghost: { bundle_id: "ghost-bundle" },
    },
  });
  await put(source, "conventions/theme", { type: "Convention", governs: "Theme", fields: { required: ["title"] } });
  await put(source, "themes/a", {
    type: "Theme",
    title: "A",
    related: "themes/b",
    generated: { by: "human:author", at: "2026-10-01T00:00:00Z" },
  }, options.themeBody ?? "See [b](b.md) and [finding](../findings/f1.md).\n");
  await put(source, "themes/b", { type: "Theme", title: "B" }, "Back to [a](a.md#top).\n");
  await put(source, "findings/f1", { type: "Finding", title: "F1" }, "Evidence.\n");
  await put(source, "findings/f2", { type: "Finding", title: "F2" }, "Evidence.\n");
  await put(source, "memo", { type: "Memo", title: "Memo" }, "Themes: [a](themes/a.md), [b](/themes/b.md).\n");

  const target = options.target ?? new NoDeleteBackend();
  await edition(target);
  await put(target, "docs/bundle", { type: "Bundle Name", title: "Board", bundle_id: TARGET_ID });
  await put(target, "docs/dependencies", {
    type: "Bundle Dependencies",
    dependencies: {
      wave: { bundle_id: SOURCE_ID },
      oth: { bundle_id: "other-bundle" },
      same: { bundle_id: "same-bundle" },
    },
  });
  await put(target, "notes/n", { type: "Note", title: "N" }, "Board note.\n");
  if (options.targetGovernsTheme) {
    await put(target, "conventions/theme", { type: "Convention", governs: "Theme", fields: { required: ["title", "owner"] } });
  }

  const binding: BundleBinding = { backend: source, label: "../wave", identity: SOURCE_ID };
  const request = (overrides: Partial<TransferRequest> = {}): TransferRequest => ({
    target: { root: "/target", backend: target },
    from: { alias: "wave", binding },
    select: { types: ["Theme"], ids: ["memo"] },
    prefix: "imp",
    allowUngoverned: true,
    actor: "process:importer",
    now: () => "2026-10-22T12:00:00.000Z",
    ...overrides,
  });
  return { source, target, binding, request };
}

/** Plan with themes/a's body set to `body`, and return its rewrites and the plan. */
async function planWithBody(body: string) {
  const fx = await fixture({ themeBody: body });
  const plan = await planDocumentTransfer(fx.request());
  const entry = plan.entries.find((e) => e.source === "themes/a")!;
  return { plan, entry, rewrites: entry.rewrites };
}

// ── links.ts: the span extractor and offset rewriter ────────────────────────

test("extractMarkdownLinks is the span extractor without images, on every body shape", () => {
  const bodies = [
    "[a](x.md) ![img](i.png) [b](y.md#f)",
    "`[code](c.md)` [real](r.md)\n\n```\n[fenced](f.md)\n```\n",
    "[[nested]](n.md) [x] (no.md) [t](a b.md) ![](e.md)",
    "    [indented](i.md)\n\npara [p](p.md)",
  ];
  for (const body of bodies) {
    for (const skipCode of [false, true]) {
      const spans = extractMarkdownLinkSpans(body, { skipCode });
      assert.deepEqual(
        extractMarkdownLinks(body, { skipCode }),
        spans.filter((s) => !s.image).map((s) => ({ text: s.text, href: s.href })),
      );
      for (const span of spans) assert.equal(body.slice(span.hrefStart, span.hrefEnd), span.href);
    }
  }
  const [image] = extractMarkdownLinkSpans("x ![alt](pic.png)");
  assert.equal(image!.image, true);
  assert.equal(image!.start, 2);
});

test("rewriteMarkdownLinks replaces hrefs by offset and never touches text", () => {
  const body = "[a](a.md) then [a.md](a.md) and [keep](k.md)";
  const spans = extractMarkdownLinkSpans(body);
  const out = rewriteMarkdownLinks(body, spans, (s) => (s.href === "a.md" ? "../longer/a.md" : undefined));
  assert.equal(out, "[a](../longer/a.md) then [a.md](../longer/a.md) and [keep](k.md)");
  assert.throws(() => rewriteMarkdownLinks("[a](zz.md)", spans.slice(0, 1), () => "x.md"), InvalidInputError);
});

test("emitLinkHref reads its own output back and refuses what would not", () => {
  assert.equal(emitLinkHref({ kind: "local", from: "imp/themes/a", to: "imp/memo", fragment: "s" }), "../memo.md#s");
  assert.equal(emitLinkHref({ kind: "qualified", alias: "wave", id: "findings/f1" }), "okf://wave/findings/f1.md");
  assert.throws(() => emitLinkHref({ kind: "local", from: "a", to: "has space" }), InvalidInputError);
  assert.throws(() => emitLinkHref({ kind: "local", from: "a", to: "b", fragment: "x)y" }), InvalidInputError);
  assert.throws(() => emitLinkHref({ kind: "qualified", alias: "Bad", id: "x" }), InvalidInputError);
  assert.throws(() => emitLinkHref({ kind: "qualified", alias: "wave", id: "x", fragment: "a b" }), InvalidInputError);
});

// ── Link rewrite rules, one row per rule ──────────────────────────────────

interface RuleRow {
  name: string;
  body: string;
  kind: LinkRewrite["kind"];
  to?: string;
  reason?: LinkRewrite["reason"];
  present?: boolean;
  conflict?: string;
}

const RULES: RuleRow[] = [
  { name: "1 inline code", body: "`[t](../findings/f1.md)`", kind: "unchanged", reason: "in_code" },
  { name: "1 fenced code", body: "```\n[t](../findings/f1.md)\n```\n", kind: "unchanged", reason: "in_code" },
  { name: "1 indented code", body: "    [t](../findings/f1.md)\n", kind: "unchanged", reason: "in_code" },
  { name: "2 external", body: "[t](https://example.com/x.md)", kind: "unchanged", reason: "external" },
  { name: "2 mailto", body: "[t](mailto:a@example.com)", kind: "unchanged", reason: "external" },
  { name: "3 anchor", body: "[t](#section)", kind: "unchanged", reason: "anchor" },
  { name: "4 image", body: "![t](../findings/f1.md)", kind: "unchanged", reason: "image" },
  { name: "5 query", body: "[t](../findings/f1.md?x=1)", kind: "unchanged", reason: "has_query" },
  { name: "6 non-document", body: "[t](../files/chart.png)", kind: "unchanged", reason: "non_document" },
  { name: "7 escapes the root", body: "[t](../../../x.md)", kind: "unchanged", reason: "escapes_source_root" },
  { name: "8 reserved index", body: "[t](../index.md)", kind: "unchanged", reason: "non_document" },
  { name: "8 reserved log", body: "[t](log.md)", kind: "unchanged", reason: "non_document" },
  { name: "9 selected relative", body: "[t](b.md)", kind: "local", to: "b.md", present: true },
  { name: "9 selected with fragment", body: "[t](b.md#part)", kind: "local", to: "b.md#part", present: true },
  { name: "9 selected root-absolute", body: "[t](/memo.md)", kind: "local", to: "../memo.md", present: true },
  { name: "9 unselected existing", body: "[t](../findings/f1.md)", kind: "qualified", to: "okf://wave/findings/f1.md", present: true },
  { name: "9 unselected with fragment", body: "[t](../findings/f1.md#q)", kind: "qualified", to: "okf://wave/findings/f1.md#q", present: true },
  { name: "9 unselected root-absolute", body: "[t](/findings/f2.md)", kind: "qualified", to: "okf://wave/findings/f2.md", present: true },
  { name: "9 absent in source", body: "[t](../findings/gone.md)", kind: "qualified", to: "okf://wave/findings/gone.md", present: false },
  { name: "9 not qualifiable", body: "[t](../.hidden/x.md)", kind: "unchanged", reason: "not_qualifiable" },
  { name: "10 same alias", body: "[t](okf://same/x.md)", kind: "unchanged", reason: "already_qualified" },
  { name: "10 different alias", body: "[t](okf://other/x.md#f)", kind: "qualified", to: "okf://oth/x.md#f" },
  { name: "10 undeclared in target", body: "[t](okf://ghost/x.md)", kind: "unchanged", reason: "already_qualified", conflict: "qualified_alias_mismatch" },
  { name: "10 undeclared in source", body: "[t](okf://nobody/x.md)", kind: "unchanged", reason: "already_qualified", conflict: "qualified_alias_mismatch" },
  { name: "10 dequalify to the target's own id", body: "[t](okf://home/notes/n.md#f)", kind: "dequalified", to: "../../notes/n.md#f" },
  { name: "10 malformed", body: "[t](okf://Bad/x.md)", kind: "unchanged", reason: "invalid_qualified" },
  { name: "9 case variant of a source id stays unchanged", body: "[t](A.md)", kind: "unchanged", reason: "case_variant" },
  { name: "9 case variant of an unselected source id stays unchanged", body: "[t](../Findings/f1.md)", kind: "unchanged", reason: "case_variant" },
  { name: "reference definition is reported, not rewritten", body: "See [x].\n\n[x]: ../findings/f1.md", kind: "unchanged", reason: "reference_definition" },
];

for (const row of RULES) {
  test(`link rule ${row.name}`, async () => {
    const { plan, rewrites } = await planWithBody(`${row.body}\n`);
    assert.equal(rewrites.length, 1, JSON.stringify(rewrites));
    const rewrite = rewrites[0]!;
    assert.equal(rewrite.kind, row.kind);
    if (row.reason) assert.equal(rewrite.reason, row.reason);
    if (row.to) assert.equal(rewrite.to_href, row.to);
    if (row.kind === "unchanged") assert.equal(rewrite.to_href, rewrite.from_href);
    if (row.present !== undefined) assert.equal(rewrite.target_present_in_source, row.present);
    if (row.conflict) {
      assert.equal(plan.ready, false);
      assert.ok(plan.conflicts.some((c) => c.code === row.conflict && c.source === "themes/a"), JSON.stringify(plan.conflicts));
    } else {
      assert.equal(plan.ready, true, JSON.stringify(plan.conflicts));
    }
    // Round trip: every emitted href reads back to what it was planned to name.
    if (rewrite.kind === "local") {
      assert.equal(resolveConceptId("imp/themes/a", rewrite.to_href), `imp/${rewrite.source_target}`);
    } else if (rewrite.kind === "qualified") {
      assert.ok(parseQualifiedHref(rewrite.to_href).ok);
    }
  });
}

test("a body rewrite changes only hrefs and counts dangling links", async () => {
  const body = "Intro [b](b.md), [f](../findings/f1.md), [gone](../findings/gone.md), `[c](b.md)`, ![i](x.png).\n";
  const { plan, entry } = await planWithBody(body);
  const fx = await fixture({ themeBody: body });
  const applied = await applyDocumentTransfer(fx.request(), plan.plan_token!);
  assert.equal(applied.written.length, 3);
  const doc = (await fx.target.read("imp/themes/a")).doc;
  assert.equal(doc.body, "Intro [b](b.md), [f](okf://wave/findings/f1.md), [gone](okf://wave/findings/gone.md), `[c](b.md)`, ![i](x.png).\n");
  assert.deepEqual(entry.rewrite_counts, { local: 1, qualified: 2, dequalified: 0, unchanged: 2 });
  assert.equal(plan.counts.dangling_in_source, 1);
});

// ── Plan shape, provenance and the record ───────────────────────────────────

test("plan maps ids under the prefix, reports left-behind types, mentions and the record", async () => {
  const fx = await fixture();
  const plan = await planDocumentTransfer(fx.request());
  assert.equal(plan.ready, true, JSON.stringify(plan.conflicts));
  assert.deepEqual(plan.entries.map((e) => [e.source, e.target]), [
    ["memo", "imp/memo"],
    ["themes/a", "imp/themes/a"],
    ["themes/b", "imp/themes/b"],
  ]);
  assert.deepEqual(plan.left_behind, { Convention: 1, Finding: 2 }, "the source's own identity and dependency docs are not counted");
  assert.deepEqual(plan.entries.find((e) => e.source === "themes/a")!.frontmatter_id_mentions, ["themes/b"]);
  assert.equal(plan.entries[0]!.kind_state, "ungoverned_both");
  assert.equal(plan.entries[1]!.kind_state, "allowed_ungoverned");
  assert.match(plan.record.id, /^promotions\/wave-[0-9a-f]{12}$/);
  assert.match(plan.plan_token!, /^document-transfer\/v1:sha256:[0-9a-f]{64}$/);
  assert.equal(plan.record.frontmatter.promotion_state, "applying");
  assert.deepEqual(await planDocumentTransfer(fx.request()), plan, "planning is deterministic and read-only");
});

test("apply keeps generated byte for byte, appends one sources entry and closes the record", async () => {
  const fx = await fixture();
  const plan = await planDocumentTransfer(fx.request());
  const result = await applyDocumentTransfer(fx.request(), plan.plan_token!);
  assert.deepEqual(result.written.map((w) => w.target), ["imp/memo", "imp/themes/a", "imp/themes/b"]);
  const a = (await fx.target.read("imp/themes/a")).doc;
  assert.deepEqual(a.frontmatter.generated, { by: "human:author", at: "2026-10-01T00:00:00Z" });
  assert.equal(a.frontmatter.related, "themes/b", "frontmatter is copied verbatim");
  assert.equal(a.frontmatter.superbee_updated_by, "process:importer");
  const sources = a.frontmatter.sources as Array<Record<string, string>>;
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0], {
    resource: "okf://wave/themes/a.md",
    id: plan.record.id,
    title: `Imported from ${SOURCE_ID} at ${(await fx.source.read("themes/a")).version}`,
  });
  assert.equal(a.body, "See [b](b.md) and [finding](okf://wave/findings/f1.md).\n");
  assert.equal((await fx.target.read("imp/memo")).doc.body, "Themes: [a](themes/a.md), [b](themes/b.md).\n");
  const record = (await fx.target.read(plan.record.id)).doc;
  assert.equal(record.frontmatter.type, "Promotion");
  assert.equal(record.frontmatter.promotion_state, "applied");
  assert.equal(record.frontmatter.plan_token, plan.plan_token);
  for (const row of record.frontmatter.entries as Array<Record<string, string>>) {
    assert.equal(row.target_version, (await fx.target.read(row.target!)).version);
  }
  assert.match(record.body, /\[imported\]\(\.\.\/imp\/themes\/a\.md\) \[from\]\(okf:\/\/wave\/themes\/a\.md\)/);
  assert.equal(result.record.version, (await fx.target.read(plan.record.id)).version);
  assert.equal(fx.target.deletes, 0);
});

// ── Conflicts, one per code ────────────────────────────────────────────────

async function conflictsOf(fx: Fixture, overrides: Partial<TransferRequest> = {}) {
  const plan = await planDocumentTransfer(fx.request(overrides));
  assert.equal(plan.ready, false);
  assert.equal(plan.plan_token, undefined);
  await assert.rejects(applyDocumentTransfer(fx.request(overrides), "document-transfer/v1:sha256:00"), TransferConflictError);
  return plan.conflicts.map((c) => c.code);
}

test("conflict alias_undeclared", async () => {
  const fx = await fixture();
  const binding = { ...fx.binding };
  assert.ok((await conflictsOf(fx, { from: { alias: "nope", binding } })).includes("alias_undeclared"));
});

test("conflict alias_identity: wrong identity, missing identity, failing pin", async () => {
  const fx = await fixture();
  assert.ok((await conflictsOf(fx, { from: { alias: "wave", binding: { ...fx.binding, identity: "imposter" } } })).includes("alias_identity"));
  assert.ok((await conflictsOf(fx, { from: { alias: "wave", binding: { backend: fx.source, label: "x" } } })).includes("alias_identity"));
  await put(fx.target, "docs/dependencies", { type: "Bundle Dependencies", dependencies: { wave: { bundle_id: SOURCE_ID, pin: "abcdef1" } } });
  const pinned = { ...fx.binding, pin: async () => ({ ok: false as const, detail: "moved" }) };
  assert.ok((await conflictsOf(fx, { from: { alias: "wave", binding: pinned } })).includes("alias_identity"));
});

test("conflict selection_empty, source_missing, source_malformed", async () => {
  const fx = await fixture();
  assert.deepEqual(await conflictsOf(fx, { select: { types: ["Nothing"] } }), ["selection_empty"]);
  assert.ok((await conflictsOf(fx, { select: { ids: ["themes/zzz"] } })).includes("source_missing"));
  assert.ok((await conflictsOf(fx, { select: { ids: ["docs/bundle"] } })).includes("source_missing"));
  await put(fx.source, "themes/c", { type: "Theme", title: "C", sources: "not a list" });
  assert.ok((await conflictsOf(fx)).includes("source_malformed"));
});

test("conflict target_exists and record_exists", async () => {
  const fx = await fixture();
  const plan = await planDocumentTransfer(fx.request());
  await put(fx.target, "imp/themes/b", { type: "Theme", title: "occupied" });
  await put(fx.target, plan.record.id, { type: "Note", title: "occupied" });
  const codes = await conflictsOf(fx);
  assert.ok(codes.includes("target_exists"));
  assert.ok(codes.includes("record_exists"));
  assert.equal((await fx.target.read("imp/themes/b")).doc.frontmatter.title, "occupied");
});

test("conflict duplicate_target and unsafe_target_id", async () => {
  const fx = await fixture();
  assert.ok((await conflictsOf(fx, { recordId: "imp/themes/b" })).includes("duplicate_target"));
  assert.ok((await conflictsOf(fx, { recordId: "promotions/index" })).includes("unsafe_target_id"));
  assert.ok((await conflictsOf(fx, { prefix: "a//b" })).includes("unsafe_target_id"));
});

test("an import never writes the target's identity, dependencies or a Kind convention", async () => {
  const fx = await fixture();
  await put(fx.source, "bundle", { type: "Bundle Name", title: "evil", bundle_id: "evil-id" });
  await put(fx.source, "dependencies", { type: "Bundle Dependencies", title: "evil" });
  await put(fx.source, "theme2", { type: "Convention", governs: "Theme", fields: { required: ["nothing"] } });
  for (const [ids, prefix] of [[["bundle"], "docs"], [["dependencies"], "docs"], [["bundle"], "DOCS"], [["theme2"], "conventions"], [["theme2"], "Conventions"]] as const) {
    const plan = await planDocumentTransfer(fx.request({ select: { ids: [...ids] }, prefix }));
    assert.equal(plan.ready, false, `${prefix}/${ids[0]}`);
    assert.ok(plan.conflicts.some((c) => c.code === "unsafe_target_id"), JSON.stringify(plan.conflicts));
  }
  assert.ok((await conflictsOf(fx, { recordId: "conventions/promotion" })).includes("unsafe_target_id"));
  assert.ok((await conflictsOf(fx, { recordId: "docs/bundle" })).includes("unsafe_target_id"));
  assert.equal(await fx.target.exists("conventions/theme2"), false);
});

test("conflict case_collision under the filesystem identity fold", async () => {
  const fx = await fixture();
  await put(fx.target, "IMP/other", { type: "Note", title: "upper" });
  assert.ok((await conflictsOf(fx)).includes("case_collision"));
  const again = await fixture();
  assert.ok((await conflictsOf(again, { prefix: "Notes/N" })).every((code) => code === "case_collision"));
});

test("conflict kind_missing unless ungoverned is allowed; governed both validates against the target", async () => {
  const fx = await fixture();
  assert.deepEqual(await conflictsOf(fx, { allowUngoverned: false }), ["kind_missing"]);
  const governed = await fixture({ targetGovernsTheme: true });
  const plan = await planDocumentTransfer(governed.request({ allowUngoverned: false }));
  assert.equal(plan.ready, true, JSON.stringify(plan.conflicts));
  const a = plan.entries.find((e) => e.source === "themes/a")!;
  assert.equal(a.kind_state, "governed_both");
  assert.ok(a.validation_warnings.some((w) => w.field === "owner"), "warnings come from the target Kind");
});

test("conflict qualified_alias_mismatch", async () => {
  const { plan } = await planWithBody("[t](okf://ghost/x.md)\n");
  assert.deepEqual(plan.conflicts.map((c) => c.code), ["qualified_alias_mismatch"]);
});

// ── Plan token staleness ───────────────────────────────────────────────────

test("a source edit between plan and apply refuses with nothing written", async () => {
  const fx = await fixture();
  const plan = await planDocumentTransfer(fx.request());
  const before = await fx.target.list();
  await put(fx.source, "themes/b", { type: "Theme", title: "B edited" }, "Back to [a](a.md#top).\n");
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferPlanChanged);
  assert.deepEqual(await fx.target.list(), before);
});

test("a target create of a mapped id between plan and apply refuses with nothing written", async () => {
  const fx = await fixture();
  const plan = await planDocumentTransfer(fx.request());
  await put(fx.target, "imp/memo", { type: "Memo", title: "raced" });
  const before = await fx.target.list();
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), (error: unknown) =>
    error instanceof TransferConflictError && error.conflicts.some((c) => c.code === "target_exists" && c.target === "imp/memo"));
  assert.deepEqual(await fx.target.list(), before);
  assert.equal((await fx.target.read("imp/memo")).doc.frontmatter.title, "raced");
});

test("a dependencies change between plan and apply refuses with nothing written", async () => {
  const fx = await fixture();
  const plan = await planDocumentTransfer(fx.request());
  const before = await fx.target.list();
  await put(fx.target, "docs/dependencies", {
    type: "Bundle Dependencies",
    dependencies: { wave: { bundle_id: SOURCE_ID }, oth: { bundle_id: "other-bundle" }, same: { bundle_id: "same-bundle" }, extra: { bundle_id: "extra-bundle" } },
  });
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferPlanChanged);
  assert.deepEqual(await fx.target.list(), before);
});

test("a governing convention change between plan and apply refuses", async () => {
  const fx = await fixture({ targetGovernsTheme: true });
  const plan = await planDocumentTransfer(fx.request());
  await put(fx.target, "conventions/theme", { type: "Convention", governs: "Theme", fields: { required: ["title"] } });
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferPlanChanged);
});

// ── Concurrent create, interruption and resume ──────────────────────────────

/** A target where another writer creates `raceId` just before the import's own create of it. */
class RacingBackend extends NoDeleteBackend {
  readonly raceId: ConceptId;
  constructor(raceId: ConceptId) { super(); this.raceId = raceId; }
  raced = false;
  override async write(id: ConceptId, doc: OkfDocument, options?: WriteOptions): Promise<Version> {
    if (id === this.raceId && !this.raced) {
      this.raced = true;
      await super.write(id, { id, frontmatter: { type: "Note", title: "concurrent writer" }, body: "theirs\n" });
    }
    return super.write(id, doc, options);
  }
}

test("a concurrent create during apply fails that create, keeps theirs and leaves the record applying", async () => {
  const fx = await fixture({ target: new RacingBackend("imp/themes/a") });
  const plan = await planDocumentTransfer(fx.request());
  const error = await applyDocumentTransfer(fx.request(), plan.plan_token!).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof TransferInterrupted, String(error));
  assert.deepEqual(error.written.map((w) => w.target), ["imp/memo"]);
  assert.deepEqual(error.pending.map((p) => p.target), ["imp/themes/a", "imp/themes/b"]);
  assert.match(error.message, /imp\/themes\/a/);
  assert.equal((await fx.target.read("imp/themes/a")).doc.body, "theirs\n", "never overwritten");
  assert.equal(await fx.target.exists("imp/themes/b"), false);
  const record = (await fx.target.read(plan.record.id)).doc;
  assert.equal(record.frontmatter.promotion_state, "applying");
  const rows = record.frontmatter.entries as Array<Record<string, string>>;
  assert.equal(rows.find((r) => r.target === "imp/memo")!.target_version, error.written[0]!.version);
  // Resume refuses the foreign document instead of adopting or replacing it.
  await assert.rejects(resumeDocumentTransfer({ root: "/t", backend: fx.target }, plan.record.id, { alias: "wave", binding: fx.binding }, { actor: "process:importer" }), TransferResumeConflict);
  assert.equal(fx.target.deletes, 0);
});

/** A target that crashes (a plain I/O error) on the k-th document create, once. */
class CrashingBackend extends NoDeleteBackend {
  readonly crashOn: ConceptId;
  constructor(crashOn: ConceptId) { super(); this.crashOn = crashOn; }
  crashed = false;
  override async write(id: ConceptId, doc: OkfDocument, options?: WriteOptions): Promise<Version> {
    if (id === this.crashOn && !this.crashed) {
      this.crashed = true;
      throw Object.assign(new Error("EIO: simulated crash"), { code: "EIO" });
    }
    return super.write(id, doc, options);
  }
}

for (const crashOn of ["imp/memo", "imp/themes/a", "imp/themes/b"]) {
  test(`resume after a crash on '${crashOn}' finishes to the uninterrupted state and is idempotent`, async () => {
    const reference = await fixture();
    const referencePlan = await planDocumentTransfer(reference.request());
    await applyDocumentTransfer(reference.request(), referencePlan.plan_token!);

    const fx = await fixture({ target: new CrashingBackend(crashOn) });
    const plan = await planDocumentTransfer(fx.request());
    assert.equal(plan.plan_token, referencePlan.plan_token);
    await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferInterrupted);
    assert.equal((await fx.target.read(plan.record.id)).doc.frontmatter.promotion_state, "applying");

    const bundle = { root: "/t", backend: fx.target };
    const from = { alias: "wave", binding: fx.binding };
    const options = { actor: "process:importer", now: () => "2026-10-22T12:00:00.000Z" };
    const first = await resumeDocumentTransfer(bundle, plan.record.id, from, options);
    assert.equal(first.record.state, "applied");
    for (const entry of plan.entries) {
      const got = (await fx.target.read(entry.target)).doc;
      const want = (await reference.target.read(entry.target)).doc;
      assert.deepEqual(got, want, `${entry.target} equals the uninterrupted import`);
    }
    const record = (await fx.target.read(plan.record.id)).doc;
    assert.equal(record.frontmatter.promotion_state, "applied");
    const second = await resumeDocumentTransfer(bundle, plan.record.id, from, options);
    assert.deepEqual({ ...second, changed: true }, first, "resume is idempotent");
    assert.equal(second.changed, false);
    assert.equal((await fx.target.read(plan.record.id)).version, first.record.version);
    assert.equal(fx.target.deletes, 0);
  });
}

test("applying the same token again after it completed is a no-op success", async () => {
  const fx = await fixture();
  const plan = await planDocumentTransfer(fx.request());
  const first = await applyDocumentTransfer(fx.request(), plan.plan_token!);
  assert.equal(first.changed, true);
  const snapshot = async () => Promise.all((await fx.target.list()).map(async (id) => [id, (await fx.target.read(id)).version]));
  const before = await snapshot();
  const again = await applyDocumentTransfer(fx.request(), plan.plan_token!);
  assert.equal(again.changed, false);
  assert.deepEqual(again.written, first.written);
  assert.deepEqual(again.record, first.record);
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(applyDocumentTransfer(fx.request(), "document-transfer/v1:sha256:other"), TransferConflictError);
});

test("an interrupted import's token applied again points at resume instead of writing", async () => {
  const fx = await fixture({ target: new CrashingBackend("imp/themes/a") });
  const plan = await planDocumentTransfer(fx.request());
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferInterrupted);
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), (error: unknown) =>
    error instanceof TransferConflictError && error.conflicts.length === 1 && /still applying/.test(error.conflicts[0]!.detail));
});

test("resume refuses a changed source, an unknown record and a foreign binding", async () => {
  const fx = await fixture({ target: new CrashingBackend("imp/themes/b") });
  const plan = await planDocumentTransfer(fx.request());
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferInterrupted);
  const bundle = { root: "/t", backend: fx.target };
  await assert.rejects(resumeDocumentTransfer(bundle, plan.record.id, { alias: "wave", binding: { ...fx.binding, identity: "imposter" } }), TransferResumeConflict);
  await assert.rejects(resumeDocumentTransfer(bundle, plan.record.id, { alias: "other", binding: fx.binding }), TransferResumeConflict);
  await assert.rejects(resumeDocumentTransfer(bundle, "promotions/none", { alias: "wave", binding: fx.binding }), /no concept document/);
  await put(fx.source, "themes/b", { type: "Theme", title: "B moved" });
  await assert.rejects(resumeDocumentTransfer(bundle, plan.record.id, { alias: "wave", binding: fx.binding }, { actor: "process:importer" }), (error: unknown) =>
    error instanceof TransferResumeConflict && /changed/.test(error.message));
  assert.equal(await fx.target.exists("imp/themes/b"), false);
  assert.equal(fx.target.deletes, 0);
});

/** An import interrupted before any document, whose record is then edited by `forge`. */
async function forgedRecord(forge: (fm: Frontmatter, fx: Fixture) => void | Promise<void>) {
  const fx = await fixture({ target: new CrashingBackend("imp/memo") });
  const plan = await planDocumentTransfer(fx.request());
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferInterrupted);
  const record = (await fx.target.read(plan.record.id)).doc;
  const frontmatter = structuredClone(record.frontmatter);
  await forge(frontmatter, fx);
  await fx.target.write(plan.record.id, { ...record, frontmatter });
  const resume = () => resumeDocumentTransfer({ root: "/t", backend: fx.target }, plan.record.id, { alias: "wave", binding: fx.binding }, { actor: "process:importer" });
  return { fx, plan, resume };
}

test("resume recomputes each target from the record's prefix and refuses a forged one", async () => {
  const { fx, resume } = await forgedRecord((fm) => {
    (fm.entries as Array<Record<string, string>>)[0]!.target = "elsewhere/stolen";
  });
  await assert.rejects(resume(), (error: unknown) => error instanceof TransferResumeConflict && /elsewhere\/stolen/.test(error.message));
  assert.equal(await fx.target.exists("elsewhere/stolen"), false);
  assert.equal(await fx.target.exists("imp/themes/a"), false, "nothing was written");
});

test("resume refuses a forged record that would install a convention or the target's identity", async () => {
  for (const [source, target] of [["conventions/theme", "conventions/theme"], ["docs/bundle", "docs/bundle"]] as const) {
    const { fx, resume } = await forgedRecord(async (fm, at) => {
      delete fm.target_prefix;
      const rows = fm.entries as Array<Record<string, string>>;
      // The forged entry carries the source's real version, so only the target rule can refuse it.
      rows[0] = { source, source_version: (await at.source.read(source)).version, target };
      for (const row of rows.slice(1)) row.target = row.source!;
    });
    await assert.rejects(resume(), (error: unknown) => error instanceof TransferResumeConflict && /may write|describes the source/.test(error.message), target);
    assert.equal((await fx.target.read("docs/bundle")).doc.frontmatter.bundle_id, TARGET_ID);
    assert.equal(await fx.target.exists("conventions/theme"), false);
  }
});

test("resume refuses when the target's alias now names another bundle", async () => {
  const { fx, resume } = await forgedRecord(() => undefined);
  await put(fx.target, "docs/dependencies", { type: "Bundle Dependencies", dependencies: { wave: { bundle_id: "impostor" } } });
  await assert.rejects(resume(), (error: unknown) => error instanceof TransferResumeConflict && /alias_identity/.test(error.message));
  assert.equal(await fx.target.exists("imp/memo"), false);
});

test("an invalid OKF actor is refused before anything is read or written", async () => {
  const fx = await fixture();
  await assert.rejects(planDocumentTransfer(fx.request({ actor: "not an actor" })), /must be human/);
});

// ── Refresh ────────────────────────────────────────────────────────────────

/** An applied import, plus a refresh request against its record. */
async function imported(options: { target?: NoDeleteBackend } = {}) {
  const fx = await fixture(options);
  const plan = await planDocumentTransfer(fx.request());
  await applyDocumentTransfer(fx.request(), plan.plan_token!);
  const recordId = plan.record.id;
  const refresh = (overrides: Partial<RefreshRequest> = {}): RefreshRequest => ({
    target: { root: "/target", backend: fx.target },
    recordId,
    from: { alias: "wave", binding: fx.binding },
    actor: "process:importer",
    now: () => "2026-10-23T12:00:00.000Z",
    ...overrides,
  });
  return { fx, recordId, refresh };
}

async function versionsOf(backend: MemoryBackend): Promise<Array<[string, string]>> {
  return Promise.all((await backend.list()).map(async (id) => [id, (await backend.read(id)).version] as [string, string]));
}

test("refresh of an unchanged source plans nothing and issues no token", async () => {
  const { refresh } = await imported();
  const plan = await planDocumentRefresh(refresh());
  assert.equal(plan.ready, true);
  assert.equal(plan.plan_token, undefined);
  assert.deepEqual(plan.counts, { update: 0, overwrite: 0, unchanged: 3, skip: 0, conflict: 0 });
});

test("refresh updates a changed source in place, rewrites its links and moves the record forward", async () => {
  const { fx, recordId, refresh } = await imported();
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Now see [b](b.md) and [f2](../findings/f2.md).\n");
  const plan = await planDocumentRefresh(refresh());
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.entries.map((e) => [e.target, e.action]), [["imp/memo", "unchanged"], ["imp/themes/a", "update"], ["imp/themes/b", "unchanged"]]);
  assert.equal(plan.entries[1]!.dropped_links, 1, "the finding link the new body no longer carries is reported");
  const result = await applyDocumentRefresh(refresh(), plan.plan_token!);
  assert.equal(result.changed, true);
  assert.deepEqual(result.written.map((w) => w.target), ["imp/themes/a"]);
  const a = await fx.target.read("imp/themes/a");
  assert.equal(a.doc.frontmatter.title, "A v2");
  assert.equal(a.doc.body, "Now see [b](b.md) and [f2](okf://wave/findings/f2.md).\n");
  const sourceVersion = (await fx.source.read("themes/a")).version;
  assert.deepEqual(a.doc.frontmatter.sources, [{ resource: "okf://wave/themes/a.md", id: recordId, title: `Imported from ${SOURCE_ID} at ${sourceVersion}` }]);
  const record = (await fx.target.read(recordId)).doc;
  assert.equal(record.frontmatter.promotion_state, "applied");
  assert.equal(record.frontmatter.refresh, undefined);
  assert.equal(record.frontmatter.refresh_token, plan.plan_token);
  const row = (record.frontmatter.entries as Array<Record<string, string>>).find((r) => r.target === "imp/themes/a")!;
  assert.deepEqual([row.source_version, row.target_version], [sourceVersion, a.version]);
  assert.equal((await planDocumentRefresh(refresh())).counts.unchanged, 3, "a refreshed copy is the new baseline");
  const before = await versionsOf(fx.target);
  const again = await applyDocumentRefresh(refresh(), plan.plan_token!);
  assert.equal(again.changed, false, "the same token again is a no-op success");
  assert.deepEqual(await versionsOf(fx.target), before);
  assert.equal(fx.target.deletes, 0);
});

test("refresh reports a locally edited copy as a conflict and never overwrites it silently", async () => {
  const { fx, refresh } = await imported();
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed.\n");
  await put(fx.source, "themes/b", { type: "Theme", title: "B v2" }, "Changed too.\n");
  const edited = await fx.target.read("imp/themes/a");
  await fx.target.write("imp/themes/a", { ...edited.doc, body: "Investor wording.\n" });
  const localVersion = (await fx.target.read("imp/themes/a")).version;

  const plan = await planDocumentRefresh(refresh());
  assert.equal(plan.ready, false);
  assert.equal(plan.plan_token, undefined);
  assert.deepEqual(plan.conflicts.map((c) => [c.code, c.target]), [["target_edited", "imp/themes/a"]]);
  assert.equal(plan.entries.find((e) => e.target === "imp/themes/a")!.edited, true);
  await assert.rejects(applyDocumentRefresh(refresh(), "document-transfer/v1:refresh:sha256:00"), TransferConflictError);
  assert.equal((await fx.target.read("imp/themes/a")).version, localVersion);

  // --skip keeps the local edit and refreshes the rest; the copy stays reported next time.
  const skipped = await planDocumentRefresh(refresh({ skip: ["imp/themes/a"] }));
  assert.deepEqual(skipped.entries.map((e) => e.action), ["unchanged", "skip", "update"]);
  await applyDocumentRefresh(refresh({ skip: ["imp/themes/a"] }), skipped.plan_token!);
  assert.equal((await fx.target.read("imp/themes/a")).doc.body, "Investor wording.\n");
  assert.equal((await fx.target.read("imp/themes/b")).doc.frontmatter.title, "B v2");
  assert.deepEqual((await planDocumentRefresh(refresh())).conflicts.map((c) => c.code), ["target_edited"]);

  // --overwrite (by source id) discards it deliberately.
  const overwritten = await planDocumentRefresh(refresh({ overwrite: ["themes/a"] }));
  assert.deepEqual(overwritten.entries.map((e) => e.action), ["unchanged", "overwrite", "unchanged"]);
  await applyDocumentRefresh(refresh({ overwrite: ["themes/a"] }), overwritten.plan_token!);
  assert.equal((await fx.target.read("imp/themes/a")).doc.body, "Changed.\n");
  assert.equal(fx.target.deletes, 0);
});

test("an edit to an unchanged source's copy is reported but not a conflict", async () => {
  const { fx, refresh } = await imported();
  const read = await fx.target.read("imp/memo");
  await fx.target.write("imp/memo", { ...read.doc, body: "Local.\n" });
  const plan = await planDocumentRefresh(refresh());
  assert.equal(plan.ready, true);
  const memo = plan.entries.find((e) => e.target === "imp/memo")!;
  assert.deepEqual([memo.action, memo.edited], ["unchanged", true]);
});

test("refresh conflicts: source gone, copy gone, unknown names, an unapplied record and a foreign alias", async () => {
  const { fx, refresh } = await imported();
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed.\n");
  await fx.source.delete("memo");
  await put(fx.source, "themes/b", { type: "Theme", title: "B v2" }, "Changed.\n");
  const plan = await planDocumentRefresh(refresh({ skip: ["nope"], overwrite: ["imp/themes/b"] }));
  assert.deepEqual(plan.conflicts.map((c) => c.code).sort(), ["not_in_record", "source_missing"]);
  assert.equal(plan.entries.find((e) => e.target === "imp/themes/b")!.action, "update", "overwrite of an unedited copy is an ordinary update");
  const both = await planDocumentRefresh(refresh({ skip: ["imp/memo"], overwrite: ["imp/memo"] }));
  assert.ok(both.conflicts.some((c) => c.code === "not_in_record" && /both/.test(c.detail)));
  assert.deepEqual((await planDocumentRefresh(refresh({ from: { alias: "other", binding: fx.binding } }))).conflicts.map((c) => c.code).includes("alias_identity"), true);
  assert.equal(fx.target.deletes, 0);
});

test("refresh never recreates a copy that was deleted in the target", async () => {
  const { fx, refresh } = await imported();
  await put(fx.source, "themes/b", { type: "Theme", title: "B v2" }, "Changed.\n");
  // The no-delete backend refuses deletes, so remove the copy beneath it.
  await MemoryBackend.prototype.delete.call(fx.target, "imp/themes/b");
  const plan = await planDocumentRefresh(refresh());
  assert.deepEqual(plan.conflicts.map((c) => [c.code, c.target]), [["target_missing", "imp/themes/b"]]);
  const skipped = await planDocumentRefresh(refresh({ skip: ["imp/themes/b"] }));
  assert.equal(skipped.ready, true);
  assert.equal(skipped.plan_token, undefined);
  assert.equal(await fx.target.exists("imp/themes/b"), false);
});

test("a copy edited between plan and apply refuses with nothing written", async () => {
  const { fx, recordId, refresh } = await imported();
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed.\n");
  const plan = await planDocumentRefresh(refresh());
  const read = await fx.target.read("imp/themes/a");
  await fx.target.write("imp/themes/a", { ...read.doc, body: "Raced.\n" });
  await assert.rejects(applyDocumentRefresh(refresh(), plan.plan_token!), TransferConflictError);
  assert.equal((await fx.target.read("imp/themes/a")).doc.body, "Raced.\n");
  assert.equal((await fx.target.read(recordId)).doc.frontmatter.promotion_state, "applied");
});

test("an interrupted refresh stays refreshing, blocks a new plan, and resume finishes it idempotently", async () => {
  const target = new CrashingBackend("never");
  const { fx, recordId, refresh } = await imported({ target });
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed a.\n");
  await put(fx.source, "themes/b", { type: "Theme", title: "B v2" }, "Changed b.\n");
  const plan = await planDocumentRefresh(refresh());
  (target as unknown as { crashOn: string }).crashOn = "imp/themes/b";
  await assert.rejects(applyDocumentRefresh(refresh(), plan.plan_token!), (error: unknown) =>
    error instanceof TransferInterrupted && error.state === "refreshing" && /promotion_state refreshing/.test(error.message)
      && error.written.length === 1 && error.pending[0]!.target === "imp/themes/b");
  const record = (await fx.target.read(recordId)).doc;
  assert.equal(record.frontmatter.promotion_state, "refreshing");
  assert.deepEqual(((record.frontmatter.refresh as { entries: Array<{ target: string }> }).entries).map((e) => e.target), ["imp/themes/a", "imp/themes/b"]);
  assert.ok((await planDocumentRefresh(refresh())).conflicts.some((c) => c.code === "record_state"));

  const bundle = { root: "/t", backend: fx.target };
  const resumed = await resumeDocumentTransfer(bundle, recordId, { alias: "wave", binding: fx.binding }, { actor: "process:importer" });
  assert.equal(resumed.changed, true);
  assert.deepEqual(resumed.written.map((w) => w.target), ["imp/themes/a", "imp/themes/b"]);
  assert.equal((await fx.target.read("imp/themes/b")).doc.body, "Changed b.\n");
  const closed = (await fx.target.read(recordId)).doc;
  assert.equal(closed.frontmatter.promotion_state, "applied");
  assert.equal(closed.frontmatter.refresh, undefined);
  assert.equal((await planDocumentRefresh(refresh())).counts.unchanged, 3);
  const again = await resumeDocumentTransfer(bundle, recordId, { alias: "wave", binding: fx.binding });
  assert.equal(again.changed, false);
  assert.equal(fx.target.deletes, 0);
});

test("resume of a refresh leaves a copy another writer changed, closes the record and reports it", async () => {
  const target = new CrashingBackend("never");
  const { fx, recordId, refresh } = await imported({ target });
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed a.\n");
  const plan = await planDocumentRefresh(refresh());
  (target as unknown as { crashOn: string }).crashOn = "imp/themes/a";
  await assert.rejects(applyDocumentRefresh(refresh(), plan.plan_token!), TransferInterrupted);
  const read = await fx.target.read("imp/themes/a");
  await fx.target.write("imp/themes/a", { ...read.doc, body: "Someone else.\n" });
  const resumed = await resumeDocumentTransfer({ root: "/t", backend: fx.target }, recordId, { alias: "wave", binding: fx.binding });
  assert.deepEqual(resumed.written, []);
  assert.deepEqual(resumed.left?.map((l) => l.target), ["imp/themes/a"]);
  assert.match(resumed.left![0]!.detail, /another writer/);
  assert.equal((await fx.target.read("imp/themes/a")).doc.body, "Someone else.\n");
  assert.equal((await fx.target.read(recordId)).doc.frontmatter.promotion_state, "applied");
  assert.deepEqual((await planDocumentRefresh(refresh())).conflicts.map((c) => [c.code, c.target]), [["target_edited", "imp/themes/a"]], "the old baseline brings it back as a conflict");
});

test("resume of a refresh leaves a row whose source moved on, unwritten", async () => {
  const target = new CrashingBackend("never");
  const { fx, recordId, refresh } = await imported({ target });
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed a.\n");
  const plan = await planDocumentRefresh(refresh());
  (target as unknown as { crashOn: string }).crashOn = "imp/themes/a";
  await assert.rejects(applyDocumentRefresh(refresh(), plan.plan_token!), TransferInterrupted);
  const before = (await fx.target.read("imp/themes/a")).version;
  await put(fx.source, "themes/a", { type: "Theme", title: "A v3" }, "Changed again.\n");
  const resumed = await resumeDocumentTransfer({ root: "/t", backend: fx.target }, recordId, { alias: "wave", binding: fx.binding });
  assert.match(resumed.left![0]!.detail, /changed since the refresh was planned/);
  assert.equal((await fx.target.read("imp/themes/a")).version, before);
  const next = await planDocumentRefresh(refresh());
  assert.deepEqual(next.entries.find((e) => e.target === "imp/themes/a")!.action, "update");
});

test("a re-import that collides with promoted copies names the record a refresh updates", async () => {
  const { fx, recordId } = await imported();
  const plan = await planDocumentTransfer(fx.request({ recordId: "promotions/second" }));
  const collisions = plan.conflicts.filter((c) => c.code === "target_exists");
  assert.equal(collisions.length, 3);
  assert.ok(collisions.every((c) => c.record === recordId && c.detail.includes(recordId)));
});

test("a copy edited after a crashed refresh wrote it is left by resume, not adopted as the new baseline", async () => {
  const target = new CrashingBackend("never");
  const { fx, recordId, refresh } = await imported({ target });
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed a.\n");
  await put(fx.source, "themes/b", { type: "Theme", title: "B v2" }, "Changed b.\n");
  const plan = await planDocumentRefresh(refresh());
  (target as unknown as { crashOn: string }).crashOn = "imp/themes/b";
  await assert.rejects(applyDocumentRefresh(refresh(), plan.plan_token!), TransferInterrupted);
  const written = await fx.target.read("imp/themes/a");
  await fx.target.write("imp/themes/a", { ...written.doc, body: "Edited after the refresh wrote it.\n" });
  const resumed = await resumeDocumentTransfer({ root: "/t", backend: fx.target }, recordId, { alias: "wave", binding: fx.binding });
  assert.deepEqual(resumed.left?.map((l) => l.target), ["imp/themes/a"]);
  await put(fx.source, "themes/a", { type: "Theme", title: "A v3" }, "Changed again.\n");
  const next = await planDocumentRefresh(refresh());
  assert.deepEqual(next.conflicts.map((c) => [c.code, c.target]), [["target_edited", "imp/themes/a"]]);
  assert.equal((await fx.target.read("imp/themes/a")).doc.body, "Edited after the refresh wrote it.\n");
});

test("an overwrite row edited again before resume is left, not reported written", async () => {
  const target = new CrashingBackend("never");
  const { fx, recordId, refresh } = await imported({ target });
  const first = await fx.target.read("imp/themes/a");
  await fx.target.write("imp/themes/a", { ...first.doc, body: "First local edit.\n" });
  const plan = await planDocumentRefresh(refresh({ overwrite: ["imp/themes/a"] }));
  (target as unknown as { crashOn: string }).crashOn = "imp/themes/a";
  await assert.rejects(applyDocumentRefresh(refresh({ overwrite: ["imp/themes/a"] }), plan.plan_token!), TransferInterrupted);
  const second = await fx.target.read("imp/themes/a");
  await fx.target.write("imp/themes/a", { ...second.doc, body: "Second local edit.\n" });
  const resumed = await resumeDocumentTransfer({ root: "/t", backend: fx.target }, recordId, { alias: "wave", binding: fx.binding });
  assert.deepEqual(resumed.written, []);
  assert.deepEqual(resumed.left?.map((l) => l.target), ["imp/themes/a"]);
  assert.equal((await planDocumentRefresh(refresh())).entries.find((e) => e.target === "imp/themes/a")!.edited, true);
});

test("an import resume flags a copy edited after the interrupted write, so a refresh treats it as edited", async () => {
  const fx = await fixture({ target: new CrashingBackend("imp/themes/b") });
  const plan = await planDocumentTransfer(fx.request());
  await assert.rejects(applyDocumentTransfer(fx.request(), plan.plan_token!), TransferInterrupted);
  const written = await fx.target.read("imp/themes/a");
  await fx.target.write("imp/themes/a", { ...written.doc, body: "Edited before the resume.\n" });
  const bundle = { root: "/target", backend: fx.target };
  await resumeDocumentTransfer(bundle, plan.record.id, { alias: "wave", binding: fx.binding }, { actor: "process:importer" });
  const rows = (await fx.target.read(plan.record.id)).doc.frontmatter.entries as Array<Record<string, unknown>>;
  assert.deepEqual(rows.filter((r) => r.target_edited === true).map((r) => r.target), ["imp/themes/a"]);
  await put(fx.source, "themes/a", { type: "Theme", title: "A v2" }, "Changed.\n");
  const refreshPlan = await planDocumentRefresh({ target: bundle, recordId: plan.record.id, from: { alias: "wave", binding: fx.binding } });
  assert.deepEqual(refreshPlan.conflicts.map((c) => [c.code, c.target]), [["target_edited", "imp/themes/a"]]);
  // An explicit overwrite clears the flag: the refreshed copy is the import's baseline again.
  const overwrite = { target: bundle, recordId: plan.record.id, from: { alias: "wave", binding: fx.binding }, overwrite: ["imp/themes/a"], actor: "process:importer" };
  const overwritePlan = await planDocumentRefresh(overwrite);
  await applyDocumentRefresh(overwrite, overwritePlan.plan_token!);
  const after = (await fx.target.read(plan.record.id)).doc.frontmatter.entries as Array<Record<string, unknown>>;
  assert.equal(after.some((r) => r.target_edited === true), false);
});
