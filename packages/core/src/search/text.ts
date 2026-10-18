/**
 * The search text rules, one owner: normalization, tokenization, the body scanner that keeps original
 * byte offsets, query normalization and the automatic fallback's relaxation, plus the UTF-8 helpers
 * excerpts need. Moved unchanged from portal-webmcp 0.3.1 (`search.ts`, `text.ts`).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * Move an index forward until it starts a UTF-8 sequence. A slice that begins on
 * a continuation byte would decode to a replacement character, so continuations
 * are skipped rather than replaced.
 */
export function forwardBoundary(bytes: Uint8Array, index: number): number {
  let cursor = Math.max(0, Math.min(index, bytes.byteLength));
  while (cursor < bytes.byteLength && continuation(bytes[cursor])) cursor += 1;
  return cursor;
}

/** Move an index backward until it ends a complete UTF-8 sequence. */
export function backwardBoundary(bytes: Uint8Array, index: number): number {
  let cursor = Math.max(0, Math.min(index, bytes.byteLength));
  while (cursor > 0 && continuation(bytes[cursor])) cursor -= 1;
  return cursor;
}

export function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end));
}

/** Collapse every maximal whitespace run to one ASCII space and trim both ends. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const TOKEN = /[\p{L}\p{N}]+/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;

/** Locale-independent normalization: Unicode NFKC then `toLowerCase()`. */
export function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** Tokenization into maximal Unicode letter-or-number sequences of the normalized text. */
export function tokenize(value: string): string[] {
  return [...normalize(value).matchAll(TOKEN)].map((match) => match[0]!);
}

/** A field's normalized phrase is its tokens joined by one ASCII space. */
export function phrase(value: string): string {
  return tokenize(value).join(" ");
}

/**
 * Whether an original character can belong to a token run.
 *
 * Body tokens must keep original byte offsets, so the body is segmented before
 * normalization rather than after. A character joins a run when it is a letter
 * or number, a combining mark (so a decomposed sequence composes inside its own
 * run), or a compatibility character whose NFKC form contains a letter or
 * number. NFKC never composes across a character outside that set, so run-wise
 * tokenization yields the same terms as tokenizing the whole normalized field.
 */
const runMembership = new Map<string, boolean>();
function inTokenRun(character: string): boolean {
  const cached = runMembership.get(character);
  if (cached !== undefined) return cached;
  const member =
    LETTER_OR_NUMBER.test(character) || MARK.test(character) || LETTER_OR_NUMBER.test(character.normalize("NFKC"));
  runMembership.set(character, member);
  return member;
}

/**
 * Visits every body token in document order with the original UTF-8 byte range of the run that
 * produced it (every token of one run shares its range). `visit` returns `true` to stop the scan.
 * The in-memory index and the excerpt both read the body through this one scanner, so a match's
 * offsets are the same wherever they are computed.
 */
export function scanBody(body: string, visit: (term: string, start: number, end: number) => boolean | void): void {
  let byteOffset = 0;
  let runStart = 0;
  let run = "";
  let stopped = false;
  const flush = (): void => {
    if (run.length === 0) return;
    for (const match of normalize(run).matchAll(TOKEN)) {
      if (visit(match[0]!, runStart, byteOffset) === true) {
        stopped = true;
        break;
      }
    }
    run = "";
  };
  for (const character of body) {
    if (inTokenRun(character)) {
      if (run.length === 0) runStart = byteOffset;
      run += character;
    } else {
      flush();
      if (stopped) return;
    }
    byteOffset += utf8(character).byteLength;
  }
  flush();
}

export interface NormalizedQueryV1 {
  readonly phrase: string;
  readonly terms: readonly string[];
}

/** Duplicate query tokens collapse after their first occurrence; the phrase is the remainder. */
export function normalizeQuery(query: string): NormalizedQueryV1 {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return { phrase: terms.join(" "), terms: Object.freeze(terms) };
}

// Fixed package text, deliberately not locale-sensitive. These words carry
// little retrieval signal in ordinary English questions. They are removed only
// by the automatic fallback, never by explicit `all` or `any` matching.
// prettier-ignore
const CONVERSATIONAL_TERMS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does",
  "for", "from", "how", "in", "is", "it", "of", "on", "or", "should", "that", "the",
  "this", "to", "was", "what", "when", "where", "which", "who", "why", "will", "with",
]);

export interface RelaxedQueryV1 {
  readonly query: NormalizedQueryV1;
  readonly ignoredTerms: readonly string[];
}

/**
 * Removes fixed conversational terms for automatic any-term fallback. If that
 * would remove the whole query, the original normalized query stays intact.
 */
export function relaxQuery(query: NormalizedQueryV1): RelaxedQueryV1 {
  const terms = query.terms.filter((term) => !CONVERSATIONAL_TERMS.has(term));
  if (terms.length === 0) return { query, ignoredTerms: Object.freeze([]) };
  const kept = new Set(terms);
  return {
    query: { phrase: terms.join(" "), terms: Object.freeze(terms) },
    ignoredTerms: Object.freeze(query.terms.filter((term) => !kept.has(term))),
  };
}
