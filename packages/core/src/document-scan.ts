/** Runtime-neutral document scan policy, shared by engine queries and backend-fed search. */
import { FilesystemIdentityAliasError } from "./errors.js";
import { MalformedDocumentError } from "./frontmatter-contract.js";
import type { ConceptId, ReadResult, StorageBackend } from "./types.js";

/** A document a resilient scan skipped because it was malformed. */
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
 * Delete-tolerant batch read: one `readMany`, falling back to per-id reads only when the batch
 * fails because an id vanished (or, with `onMalformed`, because one document is malformed, or,
 * with `onAliased`, because one id is spelled differently on disk). Absent ids are simply missing
 * from the result; a malformed or aliased id is reported through its hook and skipped. Any other
 * failure still throws. Shared by the scan path and the cross-bundle resolver, which issues one
 * call per bound alias.
 */
export async function readManyExisting(
  backend: StorageBackend,
  ids: ConceptId[],
  onMalformed?: (skip: SkippedDoc) => void,
  onAliased?: (skip: SkippedDoc) => void,
): Promise<ReadResult[]> {
  try {
    return await backend.readMany(ids);
  } catch (err) {
    const malformed = err instanceof MalformedDocumentError && onMalformed !== undefined;
    const aliased = err instanceof FilesystemIdentityAliasError && onAliased !== undefined;
    if (!isEnoent(err) && !malformed && !aliased) throw err;
    const out: ReadResult[] = [];
    for (const id of ids) {
      try {
        out.push(await backend.read(id));
      } catch (candidate) {
        if (isEnoent(candidate)) continue;
        if (candidate instanceof MalformedDocumentError && onMalformed) {
          onMalformed({ id, reason: candidate.detail });
          continue;
        }
        if (candidate instanceof FilesystemIdentityAliasError && onAliased) {
          onAliased({ id, reason: candidate.message });
          continue;
        }
        throw candidate;
      }
    }
    return out;
  }
}

