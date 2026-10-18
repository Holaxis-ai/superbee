/**
 * Scoring, ordering, facets and excerpts over a source's evidence. The weights, the order and the
 * excerpt window are portal-webmcp 0.3.1's (`search.ts`), read from evidence instead of an index
 * row, so every source ranks with this one code.
 */
import {
  BODY_OCCURRENCE_CAP,
  EXCERPT_LEAD_BYTES,
  SEARCH_LIMITS,
  SEARCH_MATCH_FIELDS,
  SIGNAL_INTERVAL,
  type SearchFacetV1,
  type SearchFacetValueV1,
  type SearchFiltersV1,
  type SearchMatchFieldV1,
  type SearchMatchModeV1,
  type SearchStopV1,
} from "./contract.js";
import { stopIfAsked } from "./errors.js";
import { codeUnitCompare } from "./identity.js";
import type { SearchEvidenceV1, SearchTextV1 } from "./source.js";
import {
  backwardBoundary,
  collapseWhitespace,
  decodeUtf8,
  forwardBoundary,
  scanBody,
  utf8,
  type NormalizedQueryV1,
} from "./text.js";

export interface SearchTermEvidenceV1 {
  readonly term: string;
  readonly fields: readonly SearchMatchFieldV1[];
}

export interface RankedHitV1 {
  readonly evidence: SearchEvidenceV1;
  readonly score: number;
  /** Exact normalized terms and indexed fields that contributed to this hit. */
  readonly matchedTerms: readonly SearchTermEvidenceV1[];
}

/** The fields holding `term`, in the contract's field order whatever order the source used. */
function fieldsForTerm(evidence: SearchEvidenceV1, term: string): SearchMatchFieldV1[] {
  const held = evidence.terms.get(term);
  if (held === undefined) return [];
  return SEARCH_MATCH_FIELDS.filter((field) => held.fields.includes(field));
}

function score(
  evidence: SearchEvidenceV1,
  query: NormalizedQueryV1,
  match: SearchMatchModeV1,
): { score: number; matchedTerms: readonly SearchTermEvidenceV1[] } | undefined {
  const matchedTerms: SearchTermEvidenceV1[] = [];
  for (const term of query.terms) {
    const fields = fieldsForTerm(evidence, term);
    if (fields.length === 0) {
      if (match === "all") return undefined;
      continue;
    }
    matchedTerms.push(Object.freeze({ term, fields: Object.freeze(fields) }));
  }
  if (matchedTerms.length === 0) return undefined;
  let total = 0;
  if (evidence.titlePhrase === query.phrase) total += 10_000;
  else if (evidence.titlePhrase.startsWith(`${query.phrase} `)) total += 5_000;
  if (evidence.idPhrase === query.phrase) total += 4_000;
  for (const { term, fields } of matchedTerms) {
    if (fields.includes("title")) total += 500;
    if (fields.includes("type")) total += 250;
    if (fields.includes("tag")) total += 250;
    if (fields.includes("description")) total += 100;
    if (fields.includes("id")) total += 100;
    const occurrences = evidence.terms.get(term)?.bodyOccurrences ?? 0;
    total += Math.min(occurrences, BODY_OCCURRENCE_CAP) * 10;
  }
  return { score: total, matchedTerms: Object.freeze(matchedTerms) };
}

/** Deterministic ranking: score descending, then canonical id in code-unit order. With `any`,
 * term coverage first. The exact filters are applied again here, so a source cannot widen them. */
export function rankEvidence(
  documents: readonly SearchEvidenceV1[],
  query: NormalizedQueryV1,
  filters: SearchFiltersV1,
  match: SearchMatchModeV1,
  stop?: SearchStopV1,
): readonly RankedHitV1[] {
  stopIfAsked(stop);
  const hits: RankedHitV1[] = [];
  for (const [position, evidence] of documents.entries()) {
    if (position % SIGNAL_INTERVAL === 0) stopIfAsked(stop);
    if (filters.type !== undefined && evidence.type !== filters.type) continue;
    if (filters.tag !== undefined && !evidence.tags.includes(filters.tag)) continue;
    if (filters.prefix !== undefined && !evidence.id.startsWith(filters.prefix)) continue;
    const value = score(evidence, query, match);
    if (value === undefined) continue;
    hits.push(Object.freeze({ evidence, score: value.score, matchedTerms: value.matchedTerms }));
  }
  hits.sort(
    (left, right) =>
      (match === "any" ? right.matchedTerms.length - left.matchedTerms.length : 0) ||
      right.score - left.score ||
      codeUnitCompare(left.evidence.id, right.evidence.id),
  );
  return Object.freeze(hits);
}

function facetValues(counts: Map<string, number>): SearchFacetValueV1[] {
  return [...counts.entries()]
    .sort(([leftValue, left], [rightValue, right]) => right - left || codeUnitCompare(leftValue, rightValue))
    .slice(0, SEARCH_LIMITS.maxFacetValues)
    .map(([value, count]) => ({ value, count }));
}

/** Value counts over every hit; a repeated tag counts once per document. */
export function facetsOf(hits: readonly RankedHitV1[], wanted: ReadonlySet<SearchFacetV1>) {
  const types = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const { evidence } of hits) {
    if (wanted.has("type") && evidence.type !== undefined) types.set(evidence.type, (types.get(evidence.type) ?? 0) + 1);
    if (wanted.has("tags")) for (const tag of new Set(evidence.tags)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return {
    ...(wanted.has("type") ? { type: facetValues(types) } : {}),
    ...(wanted.has("tags") ? { tags: facetValues(tags) } : {}),
  };
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function excerptFrom(bytes: Uint8Array, match: ByteRange, excerptBytes: number): string {
  const matchBytes = match.end - match.start;
  const leadBudget = Math.max(0, excerptBytes - Math.min(excerptBytes, matchBytes));
  const lead = Math.min(EXCERPT_LEAD_BYTES, leadBudget);
  const start = forwardBoundary(bytes, Math.max(0, match.start - lead));
  const end = backwardBoundary(bytes, Math.min(bytes.byteLength, start + excerptBytes));
  return collapseWhitespace(decodeUtf8(bytes, start, Math.max(start, end)));
}

/**
 * The body around the first body match of the query's terms, else the start of the description.
 * The first token the scanner meets is the lowest byte start; tokens sharing a start come from one
 * run and share its range, so query-term order cannot change the window. The body is scanned only
 * when the evidence says it holds a term, and only up to the first match.
 */
export function excerptOf(
  hit: RankedHitV1,
  text: SearchTextV1 | undefined,
  query: NormalizedQueryV1,
  excerptBytes: number,
): string {
  const body = text?.body ?? "";
  const found: { range?: ByteRange } = {};
  if (hit.matchedTerms.some(({ fields }) => fields.includes("body"))) {
    const terms = new Set(query.terms);
    scanBody(body, (term, start, end) => {
      if (!terms.has(term)) return false;
      found.range = { start, end };
      return true;
    });
  }
  return found.range !== undefined
    ? excerptFrom(utf8(body), found.range, excerptBytes)
    : excerptFrom(utf8(text?.description ?? ""), { start: 0, end: 0 }, excerptBytes);
}
