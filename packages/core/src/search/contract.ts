/**
 * The `documents.search.v1` contract: its constants, request and result types, and the frontmatter
 * fields a search reads. Ranking and index limits are portal-webmcp 0.3.1's (algorithm
 * `portal-webmcp-search/v1`, a long document indexed whole up to 65,536 body terms); the request
 * limits are this contract's.
 */

export const SEARCH_OPERATION_ID = "documents.search.v1";

/** The ranking algorithm, shared with portal-webmcp 0.3.1's `superbee_search_documents`. */
export const SEARCH_ALGORITHM = "portal-webmcp-search/v1";

/** Largest answer, as JSON. A page of long hits can exceed it before 50 hits: the page then ends
 * early with a cursor at the cut. */
export const SEARCH_MAX_OUTPUT_BYTES = 64 * 1024;

export const SEARCH_LIMITS = Object.freeze({
  /** Largest query, UTF-8 bytes. */
  maxQueryBytes: 1_024,
  /** Distinct normalized query terms. */
  maxQueryTerms: 16,
  defaultRows: 10,
  maxRows: 50,
  /** Excerpt length, UTF-8 bytes. */
  excerptBytes: 512,
  /** Largest exact `type` or `tag` filter, UTF-8 bytes (the kernel query's filter bound). */
  maxFilterBytes: 256,
  /** Largest cursor, UTF-8 bytes. */
  maxCursorBytes: 2_048,
  /** Values per facet, most frequent first. */
  maxFacetValues: 50,
  // Index limits, enforced while an in-memory index is built.
  maxIndexDocuments: 20_000,
  maxIndexSourceBytes: 67_108_864,
  /** portal-webmcp's V1 value: a long document is indexed whole, never truncated. */
  maxTermsPerDocument: 65_536,
} as const);

/** Body occurrences of one distinct query term that can still add score. */
export const BODY_OCCURRENCE_CAP = 20;

/** Bytes an excerpt may reach behind its first body match before the match starts. */
export const EXCERPT_LEAD_BYTES = 256;

/** Documents processed between cancellation checks. */
export const SIGNAL_INTERVAL = 128;

export const SEARCH_MATCHES = Object.freeze(["auto", "all", "any"] as const);
export type SearchMatchV1 = (typeof SEARCH_MATCHES)[number];
export type SearchMatchModeV1 = "all" | "any";
export const SEARCH_FACETS = Object.freeze(["type", "tags"] as const);
export type SearchFacetV1 = (typeof SEARCH_FACETS)[number];
export const SEARCH_MATCH_FIELDS = Object.freeze(["title", "type", "tag", "description", "id", "body"] as const);
export type SearchMatchFieldV1 = (typeof SEARCH_MATCH_FIELDS)[number];

export const SEARCH_GUIDANCE = Object.freeze({
  all: 'No document contains every query term. Retry with match "any", fewer terms, or different exact filters.',
  any: "No document contains any searchable query term. Try domain-specific keywords or remove exact type and tag filters.",
});

/** One document of a search corpus: a read model row, or a working copy's head and body. */
export interface SearchDocumentV1 {
  readonly id: string;
  readonly version: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/** Cancellation for a long build or ranking: a signal, a host check that throws, or both. */
export interface SearchStopV1 {
  readonly signal?: AbortSignal;
  /** Called every SIGNAL_INTERVAL documents; throws to stop (for example a deadline). */
  readonly check?: () => void;
}

/** The exact filters a source applies before it answers evidence. */
export interface SearchFiltersV1 {
  readonly type?: string;
  readonly tag?: string;
}

export interface SearchRequestV1 {
  /** Free text, at most 1 KiB and 16 distinct terms after normalization. */
  readonly query: string;
  /** `auto` (default): every term, then any term without conversational words when nothing matched. */
  readonly match?: SearchMatchV1;
  /** Exact frontmatter `type`. */
  readonly type?: string;
  /** Exact declared tag. */
  readonly tag?: string;
  /** Hits per page, 1 to 50; default 10. */
  readonly limit?: number;
  /** A previous answer's `nextCursor`, for the same corpus, query, match and filters. */
  readonly cursor?: string;
  /** Value counts over every hit (not only this page), most frequent first, at most 50 each. */
  readonly facets?: readonly SearchFacetV1[];
}

export interface SearchHitV1 {
  readonly id: string;
  readonly version: string;
  readonly title?: string;
  readonly type?: string;
  readonly tags: readonly string[];
  readonly score: number;
  readonly matchedTerms: readonly { readonly term: string; readonly fields: readonly SearchMatchFieldV1[] }[];
  /** At most SEARCH_LIMITS.excerptBytes UTF-8 bytes: the body around the first match, else the description. */
  readonly excerpt: string;
}

export interface SearchFacetValueV1 {
  readonly value: string;
  readonly count: number;
}

export interface SearchResultV1 {
  readonly hits: readonly SearchHitV1[];
  readonly query: {
    readonly requestedMatch: SearchMatchV1;
    readonly effectiveMatch: SearchMatchModeV1;
    readonly fallbackUsed: boolean;
    /** The terms matched: normalized, deduplicated, and without ignoredTerms after a fallback. */
    readonly terms: readonly string[];
    /** Conversational terms the fallback left out; absent when none were. */
    readonly ignoredTerms?: readonly string[];
  };
  /** Hits across every page. */
  readonly total: number;
  readonly facets?: { readonly type?: readonly SearchFacetValueV1[]; readonly tags?: readonly SearchFacetValueV1[] };
  readonly nextCursor?: string;
  readonly corpus: { readonly documents: number };
  /** Fixed advice when nothing matched. */
  readonly guidance?: string;
}

// The one place that decides which frontmatter members become searchable or displayable fields;
// nothing here reinterprets Markdown or adds Kind semantics.

function stringMember(frontmatter: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" ? value : undefined;
}

export function documentTitle(document: SearchDocumentV1): string | undefined {
  return stringMember(document.frontmatter, "title");
}

export function documentType(document: SearchDocumentV1): string | undefined {
  return stringMember(document.frontmatter, "type");
}

export function documentDescription(document: SearchDocumentV1): string | undefined {
  return stringMember(document.frontmatter, "description");
}

/** Declared string tags only; a non-array or non-string member contributes nothing. */
export function documentTags(document: SearchDocumentV1): readonly string[] {
  const value = document.frontmatter["tags"];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
