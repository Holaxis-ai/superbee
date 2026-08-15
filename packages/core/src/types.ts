/**
 * Shared type shapes for the OKF store engine.
 *
 * These are the contract types originally sketched in `index.ts`; they are kept
 * here so the implementation modules can import them without a cycle, and are
 * re-exported verbatim from `index.ts` to keep the public contract stable.
 *
 * @see OKF spec — GoogleCloudPlatform/knowledge-catalog, `okf/SPEC.md`
 * @packageDocumentation
 */

/**
 * A concept's stable identity within a bundle: its path relative to the bundle
 * root with exactly the final `.md` removed (e.g. `tables/users`). IDs always use
 * forward slashes and are canonical storage keys, not file-like aliases: `x` maps
 * to `x.md`, while canonical id `x.md` maps to the distinct file `x.md.md`.
 * Directory hierarchy implies parent/child but is NOT emitted as graph edges —
 * only explicit body links are.
 */
export type ConceptId = string;

/**
 * A blob's stable identity within a bundle: a bundle-relative path key (e.g.
 * `artifacts/report.html`). Unlike a {@link ConceptId}, a blob key is the LITERAL
 * relative path (no `.md` stripped) and the blob/concept namespaces are disjoint by
 * construction — a blob key may never end in `.md` (see `assertSafeBlobKey` in
 * `paths.ts`), so the concept walk never has to distinguish the two kinds of file by
 * content, only by extension.
 */
export type BlobKey = string;

/**
 * The parsed YAML frontmatter of a concept document.
 *
 * Per OKF §4.1 the ONLY spec-required field is {@link Frontmatter.type}. All
 * other well-known fields are optional/recommended, and producers MAY add
 * arbitrary extra keys — consumers MUST preserve unknown keys on round-trip and
 * MUST NOT reject a document for carrying them (§9 permissive-consumption).
 */
export interface Frontmatter {
  /** REQUIRED, non-empty. Free-form kind of concept (e.g. `"BigQuery Table"`, `"Spec"`). Not centrally registered; consumers tolerate unknown values. */
  type: string;
  /** Human-readable display name; consumers MAY derive it from the filename if omitted. */
  title?: string;
  /** Single-sentence summary; used by index generators, search snippets, previews. */
  description?: string;
  /** Canonical URI of the underlying asset; correctly ABSENT for abstract concepts. */
  resource?: string;
  /** Cross-cutting categorization tags. */
  tags?: string[];
  /** Legacy v0.1 ISO-8601 datetime of last meaningful change (`generated.at` is the v0.2 clock). */
  timestamp?: string;
  /** Bundle-version marker; permitted ONLY in the bundle-root `index.md` frontmatter (§11). */
  okf_version?: string;
  /** Arbitrary producer-defined keys are permitted and preserved on round-trip. */
  [key: string]: unknown;
}

/** A fully parsed concept document: identity, frontmatter, and raw markdown body. */
export interface OkfDocument {
  /** Concept ID (bundle-relative path minus `.md`). */
  id: ConceptId;
  /** Parsed YAML frontmatter. */
  frontmatter: Frontmatter;
  /** The markdown body following the closing `---` delimiter. */
  body: string;
}

/** A handle to an opened bundle rooted at an absolute filesystem directory. */
export interface Bundle {
  /** Absolute path to the bundle root directory. */
  root: string;
  /**
   * Storage adapter the engine routes I/O through. Optional and defaulted: when
   * omitted, the engine uses a filesystem adapter rooted at {@link Bundle.root}, so
   * existing `{ root }` callers keep working unchanged. Supplying a different
   * {@link StorageBackend} makes a non-filesystem store (e.g. a future remote
   * adapter) a plug-in, not a rewrite.
   */
  backend?: StorageBackend;
}

/** The two OKF reserved filenames the engine reads/writes directly (§6 index.md / §7 log.md). */
export type ReservedFilename = "index.md" | "log.md";

/**
 * An opaque version token for a stored concept document — the unit of optimistic
 * concurrency. It is CONTENT-ADDRESSED by intent (a SHA-256 over the serialized
 * document), so identical content yields the same token, but callers MUST treat it
 * as opaque: compare it for equality, never parse or order it. A document-centric
 * remote backend uses this exact shape as its per-doc head etag.
 */
export type Version = string;

/** A concept document read from a backend, together with the {@link Version} of the returned bytes. */
export interface ReadResult {
  /** The parsed concept document. */
  doc: OkfDocument;
  /** Opaque version token of exactly these bytes — pass it back as {@link WriteOptions.expectedVersion} for a compare-and-swap. */
  version: Version;
}

/**
 * A concept document's HEAD projection: identity + full frontmatter + version, NEVER the
 * body. This is the row shape `queryHeads` (engine) / {@link StorageBackend.queryHeads}
 * (seam) return — full frontmatter rather than a fixed thin column set because every
 * frontmatter consumer (`--fields` projection, kind-declared columns,
 * {@link QueryFilter.fields} equality) needs arbitrary keys, while bodies are the actual
 * transfer weight a scan does not need.
 */
export interface HeadResult {
  /** Concept ID (bundle-relative path minus `.md`). */
  id: ConceptId;
  /** The document's FULL parsed frontmatter. */
  frontmatter: Frontmatter;
  /** Opaque content-addressed version token of the full document these heads project — the same token {@link StorageBackend.read} returns, usable as a CAS basis. */
  version: Version;
}

/**
 * The raw content of a reserved file (`index.md` / `log.md`) together with the
 * {@link Version} of exactly those bytes — the CAS basis for a conditional
 * {@link StorageBackend.writeReserved}. Reserved files are unparsed markdown, so
 * their version is the content-address of the raw string (same digest a concept
 * document's on-disk bytes carry), which makes the token identical across adapters.
 */
export interface ReservedReadResult {
  /** Raw file content. */
  content: string;
  /** Opaque content-addressed version token of exactly this content. */
  version: Version;
}

/**
 * A blob read from a backend: its raw bytes, resolved MIME content-type, and the
 * {@link Version} of exactly those bytes (the compare-and-swap basis for a later
 * {@link StorageBackend.writeBlob}). The version is a hash of the RAW BYTES (see
 * `blobVersion` in `versioning.ts`) — never routed through a string/UTF-8 encoding,
 * so binary content round-trips byte-identical and hashes identically regardless of
 * backend.
 */
export interface ReadBlobResult {
  /** Raw blob bytes, exactly as written. */
  bytes: Uint8Array;
  /** Resolved MIME content-type (see `content-type.ts`'s single resolution point). */
  contentType: string;
  /** Opaque content-addressed version token of exactly these bytes. */
  version: Version;
}

/** One entry in a document's version history (newest-first as returned by {@link StorageBackend.versions}). */
export interface VersionInfo {
  /** Opaque content-addressed version token for this revision. */
  version: Version;
  /** Who wrote this revision. Defaults to a local identity when the write was unattributed. */
  actor: string;
  /** ISO-8601 instant this revision was recorded. */
  timestamp: string;
  /**
   * The client-declared sub-identity/label under {@link VersionInfo.actor} (the principal), when
   * one was attested. ABSENT on backends that record no agent: FilesystemBackend (keeps no
   * history), the reference server / local `--dir` (no auth manufactures it). Only the auth'd
   * worker's `withActor` splits a client's claimed actor into this field under the server-set
   * principal — see the actor-identity design. Free-form, sanitized at the trust boundary.
   */
  agent?: string;
}

/** Options controlling a conditional / attributed {@link StorageBackend.write}. */
export interface WriteOptions {
  /**
   * Compare-and-swap guard. When set to a {@link Version} token, the write succeeds
   * ONLY if the backend's current version for `id` equals that token; otherwise it
   * throws a typed `VersionConflict`. When set to `null`, the write is an
   * **expect-absent create**: it succeeds ONLY if `id` does not currently exist;
   * otherwise it throws `VersionConflict` (with `expected: null`, `actual: <current>`).
   * This closes the seam's create-race gap — bundle initialization and portable-index
   * projection use it for first-ever-create paths instead of an unconditional write. When omitted
   * entirely, the write is UNCONDITIONAL (last-writer-wins, the historical default).
   * Passing a version token for a not-yet-existing document is also a conflict (its
   * current version is "none").
   */
  expectedVersion?: Version | null;
  /** Who is performing this write; recorded against the new version. Defaults to a local identity when omitted. */
  actor?: string;
  /**
   * OPTIONAL client-declared agent label recorded ALONGSIDE {@link WriteOptions.actor} (the
   * principal). Additive: a backend that ignores it (FilesystemBackend) or a caller that omits it
   * behaves exactly as before. NOT part of the content-addressed version token, so it never
   * affects CAS or cross-backend token parity.
   */
  agent?: string;
}

/**
 * Options controlling a conditional {@link StorageBackend.delete} / {@link
 * StorageBackend.deleteBlob}. Deliberately NOT {@link WriteOptions}: a delete records no
 * new revision (no `actor` to attribute one to — D5, deleting a document also purges its
 * history, so per-write attribution has nothing left to attach to), and expect-absent is
 * meaningless for a delete (there is no "create" reading of removing something that isn't
 * there) — so unlike `WriteOptions.expectedVersion`, this `expectedVersion` carries NO
 * `null` branch.
 */
export interface DeleteOptions {
  /**
   * Compare-and-swap guard. When set, the delete succeeds ONLY if the backend's current
   * version for the target equals this token; otherwise it throws a typed
   * `VersionConflict`. When omitted, the delete is unconditional. In BOTH cases, deleting
   * an already-ABSENT target is never an error and never a conflict — it returns `false`
   * regardless of `expectedVersion` (idempotency, AXI P6: absence is success, not failure).
   */
  expectedVersion?: Version;
}

/**
 * The storage seam the OKF engine operates over. The engine keeps ALL OKF
 * semantics (id safety, non-empty `type`, link/backlink derivation, freshness);
 * a backend ONLY persists and retrieves concept documents and the reserved
 * `index.md`/`log.md` files.
 *
 * The contract is deliberately shaped for the HARDEST backend — networked,
 * concurrent, multi-writer, versioned, attributed — so that a document-centric
 * remote store is a plug-in, not a rewrite: {@link StorageBackend.read} surfaces a
 * content-addressed {@link Version}; {@link StorageBackend.write} takes an optional
 * compare-and-swap {@link WriteOptions.expectedVersion} (throwing `VersionConflict`
 * on mismatch) and an {@link WriteOptions.actor}; {@link StorageBackend.versions}
 * exposes history; {@link StorageBackend.readMany} batches reads so link-graph /
 * backlink traversal does not do N single round-trips. `FilesystemBackend` is the
 * DEGENERATE adapter (single-version history, enforced CAS through a same-user cross-process
 * filesystem critical section over the on-disk hash);
 * `MemoryBackend` proves the same contract for the hard case (a real version chain,
 * enforced CAS, per-write attribution).
 *
 * Every `ConceptId` passed through this seam is canonical and exact. Backends MUST NOT
 * normalize aliases independently: the invariant is
 * `conceptIdFromPath(pathFromConceptId(id)) === id`, and the route/write key owns the
 * identity of the returned document even when the input document carries a different `id`.
 */
export interface StorageBackend {
  /** Read + parse the concept document at `id`, with its version token. Rejects (ENOENT-shaped) if absent. */
  read(id: ConceptId): Promise<ReadResult>;
  /**
   * Batch-read `ids`, returning results in the SAME order. Rejects (ENOENT-shaped)
   * if any id is absent — callers list-then-read a known set. This is the single
   * round-trip the graph / backlink traversal uses instead of N {@link StorageBackend.read} calls.
   */
  readMany(ids: ConceptId[]): Promise<ReadResult[]>;
  /**
   * Persist the concept document at `id` (create or overwrite) and return the new
   * {@link Version}. Honors {@link WriteOptions.expectedVersion} (compare-and-swap; a
   * `null` token means expect-ABSENT, i.e. create-if-absent) and records
   * {@link WriteOptions.actor}. With no options this is an unconditional write under a
   * defaulted actor — the historical behavior.
   */
  write(id: ConceptId, doc: OkfDocument, options?: WriteOptions): Promise<Version>;
  /** True when a concept document exists at `id`. */
  exists(id: ConceptId): Promise<boolean>;
  /** Concept ids (reserved files excluded), optionally restricted to a bundle-relative `prefix`. */
  list(prefix?: string): Promise<ConceptId[]>;
  /**
   * Version history for `id`, newest-first, or `[]` when the document does not exist.
   * A backend that keeps no history (e.g. a plain filesystem) honestly returns just
   * the single current version.
   */
  versions(id: ConceptId): Promise<VersionInfo[]>;
  /**
   * Raw content of a reserved file at `dir` (`""` = bundle root) with its
   * {@link Version}, or `null` if absent. The version is the CAS basis a caller
   * passes back as {@link WriteOptions.expectedVersion} to
   * {@link StorageBackend.writeReserved} for a read-modify-write that does not lose
   * a concurrent writer's update.
   */
  readReserved(dir: string, name: ReservedFilename): Promise<ReservedReadResult | null>;
  /**
   * Persist raw content of a reserved file at `dir` and return its new {@link Version}.
   * Honors {@link WriteOptions.expectedVersion} (compare-and-swap → typed
   * `VersionConflict` on mismatch; passing a version token for an absent file is a
   * conflict; passing `null` means expect-ABSENT, i.e. create-if-absent — a conflict
   * when the file already exists); with no options the write is unconditional (the
   * historical last-writer-wins). The filesystem adapter enforces the version premise
   * with an external same-user cross-process mutation lock; `MemoryBackend` enforces it in memory.
   */
  writeReserved(
    dir: string,
    name: ReservedFilename,
    content: string,
    options?: WriteOptions,
  ): Promise<Version>;

  /**
   * Hard-delete the concept document at `id` (no tombstone — the row/file is gone, not
   * marked deleted). Non-cascading: outbound links FROM this doc and inbound links from
   * OTHER docs still naming it are left exactly as written (backlinks are derived, so a
   * dangling reference simply resolves to nothing on the next graph walk — no cleanup
   * pass runs here). Returns `true` when a document existed and was removed, `false`
   * when it was already absent — idempotent, NEVER a rejection for "nothing to delete."
   * Honors {@link DeleteOptions.expectedVersion} (compare-and-swap → typed
   * `VersionConflict` on mismatch), but an ABSENT target returns `false` regardless of
   * `expectedVersion` (absence always wins over a stale-version check — there is nothing
   * left to conflict with). Rejects (via the engine's reserved-file / id-safety guards,
   * not this seam method itself) for `index.md`/`log.md` — see `deleteDoc` in
   * `bundle.ts`.
   */
  delete(id: ConceptId, options?: DeleteOptions): Promise<boolean>;

  // ── blobs: opaque bytes + a content-type ────────────────────────────────────
  //
  // A blob is NOT a concept document: it carries no frontmatter/body split, and its
  // key is a LITERAL bundle-relative path (never `.md` — the two namespaces are
  // disjoint by construction, guarded at every op). It reuses the SAME version/CAS/
  // actor machinery as concept documents, but the version is a hash of the RAW BYTES
  // (`blobVersion`, `versioning.ts`) — never the doc-shaped `contentVersion`/
  // `versionOfBytes`, which would corrupt binary content by routing it through a
  // UTF-8 string.

  /**
   * Read the blob at `key` (raw bytes, resolved content-type, and its {@link Version}),
   * or `null` if absent. Unlike {@link StorageBackend.read}, a missing blob is a normal
   * `null` result, not a rejection — callers probe with `readBlob` the way they probe a
   * file, not the way they read a known-to-exist concept.
   */
  readBlob(key: BlobKey): Promise<ReadBlobResult | null>;
  /**
   * Persist the blob at `key` (create or overwrite) and return the new {@link Version}
   * (the SHA-256 of the raw bytes). Honors {@link WriteOptions.expectedVersion}
   * (compare-and-swap; `null` = expect-absent create) and {@link WriteOptions.actor}
   * for contract parity with {@link StorageBackend.write} — attribution recording is
   * backend-specific (unobserved on a plain filesystem, same as docs). `contentType`
   * is an explicit override; omitted, it is inferred from `key`'s extension at read
   * time. Whether an explicit override is PERSISTED is backend-specific and
   * documented per-adapter (`FilesystemBackend` infers-on-read; `MemoryBackend`
   * persists it) — both resolve through the ONE MIME source in `content-type.ts`.
   */
  writeBlob(
    key: BlobKey,
    bytes: Uint8Array,
    contentType?: string,
    options?: WriteOptions,
  ): Promise<Version>;
  /** True when a blob exists at `key`. */
  existsBlob(key: BlobKey): Promise<boolean>;
  /** Blob keys, optionally restricted to a bundle-relative `prefix`, sorted. Never includes concept documents or reserved files. */
  listBlobs(prefix?: string): Promise<BlobKey[]>;
  /**
   * Hard-delete the blob at `key` (no tombstone, no history to purge — blobs never
   * carried one). Returns `true` when a blob existed and was removed, `false` when it
   * was already absent — idempotent, mirroring {@link StorageBackend.delete} exactly
   * (same {@link DeleteOptions} CAS contract: an absent target returns `false`
   * regardless of `expectedVersion`).
   */
  deleteBlob(key: BlobKey, options?: DeleteOptions): Promise<boolean>;

  /**
   * OPTIONAL head-projection push-down (the wire-transfer optimization the protocol's
   * `GET /docs?fields=frontmatter&prefix=&type=&tag=` push-down row was specified for).
   * Returns {@link HeadResult} rows — full frontmatter + version, NEVER bodies.
   *
   * CONTRACT (gate 3 — the backend does not own filter semantics): this is a push-down
   * HINT. A backend MAY over-return (ignore any facet it cannot push server-side); the
   * ENGINE re-applies the one canonical predicate (`matchesFilter`, `bundle.ts`) to
   * whatever comes back, so semantics stay in core. A backend MUST NOT under-return for
   * a facet it chooses to honor. A backend that does not implement this method
   * (FilesystemBackend / MemoryBackend — both local to their data, where a head projection
   * saves nothing) is served by the engine's fallback (`list` +
   * `readMany`, bodies read then dropped), which additionally honors the scan's
   * malformed-doc resilience (`QueryOptions.onSkip`); the push-down path does not — a
   * malformed doc fails the server-side scan, exactly as the wire `list` always has.
   */
  queryHeads?(filter?: QueryFilter): Promise<HeadResult[]>;

  /**
   * OPTIONAL capabilities self-declaration. `StorageBackend` carries
   * no capabilities descriptor by default, so a wire router that wants to report an adapter's
   * real guarantees (`GET /v0/capabilities`, `docs/WIRE-PROTOCOL.md`) has historically inferred
   * them via `instanceof` against the two in-repo adapters — correct for those two, but unable
   * to classify a THIRD adapter it has never heard of (for example, a document-centric hosted
   * backend). A backend that implements this method reports its own limits instead of
   * being guessed at; a backend that does NOT implement it falls back to the router's
   * pre-existing `instanceof` inference. `FilesystemBackend` self-declares because enforced
   * cross-process CAS and retained history are now intentionally different capabilities.
   */
  capabilities?(): {
    /** Whether `versions()` retains more than the current revision. When omitted, legacy adapters preserve the v0 inference from `enforced_cas`. */
    history?: boolean;
    /** Whether `write`/`writeBlob`/`writeReserved`'s `expectedVersion` CAS is ENFORCED (atomic, race-proof) rather than best-effort. */
    enforced_cas: boolean;
    /** Whether `readBlob`/`writeBlob`/`existsBlob`/`listBlobs` are implemented for real (not a stub). */
    blobs: boolean;
    /** Whether `list`/`query` support server-side filter push-down (thin projections). Defaults to `true` when omitted — every adapter today does. */
    projections?: boolean;
    /** Whether server-side backlink/graph traversal is available. Defaults to `false` when omitted — deferred to v1 on every adapter today. */
    backlinks?: boolean;
  };
}

/** Options for {@link initBundle}. */
export interface InitBundleOptions {
  /** Supported OKF authoring version stamped into the root `index.md`. Defaults to `"0.1"`. */
  okfVersion?: string;
  /**
   * Require that this call CREATE the bundle: the root `index.md` write runs expect-absent
   * through the backend's CAS, and a pre-existing or concurrently created `index.md` throws
   * `VersionConflict` instead of opening the existing bundle. Default false (open-or-create).
   */
  expectNew?: boolean;
}

/** Filter for {@link query}. Provided facets are ANDed; reserved files are always excluded. */
export interface QueryFilter {
  /** Restrict to concepts whose frontmatter `type` equals this value. */
  type?: string;
  /** Restrict to concepts carrying ALL of these tags. */
  tags?: string[];
  /** Restrict to concept IDs beginning with this bundle-relative prefix. */
  prefix?: string;
  /**
   * Restrict to concepts whose frontmatter field equals this value. Multiple entries are ANDed
   * with each other and with the other facets. Comparison mirrors kind enum validation's coercion:
   * the frontmatter value is coerced to string(s) with `String(v)` per element (a scalar becomes a
   * one-element set, an array is coerced element-wise) and the requested value must be a member of
   * that set — so an unquoted YAML scalar (e.g. `priority: 1`) matches `"1"`, and an array field
   * (e.g. `tags: [a,b]`) matches on membership. A field the doc lacks never matches (empty set).
   */
  fields?: Record<string, string>;
}

/** A single resolved outbound cross-link (a standard markdown link, never a wikilink). */
export interface Link {
  /** Source concept ID (the document the link appears in). */
  from: ConceptId;
  /** Resolved target concept ID. MAY point at a not-yet-written concept (broken links are valid, §5). */
  to: ConceptId;
  /** The link's display text. */
  text: string;
  /** The raw target as written in the markdown, before resolution (e.g. `/a/b.md`, `./x.md`). */
  href: string;
}

/**
 * Filter for {@link queryEdges} — the whole-bundle derived edge list, filtered. `from`/`to` each
 * accept a single {@link ConceptId}, a trailing-slash prefix (`"tasks/"` matches any id starting
 * with that literal string — one rule, no glob syntax), or an array of either (union: a match
 * against ANY entry satisfies that facet). Providing both `from` and `to` ANDs them. `text` is an
 * EXACT match against the link's display text (never substring/regex/case-insensitive). All facets
 * are optional. ID selectors are exact canonical engine identities (`x` and `x.md` are distinct),
 * not path-like aliases. An empty filter returns every edge in the bundle (still including
 * dangling ones — a link to a nonexistent doc is a valid edge, per §5).
 */
export interface EdgeFilter {
  /** Restrict to edges whose source matches this id/prefix (or union of ids/prefixes). */
  from?: string | string[];
  /** Restrict to edges whose resolved target matches this id/prefix (or union of ids/prefixes). */
  to?: string | string[];
  /** Restrict to edges whose display text exactly equals this value. */
  text?: string;
}

/** A consumer-derived freshness verdict. OKF has no first-class staleness flag (mapping §c). */
export type FreshnessVerdict = "fresh" | "stale" | "empty";

/** Inputs for a {@link freshness} judgment. */
export interface FreshnessOptions {
  /** Instant to compare against; defaults to "now". */
  now?: Date;
  /** Maximum age before a concept is judged `stale`. */
  maxAgeMs?: number;
  /** ISO-8601 timestamps of upstream dependencies; any newer than the concept marks it `stale`. */
  dependsOn?: string[];
}

/** The outcome of a {@link freshness} judgment. */
export interface FreshnessResult {
  /** `fresh` / `stale` / `empty` (no usable `generated.at` or legacy `timestamp`). */
  verdict: FreshnessVerdict;
  /** Age in milliseconds relative to the comparison instant, when a meaningful-change time was present. */
  ageMs?: number;
  /** Human-readable reason (e.g. exceeded max age, a dependency is newer). */
  reason?: string;
}
