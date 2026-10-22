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
 * does not bundle. The posix join/relative logic is implemented as pure
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

/** One markdown link or image as written in a body, with the offsets of its parts in that body. */
export interface MarkdownLinkSpan {
  text: string;
  href: string;
  /** Offset of the opening `[` (of the `!` for an image). */
  start: number;
  /** Offset just past the closing `)`. */
  end: number;
  /** Offset of the href's first character. */
  hrefStart: number;
  /** Offset just past the href's last character. */
  hrefEnd: number;
  /** True for `![text](href)`. */
  image: boolean;
}

/**
 * Extract every non-image markdown link from a body, in document order. With `skipCode`, a link
 * written inside an inline code span or a fenced or indented code block ({@link maskMarkdownCode})
 * is not a link; the returned text and href are still sliced from the original body. This is
 * {@link extractMarkdownLinkSpans} without images, so the link graph and a span-driven body
 * rewrite always agree about what a link is.
 */
export function extractMarkdownLinks(source: string, options: { skipCode?: boolean } = {}): RawLink[] {
  const out: RawLink[] = [];
  for (const span of extractMarkdownLinkSpans(source, options)) {
    if (!span.image) out.push({ text: span.text, href: span.href });
  }
  return out;
}

/**
 * Replace hrefs by offset. `replace` returns the new href for a span, or undefined to keep it.
 * Spans are applied from the end of the body backwards, so earlier offsets stay valid; link text
 * and everything outside the hrefs never changes. A span that overlaps another or does not match
 * the body is refused.
 */
export function rewriteMarkdownLinks(
  body: string,
  spans: readonly MarkdownLinkSpan[],
  replace: (span: MarkdownLinkSpan) => string | undefined,
): string {
  const ordered = [...spans].sort((a, b) => b.hrefStart - a.hrefStart);
  let out = body;
  let floor = Number.POSITIVE_INFINITY;
  for (const span of ordered) {
    if (span.hrefEnd > floor) throw new InvalidInputError("link spans overlap; refusing to rewrite the body");
    floor = span.hrefStart;
    if (body.slice(span.hrefStart, span.hrefEnd) !== span.href) {
      throw new InvalidInputError("a link span does not match the body it was extracted from");
    }
    const next = replace(span);
    if (next === undefined || next === span.href) continue;
    out = out.slice(0, span.hrefStart) + next + out.slice(span.hrefEnd);
  }
  return out;
}

/**
 * Extract every markdown link AND image from a body, in document order, with offsets: the one
 * link scanner. With `skipCode`, a link inside code is not a link (see {@link extractMarkdownLinks}).
 */
export function extractMarkdownLinkSpans(source: string, options: { skipCode?: boolean } = {}): MarkdownLinkSpan[] {
  const body = options.skipCode ? maskMarkdownCode(source) : source;
  const out: MarkdownLinkSpan[] = [];
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
        const image = hrefRest.open > 0 && body[hrefRest.open - 1] === "!";
        out.push({
          text: source.slice(hrefRest.open + 1, hrefRest.close),
          href: source.slice(hrefRest.hrefStart, cursor),
          start: image ? hrefRest.open - 1 : hrefRest.open,
          end: cursor + 1,
          hrefStart: hrefRest.hrefStart,
          hrefEnd: cursor,
          image,
        });
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
 * Column width of leading whitespace at `from` and its length in characters. `startColumn` is the
 * line column of `from`: a tab advances to the next multiple of 4 of the LINE's columns.
 */
function leadingIndent(line: string, from: number, startColumn: number): { columns: number; chars: number } {
  let columns = 0;
  let index = from;
  while (index < line.length) {
    const char = line[index];
    if (char === " ") columns += 1;
    else if (char === "\t") columns += 4 - ((startColumn + columns) % 4);
    else break;
    index++;
  }
  return { columns, chars: index - from };
}

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;

/**
 * Blank out (with spaces, keeping every newline and the string's length) the CommonMark code a
 * reader sees as code: fenced blocks (``` and ~~~, fence lines included), indented blocks, and
 * inline code spans with their backticks. Offsets into the result are offsets into `body`.
 *
 * Linear time and line-based. Block quote markers and list-item content indentation are honored
 * so an indented continuation paragraph in a list stays prose, and a fence ends with the block
 * quote or list item that holds it. HTML blocks (`<pre>`) are not modelled. An unclosed fence runs to the end of the body, and an unmatched
 * backtick run is literal text, as in CommonMark.
 */
/** @internal Exported for the qualified-link parser and its tests; not a stable API. */
export function maskMarkdownCode(body: string): string {
  const out = body.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index++) if (out[index] !== "\n" && out[index] !== "\r") out[index] = " ";
  };
  const lists: number[] = [];
  let fence: { char: string; length: number; container: number; quotes: number } | null = null;
  let inParagraph = false;
  let segmentStart = -1;
  const closeSegment = (end: number): void => {
    if (segmentStart >= 0) maskCodeSpans(body, segmentStart, end, blank);
    segmentStart = -1;
  };

  let lineStart = 0;
  while (lineStart <= body.length) {
    const newline = body.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? body.length : newline;
    const line = body.slice(lineStart, lineEnd);
    // Block quote markers are container syntax; what follows them is the line's content.
    let contentAt = 0;
    let quotes = 0;
    for (let match = /^ {0,3}> ?/.exec(line); match; match = /^ {0,3}> ?/.exec(line.slice(contentAt))) {
      // Inside a fence, `>` beyond the fence's own quote depth is fence content, not a marker.
      if (fence && quotes >= fence.quotes) break;
      contentAt += match[0].length;
      quotes++;
    }
    const { columns: indent, chars } = leadingIndent(line, contentAt, contentAt);
    const rest = line.slice(contentAt + chars).replace(/\r$/, "");
    const isBlank = rest.trim() === "";

    // The block quote or list item holding the fence ended (a lazy line cannot continue a fence).
    if (fence && (quotes < fence.quotes || (!isBlank && indent < fence.container))) fence = null;
    if (fence) {
      const close = indent - fence.container <= 3 ? FENCE_OPEN.exec(rest) : null;
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length && close[2]!.trim() === "") fence = null;
      blank(lineStart, lineEnd);
    } else if (isBlank) {
      closeSegment(lineStart);
      inParagraph = false;
    } else {
      if (!inParagraph) while (lists.length > 0 && lists[lists.length - 1]! > indent) lists.pop();
      let container = lists.length > 0 ? lists[lists.length - 1]! : 0;
      let relative = indent - container;
      let text = rest;
      let textAt = lineStart + contentAt + chars;
      const marker = relative <= 3 && !THEMATIC_BREAK.test(text) ? LIST_MARKER.exec(text) : null;
      if (marker) {
        // A list item ends any paragraph (and so any code span) before it. Its content column is
        // the marker plus its spacing, or the marker plus one when the item starts blank or the
        // spacing is 5+ columns (the item then opens with indented code).
        closeSegment(lineStart);
        const markerEnd = indent + marker[1]!.length;
        const spacing = leadingIndent(marker[2]!, 0, contentAt + markerEnd).columns;
        const wide = marker[2] === "" || spacing >= 5;
        lists.push(markerEnd + (wide ? 1 : spacing));
        container = lists[lists.length - 1]!;
        text = text.slice(marker[1]!.length + (wide ? 0 : marker[2]!.length));
        textAt += marker[1]!.length + (wide ? 0 : marker[2]!.length);
        relative = wide ? Math.max(spacing - 1, 0) : 0;
        inParagraph = false;
      }
      const open = relative <= 3 ? FENCE_OPEN.exec(text) : null;
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        closeSegment(lineStart);
        fence = { char: open[1]![0]!, length: open[1]!.length, container, quotes };
        blank(textAt, lineEnd);
        inParagraph = false;
      } else if (!inParagraph && relative >= 4) {
        closeSegment(lineStart);
        blank(textAt, lineEnd);
      } else if (ATX_HEADING.test(text) || THEMATIC_BREAK.test(text)) {
        closeSegment(lineStart);
        maskCodeSpans(body, textAt, lineEnd, blank);
        inParagraph = false;
      } else {
        if (segmentStart < 0) segmentStart = textAt;
        inParagraph = text.trim() !== "";
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  closeSegment(body.length);
  return out.join("");
}

/**
 * Blank inline code spans in `body[from, to)`: a backtick run opens a span closed by the next run
 * of exactly the same length; with none, the run is literal. A backslash escapes one backtick
 * outside a span. Runs are indexed by length so matching stays linear on hostile input.
 */
function maskCodeSpans(body: string, from: number, to: number, blank: (from: number, to: number) => void): void {
  const runs: Array<{ at: number; length: number }> = [];
  for (let index = from; index < to; ) {
    if (body[index] !== "`") {
      index++;
      continue;
    }
    let end = index;
    while (end < to && body[end] === "`") end++;
    runs.push({ at: index, length: end - index });
    index = end;
  }
  const byLength = new Map<number, number[]>();
  runs.forEach((run, position) => {
    const list = byLength.get(run.length);
    if (list) list.push(position);
    else byLength.set(run.length, [position]);
  });
  const next = new Map<number, number>();
  const nextRun = (length: number, after: number): number => {
    const list = byLength.get(length);
    if (!list) return -1;
    let cursor = next.get(length) ?? 0;
    while (cursor < list.length && list[cursor]! <= after) cursor++;
    next.set(length, cursor);
    return cursor < list.length ? list[cursor]! : -1;
  };
  let escapeScan = from;
  let escaped = false;
  for (let position = 0; position < runs.length; position++) {
    let { at, length } = runs[position]!;
    // Odd count of backslashes immediately before the run (outside any span) escapes its first backtick.
    for (; escapeScan < at; escapeScan++) escaped = body[escapeScan] === "\\" ? !escaped : false;
    if (escaped) {
      at += 1;
      length -= 1;
      escaped = false;
      if (length === 0) continue;
      const list = byLength.get(length);
      // The shortened run is an opener of a different length; only later runs can close it.
      if (!list) continue;
    }
    const closer = nextRun(length, position);
    if (closer < 0) continue;
    const close = runs[closer]!;
    blank(at, close.at + close.length);
    position = closer;
    escapeScan = close.at + close.length;
    escaped = false;
  }
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
  // Relativize to the target's FILE path, not its id: a hub id that equals or prefixes the
  // source's directory (`projects` from `projects/a`) must emit `../projects.md`, never an empty
  // or `..` path. Non-final id segments cannot end in `.md`, so the result is never empty.
  return relativePosix(fromDir, `${targetId}.md`);
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
