/** Runtime-neutral document scan policy, shared by engine queries and backend-fed search. */
import { FilesystemIdentityAliasError } from "./errors.js";
import { MalformedDocumentError } from "./frontmatter-contract.js";
import { permissionDeniedReason } from "./skip-reasons.js";
import type { ConceptId, ReadResult, StorageBackend } from "./types.js";

/** A document a resilient scan skipped because it was malformed or the host denied reading it. */
export interface SkippedDoc {
  id: ConceptId;
  reason: string;
}

/** Options for document and head scans. */
export interface QueryOptions {
  onSkip?: (skip: SkippedDoc) => void;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * The stable skip reason for a read the host refused, or `undefined` for any other failure. The
 * filesystem error's own message carries the absolute host path, so it is never the reason.
 */
function deniedReason(err: unknown): string | undefined {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "EACCES" || code === "EPERM" ? permissionDeniedReason(code) : undefined;
}

/**
 * Delete-tolerant batch read: `readMany`, and when the batch fails because an id vanished (or,
 * with `onMalformed`, because one document is malformed, or, with `onAliased`, because one id is
 * spelled differently on disk, or, with `onDenied`, because the host refused to read one), the
 * same batch read again in halves until the failing ids stand alone. Absent ids are simply missing
 * from the result; a malformed, aliased or denied id is reported through its hook and skipped. Any
 * other failure still throws. Halving keeps every surviving id inside a batch read, so one bad id
 * costs about one more batch rather than one unbatched read per id, which on a filesystem lists the
 * document's directory for every document. Shared by the scan path and the cross-bundle resolver,
 * which issues one call per bound alias.
 */
export async function readManyExisting(
  backend: StorageBackend,
  ids: ConceptId[],
  onMalformed?: (skip: SkippedDoc) => void,
  onAliased?: (skip: SkippedDoc) => void,
  onDenied?: (skip: SkippedDoc) => void,
): Promise<ReadResult[]> {
  const tolerated = (err: unknown): boolean =>
    isEnoent(err) ||
    (err instanceof MalformedDocumentError && onMalformed !== undefined) ||
    (err instanceof FilesystemIdentityAliasError && onAliased !== undefined) ||
    (deniedReason(err) !== undefined && onDenied !== undefined);
  const readOne = async (id: ConceptId): Promise<ReadResult[]> => {
    try {
      return [await backend.read(id)];
    } catch (candidate) {
      if (isEnoent(candidate)) return [];
      if (candidate instanceof MalformedDocumentError && onMalformed) {
        onMalformed({ id, reason: candidate.detail });
        return [];
      }
      if (candidate instanceof FilesystemIdentityAliasError && onAliased) {
        onAliased({ id, reason: candidate.message });
        return [];
      }
      const reason = deniedReason(candidate);
      if (reason !== undefined && onDenied) {
        onDenied({ id, reason });
        return [];
      }
      throw candidate;
    }
  };
  const readBatch = async (batch: ConceptId[]): Promise<ReadResult[]> => {
    try {
      return await backend.readMany(batch);
    } catch (err) {
      if (!tolerated(err)) throw err;
      if (batch.length === 1) return readOne(batch[0]!);
      const half = Math.ceil(batch.length / 2);
      return [...(await readBatch(batch.slice(0, half))), ...(await readBatch(batch.slice(half)))];
    }
  };
  return readBatch(ids);
}
