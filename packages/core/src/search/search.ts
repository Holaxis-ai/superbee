/**
 * One `documents.search.v1` request over a source. Query normalization, the 16-term cap, `auto`
 * matching (all terms, then the any-term fallback without conversational terms) and the guidance
 * text are portal-webmcp 0.3.1's `superbee_search_documents`; cursors, facets, the page budget and
 * the result shape are this contract's. Every refusal is a `SearchInputError` with a fixed reason.
 */
import { sha256HexOfUtf8 } from "../sha256.js";
import {
  SEARCH_ALGORITHM,
  SEARCH_FACETS,
  SEARCH_GUIDANCE,
  SEARCH_LIMITS,
  SEARCH_MATCHES,
  type SearchFacetV1,
  type SearchFiltersV1,
  type SearchHitV1,
  type SearchMatchModeV1,
  type SearchMatchV1,
  type SearchRequestV1,
  type SearchResultV1,
  type SearchStopV1,
} from "./contract.js";
import { SearchBroadQueryError, SearchInputError, stopIfAsked } from "./errors.js";
import { base64UrlDecode, base64UrlEncode, canonicalJson } from "./identity.js";
import { excerptOf, facetsOf, rankEvidence } from "./rank.js";
import type { SearchSource, SearchTextV1 } from "./source.js";
import { normalizeQuery, relaxQuery, utf8, utf8ByteLength, type NormalizedQueryV1 } from "./text.js";

/** What a cursor is bound to besides the request and the corpus key: a host scope such as the bundle id. */
export interface SearchScopeV1 {
  readonly scope?: string;
}

export interface SearchOptionsV1 {
  /** The largest answer, as UTF-8 JSON: a page that would exceed it ends early, with `nextCursor` at
   * the cut, keeping at least one hit. Absent: every requested hit is returned. */
  readonly maxResultBytes?: number;
  /** The most capped term instances a request's terms may hold across the corpus before the request
   * is refused as too broad. Default and ceiling: SEARCH_LIMITS.maxEvidenceInstances. */
  readonly maxEvidenceInstances?: number;
}

const CURSOR_VERSION = 1;
const REQUEST_MEMBERS = new Set(["query", "match", "type", "tag", "prefix", "limit", "cursor", "facets"]);

/** A lone surrogate: matched by code unit in memory, but it has no UTF-8 form a native index can bind. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function optionalFilter(value: unknown, maxBytes: number = SEARCH_LIMITS.maxFilterBytes): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "" || utf8ByteLength(value) > maxBytes || LONE_SURROGATE.test(value))
    throw new SearchInputError("filter");
  return value;
}

function evidenceInstanceBound(value: number | undefined): number {
  if (value === undefined) return SEARCH_LIMITS.maxEvidenceInstances;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("maxEvidenceInstances must be a positive integer");
  return Math.min(value, SEARCH_LIMITS.maxEvidenceInstances);
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

interface CheckedRequest {
  readonly query: NormalizedQueryV1;
  readonly requestedMatch: SearchMatchV1;
  readonly type: string | undefined;
  readonly tag: string | undefined;
  readonly prefix: string | undefined;
  readonly filters: SearchFiltersV1;
  readonly limit: number;
  readonly wanted: ReadonlySet<SearchFacetV1>;
}

/** The contract's checks on every member except the cursor's binding, in one order. */
function checkRequest(request: SearchRequestV1): CheckedRequest {
  const raw: unknown = request?.query;
  if (typeof raw !== "string" || utf8ByteLength(raw) > SEARCH_LIMITS.maxQueryBytes) throw new SearchInputError("query");
  const query = normalizeQuery(raw);
  if (query.terms.length === 0) throw new SearchInputError("empty-query");
  if (query.terms.length > SEARCH_LIMITS.maxQueryTerms) throw new SearchInputError("too-many-query-terms");
  const requestedMatch = request.match ?? "auto";
  if (!(SEARCH_MATCHES as readonly unknown[]).includes(requestedMatch)) throw new SearchInputError("match");
  const type = optionalFilter(request.type);
  const tag = optionalFilter(request.tag);
  const prefix = optionalFilter(request.prefix, SEARCH_LIMITS.maxPrefixBytes);
  const filters = {
    ...(type === undefined ? {} : { type }),
    ...(tag === undefined ? {} : { tag }),
    ...(prefix === undefined ? {} : { prefix }),
  };
  const limit = request.limit ?? SEARCH_LIMITS.defaultRows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.maxRows) throw new SearchInputError("limit");
  const wanted = new Set<SearchFacetV1>();
  if (request.facets !== undefined) {
    if (!Array.isArray(request.facets) || request.facets.length > SEARCH_FACETS.length)
      throw new SearchInputError("facets");
    for (const facet of request.facets) {
      if (!(SEARCH_FACETS as readonly unknown[]).includes(facet) || wanted.has(facet))
        throw new SearchInputError("facets");
      wanted.add(facet);
    }
  }
  return { query, requestedMatch, type, tag, prefix, filters, limit, wanted };
}

function cursorText(cursor: unknown): string {
  if (typeof cursor !== "string" || cursor === "" || utf8ByteLength(cursor) > SEARCH_LIMITS.maxCursorBytes)
    throw new SearchInputError("cursor");
  return cursor;
}

/**
 * The contract's checks without a schema library: a plain request object with only the contract's
 * members, each within its bounds. Returns a copy holding the members present. A cursor's binding
 * is checked when it is used, against the corpus it continues.
 */
export function validateSearchRequest(input: unknown): SearchRequestV1 {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new SearchInputError("request");
  for (const member of Object.keys(input)) if (!REQUEST_MEMBERS.has(member)) throw new SearchInputError("request");
  const request = input as SearchRequestV1;
  checkRequest(request);
  if (request.cursor !== undefined) cursorText(request.cursor);
  return {
    query: request.query,
    ...(request.match === undefined ? {} : { match: request.match }),
    ...(request.type === undefined ? {} : { type: request.type }),
    ...(request.tag === undefined ? {} : { tag: request.tag }),
    ...(request.prefix === undefined ? {} : { prefix: request.prefix }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.facets === undefined ? {} : { facets: [...request.facets] }),
  };
}

function bindingOf(
  corpusKey: string,
  scope: string | undefined,
  state: Record<string, string | null | undefined>,
): string {
  return sha256HexOfUtf8(
    canonicalJson({
      algorithm: SEARCH_ALGORITHM,
      corpusKey,
      scope: scope ?? null,
      ...state,
    }),
  );
}

function encodeCursor(binding: string, position: number): string {
  return base64UrlEncode(utf8(canonicalJson({ b: binding, p: position, v: CURSOR_VERSION })));
}

/** The position a cursor continues from; it must carry this request's binding and lie inside the hits. */
function decodeCursor(cursor: unknown, binding: string, total: number): number {
  const bytes = base64UrlDecode(cursorText(cursor));
  let parsed: unknown;
  try {
    parsed = bytes && JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SearchInputError("cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SearchInputError("cursor");
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "b,p,v" || body.v !== CURSOR_VERSION || body.b !== binding)
    throw new SearchInputError("cursor");
  // A cursor is minted only while hits remain, so a position at or past the end was forged or replayed.
  const position = body.p;
  if (!Number.isSafeInteger(position) || (position as number) < 1 || (position as number) >= total)
    throw new SearchInputError("cursor");
  return position as number;
}

/**
 * Runs one request over a source. Throws `SearchInputError` for a request outside the contract
 * (including a cursor minted for another corpus, scope, query, match or filters),
 * `SearchBroadQueryError` when the request's terms exceed `maxEvidenceInstances`, `SearchLimitError`
 * as the source does, and stops as `stop` asks.
 */
export async function searchDocuments(
  source: SearchSource,
  request: SearchRequestV1,
  scope: SearchScopeV1 = {},
  stop?: SearchStopV1,
  options: SearchOptionsV1 = {},
): Promise<SearchResultV1> {
  if (typeof source?.evidence !== "function" || typeof source.text !== "function")
    throw new TypeError("searchDocuments needs a SearchSource");
  const { query, requestedMatch, type, tag, prefix, filters, limit, wanted } = checkRequest(request);
  const maxInstances = evidenceInstanceBound(options.maxEvidenceInstances);
  stopIfAsked(stop);
  const batch = await source.evidence(query.terms, filters, { maxInstances }, stop);
  stopIfAsked(stop);
  const size = batch?.size;
  if (
    typeof batch?.key !== "string" ||
    batch.key === "" ||
    !Array.isArray(batch.documents) ||
    !isCount(batch.volume) ||
    ![size?.documents, size?.indexed, size?.skipped, size?.reindexPending].every(isCount)
  )
    throw new TypeError("the search source answered a malformed evidence batch");
  // The same bound on every source, whether or not the source stopped before its walk.
  if (batch.volume > maxInstances) throw new SearchBroadQueryError(maxInstances, batch.volume);

  let effectiveMatch: SearchMatchModeV1 = requestedMatch === "any" ? "any" : "all";
  let effectiveQuery = query;
  let ignoredTerms: readonly string[] = [];
  let fallbackUsed = false;
  let hits = rankEvidence(batch.documents, effectiveQuery, filters, effectiveMatch, stop);
  if (requestedMatch === "auto" && hits.length === 0 && query.terms.length > 1) {
    // The relaxed terms are a subset of the terms the evidence answered, so one read serves both.
    const relaxed = relaxQuery(query);
    effectiveQuery = relaxed.query;
    ignoredTerms = relaxed.ignoredTerms;
    effectiveMatch = "any";
    fallbackUsed = true;
    hits = rankEvidence(batch.documents, effectiveQuery, filters, effectiveMatch, stop);
  }

  const binding = bindingOf(batch.key, scope?.scope, {
    query: query.phrase,
    match: requestedMatch,
    type: type ?? null,
    tag: tag ?? null,
    // Absent when unused, so a request without a prefix binds as it did before the filter existed.
    prefix,
  });
  const start = request.cursor === undefined ? 0 : decodeCursor(request.cursor, binding, hits.length);
  const page = hits.slice(start, start + limit);
  const texts: ReadonlyMap<string, SearchTextV1> =
    page.length === 0
      ? new Map()
      : await source.text(page.map(({ evidence }) => ({ id: evidence.id, version: evidence.version })));
  stopIfAsked(stop);
  const rows = page.map((hit): SearchHitV1 => {
    const { evidence } = hit;
    return {
      id: evidence.id,
      version: evidence.version,
      ...(evidence.title === undefined ? {} : { title: evidence.title }),
      ...(evidence.type === undefined ? {} : { type: evidence.type }),
      tags: [...evidence.tags],
      score: hit.score,
      matchedTerms: hit.matchedTerms.map(({ term, fields }) => ({ term, fields: [...fields] })),
      excerpt: excerptOf(hit, texts.get(evidence.id), effectiveQuery, SEARCH_LIMITS.excerptBytes),
    };
  });
  const answer = (count: number): SearchResultV1 => ({
    hits: rows.slice(0, count),
    query: {
      requestedMatch,
      effectiveMatch,
      fallbackUsed,
      terms: [...effectiveQuery.terms],
      ...(ignoredTerms.length === 0 ? {} : { ignoredTerms: [...ignoredTerms] }),
    },
    total: hits.length,
    ...(wanted.size === 0 ? {} : { facets: facetsOf(hits, wanted) }),
    ...(start + count < hits.length ? { nextCursor: encodeCursor(binding, start + count) } : {}),
    corpus: {
      documents: size.documents,
      indexed: size.indexed,
      skipped: size.skipped,
      reindexPending: size.reindexPending,
    },
    ...(hits.length === 0
      ? {
          guidance:
            effectiveMatch === "all" && effectiveQuery.terms.length > 1 ? SEARCH_GUIDANCE.all : SEARCH_GUIDANCE.any,
        }
      : {}),
  });
  // A page that does not fit the host's answer budget ends early, with a cursor at the cut (as
  // portal-webmcp's pages do), so a long question at limit 50 still answers. At least one hit is kept:
  // a single hit too large for the budget is the host's refusal to make.
  let count = rows.length;
  let result = answer(count);
  const budget = options.maxResultBytes;
  if (budget !== undefined && count > 1 && utf8ByteLength(JSON.stringify(result)) > budget) {
    const sizes = rows.map((row) => utf8ByteLength(JSON.stringify(row)) + 1);
    let size = utf8ByteLength(JSON.stringify(answer(0))) + utf8ByteLength(encodeCursor(binding, start)) + 16;
    count = 0;
    while (count < rows.length && size + sizes[count]! <= budget) size += sizes[count++]!;
    count = Math.max(1, count);
    result = answer(count);
    while (count > 1 && utf8ByteLength(JSON.stringify(result)) > budget) result = answer(--count);
  }
  return result;
}
