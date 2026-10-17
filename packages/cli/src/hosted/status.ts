// `superbee status` in a hosted checkout: the checkout's sync state, read from local state only.
//
// Nothing here sends a request, takes a sign-in, or writes the store, the projection record or the
// folder. It answers what the next `sync` would find: documents with an unsent change, conflicts,
// held files and held deletions, each tracked ordinary file's state, and how long ago the last
// pull completed. The folder is classified by the sync scan itself (`scanCheckout` in preview), so
// status and sync never disagree about what a file is.
import { UNSETTLED_STATES, openLocalBundle } from "@superbee/browser-local";
import type { FileJournaledBackend } from "@superbee/core/file-journaled-backend";

import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { cliInvocation } from "../invocation.js";
import { checkoutBindingDigest, type CheckoutBinding } from "./binding.js";
import { BLOB_SYNC_META_KEY, blobCheckoutStates, type BlobFileState } from "./blob-sync.js";
import { storeOkfVersion, withIdleCheckoutStore } from "./checkout-store.js";
import { ageMs, describeAge, HOSTED_STALE_WARNING_MS, readFreshness } from "./freshness.js";
import { readProjection, scanCheckout, type HeldReason } from "./sync-scan.js";

/** Ids shown per category; the counts are always the totals. */
export const STATUS_IDS_SHOWN = 5;

export interface Classified {
  readonly unsent: Set<string>;
  readonly conflicts: Set<string>;
  readonly held: Map<string, HeldReason>;
  readonly heldDeletions: Set<string>;
  /** Every tracked ordinary file and its state; never counted as a held document. */
  readonly blobs: { key: string; state: BlobFileState }[];
}

/**
 * Every document with local state the host does not have, by category, read from the store and a
 * preview scan. The caller holds the checkout lock (or accepts a racing sync).
 */
export async function classifyCheckout(binding: CheckoutBinding, home: string, store: FileJournaledBackend): Promise<Classified> {
  const result: Classified = { unsent: new Set(), conflicts: new Set(), held: new Map(), heldDeletions: new Set(), blobs: [] };

  // Changes already journaled: the first unsettled intent per document says what it is (as sync's rows do).
  const firstIntent = new Map<string, string>();
  for (const row of await store.listIntents(UNSETTLED_STATES)) if (!firstIntent.has(row.target)) firstIntent.set(row.target, row.state);
  for (const [id, state] of firstIntent) (state === "conflict" ? result.conflicts : result.unsent).add(id);

  // Files that differ from what the last sync or pull placed: what the next scan would find.
  const projection = await readProjection(home, binding.checkout_id, store);
  const scope = { origin: binding.origin, prefix: binding.routes, bundleId: binding.bundle_id, workspaceSlug: binding.workspace_slug ?? null };
  const tracked = (await store.readMeta(BLOB_SYNC_META_KEY)) !== undefined;
  const report = await scanCheckout({
    // As sync passes it, so a tracked ordinary file is never classified as a document; preview never admits.
    ...(tracked ? { blobs: { store, scope, binding: checkoutBindingDigest(binding.checkout_id), createdAt: new Date().toISOString(), allowed: true } } : {}),
    folder: binding.path,
    bundleId: binding.bundle_id,
    okfVersion: await storeOkfVersion(store),
    local: openLocalBundle(binding.checkout_id, { backend: store }),
    projection,
    preview: true,
    // What the host said at the last sync: a preview makes no request.
    definitionWrites: binding.definition_writes ?? null,
    rootWrites: projection.rootWrites ?? "refused",
    documentInputBytes: binding.document_input_bytes ?? null,
  });
  if (tracked) result.blobs.push(...await blobCheckoutStates(binding.path, store, scope));
  const blobKeys = new Set(result.blobs.map(row => row.key));
  for (const id of report.pending) result.unsent.add(id);
  for (const id of report.conflicted) result.conflicts.add(id);
  for (const row of report.held) {
    if (blobKeys.has(row.id) && row.path === row.id) continue;
    if (row.reason === "bulk_deletion") result.heldDeletions.add(row.id);
    else result.held.set(row.id, row.reason);
  }
  // The held set also names the deletes the host held: journaled, but a plain sync never sends them.
  for (const id of report.hold?.ids ?? []) result.heldDeletions.add(id);

  // One category per document: a conflict needs the person first, then a held file.
  for (const id of result.conflicts) {
    result.held.delete(id);
    result.heldDeletions.delete(id);
    result.unsent.delete(id);
  }
  for (const id of [...result.held.keys(), ...result.heldDeletions]) result.unsent.delete(id);
  return result;
}

const firstIds = (ids: Iterable<string>): string[] => [...ids].sort().slice(0, STATUS_IDS_SHOWN);

export interface HostedStatus {
  /** The `sync` block of the status record. */
  readonly sync: Record<string, unknown>;
  /** Next steps, empty when there is nothing to do. */
  readonly help: CommandText[];
}

/**
 * The hosted checkout's sync state. `busy` when another command holds the checkout (a sync is
 * running): the freshness is still reported, the folder is not read.
 */
export async function hostedStatus(binding: CheckoutBinding, home: string, now: Date = new Date()): Promise<HostedStatus> {
  const freshness = await readFreshness(home, binding.checkout_id);
  const age = ageMs(freshness.pulled_at, now);
  const stale = age === null || age > HOSTED_STALE_WARNING_MS;
  const classified = await withIdleCheckoutStore(binding, home, (store) => classifyCheckout(binding, home, store));

  const sync: Record<string, unknown> = {
    bundle_id: binding.bundle_id,
    host: binding.origin,
    folder: binding.path,
  };
  const syncCommand = commandFragment`${cliInvocation()} sync --dir ${commandToken(binding.path)}`;
  const help: CommandText[] = [];
  if (classified === null) {
    sync.state = "busy";
  } else {
    const { unsent, conflicts, held, heldDeletions, blobs } = classified;
    const blobCount = (state: BlobFileState) => blobs.filter(row => row.state === state).length;
    const blobDecision = blobCount("conflict") + blobCount("refused") + blobCount("held"), blobUnsent = blobCount("pending") + blobCount("unknown");
    sync.state = conflicts.size > 0 || held.size > 0 || heldDeletions.size > 0 || blobDecision > 0 ? "needs_decision" : unsent.size > 0 || blobUnsent > 0 ? "unsent_changes" : "clean";
    sync.unsent = unsent.size;
    if (unsent.size > 0) sync.unsent_ids = firstIds(unsent);
    sync.conflicts = conflicts.size;
    if (conflicts.size > 0) sync.conflict_ids = firstIds(conflicts);
    sync.held_files = held.size;
    if (held.size > 0) sync.held_rows = firstIds(held.keys()).map((id) => ({ id, reason: held.get(id)! }));
    sync.held_deletions = heldDeletions.size;
    if (heldDeletions.size > 0) sync.held_deletion_ids = firstIds(heldDeletions);
    if (blobs.length > 0) {
      sync.blobs = Object.fromEntries((["clean", "pending", "conflict", "unknown", "refused", "held"] as const).filter(state => state === "clean" || blobCount(state) > 0).map(state => [state, blobCount(state)]));
      const shown = blobs.filter(row => row.state !== "clean").slice(0, STATUS_IDS_SHOWN);
      if (shown.length > 0) sync.blob_rows = shown;
    }
    const first = firstIds(conflicts)[0];
    if (first !== undefined) help.push(commandFragment`${cliInvocation()} sync --inspect --doc ${commandToken(first)} --dir ${commandToken(binding.path)}`);
    const blobConflict = blobs.find(row => row.state === "conflict")?.key;
    if (blobConflict !== undefined) for (const choice of ["keep", "take"]) help.push(commandFragment`${cliInvocation()} sync --resolve ${commandToken(choice)} --doc ${commandToken(blobConflict)} --dir ${commandToken(binding.path)}`);
    if (unsent.size > 0 || conflicts.size > 0 || held.size > 0 || heldDeletions.size > 0 || blobDecision > 0 || blobUnsent > 0) help.push(syncCommand);
  }
  sync.last_pull = freshness.pulled_at;
  sync.since_pull = age === null ? "never" : describeAge(age);
  sync.stale = stale;
  if (stale && !help.includes(syncCommand)) help.push(syncCommand);
  return { sync, help };
}
