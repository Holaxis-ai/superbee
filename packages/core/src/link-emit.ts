/**
 * The one way core writes a link href into a body: a bundle-relative href to a local concept, or
 * a qualified `okf://<alias>/<id>.md` href to a concept in another bundle. Every emitted href is
 * read back through the same scanner and resolvers the graph uses, so a writer can never store a
 * link the graph would read as a different target (or not at all). Pure and browser-safe.
 */

import { InvalidInputError } from "./errors.js";
import { extractMarkdownLinks, relativeHref, resolveConceptId } from "./links.js";
import { parseQualifiedHref, qualifiedHref } from "./qualified-links.js";
import type { ConceptId } from "./types.js";

export type LinkHrefTarget =
  /** A concept in the same bundle, written relative to `from`. */
  | { kind: "local"; from: ConceptId; to: ConceptId; fragment?: string }
  /** A concept in the bundle declared as `alias`. */
  | { kind: "qualified"; alias: string; id: ConceptId; fragment?: string };

function readsBackAsOneLink(href: string): boolean {
  const readBack = extractMarkdownLinks(`[x](${href})`);
  return readBack.length === 1 && readBack[0]!.href === href;
}

/**
 * Emit the href for `target`, or throw {@link InvalidInputError} when the href would not read back
 * as exactly that target: the scanner must see one link with this href, and the local resolver
 * (or the qualified parser) must return the same id, alias and fragment.
 */
export function emitLinkHref(target: LinkHrefTarget): string {
  if (target.kind === "qualified") {
    const href = qualifiedHref({ alias: target.alias, id: target.id }, target.fragment);
    const parsed = parseQualifiedHref(href);
    if (!readsBackAsOneLink(href) || !parsed.ok || parsed.ref.alias !== target.alias || parsed.ref.id !== target.id
      || parsed.fragment !== target.fragment) {
      throw new InvalidInputError(`'okf://${target.alias}/${target.id}.md' cannot be written as a link that reads back to the same target.`);
    }
    return href;
  }
  const base = relativeHref(target.from, target.to);
  const href = target.fragment === undefined ? base : `${base}#${target.fragment}`;
  const fragmentAt = href.indexOf("#");
  const readFragment = fragmentAt < 0 ? undefined : href.slice(fragmentAt + 1);
  if (!readsBackAsOneLink(href) || resolveConceptId(target.from, href) !== target.to || readFragment !== target.fragment
    || base.includes("?")) {
    throw new InvalidInputError(`'${target.to}' cannot be written as a link from '${target.from}' that resolves back to it (href '${href}').`);
  }
  return href;
}
