/**
 * Unit tests for the pure (dependency-free) engine functions: path identity,
 * cross-link extraction/resolution, freshness derivation, the context-note
 * mapping, and the ported content_type inference.
 *
 * These modules import no filesystem or YAML runtime, so they run directly under
 * Node's built-in TypeScript stripping (see test/ts-loader.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  conceptIdFromPath,
  pathFromConceptId,
  isReservedFile,
  assertSafeConceptId,
  assertSafeReservedDir,
} from "../src/paths.js";
import {
  extractMarkdownLinks,
  resolveConceptId,
  relativeHref,
  parseLinksFromDoc,
  isExternalHref,
} from "../src/links.js";
import { freshness, parseTimestamp } from "../src/freshness.js";
import { meaningfulChangeTimeValue } from "../src/meaningful-change-time.js";
import {
  extensionOfDocKey,
  inferContentTypeFromDocKey,
  inferContentTypeForNewBlob,
} from "../src/content-type.js";
import type { OkfDocument } from "../src/types.js";
import { InvalidInputError } from "../src/errors.js";

test("paths: conceptId <-> path round-trip and reserved detection", () => {
  assert.equal(conceptIdFromPath("tables/users.md"), "tables/users");
  assert.equal(conceptIdFromPath("./a/b.md"), "a/b");
  assert.equal(pathFromConceptId("tables/users"), "tables/users.md");
  assert.equal(pathFromConceptId("tables/users.md"), "tables/users.md.md");
  assert.equal(conceptIdFromPath(pathFromConceptId("tables/users.md")), "tables/users.md");
  assert.ok(isReservedFile("index.md"));
  assert.ok(isReservedFile("datasets/log.md"));
  assert.ok(!isReservedFile("datasets/events.md"));
});

test("paths: assertSafeConceptId rejects traversal / absolute", () => {
  assert.doesNotThrow(() => assertSafeConceptId("a/b/c"));
  assert.doesNotThrow(() => assertSafeConceptId("a/b.md"));
  assert.throws(() => assertSafeConceptId("../escape"));
  assert.throws(() => assertSafeConceptId("/abs/path"));
  assert.throws(() => assertSafeConceptId(""));
  // A mixed sub + parent-dir-escape id (a legitimate-looking prefix that still climbs out).
  assert.throws(() => assertSafeConceptId("concepts/../../../etc/passwd"));
  for (const alias of ["./a/b", "a//b", "a\\b", "a/./b", "a/b/"]) {
    assert.throws(() => assertSafeConceptId(alias), InvalidInputError);
  }
  assert.throws(() => assertSafeConceptId("a.md/b"), InvalidInputError);
  assert.doesNotThrow(() => assertSafeConceptId("a/b.md"));
});

test("paths: safe nonblank concept ids retain their exact boundary bytes", () => {
  const ids = [
    "ordinary/id",
    " internal space/id ",
    " leading/id",
    "trailing/id ",
    'quoted/"id"',
    "--option-like",
    "utf8/café-🚀",
    "line\nbreak",
  ];
  for (const id of ids) {
    assert.doesNotThrow(() => assertSafeConceptId(id), JSON.stringify(id));
    assert.equal(pathFromConceptId(id), `${id}.md`, JSON.stringify(id));
  }
  for (const id of ["", " ", "\t\n"]) {
    assert.throws(() => assertSafeConceptId(id), InvalidInputError, JSON.stringify(id));
  }
});

test("paths: assertSafeReservedDir rejects traversal / absolute but allows the bundle root", () => {
  assert.doesNotThrow(() => assertSafeReservedDir("")); // "" == bundle root, always valid
  assert.doesNotThrow(() => assertSafeReservedDir("a/b/c"));
  assert.throws(() => assertSafeReservedDir("../escape"));
  assert.throws(() => assertSafeReservedDir("/abs/dir"));
  assert.throws(() => assertSafeReservedDir("sub/../../../tmp")); // mixed sub + escape
});

test("links: extractMarkdownLinks skips images, keeps text links", () => {
  const links = extractMarkdownLinks("see [x](/a.md) and ![img](/p.png) and [y](./b.md)");
  assert.deepEqual(links, [
    { text: "x", href: "/a.md" },
    { text: "y", href: "./b.md" },
  ]);
});

test("links: resolveConceptId handles absolute, relative, parent, anchors, external", () => {
  assert.equal(resolveConceptId("tables/events", "/references/metrics/m.md"), "references/metrics/m");
  assert.equal(resolveConceptId("tables/events", "./users.md"), "tables/users");
  assert.equal(resolveConceptId("tables/events", "../references/m.md"), "references/m");
  assert.equal(resolveConceptId("tables/events", "/a/b.md#section"), "a/b");
  assert.equal(resolveConceptId("a/b", "https://example.com/x.md"), null); // external
  assert.equal(resolveConceptId("a/b", "./notes.txt"), null); // non-.md
  assert.equal(isExternalHref("mailto:x@y.com"), true);
});

test("links: parseLinksFromDoc keeps broken links, drops non-concept links", () => {
  const doc: OkfDocument = {
    id: "notes/a",
    frontmatter: { type: "Note" },
    body: "[live](/notes/b.md) [broken](/notes/ghost.md) [ext](https://x.io)",
  };
  const links = parseLinksFromDoc(doc);
  assert.deepEqual(
    links.map((l) => l.to),
    ["notes/b", "notes/ghost"],
  );
  assert.equal(links[0]!.from, "notes/a");
});

test("links: malformed paths that cannot name canonical concepts never become graph edges", () => {
  assert.equal(resolveConceptId("notes/a", "/foo.md/bar.md"), null);
  const doc: OkfDocument = {
    id: "notes/a",
    frontmatter: { type: "Note" },
    body: "[invalid](/foo.md/bar.md) [valid](/foo/bar.md)",
  };
  assert.deepEqual(parseLinksFromDoc(doc).map((link) => link.to), ["foo/bar"]);
});

test("links: resolveConceptId returns null for a reserved-filename target (index.md/log.md), any directory level, any href form", () => {
  // Bundle-root reserved files, relative form.
  assert.equal(resolveConceptId("notes/a", "index.md"), null);
  assert.equal(resolveConceptId("notes/a", "log.md"), null);
  assert.equal(resolveConceptId("notes/a", "./log.md"), null);
  // Bundle-root reserved files, absolute form.
  assert.equal(resolveConceptId("notes/a", "/index.md"), null);
  assert.equal(resolveConceptId("notes/a", "/log.md"), null);
  // Nested reserved files (§3.1: reserved at ANY directory level), relative + absolute.
  assert.equal(resolveConceptId("notes/a", "../log.md"), null);
  assert.equal(resolveConceptId("concepts/a", "./sub/index.md"), null);
  assert.equal(resolveConceptId("notes/a", "/concepts/sub/index.md"), null);
  // A relative traversal that lands back on a reserved file at the resolved directory.
  assert.equal(resolveConceptId("a/b/c", "../../index.md"), null);
  // Anchors/queries on a reserved target still resolve to null (anchor stripped first).
  assert.equal(resolveConceptId("notes/a", "/log.md#section"), null);
  // A normal, non-reserved sibling target is unaffected by the guard.
  assert.equal(resolveConceptId("notes/a", "./sibling.md"), "notes/sibling");
  assert.equal(resolveConceptId("notes/a", "/concepts/sub/notindex.md"), "concepts/sub/notindex");
});

test("links: parseLinksFromDoc drops reserved-target links from the edge set entirely (not surfaced as broken either)", () => {
  const doc: OkfDocument = {
    id: "notes/a",
    frontmatter: { type: "Note" },
    body:
      "[home](index.md) [changelog](log.md) [nested](./sub/index.md) " +
      "[real](./sibling.md) [broken](./ghost.md)",
  };
  const links = parseLinksFromDoc(doc);
  assert.deepEqual(
    links.map((l) => l.to),
    ["notes/sibling", "notes/ghost"],
  );
});

test("links: relativeHref emits bundle-relative form (and passes external URLs through)", () => {
  // Same directory → bare basename.
  assert.equal(relativeHref("concepts/okf-alignment", "concepts/link-graph"), "link-graph.md");
  // Sibling directory → `../`.
  assert.equal(
    relativeHref("context-notes/cycle-x", "concepts/okf-alignment"),
    "../concepts/okf-alignment.md",
  );
  // Accepts an absolute-or-.md target and still emits relative.
  assert.equal(relativeHref("a/b/c", "a/x"), "../x.md");
  assert.equal(relativeHref("a/b/c", "a/x.md"), "../x.md.md");
  // External URLs are not rewritten.
  assert.equal(relativeHref("a/b", "https://example.com/x"), "https://example.com/x");
  // A relative link round-trips through the resolver back to the full concept id.
  const href = relativeHref("context-notes/cycle-x", "concepts/okf-alignment");
  assert.equal(resolveConceptId("context-notes/cycle-x", href), "concepts/okf-alignment");
});

test("freshness: empty / fresh / stale-by-age / stale-by-dependency", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  const mk = (ts?: string): OkfDocument => ({ id: "x", frontmatter: { type: "T", timestamp: ts }, body: "" });

  assert.equal(freshness(mk(undefined), { now }).verdict, "empty");
  assert.equal(parseTimestamp("not-a-date"), null);
  // Belt-and-suspenders: parseTimestamp tolerates a raw Date / epoch-ms number.
  assert.equal(parseTimestamp(new Date("2026-07-01T12:00:00Z")), Date.parse("2026-07-01T12:00:00Z"));
  assert.equal(parseTimestamp(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseTimestamp(new Date("invalid")), null);

  const recent = freshness(mk("2026-07-01T11:00:00Z"), { now, maxAgeMs: 2 * 3600_000 });
  assert.equal(recent.verdict, "fresh");
  assert.equal(recent.ageMs, 3600_000);

  const old = freshness(mk("2026-06-01T12:00:00Z"), { now, maxAgeMs: 24 * 3600_000 });
  assert.equal(old.verdict, "stale");

  const v02 = freshness({
    id: "x",
    frontmatter: {
      type: "T",
      timestamp: "2026-06-01T12:00:00Z",
      generated: { at: "2026-07-01T11:00:00Z", by: "producer/1" },
    },
    body: "",
  }, { now, maxAgeMs: 2 * 3600_000 });
  assert.equal(v02.verdict, "fresh");
  assert.equal(v02.ageMs, 3600_000);

  const dep = freshness(mk("2026-07-01T10:00:00Z"), {
    now,
    dependsOn: ["2026-07-01T11:00:00Z"], // dependency newer than the note
  });
  assert.equal(dep.verdict, "stale");
  assert.match(dep.reason ?? "", /dependency/);
});

test("freshness: OKF v0.2 stale_after is an absolute date and does not change v0.1 semantics", () => {
  const doc: OkfDocument = {
    id: "x",
    frontmatter: { type: "T", stale_after: "2026-07-01" },
    body: "",
  };

  const before = freshness(doc, { okfVersion: "0.2", now: new Date("2026-06-30T23:59:59Z") });
  assert.equal(before.verdict, "empty");

  const onDate = freshness(doc, { okfVersion: "0.2", now: new Date("2026-07-01T00:00:00Z") });
  assert.equal(onDate.verdict, "stale");
  assert.equal(onDate.ageMs, undefined);
  assert.match(onDate.reason ?? "", /stale_after 2026-07-01/);

  assert.equal(
    freshness(doc, { okfVersion: "0.1", now: new Date("2026-07-02T00:00:00Z") }).verdict,
    "empty",
  );
  assert.equal(
    freshness({ ...doc, frontmatter: { ...doc.frontmatter, stale_after: "2026-02-31" } }, {
      okfVersion: "0.2",
      now: new Date("2026-07-02T00:00:00Z"),
    }).verdict,
    "empty",
  );
});

test("meaningful change time lookup prefers v0.2 generated.at and falls back to v0.1 timestamp", () => {
  const cases: Array<{ label: string; frontmatter: Record<string, unknown>; expected: unknown }> = [
    { label: "missing", frontmatter: { type: "T" }, expected: undefined },
    { label: "blank", frontmatter: { type: "T", timestamp: "   " }, expected: "   " },
    { label: "malformed", frontmatter: { type: "T", timestamp: "not-a-date" }, expected: "not-a-date" },
    { label: "valid", frontmatter: { type: "T", timestamp: "2026-07-01T12:00:00Z" }, expected: "2026-07-01T12:00:00Z" },
  ];
  for (const row of cases) {
    assert.equal(meaningfulChangeTimeValue(row.frontmatter), row.expected, row.label);
  }
  assert.equal(
    meaningfulChangeTimeValue({
      type: "T",
      timestamp: "2026-07-01T12:00:00Z",
      generated: { at: "2026-08-01T12:00:00Z", by: "producer/1" },
    }),
    "2026-08-01T12:00:00Z",
  );
  assert.equal(
    meaningfulChangeTimeValue({ type: "T", timestamp: "legacy", generated: { by: "producer/1" } }),
    "legacy",
  );
});

test("content-type: extension inference + warning policy", () => {
  assert.equal(extensionOfDocKey("a/b/c.HTML"), "html");
  assert.equal(extensionOfDocKey("a/b/.gitignore"), undefined);
  assert.equal(inferContentTypeFromDocKey("x.md"), "text/markdown; charset=utf-8");
  assert.equal(inferContentTypeFromDocKey("x.unknownext"), undefined);

  const promoted = inferContentTypeForNewBlob("page.html", "application/octet-stream");
  assert.equal(promoted.contentType, "text/html; charset=utf-8");
  assert.equal(promoted.inferred, true);
  assert.equal(promoted.warning?.code, "CONTENT_TYPE_INFERRED");

  const same = inferContentTypeForNewBlob("x.md", "text/markdown; charset=utf-8");
  assert.equal(same.warning, undefined); // no behavior change -> no warning

  const unknown = inferContentTypeForNewBlob("x.weird", "application/octet-stream");
  assert.equal(unknown.contentType, "application/octet-stream");
  assert.equal(unknown.warning?.code, "CONTENT_TYPE_INFER_FALLBACK");

  const noext = inferContentTypeForNewBlob("README", "text/plain");
  assert.equal(noext.warning, undefined);
});

// ── mutation-survivor pins (core-survivor-triage unit) ────────────────────────
// Red-proven pins for Stryker survivors from the first full core mutation report.

// kills: paths.ts:92:7 ConditionalExpression #2695
// kills: paths.ts:92:7 LogicalOperator #2696
// kills: paths.ts:92:7 ConditionalExpression #2697
// kills: paths.ts:92:34 ConditionalExpression #2700
// kills: paths.ts:92:34 MethodExpression #2702
// kills: paths.ts:92:49 StringLiteral #2703
// kills: paths.ts:92:53 BlockStatement #2704
test("pin: assertSafeBlobKey failures are typed InvalidInputError — empty, whitespace-only, and non-string keys", async () => {
  const { assertSafeBlobKey } = await import("../src/paths.js");
  const { InvalidInputError } = await import("../src/errors.js");
  for (const bad of ["", "   ", 42 as unknown as string]) {
    assert.throws(() => assertSafeBlobKey(bad), InvalidInputError, `key ${JSON.stringify(bad)}`);
  }
});

// kills: paths.ts:20:27 StringLiteral #2641
// kills: paths.ts:20:40 Regex #2642
// kills: paths.ts:20:51 StringLiteral #2643
// kills: paths.ts:37:41 Regex #2650
// kills: paths.ts:38:24 StringLiteral #2653
// kills: paths.ts:43:36 Regex #2658
// kills: paths.ts:43:46 StringLiteral #2659
// kills: paths.ts:43:58 Regex #2660
test("pin: id/path normalization edges — absolute strip, non-.md passthrough, duplicate separators, mid-name .md", () => {
  assert.equal(conceptIdFromPath("/abs/x.md"), "abs/x");
  assert.equal(conceptIdFromPath("notes.txt"), "notes.txt");
  assert.equal(conceptIdFromPath("a//b.md"), "a/b");
  assert.equal(conceptIdFromPath("a\\b.md"), "a/b");
  assert.equal(conceptIdFromPath("a/./b.md"), "a/b");
  assert.throws(() => pathFromConceptId("/a"), InvalidInputError);
  assert.equal(pathFromConceptId("x.md.y"), "x.md.y.md");
});

// kills: paths.ts:53:7 ConditionalExpression #2667
// kills: paths.ts:53:33 MethodExpression #2672
// kills: paths.ts:127:7 ConditionalExpression #2753
// kills: paths.ts:127:32 BlockStatement #2756
test("pin: concept-id and reserved-dir guard failures are typed InvalidInputError — whitespace-only and non-string inputs", async () => {
  const { InvalidInputError } = await import("../src/errors.js");
  assert.throws(() => assertSafeConceptId("   "), InvalidInputError);
  assert.throws(() => assertSafeConceptId(42 as unknown as string), InvalidInputError);
  assert.throws(() => assertSafeReservedDir(42 as unknown as string), InvalidInputError);
});

// kills: links.ts:42:13 MethodExpression #2254
// kills: links.ts:43:10 Regex #2260
// kills: links.ts:43:75 MethodExpression #2266
// kills: links.ts:78:31 Regex #2325
// kills: links.ts:78:31 Regex #2326
// kills: links.ts:84:27 Regex #2330
test("pin: isExternalHref anchors at the start and trims; resolveConceptId clamps runaway ../ and strips only the FINAL .md", () => {
  assert.equal(isExternalHref("dir/https://example.com"), false);
  assert.equal(isExternalHref("   https://example.com/x   "), true);
  assert.equal(isExternalHref("#anchor"), true);
  assert.equal(resolveConceptId("a/b", "../../../x.md"), "x");
  assert.equal(resolveConceptId("a/b", "b../c.md"), "a/b../c");
  assert.equal(resolveConceptId("r", "a.md-plan.md"), "a.md-plan");
});

// kills: links.ts:98:30 Regex #2337
// kills: links.ts:98:50 Regex #2339
// kills: links.ts:100:19 ConditionalExpression #2342
test("pin: relativeHref edges — multi-slash absolute targets, mid-name .md, and a root-level fromId", () => {
  assert.throws(() => relativeHref("a/b", "//x.md"), InvalidInputError);
  assert.equal(relativeHref("r", "a.md-plan.md"), "a.md-plan.md.md");
  assert.equal(relativeHref("readme", "x.md"), "x.md.md");
});

// kills: freshness.ts:57:11 ConditionalExpression #1257
// kills: freshness.ts:57:11 LogicalOperator #1259
// kills: freshness.ts:57:29 EqualityOperator #1263
// kills: freshness.ts:67:47 EqualityOperator #1276
test("pin: freshness boundary equality is FRESH (age == maxAgeMs, dep == ts) and an unusable dep never marks stale", () => {
  const doc: OkfDocument = { id: "d", frontmatter: { type: "Note", timestamp: "2026-07-16T00:00:00.000Z" }, body: "" };
  const now = new Date(Date.parse("2026-07-16T00:00:00.000Z") + 1000);
  assert.equal(freshness(doc, { now, maxAgeMs: 1000 }).verdict, "fresh");
  assert.equal(freshness(doc, { now, dependsOn: ["2026-07-16T00:00:00.000Z"] }).verdict, "fresh");
  assert.equal(freshness(doc, { now, dependsOn: ["not-a-date"] }).verdict, "fresh");
});

// kills: content-type.ts map StringLiterals #676 #678 #679 #680 #681 #682 #683 #684 #685 #686 #687 #688 #689 #690 #691 #692 #693 #694 #695 #696 #697 #698 #699 #700 #701 #702 #703 #704 #705 #706 #707 #708 #709
// kills: content-type.ts:84:10 ConditionalExpression #721
// kills: content-type.ts:84:10 EqualityOperator #723
// kills: content-type.ts:122:39 ConditionalExpression #737
// kills: content-type.ts:122:39 MethodExpression #739
// kills: content-type.ts:122:59 StringLiteral #740
// kills: content-type.ts:138:12 ObjectLiteral #747
// kills: content-type.ts:138:47 BooleanLiteral #748
// kills: content-type.ts:145:14 ObjectLiteral #756
// kills: content-type.ts:145:45 BooleanLiteral #757
// kills: content-type.ts:153:16 StringLiteral #763
// kills: content-type.ts:154:19 StringLiteral #764
// kills: content-type.ts:163:15 BooleanLiteral #766
// kills: content-type.ts:167:14 StringLiteral #770
// kills: content-type.ts:168:17 StringLiteral #771
test("pin: the extension→MIME table, inference flags, and override trimming are the served content-type contract", async () => {
  const { EXTENSION_CONTENT_TYPES, DEFAULT_BLOB_CONTENT_TYPE, resolveContentType } = await import("../src/content-type.js");
  assert.deepEqual({ ...EXTENSION_CONTENT_TYPES }, {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    markdown: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    text: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8",
    json: "application/json; charset=utf-8",
    jsonl: "application/json; charset=utf-8",
    ndjson: "application/json; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    yaml: "application/yaml; charset=utf-8",
    yml: "application/yaml; charset=utf-8",
    toml: "application/toml; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    cjs: "text/javascript; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
    tar: "application/x-tar",
    wasm: "application/wasm",
    woff: "font/woff",
    woff2: "font/woff2",
  });

  assert.equal(extensionOfDocKey("file."), undefined);
  assert.equal(resolveContentType("x.png", "   "), "image/png");
  assert.equal(resolveContentType("x.png", ""), "image/png");
  assert.equal(resolveContentType("x.unknownext"), DEFAULT_BLOB_CONTENT_TYPE);

  assert.deepEqual(inferContentTypeForNewBlob("noext", "fb/x"), { contentType: "fb/x", inferred: false });
  assert.deepEqual(inferContentTypeForNewBlob("a.png", "image/png"), { contentType: "image/png", inferred: true });
  const warned = inferContentTypeForNewBlob("a.png", "application/octet-stream");
  assert.equal(warned.warning?.field, "content_type");
  assert.equal(warned.warning?.severity, "info");
  const fallback = inferContentTypeForNewBlob("a.xyz", "fb/y");
  assert.equal(fallback.inferred, false);
  assert.equal(fallback.warning?.field, "content_type");
  assert.equal(fallback.warning?.severity, "info");
});
