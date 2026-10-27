/** Storage-neutral body replacement policy and portable preview identity. */
import { normalizeDocumentBodyForStorage } from "./frontmatter.js";
import { extractMarkdownLinkSpans, resolveConceptId, type MarkdownLinkSpan } from "./links.js";
import { isQualifiedHref, parseQualifiedHref } from "./qualified-links.js";
import { InvalidInputError } from "./errors.js";
import type { KindConvention } from "./kinds.js";
import type { Bundle, Link, OkfDocument } from "./types.js";

export const BODY_PREVIEW_LIMIT = 1000;

export const BODY_PREVIEW_TRUNCATION_MARKER = "[superbee:body-preview-truncated]";

function previewTruncationNotice(omitted: number): string {
  return `${BODY_PREVIEW_TRUNCATION_MARKER} ${omitted} more character(s) are NOT shown`;
}

export const BODY_PREVIEW_TRUNCATION_SIGNATURE =
  /\[superbee:body-preview-truncated\]\s+\d+\s+more\s+characters?\(?s?\)?\s+are\s+NOT\s+shown/i;

export const BODY_PREVIEW_KEY = "body_preview";

export const BODY_PREVIEW_RESERVED_KEYS: readonly string[] = [
  "body",
  BODY_PREVIEW_KEY,
  "body_truncated",
  "body_chars",
  "help",
];

export function attachBodyPreview(
  rec: Record<string, unknown>,
  body: string,
  fullBodyHelp: readonly string[],
): void {
  if (body.length <= BODY_PREVIEW_LIMIT) {
    rec.body = body;
    return;
  }
  const omitted = body.length - BODY_PREVIEW_LIMIT;
  rec[BODY_PREVIEW_KEY] =
    `${body.slice(0, BODY_PREVIEW_LIMIT)}\n\n${previewTruncationNotice(omitted)} — this value is a ` +
    `preview, not the document body; use this record's help to read the complete body before ` +
    `rewriting it.`;
  rec.body_truncated = true;
  rec.body_chars = body.length;
  rec.help = [...fullBodyHelp];
}

function matchesPreviewSlice(candidate: string, preview: string): boolean {
  if (candidate === preview) return true;
  const trimmed = preview.trimEnd();
  return trimmed !== "" && candidate.trimEnd() === trimmed;
}


function firstForeignNotice(storedBody: string, nextBody: string): string | undefined {
  const preservesStoredBody = nextBody.includes(storedBody.trimEnd());
  const every = new RegExp(BODY_PREVIEW_TRUNCATION_SIGNATURE.source, `${BODY_PREVIEW_TRUNCATION_SIGNATURE.flags}g`);
  for (const match of nextBody.matchAll(every)) {
    if (!(preservesStoredBody && storedBody.includes(match[0]))) return match[0];
  }
  return undefined;
}


function isSameStoredBody(nextBody: string, existingBody: string): boolean {
  return normalizeDocumentBodyForStorage(nextBody) === normalizeDocumentBodyForStorage(existingBody);
}


export type BodyPreviewFinding =
  | { reason: "preview_marker"; marker: string; notice: string }
  | { reason: "stored_body_preview"; preview_limit: number; supplied_body_chars: number; stored_body_chars: number };

/** Unchanged serialized bodies and stored notices carried by a preserving append are safe. */
export function bodyPreviewFinding(existing: OkfDocument, nextBody: string): BodyPreviewFinding | undefined {
  if (isSameStoredBody(nextBody, existing.body)) return;
  const notice = firstForeignNotice(existing.body, nextBody);
  if (notice !== undefined) return { reason: "preview_marker", marker: BODY_PREVIEW_TRUNCATION_MARKER, notice };
  if (existing.body.length > BODY_PREVIEW_LIMIT && matchesPreviewSlice(nextBody, existing.body.slice(0, BODY_PREVIEW_LIMIT))) {
    return { reason: "stored_body_preview", preview_limit: BODY_PREVIEW_LIMIT, supplied_body_chars: nextBody.length, stored_body_chars: existing.body.length };
  }
}

export type BodyReplaceFinding = BodyPreviewFinding | { reason: "dropped_links"; dropped_links: Link[] };
export class BodyReplaceError extends InvalidInputError {
  readonly id: string;
  readonly finding: BodyReplaceFinding;
  readonly storedCarriesNotice: boolean;
  constructor(id: string, finding: BodyReplaceFinding, storedCarriesNotice = false) {
    super(`Body replacement of '${id}' refused: ${finding.reason}.`);
    this.name = "BodyReplaceError";
    this.id = id; this.finding = finding; this.storedCarriesNotice = storedCarriesNotice;
  }
}
export interface BodyReplacePosture {
  acceptTruncatedBody?: boolean;
  replaceLinks?: boolean;
}

/** Capture explicit per-write intent; truthy values and unknown flags never grant an override. */
export function captureBodyReplacePosture(value: unknown): BodyReplacePosture | undefined {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new InvalidInputError("bodyReplace must be an object with boolean acceptTruncatedBody and/or replaceLinks fields.");
  }
  const captured: BodyReplacePosture = {};
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "acceptTruncatedBody" && key !== "replaceLinks") throw new InvalidInputError("Unknown bodyReplace field.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || typeof descriptor.value !== "boolean") throw new InvalidInputError(`bodyReplace.${key} must be a boolean.`);
    captured[key] = descriptor.value;
  }
  return captured;
}

/** A cross-bundle edge is a different target from a local one with the same id. */
function targetKey(l: Link): string {
  return l.bundle === undefined ? l.to : `okf://${l.bundle}/${l.to}`;
}

/**
 * A link alone on its line is the shape `link add` writes: a typed edge whose text is its relation
 * ("part of"). Another standalone link to the target may relabel it, but a prose link that merely
 * mentions the same target cannot stand in for it.
 */
type GuardedLink = Link & { standalone?: boolean };

/** Exact pairs consume first; target mode then admits retext (a standalone edge only by another
 * standalone link) while preserving occurrence counts. Exact-edge mode is available to authorities that protect
 * relationship text as well. */
export function computeDroppedLinks(existingLinks: readonly Link[], nextLinks: readonly Link[], mode: "target" | "exact-edge" = "target"): Link[] {
  const nextByTarget = new Map<string, Link[]>();
  for (const l of nextLinks) {
    const key = mode === "exact-edge" ? JSON.stringify([l.from, targetKey(l)]) : targetKey(l);
    const bucket = nextByTarget.get(key);
    if (bucket) bucket.push(l);
    else nextByTarget.set(key, [l]);
  }
  const existingByTarget = new Map<string, Link[]>();
  for (const l of existingLinks) {
    const key = mode === "exact-edge" ? JSON.stringify([l.from, targetKey(l)]) : targetKey(l);
    const bucket = existingByTarget.get(key);
    if (bucket) bucket.push(l);
    else existingByTarget.set(key, [l]);
  }

  const dropped: Link[] = [];
  for (const [target, oldOccurrences] of existingByTarget) {
    const available = [...(nextByTarget.get(target) ?? [])]; // mutable, consumed as occurrences pair off
    const unmatchedExact: Link[] = [];

    // Pass 1: exact (target,text) — consume one matching new occurrence per old occurrence.
    for (const old of oldOccurrences) {
      const idx = available.findIndex((n) => n.text === old.text);
      if (idx >= 0) available.splice(idx, 1);
      else unmatchedExact.push(old);
    }
    // Pass 2: retext — any leftover old occurrence pairs with any leftover same-target occurrence,
    // regardless of text; anything still left over after that is a real drop.
    for (const old of unmatchedExact) {
      // A prose link prefers a prose stand-in, leaving standalone links for standalone edges.
      const prose = available.findIndex((n) => !(n as GuardedLink).standalone);
      const idx = mode !== "target" ? -1
        : (old as GuardedLink).standalone ? available.findIndex((n) => (n as GuardedLink).standalone) : prose >= 0 ? prose : 0;
      if (idx >= 0 && idx < available.length) available.splice(idx, 1);
      else dropped.push(old);
    }
  }
  return dropped;
}

function aloneOnLine(body: string, span: MarkdownLinkSpan): boolean {
  const lineStart = body.lastIndexOf("\n", span.start - 1) + 1;
  const newline = body.indexOf("\n", span.end);
  const lineEnd = newline < 0 ? body.length : newline;
  return body.slice(lineStart, span.start).trim() === "" && body.slice(span.end, lineEnd).trim() === "";
}

/**
 * Every outbound cross-link a body carries, as the guard compares them: local document links (as
 * `parseLinksFromDoc` reads them) and well-formed `okf:` links into another bundle outside code (as
 * `parseQualifiedLinks` reads them). Web links are not cross-links.
 */
export function outboundLinks(doc: OkfDocument): Link[] {
  const live = new Set(extractMarkdownLinkSpans(doc.body, { skipCode: true }).map((span) => span.start));
  const links: GuardedLink[] = [];
  for (const span of extractMarkdownLinkSpans(doc.body)) {
    if (span.image) continue;
    const standalone = aloneOnLine(doc.body, span);
    if (isQualifiedHref(span.href)) {
      if (!live.has(span.start)) continue;
      const parsed = parseQualifiedHref(span.href);
      if (parsed.ok) links.push({ from: doc.id, to: parsed.ref.id, text: span.text, href: span.href, bundle: parsed.ref.alias, standalone });
      continue;
    }
    const to = resolveConceptId(doc.id, span.href);
    if (to !== null) links.push({ from: doc.id, to, text: span.text, href: span.href, standalone });
  }
  return links;
}

export function droppedLinks(_bundle: Bundle, existing: OkfDocument, nextBody: string): Link[] {
  return computeDroppedLinks(outboundLinks(existing), outboundLinks({ ...existing, body: nextBody }))
    .map(({ standalone: _standalone, ...link }: GuardedLink) => link);
}
export function guardTruncatedBodyPreview(existing: OkfDocument, nextBody: string, acceptTruncatedBody: boolean): void {
  if (acceptTruncatedBody) return;
  const finding = bodyPreviewFinding(existing, nextBody);
  if (finding) throw new BodyReplaceError(existing.id, finding, BODY_PREVIEW_TRUNCATION_SIGNATURE.test(existing.body));
}
export function guardDroppedLinks(bundle: Bundle, existing: OkfDocument, nextBody: string, replaceLinks: boolean): void {
  if (replaceLinks || isSameStoredBody(nextBody, existing.body)) return;
  const dropped = droppedLinks(bundle, existing, nextBody);
  if (dropped.length) throw new BodyReplaceError(existing.id, { reason: "dropped_links", dropped_links: dropped });
}
export function guardBodyReplace(bundle: Bundle, existing: OkfDocument, nextBody: string, posture?: BodyReplacePosture): void {
  if (isSameStoredBody(nextBody, existing.body)) return;
  guardTruncatedBodyPreview(existing, nextBody, Boolean(posture?.acceptTruncatedBody));
  guardDroppedLinks(bundle, existing, nextBody, Boolean(posture?.replaceLinks));
}

/** A scalar patch cannot replace a declared list, even when the stored field is absent. */
export class TypedListPatchError extends InvalidInputError {
  readonly field: string;
  readonly fieldType: "string-list" | "https-url-list";
  constructor(field: string, fieldType: "string-list" | "https-url-list") {
    super(`'${field}' is a ${fieldType} field; use an explicit whole-list replacement.`);
    this.name = "TypedListPatchError";
    this.field = field; this.fieldType = fieldType;
  }
}
export function assertTypedListPatch(kind: KindConvention, storageField: string): void {
  const types = kind.fields.types ?? {};
  const type = Object.hasOwn(types, storageField) ? types[storageField] : undefined;
  if (type === "string-list" || type === "https-url-list") throw new TypedListPatchError(storageField, type);
}
