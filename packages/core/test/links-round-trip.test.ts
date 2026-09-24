/**
 * Emit/parse round trip for cross-links: for every canonical source/target pair, the href that
 * `relativeHref` emits must be seen by `extractMarkdownLinks` and resolve through
 * `resolveConceptId` (from the same source) back to exactly the target. `link add` relies on this
 * for both graph correctness and idempotence, so the property is checked over a deterministic
 * enumeration of ids that covers siblings, descendants, ancestor hubs (`projects` next to
 * `projects/`), roots, and ids whose final segment itself ends in `.md`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractMarkdownLinks, relativeHref, resolveConceptId } from "../src/links.js";
import { assertSafeConceptId, isReservedFile, pathFromConceptId } from "../src/paths.js";

const SEGMENTS = ["a", "b", "ab", "x.md"];
const MAX_DEPTH = 3;

function enumerateIds(): string[] {
  const ids: string[] = [];
  let frontier: string[] = [""];
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const next: string[] = [];
    for (const prefix of frontier) {
      for (const segment of SEGMENTS) next.push(prefix === "" ? segment : `${prefix}/${segment}`);
    }
    ids.push(...next);
    frontier = next;
  }
  return ids.filter((id) => {
    try {
      assertSafeConceptId(id);
    } catch {
      return false;
    }
    return !isReservedFile(pathFromConceptId(id));
  });
}

test("links round trip: relativeHref output resolves back to the target for every enumerated pair", () => {
  const ids = enumerateIds();
  assert.ok(ids.length > 40, "enumeration covers a meaningful id space");
  const failures: string[] = [];
  for (const from of ids) {
    for (const to of ids) {
      const href = relativeHref(from, to);
      const parsed = extractMarkdownLinks(`[t](${href})`);
      const resolved = parsed.length === 1 && parsed[0]!.href === href ? resolveConceptId(from, href) : undefined;
      if (resolved !== to) failures.push(`${from} -> ${to}: href ${JSON.stringify(href)} resolved to ${JSON.stringify(resolved)}`);
    }
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} non-round-tripping pairs`);
});

test("links round trip: ancestor hub targets emit a parent-relative href", () => {
  assert.equal(relativeHref("projects/a", "projects"), "../projects.md");
  assert.equal(relativeHref("a/b/c", "a"), "../../a.md");
  assert.equal(relativeHref("a/b/c", "a/b"), "../b.md");
});
