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
  /** Every document of the corpus. */
  readonly documents: number;
  /** Documents the source searches, reindexPending included. */
  readonly indexed: number;
  /** Documents the index cannot hold (over SEARCH_LIMITS.maxTermsPerDocument body terms, or a
   * backend's own row bound), left out and counted. */
  readonly skipped: number;
  /** Indexed documents served at an older text version, awaiting re-derivation. */
  readonly reindexPending: number;
}

/** What the engine allows one evidence read: a source that can stops before walking anything. */
export interface SearchEvidenceBoundsV1 {
  /** The most capped term instances the terms may hold; over it, `documents` is empty. */
  readonly maxInstances: number;
}

export interface SearchEvidenceBatchV1 {
  /** Identity of what was searched: a snapshot digest, a heads digest, or a revision. Cursors bind to it. */
  readonly key: string;
  readonly size: SearchCorpusSizeV1;
  /** Sum over the terms of their capped instance counts (searchRowText's `instances`) across the
   * indexed documents, before the filters. */
  readonly volume: number;
  /** Every indexed document holding at least one of the terms after the exact filters, once each.
   * Empty when `volume` exceeds the bound. */
  readonly documents: readonly SearchEvidenceV1[];
}

export interface SearchTextV1 {
  readonly description: string;
  readonly body: string;
}

export interface SearchSource {
  /** One consistent read: identity, sizes, the volume pre-check and the evidence for `terms` after
   * the exact filters. */
  evidence(
    terms: readonly string[],
    filters: SearchFiltersV1,
    bounds: SearchEvidenceBoundsV1,
    stop?: SearchStopV1,
  ): Promise<SearchEvidenceBatchV1>;
  /** Description and body of the page's hits, at the evidence's version, for excerpts only. */
  text(hits: readonly { readonly id: string; readonly version: string }[]): Promise<ReadonlyMap<string, SearchTextV1>>;
}
