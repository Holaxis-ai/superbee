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
export { VersionConflict, stripETagWrapper } from "./version-transport.js";
