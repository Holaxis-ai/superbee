/** Runtime-neutral document scan policy, shared by engine queries and backend-fed search. */
import { FilesystemIdentityAliasError } from "./errors.js";
import { MalformedDocumentError } from "./frontmatter-contract.js";
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
  return code === "EACCES" || code === "EPERM" ? `permission denied (${code})` : undefined;
}

/**
 * Delete-tolerant batch read: one `readMany`, falling back to per-id reads only when the batch
 * fails because an id vanished (or, with `onMalformed`, because one document is malformed, or,
 * with `onAliased`, because one id is spelled differently on disk, or, with `onDenied`, because
 * the host refused to read one). Absent ids are simply missing from the result; a malformed,
 * aliased or denied id is reported through its hook and skipped. Any other failure still throws. Shared by the scan path and the cross-bundle resolver, which issues one
 * call per bound alias.
 */
export async function readManyExisting(
  backend: StorageBackend,
  ids: ConceptId[],
  onMalformed?: (skip: SkippedDoc) => void,
  onAliased?: (skip: SkippedDoc) => void,
  onDenied?: (skip: SkippedDoc) => void,
): Promise<ReadResult[]> {
  try {
    return await backend.readMany(ids);
  } catch (err) {
    const malformed = err instanceof MalformedDocumentError && onMalformed !== undefined;
    const aliased = err instanceof FilesystemIdentityAliasError && onAliased !== undefined;
    const denied = deniedReason(err) !== undefined && onDenied !== undefined;
    if (!isEnoent(err) && !malformed && !aliased && !denied) throw err;
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
        const reason = deniedReason(candidate);
        if (reason !== undefined && onDenied) {
          onDenied({ id, reason });
          continue;
        }
        throw candidate;
      }
    }
    return out;
  }
}

