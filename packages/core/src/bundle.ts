/**
 * OKF bundle operations — the engine.
 *
 * The engine owns all OKF SEMANTICS (id safety, the non-empty `type` rule,
 * reserved-file handling, edition-aware write normalization, link/backlink derivation) and routes
 * every store access through a {@link StorageBackend}.
 * When a {@link Bundle} carries no `backend`, a {@link FilesystemBackend} rooted at
 * `bundle.root` is used — so existing `{ root }` callers keep working unchanged while
 * a non-filesystem store becomes a plug-in rather than a rewrite.
 */

import path from "node:path";

import { FilesystemBackend } from "./backend.js";
import {
  normalizeV01DocumentForWrite,
  normalizeV02DocumentForWrite,
} from "./document-write-policy.js";
import { isUsableTimestamp, MalformedDocumentError, parseMarkdown, stringifyWithData } from "./frontmatter.js";
import { GENERATED_INDEX_MARKER } from "./index-marker.js";
import { parseLinksFromDoc } from "./links.js";
import {
  assertSafeConceptId,
  isReservedFile,
  pathFromConceptId,
} from "./paths.js";
import { InvalidInputError } from "./errors.js";
import { matchesFilter } from "./query-filter.js";
import { VersionConflict } from "./versioning.js";
import type {
  BlobKey,
  Bundle,
  ConceptId,
  DeleteOptions,
  EdgeFilter,
  HeadResult,
  InitBundleOptions,
  Link,
  OkfDocument,
  QueryFilter,
  ReadBlobResult,
  ReadResult,
  StorageBackend,
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

// Compatibility export: the implementation lives in the browser-safe module, while existing
// direct engine-module consumers keep their historical import path.
export { matchesFilter } from "./query-filter.js";

/** A written concept document together with the {@link Version} the backend recorded for it. */
export interface WriteResult {
  /** The persisted document after the bundle edition's shape normalization. */
  doc: OkfDocument;
  /** Opaque version token of the write — pass it back as {@link WriteOptions.expectedVersion} for a later compare-and-swap. */
  version: Version;
}

/** @internal Resolve the backend a bundle operation should use (defaults to a filesystem adapter). */
export function backendFor(bundle: Bundle): StorageBackend {
  return bundle.backend ?? new FilesystemBackend(bundle.root);
}

/** Read the bundle-root OKF edition without assuming a filesystem-backed bundle. */
export async function readBundleOkfVersion(bundle: Bundle): Promise<string | undefined> {
  const index = await backendFor(bundle).readReserved("", "index.md");
  if (!index) return undefined;
  const value = parseMarkdown(index.content, "index.md").frontmatter.okf_version;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// ── bundle lifecycle ──────────────────────────────────────────────────────────

/** OKF versions this writer can truthfully declare on newly authored bundles. */
export const SUPPORTED_OKF_AUTHORING_VERSIONS = ["0.1", "0.2"] as const;

/** Product default for genuinely new bundles; separate from the supported-version set. */
export const DEFAULT_OKF_AUTHORING_VERSION = "0.2";

/** Resolve the default authoring version or reject a version this writer cannot produce. */
export function resolveOkfAuthoringVersion(requested?: string): string {
  const version = requested ?? DEFAULT_OKF_AUTHORING_VERSION;
  if (!(SUPPORTED_OKF_AUTHORING_VERSIONS as readonly string[]).includes(version)) {
    throw new InvalidInputError(
      `Unsupported OKF authoring version '${version}'. This build can author ${SUPPORTED_OKF_AUTHORING_VERSIONS.join(" and ")}; ` +
        "bundles declaring other versions can still be read or transported.",
    );
  }
  return version;
}

/**
 * Initialize (or open) an OKF bundle at `root`. Creates the directory and a root
 * `index.md` carrying `okf_version` frontmatter (OKF v0.1 §11 / v0.2 §12 — the sole place any
 * index.md may carry frontmatter). Idempotent: an existing `index.md` is left
 * untouched. Filesystem-backed by construction (creating a bundle is inherently
 * a local operation; a remote store is provisioned out of band).
 */
export async function initBundle(root: string, options: InitBundleOptions = {}): Promise<Bundle> {
  const okfVersion = resolveOkfAuthoringVersion(options.okfVersion);
  const resolved = path.resolve(root);
  const backend = new FilesystemBackend(resolved);
  if (options.expectNew || (await backend.readReserved("", "index.md")) === null) {
    const name = path.basename(resolved);
    const body = `${GENERATED_INDEX_MARKER}\n# ${name}\n\nAn Open Knowledge Format bundle.\n`;
    // Expect-absent create (Defect C hardening): a plain check-absent-then-unconditional-write
    // leaves a benign TOCTOU window — two racing `init`s of the SAME fresh directory both see
    // `null` and both write. Harmless in practice (both write byte-identical content, since `name`
    // and `okfVersion` are deterministic from `root`/`options`), but the write itself should still
    // go through the seam's CAS discipline rather than silently assume no one else got there
    // first. `expectedVersion: null` makes that assumption explicit and a `VersionConflict` (the
    // OTHER racer won) is swallowed — the loser's own bundle is equally initialized either way.
    // With `expectNew`, the CAS is the create guarantee itself: a losing racer (or a pre-existing
    // index.md, read fresh by the expect-absent write) MUST surface as `VersionConflict`.
    try {
      await backend.writeReserved("", "index.md", stringifyWithData({ okf_version: okfVersion }, body), {
        expectedVersion: null,
      });
    } catch (err) {
      if (options.expectNew || !(err instanceof VersionConflict)) throw err;
    }
  }
  return { root: resolved };
}

// ── concept documents ─────────────────────────────────────────────────────────

function assertWritableConceptDocument(doc: OkfDocument): string {
  assertSafeConceptId(doc.id);
  const rel = pathFromConceptId(doc.id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(
      `'${doc.id}' maps to a reserved file (${rel}); use the index/log accessors, not writeDoc.`,
    );
  }

  const type = doc.frontmatter?.type;
  if (typeof type !== "string" || type.trim() === "") {
    throw new InvalidInputError(
      `OKF conformance: frontmatter.type is required and must be non-empty (concept '${doc.id}').`,
    );
  }
  return type;
}

/**
 * Atomically write (create or overwrite) a concept document to `<id>.md` and
 * surface the backend's {@link WriteResult} (the normalized document + its version
 * token). Enforces the OKF non-empty `type` rule (v0.1 §9 / v0.2 §11), rejects reserved-file ids, preserves
 * unknown frontmatter keys, and applies the bundle edition's document-shape policy. A v0.1
 * document retains the historical guaranteed `timestamp`; a v0.2 document does not invent the
 * optional `generated` family or legacy clock fields.
 *
 * `options` threads the seam's hard-case capabilities THROUGH the engine: an
 * `expectedVersion` makes the write a compare-and-swap (typed `VersionConflict` on
 * mismatch), and `actor` attributes the revision. This is the version-returning
 * surface; {@link writeDoc} is the contract-stable wrapper that returns just the
 * document (so the version never leaks into a caller — e.g. CLI TOON output — that
 * did not ask for it).
 */
export async function writeDocVersioned(
  bundle: Bundle,
  doc: OkfDocument,
  options?: WriteOptions,
): Promise<WriteResult> {
  // Preserve the historical fail-before-I/O contract for malformed ids/types. Edition discovery
  // is storage I/O and must not mask a caller error with an unrelated root-index failure.
  const type = assertWritableConceptDocument(doc);
  const okfVersion = await readBundleOkfVersion(bundle) ?? "0.1";
  return persistDocForEdition(bundle, doc, type, okfVersion, options);
}

/** @internal Edition-pinned sibling used by mutation policy after it has read the root once. */
export async function writeDocVersionedForEdition(
  bundle: Bundle,
  doc: OkfDocument,
  okfVersion: string,
  options?: WriteOptions,
): Promise<WriteResult> {
  const type = assertWritableConceptDocument(doc);
  return persistDocForEdition(bundle, doc, type, okfVersion, options);
}

async function persistDocForEdition(
  bundle: Bundle,
  doc: OkfDocument,
  type: string,
  okfVersion: string,
  options?: WriteOptions,
): Promise<WriteResult> {
  let saved: OkfDocument;
  if (okfVersion === "0.1") {
    const existingTimestamp = doc.frontmatter.timestamp;
    const timestamp = isUsableTimestamp(existingTimestamp)
      ? { preserveExisting: true as const, existingTimestamp }
      : { preserveExisting: false as const, fallbackTimestamp: new Date().toISOString() };
    saved = normalizeV01DocumentForWrite(doc, type, timestamp);
  } else {
    // Newer-edition raw transport stays permissive and non-inventing. Product mutation semantics
    // (including v0.2's meaningful-change clock) live in `mutateDocument`, which supplies this hint.
    saved = normalizeV02DocumentForWrite(doc, type);
  }

  const version = await backendFor(bundle).write(doc.id, saved, options);
  return { doc: saved, version };
}

/**
 * Atomically write (create or overwrite) a concept document, returning the
 * normalized {@link OkfDocument}. Contract-stable: the return type is unchanged from
 * the historical `Promise<OkfDocument>`, and the new `options` argument is optional.
 * Callers that need the resulting version token use {@link writeDocVersioned}.
 */
export async function writeDoc(
  bundle: Bundle,
  doc: OkfDocument,
  options?: WriteOptions,
): Promise<OkfDocument> {
  return (await writeDocVersioned(bundle, doc, options)).doc;
}

/**
 * Read a single concept document by ID together with its {@link ReadResult} version
 * token (the compare-and-swap basis for a later {@link writeDoc}). Same id-safety and
 * reserved-file guards as {@link readDoc}; this is the version-surfacing read that
 * leaves {@link readDoc}'s existing `Promise<OkfDocument>` return untouched.
 */
export async function readDocVersioned(bundle: Bundle, id: ConceptId): Promise<ReadResult> {
  assertSafeConceptId(id);
  const rel = pathFromConceptId(id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(`'${id}' is a reserved file (index.md / log.md), not a concept document.`);
  }
  return backendFor(bundle).read(id);
}

/** Read and parse a single concept document by ID. Rejects reserved-file ids. */
export async function readDoc(bundle: Bundle, id: ConceptId): Promise<OkfDocument> {
  return (await readDocVersioned(bundle, id)).doc;
}

/** True when the exact canonical concept ID exists. File-like aliases belong at user ingress. */
export async function existsDoc(bundle: Bundle, id: ConceptId): Promise<boolean> {
  assertSafeConceptId(id);
  const rel = pathFromConceptId(id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(`'${id}' is a reserved file (index.md / log.md), not a concept document.`);
  }
  return backendFor(bundle).exists(id);
}

/**
 * Attributed version history for a concept, newest-first (delegates to
 * {@link StorageBackend.versions}). Same id-safety and reserved-file guards as
 * {@link readDoc}. A backend that keeps no history (the plain filesystem) honestly
 * returns just the single current revision; `MemoryBackend` and a document-centric
 * remote adapter return the full chain. `[]` for a never-written concept.
 */
export async function docVersions(bundle: Bundle, id: ConceptId): Promise<VersionInfo[]> {
  assertSafeConceptId(id);
  const rel = pathFromConceptId(id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(`'${id}' is a reserved file (index.md / log.md), not a concept document.`);
  }
  return backendFor(bundle).versions(id);
}

/**
 * Hard-delete a concept document. Same id-safety and reserved-file guards
 * {@link writeDocVersioned}/{@link readDocVersioned} carry (D4: `index.md`/`log.md` are
 * never deletable through this path — enforced HERE at the engine layer, not left to each
 * backend to reimplement). Returns `true` when the document existed and was removed,
 * `false` when it was already absent (idempotent — AXI P6, never an error for "nothing to
 * delete"). Honors {@link DeleteOptions.expectedVersion} (compare-and-swap -> typed
 * `VersionConflict` on a genuine mismatch; an absent target always returns `false`
 * regardless).
 *
 * Non-cascading and NOT self-logging (D8, a deliberate decision): outbound/inbound links
 * are left exactly as written (backlinks are derived, so a dangling reference simply stops
 * resolving on the next graph walk), and no engine mutation emits a `log.md` entry. Adding an
 * asymmetric reserved-file side effect here would cost another CAS write (and, over `--remote`,
 * another round trip) while re-seeding the deleted id in a second record.
 */
export async function deleteDoc(bundle: Bundle, id: ConceptId, options?: DeleteOptions): Promise<boolean> {
  assertSafeConceptId(id);
  const rel = pathFromConceptId(id);
  if (isReservedFile(rel)) {
    throw new InvalidInputError(`'${id}' is a reserved file (${rel}); reserved files cannot be deleted.`);
  }
  return backendFor(bundle).delete(id, options);
}

/**
 * List/query concept documents. With no filter, returns every non-reserved `.md`
 * file (sorted by id). {@link QueryFilter} facets (`type`, `tags`, `prefix`, `fields`) are
 * ANDed. Reserved `index.md`/`log.md` are always excluded.
 */
const isEnoent = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * A document a scan could not include, reported to {@link QueryOptions.onSkip}. `id` is the
 * concept id; `reason` is the underlying parser detail (the js-yaml message, one line).
 */
export interface SkippedDoc {
  id: ConceptId;
  reason: string;
}

/**
 * Batch-read `ids`, SKIPPING any that have vanished since they were listed. A scan
 * ({@link query}) or dir/index traversal over a LIVE bundle must tolerate a concurrent
 * delete in the window between the `list` that produced these ids and this read — a
 * listed-then-gone id simply no longer matches; it must NOT fail the whole operation with
 * an internal not-found (the exact multi-writer read-side race a usability round hit:
 * a concurrent delete during a scan surfaced a RUNTIME error instead of a clean result).
 * The no-race path is a single `readMany`; a not-found (or a malformed doc, when `onMalformed`
 * is supplied) triggers a per-doc, skip-missing fallback over the SAME id set — no extra cost
 * off that path, and the fallback is itself resilient to further concurrent deletes.
 *
 * `onMalformed` opts a caller into resilience against a CORRUPT document (unparseable YAML
 * frontmatter): the offending doc is skipped and reported here instead of failing the whole
 * scan — so one bad file never blinds routine inspection (`list`/`status`/`kinds`). When it is
 * OMITTED, a {@link MalformedDocumentError} propagates (attributed to the doc), preserving the
 * loud default for callers (index regeneration, backlinks) that must not silently drop
 * content.
 */
async function readManyExisting(
  backend: StorageBackend,
  ids: ConceptId[],
  onMalformed?: (skip: SkippedDoc) => void,
): Promise<ReadResult[]> {
  try {
    return await backend.readMany(ids);
  } catch (err) {
    const malformed = err instanceof MalformedDocumentError;
    if (!isEnoent(err) && !(malformed && onMalformed)) throw err;
    const out: ReadResult[] = [];
    for (const id of ids) {
      try {
        out.push(await backend.read(id));
      } catch (e) {
        if (isEnoent(e)) continue; // vanished between list and read (a concurrent delete) — skip
        if (e instanceof MalformedDocumentError && onMalformed) {
          onMalformed({ id, reason: e.detail });
          continue;
        }
        throw e;
      }
    }
    return out;
  }
}

/** Options for {@link query}/{@link list}. */
export interface QueryOptions {
  /**
   * Invoked once per document that could not be parsed (malformed YAML frontmatter). Supplying
   * this opts the scan into resilience: the corrupt doc is SKIPPED and reported here instead of
   * failing the whole query — so one bad file never blinds `list`/`status`. Omit it to keep the
   * loud default (a malformed doc throws an attributed {@link MalformedDocumentError}).
   */
  onSkip?: (skip: SkippedDoc) => void;
}

/**
 * THE one scan skeleton: list under the filter's prefix, batch-read in ONE round-trip
 * (not N single reads — backlink/link-graph traversal rides this, so it must not fan
 * out per document; a networked backend answers `readMany` with a single multi-get),
 * keep what {@link matchesFilter} admits, sort by id. {@link query} and
 * {@link queryHeads}'s fallback are both thin projections over this — the walk itself
 * exists ONCE, so scan semantics (ordering, skip behavior, the batch round-trip) cannot
 * drift between the document-shaped and head-shaped surfaces.
 */
async function scanMatching(
  backend: StorageBackend,
  filter: QueryFilter,
  onSkip?: (skip: SkippedDoc) => void,
): Promise<ReadResult[]> {
  const ids = await backend.list(filter.prefix);
  const results: ReadResult[] = [];
  for (const result of await readManyExisting(backend, ids, onSkip)) {
    if (!matchesFilter(result.doc, filter)) continue;
    results.push(result);
  }
  results.sort((a, b) => a.doc.id.localeCompare(b.doc.id));
  return results;
}

export async function query(
  bundle: Bundle,
  filter: QueryFilter = {},
  options: QueryOptions = {},
): Promise<OkfDocument[]> {
  const scanned = await scanMatching(backendFor(bundle), filter, options.onSkip);
  return scanned.map((r) => r.doc);
}

/** Alias for {@link query} (the `list` half of the `list/query` API surface). */
export const list = query;

/**
 * Like {@link query}, but returns HEAD projections ({@link HeadResult}: id + full
 * frontmatter + version, never bodies) — the scan shape for every consumer that only
 * reads frontmatter (`list`/`query` rows, dashboards). When the backend implements the
 * optional {@link StorageBackend.queryHeads} push-down (today: `RemoteBackend`, over the
 * wire's `GET /docs?fields=frontmatter` projection), a filtered scan is ONE round-trip
 * carrying no bodies; the engine re-applies {@link matchesFilter} to the returned rows
 * regardless (a push-down may over-return — semantics stay here, not in backends). A
 * backend without the method gets the same `list` + batch-read walk {@link query} does,
 * with bodies dropped after the read — identical behavior and cost to `query`, including
 * {@link QueryOptions.onSkip} malformed-doc resilience (which the push-down path cannot
 * honor: a malformed doc fails the server-side scan, as the wire list always has).
 */
export async function queryHeads(
  bundle: Bundle,
  filter: QueryFilter = {},
  options: QueryOptions = {},
): Promise<HeadResult[]> {
  const backend = backendFor(bundle);
  if (backend.queryHeads) {
    const rows = (await backend.queryHeads(filter)).filter((r) => matchesFilter(r, filter));
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
  }
  const scanned = await scanMatching(backend, filter, options.onSkip);
  return scanned.map(({ doc, version }) => ({ id: doc.id, frontmatter: doc.frontmatter, version }));
}

/**
 * Outbound cross-links of a document. Standard markdown links only (never
 * wikilinks); external / non-`.md` targets are dropped; broken links are kept.
 * `bundle` is accepted for signature stability but resolution is purely path-based.
 */
export function parseLinks(_bundle: Bundle, doc: OkfDocument): Link[] {
  return parseLinksFromDoc(doc);
}

/**
 * Validate one exact canonical `from`/`to` {@link EdgeFilter} selector. A trailing slash is the
 * query API's deliberate prefix marker; its stem must still be a canonical concept-id prefix.
 * File-like/user-friendly aliases belong at CLI ingress, never in the engine graph contract.
 */
function normalizeEdgeSelector(raw: string): string {
  if (raw.endsWith("/")) {
    const stem = raw.slice(0, -1);
    assertSafeConceptId(stem);
    return `${stem}/`;
  }
  assertSafeConceptId(raw);
  return raw;
}

/**
 * True when `value` (a resolved `from` or `to` concept id) matches ANY of `selectors` —
 * union (OR) within one flag — or when `selectors` is `undefined` (the facet was never
 * set, so it imposes no restriction). Each selector is either an EXACT canonical id match or,
 * when it ends in `/`, a PREFIX match — one rule, no glob syntax, per {@link EdgeFilter}'s
 * contract.
 */
function matchesEdgeSelector(value: ConceptId, selectors: string[] | undefined): boolean {
  if (selectors === undefined) return true;
  for (const normalized of selectors) {
    if (normalized.endsWith("/")) {
      if (value.startsWith(normalized)) return true;
    } else if (value === normalized) {
      return true;
    }
  }
  return false;
}

/** Coerce an {@link EdgeFilter} `from`/`to` facet to a selector list, or `undefined` when the
 * facet is absent entirely (meaning "no restriction" — distinct from an empty array, which
 * would restrict to nothing matching). A single selector is wrapped, an array passed through. */
function toSelectorList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * The whole-bundle derived edge list, filtered (graph-query-v0). This is the ONE atom every
 * edge-shaped question reduces to — {@link backlinks} below is now a thin call into it, and
 * so is the CLI's `link list`. Edges are DERIVED by scanning every concept's outbound links,
 * never stored (gate 2) — there is exactly one link resolver ({@link parseLinksFromDoc}, via
 * {@link parseLinks}) and exactly one whole-bundle walk ({@link query}) underneath this, per the
 * single-authority contract.
 *
 * `filter.from`/`filter.to` each accept a single id, a trailing-slash prefix, or an array of
 * either (union within the flag; providing BOTH facets ANDs them); `filter.text` is an exact
 * match. Dangling edges are included: a link whose target has no document yet is still a real
 * edge (the unresolved-link lint and pre-delete impact checks depend on seeing them) — `to`
 * is the raw resolved concept id, not a proof the target exists. Per-literal-link counting: a
 * source linking to the same target via two differently-worded links yields two rows (typed-
 * edge reading v0's pinned semantics), matching {@link parseLinks}' own no-dedup granularity.
 * Reserved files (`index.md`/`log.md`) can never be a link target ({@link parseLinksFromDoc}
 * drops them at resolution) and reserved files are never a `from` either (they are excluded
 * from every {@link query} scan) — so this never surfaces a phantom edge to/from a reserved
 * concept id. Deterministic output: sorted by `(from, to, text)`.
 */
export async function queryEdges(bundle: Bundle, filter: EdgeFilter = {}): Promise<Link[]> {
  // Validate and canonicalize selectors before scanning, including on an empty bundle. Invalid
  // engine input must not appear valid merely because there were no edges to compare it with.
  const fromSelectors = toSelectorList(filter.from)?.map(normalizeEdgeSelector);
  const toSelectors = toSelectorList(filter.to)?.map(normalizeEdgeSelector);
  const docs = await query(bundle);
  const edges: Link[] = [];
  for (const doc of docs) {
    for (const link of parseLinksFromDoc(doc)) {
      if (!matchesEdgeSelector(link.from, fromSelectors)) continue;
      if (!matchesEdgeSelector(link.to, toSelectors)) continue;
      if (filter.text !== undefined && link.text !== filter.text) continue;
      edges.push(link);
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.text.localeCompare(b.text));
  return edges;
}

/**
 * "Cited by" set for a target concept — derived by reversing the resolved link
 * graph over the whole bundle. Backlinks are DERIVED, never stored (OKF has no
 * `cited_by` frontmatter field). Returns the full citing {@link Link} (carrying
 * `text`, the only relationship-type signal the bytes carry), not a bare source
 * id — a source citing the target via two differently-worded links yields two
 * rows, mirroring {@link parseLinks}'s own no-dedup-by-target granularity on the
 * outbound side. A thin `{ to: target }` call into {@link queryEdges} (graph-query-v0's
 * generalization) — sorted `(from, to, text)` collapses to `(from, text)` here since
 * `to` is constant across every row, so this is byte-identical to the pre-generalization
 * sort.
 *
 * `queryEdges` treats a trailing `/` as a PREFIX selector — that capability belongs to
 * `queryEdges`/the CLI's `link list`, never to `backlinks`, which is a per-concept "cited
 * by" lookup and must stay EXACT-match on the LITERAL `target` ALWAYS (its
 * pre-generalization contract; `link show`, `status`'s backlink-count lints, and every
 * other caller depend on this). A valid concept id never ends in `/`, so a trailing-slash
 * `target` can never legitimately name a real concept — `backlinks(bundle, "tasks/")`
 * must be `[]` byte-identically, REGARDLESS of whether a doc literally named `tasks`
 * happens to exist. (An earlier fix here stripped the trailing slash and delegated
 * `{ to: "tasks" }` into `queryEdges` — which is wrong: it ALIASES `"tasks/"` to the
 * bare id `"tasks"`, so a bundle with a `tasks` doc would report ITS backlinks under
 * the `"tasks/"` query, when main never did. Short-circuiting instead — never handing a
 * trailing-slash target to `queryEdges` at all — avoids that alias entirely.)
 */
export async function backlinks(bundle: Bundle, target: ConceptId): Promise<Link[]> {
  if (target.endsWith("/")) return [];
  return queryEdges(bundle, { to: target });
}

// ── blobs: opaque bytes + a content-type ─────────────────────────────────────
//
// Thin, additive engine wrappers routing through `backendFor` — mirroring
// `writeDocVersioned`'s shape (B4). Future consumers (the CLI's `promote`/`pull`,
// Part C) use ONLY these, never a backend directly, so storage stays pluggable.
// Unlike concept documents, blobs carry no OKF semantics of their own (no
// `type` requirement, no reserved-file check, no timestamp defaulting) — the guard
// against traversal / `.md` collision / dot-segments lives at the BACKEND layer
// (`assertSafeBlobKey`, applied identically by every adapter), so these wrappers are
// pure pass-throughs.

/** Read a blob by key, or `null` if absent. See {@link StorageBackend.readBlob}. */
export async function readBlob(bundle: Bundle, key: BlobKey): Promise<ReadBlobResult | null> {
  return backendFor(bundle).readBlob(key);
}

/**
 * Persist a blob (create or overwrite) and return its new {@link Version}. `options`
 * threads the same compare-and-swap + actor capabilities as {@link writeDoc}. See
 * {@link StorageBackend.writeBlob} for the content-type override's per-adapter
 * persistence posture.
 */
export async function writeBlob(
  bundle: Bundle,
  key: BlobKey,
  bytes: Uint8Array,
  contentType?: string,
  options?: WriteOptions,
): Promise<Version> {
  return backendFor(bundle).writeBlob(key, bytes, contentType, options);
}

/** True when a blob exists at `key`. See {@link StorageBackend.existsBlob}. */
export async function existsBlob(bundle: Bundle, key: BlobKey): Promise<boolean> {
  return backendFor(bundle).existsBlob(key);
}

/** Blob keys, optionally restricted to a bundle-relative `prefix`. See {@link StorageBackend.listBlobs}. */
export async function listBlobs(bundle: Bundle, prefix?: string): Promise<BlobKey[]> {
  return backendFor(bundle).listBlobs(prefix);
}

/**
 * Hard-delete a blob. Pure pass-through (blobs carry no OKF semantics of their own to
 * enforce — no reserved-file concept, no id-safety guard beyond what the backend's own
 * `assertSafeBlobKey` already applies). See {@link StorageBackend.deleteBlob} for the
 * idempotency/CAS contract, which is identical to {@link deleteDoc}'s.
 */
export async function deleteBlob(bundle: Bundle, key: BlobKey, options?: DeleteOptions): Promise<boolean> {
  return backendFor(bundle).deleteBlob(key, options);
}
