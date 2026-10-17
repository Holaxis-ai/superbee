/**
 * The seam a backend implements so the engine can search it. A source answers evidence for the
 * query's terms in one consistent read and the text of the page's hits for excerpts; the engine
 * ranks, pages and facets every source with the same code, so two sources that answer the same
 * evidence for the same documents give byte-identical results.
 */
import type { SearchFiltersV1, SearchMatchFieldV1, SearchStopV1 } from "./contract.js";

/** What one indexed document holds of the query's terms, plus the fields ranking and facets read. */
export interface SearchEvidenceV1 {
  readonly id: string;
  readonly version: string;
  readonly title?: string;
  readonly type?: string;
  /** Declared string tags, in document order. */
  readonly tags: readonly string[];
  readonly titlePhrase: string;
  readonly idPhrase: string;
  /** term -> the fields holding it and its body occurrences, capped at BODY_OCCURRENCE_CAP. Only
   * terms the document holds appear. */
  readonly terms: ReadonlyMap<string, { readonly fields: readonly SearchMatchFieldV1[]; readonly bodyOccurrences: number }>;
}

/** The sizes of what a source searched, reported as the result's `corpus`. */
export interface SearchCorpusSizeV1 {
  readonly documents: number;
}

export interface SearchEvidenceBatchV1 {
  /** Identity of what was searched: a snapshot digest, a heads digest, or a revision. Cursors bind to it. */
  readonly key: string;
  readonly size: SearchCorpusSizeV1;
  /** Every indexed document holding at least one of the terms after the exact filters, once each. */
  readonly documents: readonly SearchEvidenceV1[];
}

export interface SearchTextV1 {
  readonly description: string;
  readonly body: string;
}

export interface SearchSource {
  /** One consistent read: identity, sizes and the evidence for `terms` after the exact filters. */
  evidence(terms: readonly string[], filters: SearchFiltersV1, stop?: SearchStopV1): Promise<SearchEvidenceBatchV1>;
  /** Description and body of the page's hits, at the evidence's version, for excerpts only. */
  text(hits: readonly { readonly id: string; readonly version: string }[]): Promise<ReadonlyMap<string, SearchTextV1>>;
}
