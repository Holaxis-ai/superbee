/**
 * Link findings: what a document's body links do, and which of them will not register.
 *
 * Core produces each finding once, as a {@link ValidationWarning} with a fixed `message` per code
 * and the facts in `details`; every surface (CLI, MCP, apps) words its own next step from those.
 * The edge rule itself is `links.ts` ({@link resolveConceptId}); this module only reports on it.
 *
 * Codes:
 *   - `LINK_NOT_RECOGNIZED`: written like a link to a document but not a graph edge
 *     (a `[[wikilink]]`, a target without `.md`, a reserved file, an invalid id).
 *   - `LINK_TARGET_ABSENT`: an edge whose target has no document yet (still legal).
 *   - `LINK_TYPE_VIOLATION`, `LINK_TYPE_CASE_VARIANT`: an edge whose text is, or nearly is, a
 *     declared link type its source or target does not conform to.
 *
 * Pure apart from the caller-supplied target reader, so it stays backend- and browser-neutral.
 */
import { collectLinkDeclarations, localEdgeQualifiedDeclaration, localEdgeViolation, type LinkTypeDeclaration } from "./link-types.js";
import { extractMarkdownLinkSpans, isExternalHref, maskMarkdownCode, resolveConceptId } from "./links.js";
import { isReservedFile } from "./paths.js";
import { isQualifiedHref, parseQualifiedKindTarget } from "./qualified-links.js";
import type { KindRegistry } from "./kinds.js";
import type { ValidationWarning } from "./validation.js";
import type { ConceptId, Link, OkfDocument } from "./types.js";

export const LINK_NOT_RECOGNIZED = "LINK_NOT_RECOGNIZED";
export const LINK_TARGET_ABSENT = "LINK_TARGET_ABSENT";
export const LINK_TYPE_VIOLATION = "LINK_TYPE_VIOLATION";
export const LINK_TYPE_CASE_VARIANT = "LINK_TYPE_CASE_VARIANT";

/** Why a link-shaped piece of body text is not a graph edge. */
export type LinkNotRecognizedReason =
  /** `[[target]]` or `[[target|text]]`: wikilinks are plain text in OKF. */
  | "wikilink"
  /** A bundle-path-like target whose last segment has no extension. */
  | "missing-md-extension"
  /** A `.md` target naming `index.md` or `log.md`, which are never documents. */
  | "reserved-target"
  /** A `.md` target that does not resolve to a valid document id. */
  | "invalid-target";

/** Offsets of the link in the document body: `[start, end)`. */
export type LinkFindingLocation = {
  start: number;
  end: number;
};

export type LinkNotRecognizedDetails = LinkFindingLocation & {
  reason: LinkNotRecognizedReason;
  text: string;
  /** The target as written (for a wikilink, the part before any `|`). */
  href: string;
  /** A target that would register, when one can be derived. */
  suggestedHref?: string;
  /** The document {@link suggestedHref} resolves to. */
  suggestedTo?: ConceptId;
};

export type LinkTargetAbsentDetails = Partial<LinkFindingLocation> & {
  to: ConceptId;
  href?: string;
  text?: string;
  /**
   * For a bare relative target (no `/`, `./` or `../`) whose bundle-root reading names an
   * existing document: that root-absolute target.
   */
  suggestedHref?: string;
  suggestedTo?: ConceptId;
};

export type LinkTypeViolationDetails = Partial<LinkFindingLocation> & {
  text: string;
  to: ConceptId;
  /** The Kind whose `links` entry declares this text. */
  declaredBy: string;
  /** That entry's target: a Kind name, or `<alias>:<Kind>` for a cross-bundle declaration. */
  declaredTarget: string;
  sourceType: string;
  /** The target document's type; `""` when untyped, null when it has no document. */
  targetType: string | null;
  /** Set when the declaration names a target in another bundle: that bundle's alias. */
  targetAlias?: string;
};

export type LinkTypeCaseVariantDetails = Partial<LinkFindingLocation> & {
  text: string;
  to: ConceptId;
  /** The declared spelling this text matches only case-insensitively. */
  declaredText: string;
};

export interface LinkNotRecognizedFinding extends ValidationWarning {
  code: typeof LINK_NOT_RECOGNIZED;
  details: LinkNotRecognizedDetails;
}
export interface LinkTargetAbsentFinding extends ValidationWarning {
  code: typeof LINK_TARGET_ABSENT;
  details: LinkTargetAbsentDetails;
}
export interface LinkTypeViolationFinding extends ValidationWarning {
  code: typeof LINK_TYPE_VIOLATION;
  details: LinkTypeViolationDetails;
}
export interface LinkTypeCaseVariantFinding extends ValidationWarning {
  code: typeof LINK_TYPE_CASE_VARIANT;
  details: LinkTypeCaseVariantDetails;
}
export type LinkTypeFinding = LinkTypeViolationFinding | LinkTypeCaseVariantFinding;
export type LinkFinding = LinkNotRecognizedFinding | LinkTargetAbsentFinding | LinkTypeFinding;

/** Reads a link target: the document, or undefined when none exists. Other failures throw. */
export type LinkTargetReader = (id: ConceptId) => Promise<OkfDocument | undefined>;

/** A document's registered edges and the findings about its links, in body order. */
export interface DocumentLinkReport {
  /** Exactly the edges {@link parseLinksFromDoc} returns. */
  links: Link[];
  findings: LinkFinding[];
}

const NOT_RECOGNIZED_MESSAGES: Record<LinkNotRecognizedReason, string> = {
  wikilink: "A [[wikilink]] is plain text, not a link; write a markdown link whose target ends in .md.",
  "missing-md-extension": "This link's target does not end in .md, so it is not a link to a document.",
  "reserved-target": "This link's target is a reserved file (index.md or log.md), which is never a document.",
  "invalid-target": "This link's target is not a valid document id, so it is not a link to a document.",
};
const TARGET_ABSENT_MESSAGE = "No document exists at this link's target yet; the link is kept as a forward declaration.";
const TYPE_VIOLATION_MESSAGE = "This link's text is a declared link type, but its source or target is not the declared kind.";
const TYPE_QUALIFIED_MESSAGE = "This link's text is declared as a link into another bundle, but it points inside this bundle.";
const TYPE_CASE_VARIANT_MESSAGE = "This link's text differs only in case from a declared link type.";

const WIKILINK = /\[\[([^[\]\n]+)\]\]/g;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function docType(doc: OkfDocument | undefined): string {
  return typeof doc?.frontmatter.type === "string" ? doc.frontmatter.type : "";
}

/** The path part of an href: anchor and query dropped, trimmed. */
function hrefPath(href: string): string {
  return (href.split("#")[0] ?? "").split("?")[0]?.trim() ?? "";
}

/** True for a relative target written without `/`, `./` or `../`. */
function isBareRelative(path: string): boolean {
  return !path.startsWith("/") && !path.startsWith("./") && !path.startsWith("../");
}

function notRecognized(
  reason: LinkNotRecognizedReason,
  fields: Omit<LinkNotRecognizedDetails, "reason">,
): LinkNotRecognizedFinding {
  return {
    code: LINK_NOT_RECOGNIZED,
    message: NOT_RECOGNIZED_MESSAGES[reason],
    field: "body",
    severity: "warning",
    details: { reason, ...fields },
  };
}

/** Why a markdown link that {@link resolveConceptId} drops still looks meant for a document, if it does. */
function classifyUnresolved(fromId: ConceptId, text: string, href: string, at: LinkFindingLocation): LinkNotRecognizedFinding | undefined {
  if (isQualifiedHref(href)) return undefined; // cross-bundle links have their own grammar and lint
  const path = hrefPath(href);
  if (path === "" || isExternalHref(path) || ANY_SCHEME.test(path)) return undefined;
  if (path.endsWith(".md")) {
    const resolved = path.startsWith("/") ? path.slice(1) : path;
    return notRecognized(isReservedFile(resolved.replace(/^(\.\.?\/)+/, "")) ? "reserved-target" : "invalid-target", { text, href, ...at });
  }
  const last = path.slice(path.lastIndexOf("/") + 1);
  // A last segment with its own extension is an asset link (a PDF, an image), not a near miss.
  if (last === "" || last.includes(".")) return undefined;
  const suggestedHref = `${path}.md`;
  const suggestedTo = resolveConceptId(fromId, suggestedHref);
  return notRecognized("missing-md-extension", { text, href, ...at, ...(suggestedTo === null ? {} : { suggestedHref, suggestedTo }) });
}

function wikilinkFindings(doc: OkfDocument): LinkNotRecognizedFinding[] {
  const masked = maskMarkdownCode(doc.body);
  const out: LinkNotRecognizedFinding[] = [];
  for (const match of masked.matchAll(WIKILINK)) {
    const start = match.index;
    const end = start + match[0].length;
    const inner = doc.body.slice(start + 2, end - 2);
    const bar = inner.indexOf("|");
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const text = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
    const path = hrefPath(target).replace(/^\/+/, "");
    const suggestedHref = path === "" ? undefined : `/${path.endsWith(".md") ? path : `${path}.md`}`;
    const suggestedTo = suggestedHref === undefined ? null : resolveConceptId(doc.id, suggestedHref);
    out.push(notRecognized("wikilink", {
      text,
      href: target,
      start,
      end,
      ...(suggestedTo === null ? {} : { suggestedHref: suggestedHref!, suggestedTo }),
    }));
  }
  return out;
}

/**
 * A document's registered edges plus the link-shaped text that will not register
 * (`LINK_NOT_RECOGNIZED`), in body order. Pure; reads nothing.
 */
export function inspectDocumentLinks(doc: OkfDocument): DocumentLinkReport {
  const links: Link[] = [];
  const findings: LinkFinding[] = [];
  for (const span of extractMarkdownLinkSpans(doc.body)) {
    if (span.image) continue;
    const to = resolveConceptId(doc.id, span.href);
    if (to !== null) {
      links.push({ from: doc.id, to, text: span.text, href: span.href });
      continue;
    }
    const finding = classifyUnresolved(doc.id, span.text, span.href, { start: span.start, end: span.end });
    if (finding) findings.push(finding);
  }
  findings.push(...wikilinkFindings(doc));
  findings.sort((a, b) => (a.details.start ?? 0) - (b.details.start ?? 0));
  return { links, findings };
}

/**
 * The finding for an edge whose target has no document, or undefined when it has one. The link
 * itself stays legal: dangling links are forward declarations.
 */
export async function linkTargetAbsentFinding(
  link: { to: ConceptId; href?: string; text?: string } & Partial<LinkFindingLocation>,
  readTarget: LinkTargetReader,
): Promise<LinkTargetAbsentFinding | undefined> {
  if ((await readTarget(link.to)) !== undefined) return undefined;
  return { code: LINK_TARGET_ABSENT, message: TARGET_ABSENT_MESSAGE, field: "body", severity: "warning", details: { ...link } };
}

async function typeFinding(
  declarations: Map<string, LinkTypeDeclaration[]>,
  link: { sourceType: string; text: string; to: ConceptId } & Partial<LinkFindingLocation>,
  readTarget: LinkTargetReader,
): Promise<LinkTypeFinding | undefined> {
  if (declarations.size === 0) return undefined;
  const { sourceType, ...where } = link;
  const exact = declarations.get(link.text);
  if (exact && exact.length > 0) {
    // Only an exact match needs the target's actual type; a near miss never pays for the read.
    const target = await readTarget(link.to);
    const targetType = target === undefined ? null : docType(target);
    const qualified = localEdgeQualifiedDeclaration(exact, sourceType);
    if (qualified) {
      return {
        code: LINK_TYPE_VIOLATION,
        message: TYPE_QUALIFIED_MESSAGE,
        field: "body",
        severity: "warning",
        details: {
          ...where,
          declaredBy: qualified.governs,
          declaredTarget: qualified.target,
          sourceType,
          targetType,
          targetAlias: parseQualifiedKindTarget(qualified.target)!.alias,
        },
      };
    }
    const violated = localEdgeViolation(exact, sourceType, targetType ?? undefined);
    if (!violated) return undefined;
    return {
      code: LINK_TYPE_VIOLATION,
      message: TYPE_VIOLATION_MESSAGE,
      field: "body",
      severity: "warning",
      details: { ...where, declaredBy: violated.governs, declaredTarget: violated.target, sourceType, targetType },
    };
  }
  const lower = link.text.toLowerCase();
  for (const declaredText of declarations.keys()) {
    if (declaredText.toLowerCase() === lower) {
      return {
        code: LINK_TYPE_CASE_VARIANT,
        message: TYPE_CASE_VARIANT_MESSAGE,
        field: "body",
        severity: "warning",
        details: { ...where, declaredText },
      };
    }
  }
  return undefined;
}

/**
 * Type-conformance finding for one local edge. When `text` exactly matches a declared link type,
 * the source and the target's actual kinds are checked against it (`LINK_TYPE_VIOLATION`; a
 * missing target checks the source only). When `text` matches a declared type only
 * case-insensitively, `LINK_TYPE_CASE_VARIANT` names the declared spelling. Untyped text, or a
 * registry with no `links` declarations, yields undefined without reading anything.
 */
export function linkTypeFinding(
  registry: KindRegistry,
  link: { sourceType: string; text: string; to: ConceptId },
  readTarget: LinkTargetReader,
): Promise<LinkTypeFinding | undefined> {
  return typeFinding(collectLinkDeclarations(registry), link, readTarget);
}

/**
 * Everything {@link inspectDocumentLinks} reports, plus, per registered edge: an absent target
 * (with a root-absolute suggestion for a bare relative href) and, when `registry` is given, link
 * type conformance. Each distinct target is read at most once. A missing-`.md` suggestion is
 * re-pointed at the bundle-root reading when only that one names an existing document.
 */
export async function documentLinkReport(
  doc: OkfDocument,
  opts: { readTarget: LinkTargetReader; registry?: KindRegistry },
): Promise<DocumentLinkReport> {
  const { links, findings } = inspectDocumentLinks(doc);
  const cache = new Map<ConceptId, Promise<OkfDocument | undefined>>();
  const read: LinkTargetReader = (id) => {
    let pending = cache.get(id);
    if (!pending) {
      pending = opts.readTarget(id);
      cache.set(id, pending);
    }
    return pending;
  };
  const exists = async (id: ConceptId) => (await read(id)) !== undefined;
  const rootReading = (path: string): ConceptId | null => (isBareRelative(path) ? resolveConceptId(doc.id, `/${path}`) : null);

  for (const finding of findings) {
    if (finding.code !== LINK_NOT_RECOGNIZED || finding.details.reason !== "missing-md-extension") continue;
    const relative = finding.details.suggestedTo;
    if (relative !== undefined && (await exists(relative))) continue;
    const path = `${hrefPath(finding.details.href)}.md`;
    const root = rootReading(path);
    if (root !== null && root !== relative && (await exists(root))) {
      finding.details.suggestedHref = `/${path}`;
      finding.details.suggestedTo = root;
    }
  }

  const declarations = opts.registry ? collectLinkDeclarations(opts.registry) : new Map<string, LinkTypeDeclaration[]>();
  const sourceType = docType(doc);
  const spans = extractMarkdownLinkSpans(doc.body).filter((span) => !span.image && resolveConceptId(doc.id, span.href) !== null);
  for (const [index, link] of links.entries()) {
    if (isQualifiedHref(link.href)) continue; // a malformed okf: href is a cross-bundle finding, not a local edge
    const span = spans[index]!;
    const where = { start: span.start, end: span.end };
    const absent = await linkTargetAbsentFinding({ to: link.to, href: link.href, text: link.text, ...where }, read);
    if (absent) {
      const path = hrefPath(link.href);
      const root = rootReading(path);
      if (root !== null && root !== link.to && (await exists(root))) {
        absent.details.suggestedHref = `/${path}`;
        absent.details.suggestedTo = root;
      }
      findings.push(absent);
    }
    const typed = await typeFinding(declarations, { sourceType, text: link.text, to: link.to, ...where }, read);
    if (typed) findings.push(typed);
  }
  findings.sort((a, b) => (a.details.start ?? 0) - (b.details.start ?? 0));
  return { links, findings };
}
