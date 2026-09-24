/**
 * node↔browser parity pin for the ONE link resolver (designs/doc-reader rev 2, HIGH-1):
 * links.ts shed its `node:path` import so it bundles for the browser, replacing
 * `path.posix.join/relative/basename` with pure string helpers. This table pins the PUBLIC
 * functions' behavior against a reference implementation built on `node:path.posix` ITSELF —
 * if the pure helpers ever drift from posix semantics, this fails naming the case. The resolver
 * is security-relevant (it is the reader's scheme-smuggling defense), so the table includes the
 * traversal/normalization shapes an attacker reaches for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveConceptId, relativeHref, isExternalHref, normalizeSegments } from "../src/links.js";
import { isReservedFile } from "../src/paths.js";

/**
 * Pin `normalizeSegments` DIRECTLY against `node:path.posix.join` (review LOW-2): the
 * `resolveConceptId` parity table can't observe a `..`-past-root regression because the shared
 * `replace(/^(\.\.\/)+/, "")` post-strip masks it — so a future refactor removing that strip could
 * regress the segment normalizer unnoticed. This table sees the raw normalization, INCLUDING the
 * mid-path and past-root `..` shapes an attacker reaches for.
 */
const SEGMENT_CASES = ["a/b/c", "a/./b", "a/../b", "../a", "a/b/../../c", "../../x", "a//b", "./a", "a/b/..", ""];

test("normalizeSegments parity: pure normalizer === node:path.posix.join across the raw table", () => {
  for (const input of SEGMENT_CASES) {
    // path.posix.join with a `.` base yields the same normalization normalizeSegments performs,
    // minus join's leading-`./` for a fully-popped path — compare on the segment arrays.
    const expected = path.posix.join(".", input).split("/").filter((s) => s !== "." && s !== "");
    assert.deepEqual(
      normalizeSegments(input.split("/")),
      expected,
      `normalizeSegments(${JSON.stringify(input)})`,
    );
  }
});

/** The pre-change implementation, verbatim, on node:path.posix — the parity reference. */
function referenceResolve(fromId: string, href: string): string | null {
  const target = (href.split("#")[0] ?? "").split("?")[0]?.trim() ?? "";
  if (target === "" || isExternalHref(target)) return null;
  if (!target.endsWith(".md")) return null;
  let resolved: string;
  if (target.startsWith("/")) {
    resolved = target.slice(1);
  } else {
    const slash = fromId.lastIndexOf("/");
    const fromDir = slash >= 0 ? fromId.slice(0, slash) : "";
    resolved = path.posix.join(fromDir, target);
  }
  resolved = resolved.replace(/^(\.\.\/)+/, "");
  if (isReservedFile(resolved)) return null;
  return resolved.replace(/\.md$/, "");
}

/** Canonical-ID emit reference on node:path.posix. */
function referenceRelativeHref(fromId: string, target: string): string {
  const t = target.trim();
  if (isExternalHref(t)) return t;
  const targetId = t;
  const slash = fromId.lastIndexOf("/");
  const fromDir = slash >= 0 ? fromId.slice(0, slash) : "";
  return path.posix.relative(fromDir, `${targetId}.md`);
}

const RESOLVE_CASES: Array<[string, string]> = [
  // Ordinary shapes.
  ["tasks/alpha", "beta.md"],
  ["tasks/alpha", "./beta.md"],
  ["tasks/alpha", "../designs/home.md"],
  ["alpha", "docs/deep/x.md"],
  ["a/b/c/d", "../../up.md"],
  ["tasks/alpha", "/decisions/x.md"],
  // Normalization / traversal shapes (the attacker set).
  ["tasks/alpha", "../../../../etc/passwd.md"],
  ["tasks/alpha", ".././.././weird.md"],
  ["tasks/alpha", "a//b///c.md"],
  ["tasks/alpha", "./././x.md"],
  ["a/b", "../b/../b/x.md"],
  ["", "x.md"],
  ["solo", "../x.md"],
  // Non-concept shapes (must be null on both sides).
  ["tasks/alpha", "https://example.com/x.md"],
  ["tasks/alpha", "javascript:alert(1)"],
  ["tasks/alpha", "javascript:alert(1).md"],
  ["tasks/alpha", "mailto:x@example.com"],
  ["tasks/alpha", "#anchor"],
  ["tasks/alpha", "x.txt"],
  ["tasks/alpha", "../index.md"],
  ["tasks/alpha", "docs/log.md"],
  ["tasks/alpha", "x.md#frag?q=1"],
  ["tasks/alpha", ""],
];

test("resolveConceptId parity: pure string helpers === node:path.posix reference across the table", () => {
  for (const [fromId, href] of RESOLVE_CASES) {
    assert.equal(
      resolveConceptId(fromId, href),
      referenceResolve(fromId, href),
      `resolveConceptId(${JSON.stringify(fromId)}, ${JSON.stringify(href)})`,
    );
  }
});

const RELATIVE_CASES: Array<[string, string]> = [
  ["tasks/alpha", "tasks/beta"],
  ["tasks/alpha", "designs/home"],
  ["alpha", "docs/deep/x"],
  ["a/b/c", "a/x"],
  ["a/b", "a/b"],
  ["deep/nest/from", "top"],
  // Ancestor hubs: the target id equals or prefixes the source's directory.
  ["projects/a", "projects"],
  ["a/b/c", "a"],
  ["a/b/c", "a/b"],
  ["x", "https://example.com/keep"],
];

test("relativeHref parity: pure string helpers === node:path.posix reference across the table", () => {
  for (const [fromId, target] of RELATIVE_CASES) {
    assert.equal(
      relativeHref(fromId, target),
      referenceRelativeHref(fromId, target),
      `relativeHref(${JSON.stringify(fromId)}, ${JSON.stringify(target)})`,
    );
  }
});
