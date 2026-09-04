/**
 * Cross-link extraction and resolution.
 *
 * OKF cross-links are STANDARD markdown links `[text](target)` — NOT
 * `[[wikilinks]]` (SPEC §5). Two target forms are supported and BOTH are
 * resolved here (unlike the reference tooling, which is internally split —
 * its edge-builder counts only relative links while its body-rewriter navigates
 * only absolute ones):
 *   - absolute bundle-relative: `/tables/users.md`   (spec-recommended, move-stable)
 *   - relative:                 `./x.md`, `../refs/m.md`
 * External (`scheme://…`, `mailto:`), in-page (`#…`) and non-`.md` targets are
 * ignored — they never become concept edges. A link to a nonexistent target is
 * still returned (broken links are valid, §5). A link whose resolved target's
 * FINAL SEGMENT is a reserved OKF filename (`index.md`/`log.md`, at any directory
 * level per §3.1) is likewise dropped: reserved files are never concept documents
 * (`paths.ts`'s `isReservedFile` — the ONE reserved-name predicate, reused here
 * rather than restated), so a concept id they'd resolve to (`index`, `docs/log`,
 * …) can never exist in the doc set. Without this guard such a link resolved to a
 * phantom concept id, which surfaced as a false-positive "unresolved link" in
 * `status` and could never become a real graph edge anywhere.
 *
 * These functions are pure and dependency-free — INCLUDING free of `node:path`:
 * this module is the ONE link resolver and it now also runs in
 * the BROWSER (the shell's doc reader routes links through it), where `node:path`
 * does not bundle. The posix join/relative/basename logic is implemented as pure
 * string helpers below, parity-pinned against `node:path.posix` by
 * `links-path-parity.test.ts` and against browser bundling by `browser-bundle.test.ts` (the
 * isomorphic-boundary gate over every browser-consumed core subpath).
 */

import { assertSafeConceptId, isReservedFile } from "./paths.js";
import { InvalidInputError } from "./errors.js";
import type { ConceptId, Link, OkfDocument } from "./types.js";

/** Normalize posix segments with a stack: `.` drops, `..` pops (or survives at the front when nothing is left to pop — matching `path.posix.join` semantics), empty segments drop. Exported for the direct parity pin (links-path-parity.test.ts) — the resolver's `..`-past-root guard is otherwise masked by its leading-`../` post-strip. */
export function normalizeSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** Pure `path.posix.join(base, rel)` for the two-argument, relative-path case this module uses. */
function joinPosix(base: string, rel: string): string {
  return normalizeSegments([...base.split("/"), ...rel.split("/")]).join("/");
}

/** Pure `path.posix.relative(from, to)` for already-rooted bundle paths (no leading `/`). */
function relativePosix(from: string, to: string): string {
  const fromSegments = normalizeSegments(from.split("/"));
  const toSegments = normalizeSegments(to.split("/"));
  let common = 0;
  while (common < fromSegments.length && common < toSegments.length && fromSegments[common] === toSegments[common]) {
    common++;
  }
  const ups = fromSegments.length - common;
  return [...Array<string>(ups).fill(".."), ...toSegments.slice(common)].join("/");
}

/** Pure `path.posix.basename` (no extension handling — this module never needs it). */
function basenamePosix(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(slash + 1) : p;
}

/** A raw markdown link as written in the body, before resolution. */
export interface RawLink {
  text: string;
  href: string;
}

/** True for links that never become concept edges (external / mail / in-page anchors). */
export function isExternalHref(href: string): boolean {
  const h = href.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(h) || h.startsWith("mailto:") || h.startsWith("#");
}

/** Extract every non-image markdown link from a body, in document order. */
export function extractMarkdownLinks(body: string): RawLink[] {
  const out: RawLink[] = [];
  let textOpen = -1;
  let afterClose: { open: number; close: number } | undefined;
  let hrefFirst: { open: number; close: number; hrefStart: number } | undefined;
  let hrefRest: { open: number; close: number; hrefStart: number } | undefined;

  for (let cursor = 0; cursor < body.length; cursor++) {
    const char = body[cursor]!;

    // This is a constant-state simulation of the former
    // /\[([^\]]*)\]\(([^)\s]+)\)/g expression. Keeping only the earliest
    // candidate in each state preserves the regex's leftmost-first behavior
    // without backtracking over hostile input.
    if (hrefRest) {
      if (char === ")") {
        if (hrefRest.open === 0 || body[hrefRest.open - 1] !== "!") {
          out.push({
            text: body.slice(hrefRest.open + 1, hrefRest.close),
            href: body.slice(hrefRest.hrefStart, cursor),
          });
        }
        textOpen = -1;
        afterClose = undefined;
        hrefFirst = undefined;
        hrefRest = undefined;
        continue;
      }
      if (char.trim() === "") hrefRest = undefined;
    }

    if (hrefFirst) {
      if (char !== ")" && char.trim() !== "" && !hrefRest) {
        hrefRest = hrefFirst;
      }
      hrefFirst = undefined;
    }

    if (afterClose) {
      if (char === "(") {
        hrefFirst = { ...afterClose, hrefStart: cursor + 1 };
      }
      afterClose = undefined;
    }

    if (textOpen >= 0 && char === "]") {
      afterClose = { open: textOpen, close: cursor };
      textOpen = -1;
    }
    if (char === "[" && textOpen < 0) textOpen = cursor;
  }
  return out;
}

/**
 * Resolve a raw markdown href to a bundle-relative {@link ConceptId}, or `null`
 * when the href is not an internal `.md` concept link. Absolute hrefs resolve
 * from the bundle root; relative hrefs resolve against the directory of `fromId`.
 */
export function resolveConceptId(fromId: ConceptId, href: string): ConceptId | null {
  // Drop anchor and query before reasoning about the path.
  const target = (href.split("#")[0] ?? "").split("?")[0]?.trim() ?? "";
  if (target === "" || isExternalHref(target)) return null;
  if (!target.endsWith(".md")) return null; // only `.md` targets become concept links

  let resolved: string;
  if (target.startsWith("/")) {
    resolved = target.slice(1);
  } else {
    const slash = fromId.lastIndexOf("/");
    const fromDir = slash >= 0 ? fromId.slice(0, slash) : "";
    // posix.join normalizes `.`/`..` segments deterministically.
    resolved = joinPosix(fromDir, target);
  }
  // Strip any residual leading `../` that escaped the bundle root (best-effort).
  resolved = resolved.replace(/^(\.\.\/)+/, "");
  // Reserved files (index.md/log.md, any directory level) are never concept
  // documents — a link to one is not a concept edge. Check BEFORE dropping the
  // `.md` suffix, since `isReservedFile` matches on the filename incl. extension.
  if (isReservedFile(resolved)) return null;
  // Drop the `.md` suffix to yield the concept id, then enforce the same canonical grammar used
  // at the storage seam. For example, `/foo.md/bar.md` cannot become `foo.md/bar`: that id would
  // collide with the concept file `foo.md` and no backend can expose it consistently.
  const id = resolved.replace(/\.md$/, "");
  try {
    assertSafeConceptId(id);
    return id;
  } catch (error) {
    if (error instanceof InvalidInputError) return null;
    throw error;
  }
}

/**
 * Build a bundle-RELATIVE markdown href from `fromId` to a target concept id (or
 * pass an external URL through unchanged). This is the emit-side counterpart of
 * {@link resolveConceptId}: it produces the relative form (`../refs/x.md`,
 * `y.md`) that the OKF reference graph builder counts as an edge — the form
 * VISION and the sample bundles use — rather than the absolute `/…md` form,
 * which the OKF reference graph does not count as a relative concept edge.
 */
export function relativeHref(fromId: ConceptId, target: string): string {
  const t = target.trim();
  if (isExternalHref(t)) return t;
  assertSafeConceptId(fromId);
  assertSafeConceptId(t);
  // `target` is an already-canonical ConceptId, not a file-like user address. A canonical id may
  // itself end in `.md` (the concept stored at `x.md.md`), so stripping here would alias it to `x`.
  const targetId = t;
  const slash = fromId.lastIndexOf("/");
  const fromDir = slash >= 0 ? fromId.slice(0, slash) : "";
  let rel = relativePosix(fromDir, targetId);
  if (rel === "") rel = basenamePosix(targetId); // link to a concept in one's own dir
  return `${rel}.md`;
}

/**
 * Outbound resolved cross-links of a document. Non-concept links (external,
 * anchors, non-`.md`) are dropped; broken (unresolved-target) links are kept.
 */
export function parseLinksFromDoc(doc: OkfDocument): Link[] {
  const links: Link[] = [];
  for (const raw of extractMarkdownLinks(doc.body)) {
    const to = resolveConceptId(doc.id, raw.href);
    if (to === null) continue;
    links.push({ from: doc.id, to, text: raw.text, href: raw.href });
  }
  return links;
}
