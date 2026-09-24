// `superbee status` in a hosted checkout: the checkout's sync state, read from local state only.
//
// Nothing here sends a request, takes a sign-in, or writes the store, the projection record or the
// folder. It answers what the next `sync` would find: documents with an unsent change, conflicts,
// held files and held deletions, and how long ago the last pull completed. The folder is
// classified by the sync scan itself (`scanCheckout` in preview), so status and sync never
// disagree about what a file is.
import { UNSETTLED_STATES, openLocalBundle } from "@superbee/browser-local";
import { parseMarkdown, type JournaledBackend } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";

import { commandFragment, commandToken, type CommandText } from "../command-text.js";
import { cliInvocation } from "../invocation.js";
import { checkoutLockName, checkoutStoreDir, type CheckoutBinding } from "./binding.js";
import { ageMs, describeAge, HOSTED_STALE_WARNING_MS, readFreshness } from "./freshness.js";
import { readProjection, scanCheckout, type HeldReason } from "./sync-scan.js";

/** Ids shown per category; the counts are always the totals. */
export const STATUS_IDS_SHOWN = 5;

interface Classified {
  readonly unsent: Set<string>;
  readonly conflicts: Set<string>;
  readonly held: Map<string, HeldReason>;
  readonly heldDeletions: Set<string>;
}

async function storeOkfVersion(store: JournaledBackend): Promise<"0.1" | "0.2" | undefined> {
  const root = await store.readReserved("", "index.md");
  if (!root) return undefined;
  try {
    const version = parseMarkdown(root.content, "index").frontmatter.okf_version;
    return version === "0.1" || version === "0.2" ? version : undefined;
  } catch {
    return undefined;
  }
}

async function classify(binding: CheckoutBinding, home: string, store: JournaledBackend): Promise<Classified> {
  const result: Classified = { unsent: new Set(), conflicts: new Set(), held: new Map(), heldDeletions: new Set() };

  // Changes already journaled: the first unsettled intent per document says what it is (as sync's rows do).
  const firstIntent = new Map<string, string>();
  for (const row of await store.listIntents(UNSETTLED_STATES)) if (!firstIntent.has(row.target)) firstIntent.set(row.target, row.state);
  for (const [id, state] of firstIntent) (state === "conflict" ? result.conflicts : result.unsent).add(id);

  // Files that differ from what the last sync or pull placed: what the next scan would find.
  const report = await scanCheckout({
    folder: binding.path,
    bundleId: binding.bundle_id,
    okfVersion: await storeOkfVersion(store),
    local: openLocalBundle(binding.checkout_id, { backend: store }),
    projection: await readProjection(home, binding.checkout_id, store),
    preview: true,
  });
  for (const id of report.pending) result.unsent.add(id);
  for (const id of report.conflicted) result.conflicts.add(id);
  for (const row of report.held) {
    if (row.reason === "bulk_deletion") result.heldDeletions.add(row.id);
    else result.held.set(row.id, row.reason);
  }

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
  const classified = await filesystemPushRoleLocks().request(checkoutLockName(binding.path), { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(home, binding.checkout_id), readOnly: true });
    try {
      return await classify(binding, home, store);
    } finally {
      await store.close();
    }
  });

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
    const { unsent, conflicts, held, heldDeletions } = classified;
    sync.state = conflicts.size > 0 || held.size > 0 || heldDeletions.size > 0 ? "needs_decision" : unsent.size > 0 ? "unsent_changes" : "clean";
    sync.unsent = unsent.size;
    if (unsent.size > 0) sync.unsent_ids = firstIds(unsent);
    sync.conflicts = conflicts.size;
    if (conflicts.size > 0) sync.conflict_ids = firstIds(conflicts);
    sync.held_files = held.size;
    if (held.size > 0) sync.held_rows = firstIds(held.keys()).map((id) => ({ id, reason: held.get(id)! }));
    sync.held_deletions = heldDeletions.size;
    if (heldDeletions.size > 0) sync.held_deletion_ids = firstIds(heldDeletions);
    const first = firstIds(conflicts)[0];
    if (first !== undefined) help.push(commandFragment`${cliInvocation()} sync --inspect --doc ${commandToken(first)} --dir ${commandToken(binding.path)}`);
    if (unsent.size > 0 || conflicts.size > 0 || held.size > 0 || heldDeletions.size > 0) help.push(syncCommand);
  }
  sync.last_pull = freshness.pulled_at;
  sync.since_pull = age === null ? "never" : describeAge(age);
  sync.stale = stale;
  if (stale && !help.includes(syncCommand)) help.push(syncCommand);
  return { sync, help };
}
