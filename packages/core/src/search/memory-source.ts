/**
 * The in-memory source: a complete corpus indexed once, answering evidence by walking its rows.
 *
 * The build is portal-webmcp 0.3.1's (`buildSearchIndex`): field term sets and a positional body
 * index holding every occurrence's original byte range, so the lazy `indexDigest` is Portal's
 * index identity byte for byte. A document over SEARCH_LIMITS.maxTermsPerDocument body terms is
 * left out and counted as skipped; the corpus bounds still refuse the whole corpus. A host builds
 * one source per corpus key and keeps it; nothing here re-reads a document after the build.
 */
import { sha256HexOfUtf8 } from "../sha256.js";
import {
  BODY_OCCURRENCE_CAP,
  SEARCH_ALGORITHM,
  SEARCH_LIMITS,
  SIGNAL_INTERVAL,
  documentDescription,
  documentTags,
  documentTitle,
  documentType,
  type SearchDocumentV1,
  type SearchFiltersV1,
  type SearchMatchFieldV1,
  type SearchStopV1,
} from "./contract.js";
import { SearchLimitError, stopIfAsked } from "./errors.js";
import { canonicalJson, codeUnitCompare } from "./identity.js";
import { documentSourceBytes, fieldTokens } from "./row-text.js";
import type {
  SearchEvidenceBatchV1,
  SearchEvidenceBoundsV1,
  SearchEvidenceV1,
  SearchSource,
  SearchTextV1,
} from "./source.js";
import { scanBody } from "./text.js";

interface BodyToken {
  /** Original UTF-8 byte offset of the run that produced this token. */
  readonly start: number;
  /** First original UTF-8 byte after the run that produced this token. */
  readonly end: number;
}

interface IndexedDocument {
  /** Identity fields as indexed, so a digest computed later cannot drift from the built index. */
  readonly indexedId: string;
  readonly indexedVersion: string;
  readonly idPhrase: string;
  readonly idSegments: ReadonlySet<string>;
  readonly titlePhrase: string;
  readonly titleTerms: ReadonlySet<string>;
  readonly typeTerms: ReadonlySet<string>;
  readonly tagTerms: ReadonlySet<string>;
  readonly descriptionTerms: ReadonlySet<string>;
  readonly bodyTerms: ReadonlyMap<string, readonly BodyToken[]>;
  /** Occurrences of each term in every field but the body; with the capped body counts these are
   * searchRowText's instances. */
  readonly fieldInstances: ReadonlyMap<string, number>;
  readonly title: string | undefined;
  readonly exactType: string | undefined;
  readonly exactTags: readonly string[];
  /** The text excerpts read, held from the build so a search never re-reads the document. */
  readonly description: string;
  readonly body: string;
}

export interface MemorySearchSourceOptionsV1 {
  /** Identifies this exact corpus (a snapshot digest, a heads digest); cursors are bound to it. */
  readonly key: string;
  /** A host's own bound on the corpus's source bytes, at most SEARCH_LIMITS.maxIndexSourceBytes. */
  readonly maxSourceBytes?: number;
  /** A host's own bound on the corpus's documents, at most SEARCH_LIMITS.maxIndexDocuments. */
  readonly maxDocuments?: number;
  /** Stops the build. */
  readonly stop?: SearchStopV1;
}

export interface MemorySearchSourceV1 extends SearchSource {
  readonly key: string;
  /** Identity of the built index; two identical corpora index identically. Computed on first read. */
  readonly indexDigest: `sha256:${string}`;
}

function limitExceeded(limit: string, max: number, actual: number): never {
  throw new SearchLimitError(limit, max, actual);
}

/** A host bound, held to the engine's own ceiling; the binding limit names itself in a refusal. */
function bound(name: string, value: number | undefined, ceilingName: string, ceiling: number) {
  if (value === undefined) return { name: ceilingName, max: ceiling };
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value < ceiling ? { name, max: value } : { name: ceilingName, max: ceiling };
}

/** Every body occurrence's byte range by term, or nothing when the body is over the term cap. */
function indexBody(body: string, maxTermsPerDocument: number): Map<string, BodyToken[]> | undefined {
  const terms = new Map<string, BodyToken[]>();
  const state = { count: 0, over: false };
  scanBody(body, (term, start, end) => {
    state.count += 1;
    // Stop before retaining an over-budget occurrence.
    if (state.count > maxTermsPerDocument) {
      state.over = true;
      return true;
    }
    const existing = terms.get(term);
    if (existing) existing.push({ start, end });
    else terms.set(term, [{ start, end }]);
    return false;
  });
  return state.over ? undefined : terms;
}

/**
 * Builds the in-memory source over a complete corpus. The corpus limits (SEARCH_LIMITS: documents,
 * source bytes) and the host's bounds throw `SearchLimitError`; a document over the per-document
 * term cap is skipped and counted; two documents with one id throw `TypeError`; a stop throws as
 * its check does.
 */
export function memorySearchSource(
  documents: readonly SearchDocumentV1[],
  options: MemorySearchSourceOptionsV1,
): MemorySearchSourceV1 {
  const key = options?.key;
  if (typeof key !== "string" || key === "") throw new TypeError("memorySearchSource needs a non-empty key");
  const maxDocuments = bound("maxDocuments", options.maxDocuments, "maxIndexDocuments", SEARCH_LIMITS.maxIndexDocuments);
  const maxSourceBytes = bound(
    "maxSourceBytes",
    options.maxSourceBytes,
    "maxIndexSourceBytes",
    SEARCH_LIMITS.maxIndexSourceBytes,
  );
  const stop = options.stop;
  stopIfAsked(stop);
  if (documents.length > maxDocuments.max) limitExceeded(maxDocuments.name, maxDocuments.max, documents.length);
  const rows: IndexedDocument[] = [];
  const ids = new Set<string>();
  let sourceBytes = 0;
  for (const [position, document] of documents.entries()) {
    if (position % SIGNAL_INTERVAL === 0) stopIfAsked(stop);
    // text() answers by id, so two documents under one id would share one excerpt.
    if (ids.has(document.id)) throw new TypeError("memorySearchSource needs one document per id");
    ids.add(document.id);
    // Check the total source budget before allocating postings for this document.
    const documentBytes = documentSourceBytes(document);
    if (sourceBytes + documentBytes > maxSourceBytes.max) {
      limitExceeded(maxSourceBytes.name, maxSourceBytes.max, sourceBytes + documentBytes);
    }
    sourceBytes += documentBytes;
    const body = document.body;
    const indexed = indexBody(body, SEARCH_LIMITS.maxTermsPerDocument);
    if (indexed === undefined) continue;
    const bodyTerms = new Map<string, readonly BodyToken[]>();
    for (const [term, tokens] of indexed) bodyTerms.set(term, Object.freeze(tokens));
    const title = documentTitle(document);
    const type = documentType(document);
    const tags = documentTags(document);
    const fields = fieldTokens(document);
    const fieldInstances = new Map<string, number>();
    for (const tokens of [fields.id, fields.title, fields.type, fields.tag, fields.description])
      for (const term of tokens) fieldInstances.set(term, (fieldInstances.get(term) ?? 0) + 1);
    rows.push({
      indexedId: document.id,
      indexedVersion: document.version,
      idPhrase: fields.id.join(" "),
      idSegments: new Set(fields.id),
      titlePhrase: fields.title.join(" "),
      titleTerms: new Set(fields.title),
      typeTerms: new Set(fields.type),
      tagTerms: new Set(fields.tag),
      descriptionTerms: new Set(fields.description),
      bodyTerms,
      fieldInstances,
      title,
      exactType: type,
      exactTags: Object.freeze([...tags]),
      description: documentDescription(document) ?? "",
      body,
    });
  }
  Object.freeze(rows);
  const byId = new Map(rows.map((row) => [row.indexedId, row]));
  let digest: `sha256:${string}` | undefined;
  const size = Object.freeze({
    documents: documents.length,
    indexed: rows.length,
    skipped: documents.length - rows.length,
    reindexPending: 0,
  });

  return Object.freeze({
    key,
    // Lazy: hashed per document only when somebody asks for the identity.
    get indexDigest() {
      digest ??= computeIndexDigest(rows);
      return digest;
    },
    async evidence(
      terms: readonly string[],
      filters: SearchFiltersV1,
      bounds: SearchEvidenceBoundsV1,
      evidenceStop?: SearchStopV1,
    ): Promise<SearchEvidenceBatchV1> {
      stopIfAsked(evidenceStop);
      let volume = 0;
      for (const [position, row] of rows.entries()) {
        if (position % SIGNAL_INTERVAL === 0) stopIfAsked(evidenceStop);
        for (const term of terms) volume += instancesOf(row, term);
      }
      const held: SearchEvidenceV1[] = [];
      // Over the bound nothing is walked, as a native index refuses before it reads a posting.
      if (volume > bounds.maxInstances) return { key, size, volume, documents: held };
      for (const [position, row] of rows.entries()) {
        if (position % SIGNAL_INTERVAL === 0) stopIfAsked(evidenceStop);
        if (filters.type !== undefined && row.exactType !== filters.type) continue;
        if (filters.tag !== undefined && !row.exactTags.includes(filters.tag)) continue;
        if (filters.prefix !== undefined && !row.indexedId.startsWith(filters.prefix)) continue;
        const evidence = evidenceOf(row, terms);
        if (evidence !== undefined) held.push(evidence);
      }
      return { key, size, volume, documents: held };
    },
    async text(hits: readonly { readonly id: string; readonly version: string }[]) {
      const texts = new Map<string, SearchTextV1>();
      for (const hit of hits) {
        const row = byId.get(hit.id);
        if (row !== undefined && row.indexedVersion === hit.version)
          texts.set(hit.id, { description: row.description, body: row.body });
      }
      return texts;
    },
  });
}

/** The term's capped instances in the row: searchRowText's `instances` for the same document. */
function instancesOf(row: IndexedDocument, term: string): number {
  return (row.fieldInstances.get(term) ?? 0) + Math.min(row.bodyTerms.get(term)?.length ?? 0, BODY_OCCURRENCE_CAP);
}

function fieldsForTerm(row: IndexedDocument, term: string): SearchMatchFieldV1[] {
  const fields: SearchMatchFieldV1[] = [];
  if (row.titleTerms.has(term)) fields.push("title");
  if (row.typeTerms.has(term)) fields.push("type");
  if (row.tagTerms.has(term)) fields.push("tag");
  if (row.descriptionTerms.has(term)) fields.push("description");
  if (row.idSegments.has(term)) fields.push("id");
  if (row.bodyTerms.has(term)) fields.push("body");
  return fields;
}

/** The row's evidence for the terms it holds, or nothing when it holds none of them. */
function evidenceOf(row: IndexedDocument, terms: readonly string[]): SearchEvidenceV1 | undefined {
  let held: Map<string, { fields: readonly SearchMatchFieldV1[]; bodyOccurrences: number }> | undefined;
  for (const term of terms) {
    const fields = fieldsForTerm(row, term);
    if (fields.length === 0) continue;
    held ??= new Map();
    held.set(term, {
      fields: Object.freeze(fields),
      bodyOccurrences: Math.min(row.bodyTerms.get(term)?.length ?? 0, BODY_OCCURRENCE_CAP),
    });
  }
  if (held === undefined) return undefined;
  return {
    id: row.indexedId,
    version: row.indexedVersion,
    ...(row.title === undefined ? {} : { title: row.title }),
    ...(row.exactType === undefined ? {} : { type: row.exactType }),
    tags: row.exactTags,
    titlePhrase: row.titlePhrase,
    idPhrase: row.idPhrase,
    terms: held,
  };
}

/** Portal's index identity, byte for byte: one hash per document, then one over the list. */
function computeIndexDigest(rows: readonly IndexedDocument[]): `sha256:${string}` {
  const fingerprints = rows.map((row) =>
    sha256HexOfUtf8(
      canonicalJson({
        id: row.indexedId,
        version: row.indexedVersion,
        idPhrase: row.idPhrase,
        titlePhrase: row.titlePhrase,
        type: row.exactType ?? null,
        tags: [...row.exactTags],
        description: [...row.descriptionTerms].sort(codeUnitCompare),
        body: [...row.bodyTerms.keys()]
          .sort(codeUnitCompare)
          .map((term) => [term, row.bodyTerms.get(term)!.map((token) => [token.start, token.end])]),
      }),
    ),
  );
  return `sha256:${sha256HexOfUtf8(canonicalJson({ algorithm: SEARCH_ALGORITHM, documents: fingerprints }))}`;
}
