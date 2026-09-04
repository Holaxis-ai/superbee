/**
 * `@superbee/core` — the OKF store engine.
 *
 * An **Open Knowledge Format (OKF v0.1 or v0.2)** *Knowledge Bundle* is a
 * directory tree of UTF-8 markdown files, each carrying a YAML frontmatter block
 * (delimited by `---` lines) plus a markdown body. Every non-reserved `.md` file
 * is a *Concept*; its *Concept ID* is the file path minus `.md`
 * (e.g. `tables/users.md` -> `tables/users`).
 *
 * The FILESYSTEM is the source of truth by default, but storage is routed through
 * a pluggable {@link StorageBackend} (default: {@link FilesystemBackend}). This
 * module implements bundle I/O, standard-markdown cross-links (never wikilinks),
 * derived backlinks, freshness derived from the edition's meaningful-change clock, and reserved-file
 * (`index.md`/`log.md`) handling. Human-facing bundle Pages consume this engine through the
 * reference server's narrow browser bridge (read-only v0 plus shell-confirmed local proposals).
 *
 * The public function signatures below are contract-stable; everything past the
 * "extensions" line is additive (pure helpers, reserved-file accessors, and the
 * ported content_type utilities).
 *
 * @see OKF spec — GoogleCloudPlatform/knowledge-catalog, `okf/SPEC.md`
 * @packageDocumentation
 */

// ── Contract types (re-exported verbatim from `types.ts`) ─────────────────────
export type {
  ConceptId,
  Frontmatter,
  OkfDocument,
  Bundle,
  InitBundleOptions,
  QueryFilter,
  Link,
  EdgeFilter,
  FreshnessVerdict,
  FreshnessOptions,
  FreshnessResult,
  ReservedFilename,
  StorageBackend,
  StorageCapabilities,
  Version,
  ReadResult,
  ReservedReadResult,
  VersionInfo,
  WriteOptions,
  DeleteOptions,
} from "./types.js";

// ── Contract functions ────────────────────────────────────────────────────────
export {
  initBundle,
  readBundleOkfVersion,
  resolveOkfAuthoringVersion,
  DEFAULT_OKF_AUTHORING_VERSION,
  SUPPORTED_OKF_AUTHORING_VERSIONS,
  writeDoc,
  readDoc,
  existsDoc,
  query,
  parseLinks,
  backlinks,
  queryEdges,
} from "./bundle.js";

// Version-surfacing engine API (additive; the seam's hard-case capabilities threaded
// through the engine): `writeDocVersioned` returns the write's version token; `readDocVersioned`
// returns a document with its version; `docVersions` exposes attributed history. The plain
// `writeDoc`/`readDoc` above keep their historical `OkfDocument` returns unchanged.
export { writeDocVersioned, readDocVersioned, docVersions } from "./bundle.js";
export type { WriteResult } from "./bundle.js";

// Delete (additive; the DELETE-operation pass): hard-delete, non-cascading, reserved files
// stay non-deletable (guarded at the SAME engine layer writeDocVersioned's reserved-file
// check lives at), idempotent (absent -> false, never an error). `deleteDoc` carries the
// engine's id-safety/reserved-file guard; `deleteBlob` is a pure pass-through, mirroring
// the blob wrappers above.
export { deleteDoc, deleteBlob } from "./bundle.js";

// Blob storage engine wrappers: opaque bytes + a
// content-type, addressed by a bundle-relative key DISJOINT from the concept-document
// namespace, versioned by a raw-byte content hash, CAS-able, actor-attributed — reusing
// the doc seam's version/CAS/actor machinery. Future consumers (the CLI's `promote`/
// `pull`) route through ONLY these, never a backend directly.
export { readBlob, writeBlob, existsBlob, listBlobs } from "./bundle.js";
export type { BlobKey, ReadBlobResult } from "./types.js";

export { freshness } from "./freshness.js";

// Pluggable storage: the seam is `StorageBackend` (types.ts). `FilesystemBackend` is
// the DEGENERATE default adapter (the engine falls back to it for a `{ root }` bundle);
// `MemoryBackend` implements the SAME contract for the hard case (real version chain,
// enforced compare-and-swap, per-write actor) and proves the engine is backend-neutral.
export { FilesystemBackend } from "./backend.js";
export { MemoryBackend } from "./memory-backend.js";

// Internal-workspace filesystem arbitration authority. CLI create-only policy reuses this
// external same-user lock rather than defining a second lock protocol or writing claims into a
// portable bundle tree.
export {
  withFilesystemMutationLock,
  FilesystemMutationLockError,
  filesystemMutationLockPath,
} from "./filesystem-lock.js";
export type {
  FilesystemMutationLockOptions,
  FilesystemMutationLockOwner,
} from "./filesystem-lock.js";

// `RemoteBackend` is the CLIENT half of the wire-protocol v0 seam-over-HTTP contract
// (docs/WIRE-PROTOCOL.md) — a FUTURE plug-in adapter, proven here against the
// in-repo reference server (`@superbee/server`) by the tri-backend contract
// tests. No CF/D1/production deployment is implied by its presence.
export { RemoteBackend, RemoteError } from "./remote-backend.js";
export type { FetchLike, RemoteBackendOptions } from "./remote-backend.js";
export { isCanonicalBundleId } from "./bundle-id.js";
export type { BundleId } from "./bundle-id.js";

// Versioning / attribution primitives shared by every adapter: the content-addressed
// version token, a default actor, and the typed compare-and-swap conflict error.
// `blobVersion` is the raw-bytes sibling of `contentVersion`/`versionOfBytes` (blobs
// are hashed directly, never routed through a string/UTF-8 step).
export {
  contentVersion,
  versionOfBytes,
  blobVersion,
  defaultActor,
  VersionConflict,
  stripETagWrapper,
} from "./versioning.js";

// The ONE versioned-mutation boundary: a shared read-decide-CAS-retry
// primitive consumed by document, link, and index mutation policies instead of
// independently hand-rolled loops.
export { versionedMutation } from "./mutation.js";
export type { MutationDecision, VersionedMutationOptions, VersionedMutationOutcome } from "./mutation.js";

// Shared document mutation policy below any transport or presentation boundary. CLI and
// future trusted consumers reuse create/overwrite/patch semantics without importing CLI code.
export {
  mutateDocument,
  DocumentNotFoundError,
  KindConformanceError,
} from "./document-mutation.js";
export type {
  DocumentMutationCandidate,
  DocumentMutationContext,
  DocumentMutationMode,
  DocumentMutationResult,
  MutateDocumentOptions,
} from "./document-mutation.js";

// Field preconditions: the domain-invariant guard `mutateDocument` evaluates against each
// attempt's fresh read, inside the same decision the CAS write is paired with. `PreconditionFailed`
// is terminal — consumers branch on the type and map it to their own conflict shape.
export { PreconditionFailed, assertFieldPreconditions } from "./document-precondition.js";
export type { FieldExpectation, FieldPrecondition } from "./document-precondition.js";

// ── Extensions (additive; do not break the contract) ──────────────────────────

// `list` is an alias of `query` (the `list/query` API surface).
export { list } from "./bundle.js";
export type { QueryOptions, SkippedDoc } from "./bundle.js";

// Head-projection scan + its canonical filter predicate — contracts documented at the
// definition sites (bundle.ts/types.ts). The delete-tolerant batch read they share
// (`readManyExisting`) is internal: its one-time export for the reference router was
// withdrawn when the router switched to consuming `queryHeads` wholesale.
export { queryHeads } from "./bundle.js";
export { matchesFilter } from "./query-filter.js";
export { applyQuerySelectionFilters } from "./query-selection.js";
export type { QuerySelectionParams } from "./query-selection.js";
export type { HeadResult } from "./types.js";

// Portable, ownership-governed `index.md` projection. Raw reserved-file interop stays on the backend seam.
export {
  GENERATED_INDEX_MARKER,
  IndexProjectionWriteError,
  planIndexProjection,
  prepareIndexProjection,
  applyIndexProjection,
} from "./index-projection.js";
export type {
  PlannedIndex,
  IndexProjectionPlan,
  IndexProjectionDisposition,
  PreparedIndexTarget,
  ReadyIndexProjection,
  RefusedIndexProjection,
  IndexProjectionPreparation,
  AppliedIndexTarget,
  IndexProjectionApplyResult,
} from "./index-projection.js";

// Pure, unit-testable path / link / note / freshness helpers.
export {
  RESERVED_FILENAMES,
  isReservedFile,
  conceptIdFromPath,
  pathFromConceptId,
  assertSafeConceptId,
  assertSafeReservedDir,
  assertSafeBlobKey,
  toPosix,
} from "./paths.js";

export {
  extractMarkdownLinks,
  resolveConceptId,
  relativeHref,
  parseLinksFromDoc,
  isExternalHref,
} from "./links.js";
export type { RawLink } from "./links.js";

export { parseTimestamp } from "./freshness.js";

export {
  SUPERBEE_UPDATED_BY_FIELD,
  mutationActorFromFrontmatter,
  persistMutationActor,
} from "./mutation-attribution.js";
export type { PersistMutationActorOptions } from "./mutation-attribution.js";

export {
  parseMarkdown,
  stringifyDoc,
  stringifyWithData,
  normalizeDocumentBodyForStorage,
  isUsableTimestamp,
  MalformedDocumentError,
} from "./frontmatter.js";

// Typed input-validation rejection — consumer boundaries branch on the TYPE (CLI: USAGE/exit 2),
// never on message prose. `FilesystemIdentityAliasError` is the alias verdict of the filesystem
// adapter (a subclass, so it maps through the same branch); `ConcurrentReplacementError` is its
// bounded-retry runtime condition.
export { InvalidInputError, FilesystemIdentityAliasError, ConcurrentReplacementError } from "./errors.js";
export { applyV02MutationMetadata } from "./document-write-policy.js";

// Kind conventions: a bundle-declared, opt-in document-kind
// registry — validation + per-kind freshness horizons, read from `Convention` docs under
// `conventions/`. THE mechanism is core (one implementation, consumed by CLI/server/future
// MCP); usage is opt-in per bundle. A conventions-free bundle is byte-for-byte unaffected.
export {
  CONVENTIONS_PREFIX,
  CONVENTION_TYPE,
  PROGRESS_STATUS_FIELD,
  SUPERBEE_PROGRESS_STATUS_FIELD,
  RESERVED_KIND_FIELD_NAMES,
  progressStatusStorageField,
  progressStatusCoordinate,
  resolveKindFieldCoordinate,
  claimCoordinates,
  kindInputFieldNames,
  readKindField,
  projectLogicalKindFields,
  projectKindForAuthoring,
  projectKindValidationWarnings,
  validateAgainstKind,
  isPresent,
  defaultTimestampAndValidateAgainstRegistry,
  freshnessHorizonMs,
  kindConventionDoc,
  parseConventionDoc,
  buildKindRegistry,
  splitSections,
  isTerminal,
} from "./kinds.js";
export { loadKinds } from "./kinds-load.js";
export type {
  KindClaimCoordinates,
  KindClaimPolicy,
  KindConvention,
  KindFieldCoordinate,
  KindFields,
  KindRegistry,
  RegistryValidationResult,
} from "./kinds.js";

// Ported MIME utilities (holaxis-agentstate `packages/schemas/src/content-type.ts`).
// `resolveContentType` is the ONE place a blob's content-type is resolved (explicit
// override > inferred from key extension > `DEFAULT_BLOB_CONTENT_TYPE`) — every
// backend's blob methods route through it.
export {
  EXTENSION_CONTENT_TYPES,
  extensionOfDocKey,
  inferContentTypeFromDocKey,
  inferContentTypeForNewBlob,
  resolveContentType,
  DEFAULT_BLOB_CONTENT_TYPE,
} from "./content-type.js";
export type { ContentTypeInference, ValidationWarning } from "./content-type.js";
