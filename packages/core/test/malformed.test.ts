/**
 * Regression tests for corrupt-document handling — a document whose YAML frontmatter cannot be
 * parsed must NEVER take down a whole-bundle scan with a raw, id-less parser error, and it must
 * parse DETERMINISTICALLY (identical bytes → identical outcome regardless of parse order).
 *
 * The determinism test is the important one: gray-matter caches the parsed file keyed by input,
 * populated with the UNPARSED file BEFORE parsing and only when no options are passed — so a second
 * parse of malformed content would silently return `{ data: {} }` instead of re-throwing. This
 * order-dependent footgun is exactly what {@link parseMarkdown}'s `matter(raw, {})` closes; if a
 * future edit drops the options object, `firstParseThrows`/`secondParseThrows` below diverge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MalformedDocumentError, parseMarkdown } from "../src/frontmatter.js";
import { FilesystemBackend } from "../src/backend.js";
import { query } from "../src/bundle.js";
import type { Bundle, SkippedDoc } from "../src/index.js";

/** A document with an unterminated YAML flow sequence — js-yaml cannot parse it. */
const MALFORMED = "---\ntype: [unclosed\ntitle: bad\n---\nbody\n";
const UNTERMINATED = "---\ntype: Concept\ntitle: Missing close\n# Body that must not disappear\n";
const WELL_FORMED = "---\ntype: Concept\ntitle: Good\n---\nfine\n";

test("parseMarkdown throws an attributed MalformedDocumentError on bad YAML", () => {
  assert.throws(
    () => parseMarkdown(MALFORMED, "notes/bad.md"),
    (err: unknown) => {
      assert.ok(err instanceof MalformedDocumentError);
      assert.equal(err.context, "notes/bad.md");
      assert.match(err.message, /malformed frontmatter in 'notes\/bad\.md'/);
      assert.match(err.message, /fix the YAML or remove the file/);
      assert.ok(err.detail.length > 0, "detail carries the underlying parser message");
      return true;
    },
  );
});

test("parseMarkdown attribution is optional (no context ⇒ no 'in ...' clause)", () => {
  assert.throws(
    () => parseMarkdown(MALFORMED),
    (err: unknown) => err instanceof MalformedDocumentError && !/ in '/.test(err.message),
  );
});

test("parseMarkdown rejects an opening frontmatter delimiter without a closing delimiter", () => {
  assert.throws(
    () => parseMarkdown(UNTERMINATED, "notes/unterminated.md"),
    (err: unknown) => {
      assert.ok(err instanceof MalformedDocumentError);
      assert.equal(err.context, "notes/unterminated.md");
      assert.match(err.detail, /unterminated YAML frontmatter delimiter/);
      return true;
    },
  );
});

test("parseMarkdown is DETERMINISTIC on malformed input — not order-dependent (gray-matter cache)", () => {
  // The regression: without the options object, the first parse throws but the second returns
  // `{ data: {} }` from gray-matter's input cache. Every repeat must throw identically.
  for (let i = 0; i < 5; i++) {
    assert.throws(() => parseMarkdown(MALFORMED), MalformedDocumentError, `parse #${i} must throw`);
  }
});

test("well-formed documents are unaffected by the options object", () => {
  const { frontmatter, body } = parseMarkdown(WELL_FORMED);
  assert.equal(frontmatter.type, "Concept");
  assert.equal(frontmatter.title, "Good");
  assert.equal(body.trim(), "fine");
});

/** Build a FilesystemBackend bundle with one good and one malformed doc; run `fn`; clean up. */
async function withCorruptBundle(fn: (bundle: Bundle) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-malformed-"));
  try {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "good.md"), WELL_FORMED);
    await writeFile(path.join(root, "notes", "bad.md"), MALFORMED);
    await fn({ root, backend: new FilesystemBackend(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("FilesystemBackend.read attributes a malformed doc to its path", async () => {
  await withCorruptBundle(async (bundle) => {
    await assert.rejects(
      () => bundle.backend!.read("notes/bad"),
      (err: unknown) =>
        err instanceof MalformedDocumentError && err.context === "notes/bad.md",
    );
    // The good doc still reads fine — corruption is isolated to the one file.
    const good = await bundle.backend!.read("notes/good");
    assert.equal(good.doc.frontmatter.title, "Good");
  });
});

test("query THROWS on a malformed doc by default (loud), but skips-and-reports with onSkip", async () => {
  await withCorruptBundle(async (bundle) => {
    // Default: no collector ⇒ the corrupt doc fails the whole scan (loud, attributed).
    await assert.rejects(() => query(bundle), MalformedDocumentError);

    // Opt-in resilience: the corrupt doc is skipped and reported; the good doc still comes back.
    const skipped: SkippedDoc[] = [];
    const docs = await query(bundle, {}, { onSkip: (s) => skipped.push(s) });
    assert.deepEqual(
      docs.map((d) => d.id),
      ["notes/good"],
    );
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.id, "notes/bad");
    assert.ok((skipped[0]?.reason ?? "").length > 0);
  });
});
