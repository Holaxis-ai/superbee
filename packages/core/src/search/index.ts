/**
 * `@superbee/core/search`: the one `documents.search.v1` engine. The contract, query rules,
 * ranking, the any-term fallback, facets, cursors and page budgets live here; a backend supplies
 * what it searches through the `SearchSource` seam, and `memorySearchSource` indexes a complete
 * corpus in memory. Pure ECMAScript with no dependency, so a Worker, a browser page and the CLI run
 * the same code. Ranking is portal-webmcp 0.3.1's (`portal-webmcp-search/v1`).
 */
export {
  BODY_OCCURRENCE_CAP,
  SEARCH_ALGORITHM,
  SEARCH_FACETS,
  SEARCH_GUIDANCE,
  SEARCH_LIMITS,
  SEARCH_MATCHES,
  SEARCH_MATCH_FIELDS,
  SEARCH_MAX_OUTPUT_BYTES,
  SEARCH_OPERATION_ID,
  type SearchDocumentV1,
  type SearchFacetV1,
  type SearchFacetValueV1,
  type SearchFiltersV1,
  type SearchHitV1,
  type SearchMatchFieldV1,
  type SearchMatchModeV1,
  type SearchMatchV1,
  type SearchRequestV1,
  type SearchResultV1,
  type SearchStopV1,
} from "./contract.js";
export { SearchAbortError, SearchInputError, SearchLimitError, type SearchInputReason } from "./errors.js";
export {
  normalize,
  normalizeQuery,
  phrase,
  relaxQuery,
  tokenize,
  type NormalizedQueryV1,
  type RelaxedQueryV1,
} from "./text.js";
export { documentSourceBytes } from "./row-text.js";
export type {
  SearchCorpusSizeV1,
  SearchEvidenceBatchV1,
  SearchEvidenceV1,
  SearchSource,
  SearchTextV1,
} from "./source.js";
export { memorySearchSource, type MemorySearchSourceOptionsV1, type MemorySearchSourceV1 } from "./memory-source.js";
export { searchDocuments, validateSearchRequest, type SearchOptionsV1, type SearchScopeV1 } from "./search.js";
