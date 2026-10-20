/** Storage-neutral body replacement policy and portable preview identity. */
import { normalizeDocumentBodyForStorage } from "./frontmatter.js";
import { parseLinksFromDoc } from "./links.js";
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

/** Exact pairs consume first; target mode then admits retext while preserving occurrence counts.
 * Exact-edge mode is available to authorities that protect relationship text as well. */
export function computeDroppedLinks(existingLinks: readonly Link[], nextLinks: readonly Link[], mode: "target" | "exact-edge" = "target"): Link[] {
  const nextByTarget = new Map<string, Link[]>();
  for (const l of nextLinks) {
    const key = mode === "exact-edge" ? JSON.stringify([l.from, l.to]) : l.to;
    const bucket = nextByTarget.get(key);
    if (bucket) bucket.push(l);
    else nextByTarget.set(key, [l]);
  }
  const existingByTarget = new Map<string, Link[]>();
  for (const l of existingLinks) {
    const key = mode === "exact-edge" ? JSON.stringify([l.from, l.to]) : l.to;
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
      if (mode === "target" && available.length > 0) available.shift();
      else dropped.push(old);
    }
  }
  return dropped;
}

export function droppedLinks(_bundle: Bundle, existing: OkfDocument, nextBody: string): Link[] {
  return computeDroppedLinks(parseLinksFromDoc(existing), parseLinksFromDoc({ ...existing, body: nextBody }));
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
