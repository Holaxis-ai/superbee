/**
 * @internal Test seams of the Node log store. This module is not in the package's `exports`, so
 * no consumer of `@superbee/core` can reach these keys; the store's own tests import them from
 * source to inject a failing log handle and to plant raw document bytes.
 */

/** The file operations the store performs on its log; a test substitutes a handle that fails on cue. */
export interface FileJournalHandle {
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

/** Option key: `(file) => Promise<FileJournalHandle>`, opening the existing log for positional writes. */
export const OPEN_LOG: unique symbol = Symbol("superbee.fileJournal.openLog");

/** Method key: `(id, raw) => Promise<void>`, planting exact bytes as a document's stored serialization. */
export const STORE_RAW: unique symbol = Symbol("superbee.fileJournal.storeRaw");
