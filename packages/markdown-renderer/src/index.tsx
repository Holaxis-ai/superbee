/**
 * The shared doc render pipeline (designs/doc-reader rev 2) — the SECURITY BOUNDARY: untrusted
 * bundle markdown renders in the SHELL ORIGIN. Three belts, each independently sufficient for its
 * class:
 *
 *  1. `mdast-util-from-markdown` (+gfm) parses with dangerous HTML OFF — a raw-HTML run in the
 *     body becomes an mdast `html` node, which this module renders as ESCAPED TEXT, never markup.
 *  2. CLOSED CONSTRUCTION: mdast nodes map DIRECTLY to React elements — there is no HTML-string
 *     intermediate, no DOM-parsing of content, and no direct HTML injection (React's dangerous
 *     inner-HTML prop is banned by the grep gate in markdown-render-gate.test.ts). The
 *     "allowlist" is the closed switch below; unknown node types render as their text content.
 *     React auto-escapes children and attributes.
 *  3. The shell's own asset CSP (`ui-server/src/assets.ts`, `script-src 'self'`) blocks inline
 *     script, event-handler attributes, and `javascript:` navigation even under a hypothetical
 *     bypass of belts 1–2.
 *
 * THE INVARIANT (pinned red by markdown.test.tsx + static.test.mjs): a raw markdown href/src NEVER
 * reaches a DOM attribute. An interactive resolved link gets a route built from
 * `resolveConceptId`; the inert profile gets only that normalized id in `data-aslite-doc-id`.
 * Everything the resolver rejects (external URLs, `javascript:`/`data:`/any scheme, non-`.md`,
 * reserved files) renders as inert text. Images are inert in v1.
 *
 * RESOURCE BOUNDS: body bytes capped ({@link MAX_BODY_CHARS}, with an honest truncation notice —
 * the AXI `read` truncation's human analog) and the walk bounded ({@link MAX_NODES} nodes,
 * {@link MAX_DEPTH} depth) — a pathological doc degrades, never hangs the trusted tab.
 */
import type { ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { AlignType, Node, Parent, RootContent } from "mdast";
import { resolveConceptId } from "@superbee/core/links";

/** Body cap before parsing (chars ≈ bytes for the ASCII-dominant common case; honest notice on cut). */
export const MAX_BODY_CHARS = 262_144;
/** Maximum mdast nodes rendered before the walk stops with a notice. */
export const MAX_NODES = 20_000;
/** Maximum nesting depth rendered before a subtree collapses to text. */
export const MAX_DEPTH = 40;

export interface RenderedMarkdown {
  element: ReactNode;
  /** True when the body was cut at {@link MAX_BODY_CHARS} or the walk hit {@link MAX_NODES}. */
  bounded: boolean;
  /**
   * The bounds this render actually applied, after defaulting and clamping. Reported so the
   * OMITTED-option path is pinnable without building a fixture at the production size: a test
   * asserts an unlimited call resolves to the constants. Without it, the production fallback could
   * be changed to `Infinity` with every bounds test still green (found in review).
   */
  limits: { maxBodyChars: number; maxNodes: number };
}

export interface RenderOptions {
  /** The doc whose body this is — the resolver's `fromId` basis for relative links. */
  fromId: string;
  /** Shell navigation for a RESOLVED doc link (the only thing a link can do). */
  onNavigateDoc: (id: string) => void;
  /** Interactive for the shell reader; inert for serialized fragments crossing into a View. */
  profile?: "interactive" | "inert";
  /** Resolve a concept id to its title, for the inline "verb → title" edge rows (falls back to the id). */
  titleFor?: (conceptId: string) => string | undefined;
  /**
   * Resource bounds, defaulting to {@link MAX_BODY_CHARS}/{@link MAX_NODES}. A TEST SEAM: degrading
   * at a budget is behavior independent of how big the budget is, so a test asserts it at a small
   * one instead of building a fixture sized off the production constant (20K nodes parsed + walked
   * ran ~1s locally and timed out against vitest's 5s default on a loaded runner). Production
   * callers omit these; that the omitted case really uses the constants is itself pinned.
   *
   * ONLY EVER TIGHTENS. This module is a resource-security boundary, so the seam cannot be used to
   * relax it: an override above the production maximum is clamped down to it, and a non-finite or
   * non-positive value ({@link resolveBound}) falls back to the maximum rather than disabling the
   * guard. NaN is the one that matters — `count >= NaN` is always false, so an unclamped NaN would
   * silently remove the walk bound entirely.
   */
  limits?: { maxBodyChars?: number; maxNodes?: number };
}

/**
 * Resolve one requested bound against its production maximum. FAIL CLOSED in every direction the
 * seam could weaken the boundary: absent, non-finite (NaN/Infinity), or non-positive all yield the
 * maximum, and a finite request is clamped down to it. So an override can only ever tighten.
 */
function resolveBound(requested: number | undefined, max: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) return max;
  return Math.min(Math.floor(requested), max);
}

/** Flatten a node's text content — the inert fallback for unknown/rejected constructs. */
function textOf(node: Node): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "html") {
    return (node as { value?: string }).value ?? "";
  }
  const children = (node as Partial<Parent>).children;
  if (!Array.isArray(children)) return "";
  return children.map((child) => textOf(child)).join("");
}

/** A paragraph child with no visible content — inter-link whitespace or a soft/hard line break. */
function isBlankInline(node: Node): boolean {
  if (node.type === "break") return true;
  if (node.type === "text") return ((node as { value?: string }).value ?? "").trim() === "";
  return false;
}

/**
 * A "bare link block": a top-level paragraph whose ONLY content is CONCEPT links (plus inter-link
 * whitespace / breaks) — no prose. These are the doc's outbound edges authored as standalone
 * references; the reader renders them as an inline "verb → target-title" list ({@link renderEdgeList})
 * rather than as bare link words. Two guards keep the rendering faithful:
 *   - a link EMBEDDED in a sentence (any prose sibling) → NOT a bare block, renders as normal prose;
 *   - a link the resolver REJECTS (external URL, `#anchor`, non-`.md`) has no concept target to name,
 *     so its paragraph is NOT an edge block and renders unchanged.
 * Otherwise purely structural — it never reads the link text, so it needs no declared vocabulary
 * and handles undeclared verbs and plain concept citations alike. Pure — the unit-tested
 * discriminator.
 */
export function isBareLinkBlock(node: Node, fromId: string): boolean {
  if (node.type !== "paragraph") return false;
  let sawLink = false;
  for (const child of (node as Parent).children) {
    if (isBlankInline(child)) continue;
    if (child.type === "link" && resolveConceptId(fromId, (child as { url?: string }).url ?? "") !== null) {
      sawLink = true;
      continue;
    }
    // Prose text, an image, or a NON-concept link (external/anchor/non-.md — its only home is the
    // body) → not a bare concept-link block, leave the whole paragraph in place.
    return false;
  }
  return sawLink;
}

/** A fenced block's language, admitted only in a strictly-shaped class name (never arbitrary). */
function safeLanguageClass(lang: unknown): string | undefined {
  return typeof lang === "string" && /^[\w+-]{1,24}$/.test(lang) ? `doc-code-${lang}` : undefined;
}

interface WalkState {
  count: number;
  bounded: boolean;
  options: RenderOptions;
  maxNodes: number;
}

function renderChildren(node: Parent, state: WalkState, depth: number): ReactNode[] {
  return node.children.map((child, index) => renderNode(child, state, depth + 1, index));
}

/** One table row of `th`/`td` cells with gfm alignment mapped to a class, never a style string. */
function renderTableRow(row: Parent, state: WalkState, depth: number, index: number, header: boolean, align: AlignType[]): ReactNode {
  return (
    <tr key={index}>
      {row.children.map((cell, cellIndex) => {
        const Tag = header ? "th" : "td";
        const alignment = align[cellIndex];
        return (
          <Tag key={cellIndex} className={alignment ? `doc-cell-${alignment}` : undefined}>
            {renderChildren(cell as Parent, state, depth + 1)}
          </Tag>
        );
      })}
    </tr>
  );
}

function renderNode(node: RootContent | Node, state: WalkState, depth: number, index: number): ReactNode {
  if (state.count >= state.maxNodes) {
    state.bounded = true;
    return null;
  }
  state.count++;
  if (depth > MAX_DEPTH) {
    state.bounded = true;
    return textOf(node);
  }

  switch (node.type) {
    case "text":
      return (node as { value: string }).value;
    case "paragraph":
      return <p key={index}>{renderChildren(node as Parent, state, depth)}</p>;
    case "heading": {
      const level = Math.min(Math.max((node as { depth: number }).depth, 1), 6);
      const Tag = `h${level}` as "h1";
      return <Tag key={index}>{renderChildren(node as Parent, state, depth)}</Tag>;
    }
    case "emphasis":
      return <em key={index}>{renderChildren(node as Parent, state, depth)}</em>;
    case "strong":
      return <strong key={index}>{renderChildren(node as Parent, state, depth)}</strong>;
    case "delete":
      return <del key={index}>{renderChildren(node as Parent, state, depth)}</del>;
    case "inlineCode":
      return (
        <code key={index}>{(node as { value: string }).value}</code>
      );
    case "code": {
      const language = safeLanguageClass((node as { lang?: unknown }).lang);
      return (
        <pre key={index} className="doc-code">
          <code className={language}>{(node as { value: string }).value}</code>
        </pre>
      );
    }
    case "blockquote":
      return <blockquote key={index}>{renderChildren(node as Parent, state, depth)}</blockquote>;
    case "list": {
      const ordered = (node as { ordered?: boolean }).ordered === true;
      const start = (node as { start?: number }).start;
      return ordered ? (
        <ol key={index} start={typeof start === "number" ? start : undefined}>
          {renderChildren(node as Parent, state, depth)}
        </ol>
      ) : (
        <ul key={index}>{renderChildren(node as Parent, state, depth)}</ul>
      );
    }
    case "listItem": {
      const checked = (node as { checked?: boolean | null }).checked;
      return (
        <li key={index} className={typeof checked === "boolean" ? "doc-task-item" : undefined}>
          {typeof checked === "boolean" && (
            state.options.profile === "inert"
              ? <span className="doc-task-marker">{checked ? "☑" : "☐"}</span>
              : <input type="checkbox" disabled checked={checked} readOnly />
          )}
          {renderChildren(node as Parent, state, depth)}
        </li>
      );
    }
    case "thematicBreak":
      return <hr key={index} />;
    case "break":
      return <br key={index} />;
    case "link": {
      // THE INVARIANT: the href below is BUILT from the resolver's output. `node.url` (raw
      // markdown) is consulted only as resolver INPUT and never reaches an attribute.
      const resolved = resolveConceptId(state.options.fromId, (node as { url?: string }).url ?? "");
      const children = renderChildren(node as Parent, state, depth);
      if (resolved === null) {
        return (
          <span
            key={index}
            className="doc-link-inert"
            title={state.options.profile === "inert" ? undefined : "external or unresolved target"}
          >
            {children}
          </span>
        );
      }
      if (state.options.profile === "inert") {
        return (
          <span key={index} className="doc-link-inert" data-aslite-doc-id={resolved}>
            {children}
          </span>
        );
      }
      const onNavigateDoc = state.options.onNavigateDoc;
      return (
        <a
          key={index}
          href={`?view=doc&id=${encodeURIComponent(resolved)}`}
          onClick={(event) => {
            event.preventDefault();
            onNavigateDoc(resolved);
          }}
        >
          {children}
        </a>
      );
    }
    case "image":
      // v1: images are inert (figures are the next unit PR; raster images a recorded deferral).
      return (
        <span
          key={index}
          className="doc-link-inert"
          title={state.options.profile === "inert" ? undefined : "images render in a later version"}
        >
          [image{(node as { alt?: string }).alt ? `: ${(node as { alt?: string }).alt}` : ""}]
        </span>
      );
    case "table": {
      const align = ((node as { align?: (AlignType | null)[] }).align ?? []) as AlignType[];
      const rows = (node as Parent).children;
      return (
        <div key={index} className="doc-table-wrap">
          <table>
            {rows.length > 0 && <thead>{renderTableRow(rows[0] as Parent, state, depth, 0, true, align)}</thead>}
            <tbody>
              {rows.slice(1).map((row, rowIndex) => renderTableRow(row as Parent, state, depth, rowIndex + 1, false, align))}
            </tbody>
          </table>
        </div>
      );
    }
    case "html":
      // Belt 1: raw HTML is DATA. Rendered as literal text (React escapes it), never parsed.
      return (
        <span key={index} className="doc-raw-html">
          {(node as { value: string }).value}
        </span>
      );
    default:
      // Unknown/unmapped node type (footnotes, definitions, future extensions): inert text.
      return textOf(node);
  }
}

/**
 * Render a run of bare concept-link paragraphs as one inline "verb → target-title" edge list, IN
 * PLACE — the doc reader's outbound relationships. `links` are the concept links collected from a
 * consecutive run of {@link isBareLinkBlock} paragraphs (authors write one edge per line, so the
 * run merges into a single aligned list). Each row shows the link's authored text (the relationship
 * verb) → the target's title, and navigates to the target. The target's title comes from `titleFor`
 * (the reader's head projection); a target with no title falls back to its id.
 */
function renderEdgeList(links: Node[], state: WalkState, index: number): ReactNode {
  const { fromId, onNavigateDoc, titleFor } = state.options;
  const rows: ReactNode[] = [];
  for (let i = 0; i < links.length; i++) {
    // Each row counts against the walk budget, like renderNode — a hostile all-edges body degrades
    // (bounded) instead of rendering unboundedly past MAX_NODES.
    if (state.count >= state.maxNodes) {
      state.bounded = true;
      break;
    }
    state.count++;
    const to = resolveConceptId(fromId, (links[i] as { url?: string }).url ?? "");
    if (to === null) continue; // isBareLinkBlock guarantees resolvability; defensive
    const verb = textOf(links[i]!).trim();
    const target = titleFor?.(to) ?? to;
    if (state.options.profile === "inert") {
      rows.push(
        <span key={i} className="doc-edge-row" data-aslite-doc-id={to}>
          <span className="doc-edge-verb">{verb}</span>
          <span className="doc-edge-arrow" aria-hidden="true">→</span>
          <span className="doc-edge-target">{target}</span>
        </span>,
      );
      continue;
    }
    rows.push(
      <a
        key={i}
        className="doc-edge-row"
        href={`?view=doc&id=${encodeURIComponent(to)}`}
        onClick={(event) => {
          event.preventDefault();
          onNavigateDoc(to);
        }}
      >
        <span className="doc-edge-verb">{verb}</span>
        <span className="doc-edge-arrow" aria-hidden="true">→</span>
        <span className="doc-edge-target">{target}</span>
      </a>,
    );
  }
  return (
    <div key={index} className="doc-edge-list">
      {rows}
    </div>
  );
}

/** Parse + render a doc body to React elements under the module's bounds. Pure aside from the callbacks. */
export function renderMarkdown(body: string, options: RenderOptions): RenderedMarkdown {
  const maxBodyChars = resolveBound(options.limits?.maxBodyChars, MAX_BODY_CHARS);
  const maxNodes = resolveBound(options.limits?.maxNodes, MAX_NODES);
  let bounded = false;
  let source = body;
  if (source.length > maxBodyChars) {
    source = source.slice(0, maxBodyChars);
    bounded = true;
  }
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const state: WalkState = { count: 0, bounded: false, options, maxNodes };
  // Render a run of bare concept-link paragraphs inline as one "verb → target" edge list (authors
  // write one edge per line, so merge the consecutive run). Non-bare paragraphs and inline links
  // render normally through renderNode.
  const children = tree.children;
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < children.length) {
    if (isBareLinkBlock(children[i]!, options.fromId)) {
      const links: Node[] = [];
      let j = i;
      while (j < children.length && isBareLinkBlock(children[j]!, options.fromId)) {
        for (const c of (children[j] as Parent).children) if (c.type === "link") links.push(c);
        j++;
      }
      nodes.push(renderEdgeList(links, state, i));
      i = j;
    } else {
      nodes.push(renderNode(children[i]!, state, 1, i));
      i++;
    }
  }
  const element = <>{nodes}</>;
  // `maxNodes` is reported from the SAME binding the walk consumed (state.maxNodes), so the
  // reported bound cannot drift from the enforced one.
  return { element, bounded: bounded || state.bounded, limits: { maxBodyChars, maxNodes: state.maxNodes } };
}
