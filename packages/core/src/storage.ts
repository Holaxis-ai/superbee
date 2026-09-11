/** Runtime-neutral storage contract for Worker, browser, and custom backend consumers. */

export type {
  BlobKey,
  ConceptId,
  DeleteOptions,
  Frontmatter,
  HeadResult,
  OkfDocument,
  QueryFilter,
  ReadBlobResult,
  ReadResult,
  ReservedFilename,
  ReservedReadResult,
  StorageBackend,
  StorageCapabilities,
  Version,
  VersionInfo,
  WriteOptions,
} from "./types.js";

export { InvalidInputError } from "./errors.js";
export { MalformedDocumentError } from "./frontmatter-contract.js";
export {
  RESERVED_FILENAMES,
  assertSafeBlobKey,
  assertSafeConceptId,
  assertSafeReservedDir,
  conceptIdFromPath,
  isReservedFile,
  pathFromConceptId,
  toPosix,
} from "./paths.js";
export { VersionConflict, isContentVersion, stripETagWrapper } from "./version-transport.js";
// The journaled-backend seam: what an adapter adds to `StorageBackend` to host a browser-local
// working copy's intent journal. Runtime-neutral, like the seam it extends.
export { IntentHoldConflict, IntentStateConflict } from "./journaled-backend.js";
export type {
  IntentPatch,
  IntentRecord,
  JournaledBackend,
  JournaledDeleteOptions,
  JournaledReadResult,
  JournaledWriteOptions,
  MetaRecord,
  NewIntentRecord,
} from "./journaled-backend.js";
// The wire request identity (`WriteOptions.requestId`) and the outcome shape an authority records
// for it: runtime-neutral, so Worker and browser consumers reach them through this seam.
export { isRequestIdentity } from "./uncertain-write.js";
export type { Outcome } from "./uncertain-write.js";
// The heads digest a wire authority and a working copy both mint over every document id and
// version, so a client can learn in one round trip whether anything changed.
export { headsDigest, isHeadsDigest, sortHeads } from "./heads-digest.js";
export type { DocumentHead } from "./heads-digest.js";
