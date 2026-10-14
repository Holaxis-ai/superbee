/**
 * Qualified (cross-bundle) links: `[text](okf://<alias>/<path>.md[#fragment])`.
 *
 * `alias` is declared in the linking bundle's `docs/dependencies`; `path` is a concept id plus
 * `.md`, relative to the TARGET bundle's root and used literally (never resolved against the
 * linking file). The display text is the link's type, as for local typed links.
 *
 * The local link resolver ({@link parseLinksFromDoc}) treats `okf://` as external and ignores it,
 * so local edges, backlinks and the renderer are unchanged; this module is the one parser for the
 * qualified form. Pure and browser-safe.
 */

import { isBundleAlias } from "./dependencies.js";
import { InvalidInputError } from "./errors.js";
import { extractMarkdownLinks } from "./links.js";
import { assertSafeConceptId, isReservedFile } from "./paths.js";
import type { ConceptId, Link, OkfDocument } from "./types.js";

export const QUALIFIED_HREF_PREFIX = "okf://";

/** A target in another bundle: the declared alias and the concept id inside that bundle. */
export interface QualifiedRef {
  alias: string;
  id: ConceptId;
}

export type ParsedQualifiedHref =
  | { ok: true; ref: QualifiedRef; fragment?: string }
  | { ok: false; detail: string };

/**
 * True when the href uses the `okf:` scheme in any letter case. A true answer means "this is a
 * cross-bundle link"; {@link parseQualifiedHref} then says whether it is well formed (a malformed
 * one is reported as `invalid_ref`, never silently ignored).
 */
export function isQualifiedHref(href: string): boolean {
  return /^okf:/i.test(href.trim());
}

/**
 * Parse an `okf://` href. Refused (`ok: false`, read as `invalid_ref`): another scheme or a
 * non-lower-case `okf://`, an alias outside `^[a-z][a-z0-9-]{0,62}$`, a leading `/` in the path,
 * an empty, `.` or `..` segment, a query, a `%`, a non-`.md` target, `index.md` or `log.md`, and
 * any id the storage seam would refuse. The fragment is returned but plays no part in resolution.
 */
export function parseQualifiedHref(href: string): ParsedQualifiedHref {
  const raw = href.trim();
  if (!raw.startsWith(QUALIFIED_HREF_PREFIX)) {
    return { ok: false, detail: "a cross-bundle link must start with okf://" };
  }
  const hash = raw.indexOf("#");
  const target = hash >= 0 ? raw.slice(QUALIFIED_HREF_PREFIX.length, hash) : raw.slice(QUALIFIED_HREF_PREFIX.length);
  const fragment = hash >= 0 ? raw.slice(hash + 1) : undefined;

  if (target.includes("?")) return { ok: false, detail: "a query is not allowed" };
  if (target.includes("%")) return { ok: false, detail: "percent-encoding is not allowed" };
  const slash = target.indexOf("/");
  if (slash < 0) return { ok: false, detail: "expected okf://<alias>/<path>.md" };
  const alias = target.slice(0, slash);
  const path = target.slice(slash + 1);
  if (!isBundleAlias(alias)) return { ok: false, detail: "alias must match ^[a-z][a-z0-9-]{0,62}$" };
  if (path.startsWith("/")) return { ok: false, detail: "the path is relative to the target bundle's root and must not start with /" };
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return { ok: false, detail: "'.' and '..' segments are not allowed" };
  }
  if (!path.endsWith(".md")) return { ok: false, detail: "the target must be a .md document" };
  if (isReservedFile(path)) return { ok: false, detail: "index.md and log.md are not documents" };
  const id = path.slice(0, -".md".length);
  try {
    assertSafeConceptId(id);
  } catch (error) {
    if (error instanceof InvalidInputError) return { ok: false, detail: error.message };
    throw error;
  }
  return fragment === undefined ? { ok: true, ref: { alias, id } } : { ok: true, ref: { alias, id }, fragment };
}

/** Emit `okf://<alias>/<id>.md[#fragment]`. Throws {@link InvalidInputError} for a ref that would not parse back. */
export function qualifiedHref(ref: QualifiedRef, fragment?: string): string {
  const href = `${QUALIFIED_HREF_PREFIX}${ref.alias}/${ref.id}.md${fragment === undefined ? "" : `#${fragment}`}`;
  const parsed = parseQualifiedHref(href);
  if (!parsed.ok || parsed.ref.alias !== ref.alias || parsed.ref.id !== ref.id || parsed.fragment !== fragment) {
    throw new InvalidInputError(
      `Not a valid cross-bundle target: ${parsed.ok ? "it does not parse back to the same alias and id" : parsed.detail}.`,
    );
  }
  return href;
}

/** One `okf:` link as written in a document body. `ref` is null when the href is malformed. */
export interface QualifiedLink {
  from: ConceptId;
  text: string;
  href: string;
  ref: QualifiedRef | null;
  /** Why the href is malformed; present exactly when `ref` is null. */
  detail?: string;
}

/** Every `okf:` link in a document body, in document order, malformed ones included. */
export function parseQualifiedLinks(doc: OkfDocument): QualifiedLink[] {
  const out: QualifiedLink[] = [];
  for (const raw of extractMarkdownLinks(doc.body)) {
    if (!isQualifiedHref(raw.href)) continue;
    const parsed = parseQualifiedHref(raw.href);
    out.push(
      parsed.ok
        ? { from: doc.id, text: raw.text, href: raw.href, ref: parsed.ref }
        : { from: doc.id, text: raw.text, href: raw.href, ref: null, detail: parsed.detail },
    );
  }
  return out;
}

/** A well-formed qualified link as an edge: `to` is the id in the target bundle, `bundle` its alias. */
export function qualifiedLinkEdge(link: QualifiedLink): Link | null {
  if (link.ref === null) return null;
  return { from: link.from, to: link.ref.id, text: link.text, href: link.href, bundle: link.ref.alias };
}

/**
 * Read a Kind link target (`links: {pours: "beers:Beer"}`). The target is qualified when the text
 * before the first `:` matches the alias grammar; anything else (`Beer`, `Some: Thing`) is a local
 * Kind name and returns null.
 */
export function parseQualifiedKindTarget(target: string): { alias: string; kind: string } | null {
  const colon = target.indexOf(":");
  if (colon < 0) return null;
  const alias = target.slice(0, colon);
  if (!isBundleAlias(alias)) return null;
  return { alias, kind: target.slice(colon + 1).trim() };
}
