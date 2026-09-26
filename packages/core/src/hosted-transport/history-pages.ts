/**
 * Paging back through one document's hosted history (`documents.history.v1`). The host serves a
 * lineage newest first, a page at a time: the first page (no `before`) states the lineage's
 * `total`, and each later page lists the versions older than the last one read. Older versions
 * never change, so a write that only appends to the lineage while the pages are read leaves the
 * listing a true picture of the lineage as the first page saw it.
 *
 * What does break a listing is a new lineage: the document deleted (and perhaps recreated, its
 * `seq` restarting at 1) between two pages. A later page that answers `document_not_found` says
 * so directly; otherwise, after a listing of more than one page, the first page's newest version
 * is read again by its `seq`, and a listing whose newest version is gone or different starts
 * again from the first page, after {@link pageRestartDelay}, at most {@link HEADS_PAGE_ATTEMPTS}
 * times in all. Pages from two lineages are never assembled into one listing.
 */

import { HEADS_PAGE_ATTEMPTS, pageRestartDelay, pause } from "./paged-reads.js";
import { HISTORY_PAGE_LIMIT, type HostedHistoryAnswer, type HostedHistoryRequest, type HostedHistoryVersion, type HostedOperationRefusal } from "./read-adapter.js";

/** Reads one page of a document's history (a client's bounded history read). */
export type HistoryPageReader = (request: HostedHistoryRequest) => Promise<HostedHistoryAnswer>;

export interface HistoryListingRequest {
  readonly documentId: string;
  /** The newest this many versions, or fewer when the lineage is shorter. */
  readonly wanted: number;
  /** Ask each page for its versions' stored bytes (a page's content shares the host's 1 MiB bound). */
  readonly includeContent?: boolean;
  /** Versions per request, 1..{@link HISTORY_PAGE_LIMIT} (default: the limit). */
  readonly pageSize?: number;
}

export type HistoryListing =
  /** Newest first; `total` is the lineage's length as the first page stated it. */
  | { readonly status: "listed"; readonly versions: readonly HostedHistoryVersion[]; readonly total: number }
  /** The first page answered `document_not_found`: the host has no such document. */
  | { readonly status: "absent" }
  /** The host refused a page for another reason; the caller maps it. */
  | { readonly status: "refused"; readonly refusal: HostedOperationRefusal }
  /** The lineage changed under every attempt. */
  | { readonly status: "moved" };

export interface HistoryListingOptions {
  readonly signal: AbortSignal;
  /** Test seam: how the listing waits before starting again. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly attempts?: number;
}

type Attempt = Exclude<HistoryListing, { status: "moved" }> | "moved";

async function listOnce(readPage: HistoryPageReader, request: HistoryListingRequest): Promise<Attempt> {
  const size = request.pageSize ?? HISTORY_PAGE_LIMIT;
  if (!Number.isSafeInteger(size) || size < 1 || size > HISTORY_PAGE_LIMIT) throw new RangeError(`history page size must be 1..${HISTORY_PAGE_LIMIT}`);
  const versions: HostedHistoryVersion[] = [];
  let total = 0;
  let before: number | undefined;
  for (;;) {
    const answer = await readPage({
      documentId: request.documentId,
      limit: Math.min(size, request.wanted - versions.length),
      ...(before === undefined ? {} : { before }),
      ...(request.includeContent ? { includeContent: true } : {}),
    });
    if (!answer.ok) {
      // Absent on the first page is the answer; absent on a later page, the lineage ended meanwhile.
      if (answer.refusal.code === "document_not_found") return before === undefined ? { status: "absent" } : "moved";
      return { status: "refused", refusal: answer.refusal };
    }
    const { page } = answer;
    if (before === undefined) total = page.total!;
    versions.push(...page.versions);
    if (!page.more || versions.length >= request.wanted) break;
    before = page.versions.at(-1)!.seq;
  }
  if (before === undefined) return { status: "listed", versions, total };
  // More than one page: the first page's newest version must still be the lineage's, by its seq.
  const newest = versions[0]!;
  const check = await readPage({ documentId: request.documentId, limit: 1, before: newest.seq + 1 });
  if (!check.ok) return check.refusal.code === "document_not_found" ? "moved" : { status: "refused", refusal: check.refusal };
  const again = check.page.versions[0];
  if (!again || again.seq !== newest.seq || again.version !== newest.version || again.timestamp !== newest.timestamp) return "moved";
  return { status: "listed", versions, total };
}

/** The newest `wanted` versions of one lineage, paged back with `before`. */
export async function readHistoryListing(readPage: HistoryPageReader, request: HistoryListingRequest, options: HistoryListingOptions): Promise<HistoryListing> {
  const attempts = options.attempts ?? HEADS_PAGE_ATTEMPTS;
  for (let attempt = 1; ; attempt += 1) {
    const result = await listOnce(readPage, request);
    if (result !== "moved") return result;
    if (attempt >= attempts) return { status: "moved" };
    await (options.sleep ?? pause)(pageRestartDelay(attempt), options.signal);
  }
}
