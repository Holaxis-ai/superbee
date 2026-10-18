/**
 * What one document contributes to any search index, one owner. The in-memory source builds its
 * term sets and volume from `fieldTokens` and the body scanner; a native index stores
 * `searchRowText`'s column texts. Both read the same tokens, so their instance counts agree.
 */
import { sha256HexOfUtf8 } from "../sha256.js";
import {
  BODY_OCCURRENCE_CAP,
  SEARCH_ALGORITHM,
  SEARCH_TEXT_REVISION,
  documentDescription,
  documentTags,
  documentTitle,
  documentType,
  type SearchDocumentV1,
} from "./contract.js";
import { normalize, scanBody, tokenize, utf8 } from "./text.js";

/** UTF-8 bytes of the text one document contributes to an index: id, title, description, type, tags, body. */
export function documentSourceBytes(document: SearchDocumentV1): number {
  return (
    utf8(document.id).byteLength +
    utf8(documentTitle(document) ?? "").byteLength +
    utf8(documentDescription(document) ?? "").byteLength +
    utf8(documentType(document) ?? "").byteLength +
    documentTags(document).reduce((total, tag) => total + utf8(tag).byteLength, 0) +
    utf8(document.body).byteLength
  );
}

/** The normalized tokens of every field except the body, in document order. */
export function fieldTokens(document: SearchDocumentV1): {
  readonly id: readonly string[];
  readonly title: readonly string[];
  readonly type: readonly string[];
  readonly tag: readonly string[];
  readonly description: readonly string[];
} {
  const type = documentType(document);
  return {
    id: tokenize(document.id),
    title: tokenize(documentTitle(document) ?? ""),
    type: type === undefined ? [] : tokenize(type),
    tag: documentTags(document).flatMap((tag) => tokenize(tag)),
    description: tokenize(documentDescription(document) ?? ""),
  };
}

export interface SearchRowTextV1 {
  /** Each field's normalized tokens joined by one ASCII space, in document order. */
  readonly idTerms: string;
  readonly titleTerms: string;
  readonly typeTerms: string;
  readonly tagTerms: string;
  readonly descriptionTerms: string;
  /** The body's tokens in document order, keeping the first BODY_OCCURRENCE_CAP occurrences of each term. */
  readonly bodyTerms: string;
  readonly titlePhrase: string;
  readonly idPhrase: string;
  /** term -> its occurrences across the six column texts above (the body capped), in first-seen order. */
  readonly instances: ReadonlyMap<string, number>;
  /** Body tokens before the cap; over SEARCH_LIMITS.maxTermsPerDocument the index cannot hold the document. */
  readonly bodyTermCount: number;
}

/** What one document contributes to any index: per-field token text, the two phrases, and the
 * instance count per term. */
export function searchRowText(document: SearchDocumentV1): SearchRowTextV1 {
  const fields = fieldTokens(document);
  const instances = new Map<string, number>();
  const count = (term: string): void => void instances.set(term, (instances.get(term) ?? 0) + 1);
  for (const tokens of [fields.id, fields.title, fields.type, fields.tag, fields.description])
    for (const term of tokens) count(term);
  const body: string[] = [];
  const seen = new Map<string, number>();
  let bodyTermCount = 0;
  scanBody(document.body, (term) => {
    bodyTermCount += 1;
    const occurrence = (seen.get(term) ?? 0) + 1;
    seen.set(term, occurrence);
    if (occurrence > BODY_OCCURRENCE_CAP) return;
    body.push(term);
    count(term);
  });
  const idTerms = fields.id.join(" ");
  const titleTerms = fields.title.join(" ");
  return Object.freeze({
    idTerms,
    titleTerms,
    typeTerms: fields.type.join(" "),
    tagTerms: fields.tag.join(" "),
    descriptionTerms: fields.description.join(" "),
    bodyTerms: body.join(" "),
    titlePhrase: titleTerms,
    idPhrase: idTerms,
    instances,
    bodyTermCount,
  });
}

// Compatibility characters, combining sequences, case pairs across scripts, scripts whose marks
// split tokens, and characters from recent Unicode versions (Glagolitic U+2C2F and U+2C5F from 14.0,
// U+1E030 from 15.0, Cyrillic TJE U+1C89 and U+1C8A from 16.0), so a runtime whose Unicode tables
// differ prints another fingerprint.
const FINGERPRINT_SAMPLE = Object.freeze([
  "ﬁ ﬂ ＡＢ ½ ℀ ㎃ ① Ⅸ ⁵ µ ㍿ ｶ ﾞ",
  "café Å Å ñ 가 क़",
  "ΟΔΟΣ Σίσυφος ǅ Ǆ İ ẞ Ꭰ ꭰ Ა Ⴀ Ꙁ",
  "खोज ค้นหา البحث 中文 검색 եւ և",
  "Ⱟⱟ \u{1e030} Ᲊᲊ",
]);

let fingerprint: string | undefined;

/** The normalizer fingerprint of the running runtime: a short hash of normalize() and tokenize()
 * over a fixed sample. */
export function normalizerFingerprint(): string {
  fingerprint ??= sha256HexOfUtf8(
    FINGERPRINT_SAMPLE.map((sample) => `${normalize(sample)}\u0001${tokenize(sample).join(" ")}`).join("\u0000"),
  ).slice(0, 16);
  return fingerprint;
}

/** `${SEARCH_ALGORITHM}/${SEARCH_TEXT_REVISION}/${normalizerFingerprint()}`: what a stored index row
 * was derived with. */
export function textVersion(): string {
  return `${SEARCH_ALGORITHM}/${SEARCH_TEXT_REVISION}/${normalizerFingerprint()}`;
}
