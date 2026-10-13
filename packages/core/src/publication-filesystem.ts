/**
 * Publication-only filesystem capture helpers. This subpath deliberately does not widen the
 * stable StorageBackend seam or the main `@superbee/core` export surface.
 */
export {
  listFilesystemReservedObjects,
  openRawFilesystemDocumentPass,
  readRawFilesystemDocument,
  readRawFilesystemReserved,
} from "./backend.js";
