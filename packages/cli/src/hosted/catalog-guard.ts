// Whether a catalog label may be forgotten while a hosted checkout lives at its folder.
//
// Forgetting a label never removes the binding, the store or a file, so the guard protects
// discoverability: a checkout holding work sync has not sent keeps the label other sessions and
// the local MCP app find it by. Everything here reads; the store opens read-only and never waits.
import { UNSETTLED_STATES } from "@superbee/browser-local";

import { samePhysicalPath } from "../bundle.js";
import { commandFragment, commandToken } from "../command-text.js";
import { CliError } from "../errors.js";
import { cliInvocation } from "../invocation.js";
import { folderIdentity, indexedBindingForPath, listReadyBindings, sameFolder, type CheckoutBinding } from "./binding.js";
import { withIdleCheckoutStore } from "./checkout-store.js";
import { classifyCheckout } from "./status.js";

export type LabelGuard =
  | { readonly checkout: null }
  /** The checkout's own folder, with nothing for sync to send. */
  | { readonly checkout: CheckoutBinding; readonly folder: "present" }
  /** No folder at the path, or one that is not the checkout's own: nothing there to scan. */
  | { readonly checkout: CheckoutBinding; readonly folder: "missing" | "replaced"; readonly strandedUnsent: number };

function unverifiable(folder: string, error: unknown): CliError {
  return new CliError("CONFLICT", `could not read the hosted checkout state for ${folder}: ${error instanceof Error ? error.message : String(error)}`, {
    details: { reason: "checkout_unverifiable", folder },
    help: commandFragment`${cliInvocation()} status --dir ${commandToken(folder)}`,
  });
}

function busy(folder: string): CliError {
  return new CliError("CONFLICT", `another command holds the checkout lock for ${folder}`, {
    details: { reason: "checkout_busy", folder },
    help: "wait for it to finish, then retry the same command",
  });
}

/**
 * The ready binding at this path: the path index first, then any binding naming the same folder by
 * path or, for a folder that is there, by identity (an entry can spell the folder in another case
 * on a case-insensitive volume, and the index is keyed by the exact spelling).
 */
async function bindingAt(home: string, folder: string): Promise<CheckoutBinding | null> {
  const indexed = await indexedBindingForPath(home, folder, true);
  if (indexed) return indexed;
  const identity = await folderIdentity(folder);
  return (await listReadyBindings(home)).find((binding) => samePhysicalPath(binding.path, folder) || (identity !== null && sameFolder(identity, binding.folder_identity))) ?? null;
}

/**
 * Refuse (CONFLICT) to forget the label of a hosted checkout whose own folder holds anything sync
 * has not sent: an unsent document, a conflict, a held file or deletion, or an ordinary file that
 * is not clean. A busy or unreadable checkout refuses too, never falling through to unguarded.
 */
export async function guardLabelRemoval(home: string, folder: string, label: string): Promise<LabelGuard> {
  let binding: CheckoutBinding | null;
  try {
    binding = await bindingAt(home, folder);
  } catch (error) {
    throw unverifiable(folder, error);
  }
  if (!binding) return { checkout: null };
  const found = binding;

  let identity;
  try {
    identity = await folderIdentity(found.path);
  } catch (error) {
    throw unverifiable(folder, error);
  }
  if (!identity || !sameFolder(identity, found.folder_identity)) {
    let stranded: number | null;
    try {
      stranded = await withIdleCheckoutStore(found, home, async (store) => (await store.listIntents(UNSETTLED_STATES)).length);
    } catch (error) {
      throw unverifiable(folder, error);
    }
    if (stranded === null) throw busy(found.path);
    return { checkout: found, folder: identity ? "replaced" : "missing", strandedUnsent: stranded };
  }

  let classified;
  try {
    classified = await withIdleCheckoutStore(found, home, (store) => classifyCheckout(found, home, store));
  } catch (error) {
    throw unverifiable(folder, error);
  }
  if (classified === null) throw busy(found.path);
  const blobs = classified.blobs.filter((row) => row.state !== "clean").length;
  const counts = {
    unsent: classified.unsent.size,
    conflicts: classified.conflicts.size,
    held_files: classified.held.size,
    held_deletions: classified.heldDeletions.size,
    blobs,
  };
  if (Object.values(counts).some((count) => count > 0)) {
    throw new CliError("CONFLICT", `workspace "${label}" is the hosted checkout of '${found.bundle_id}' at ${found.path}, which holds changes sync has not sent`, {
      details: { reason: "unsent_changes", label, folder: found.path, bundle_id: found.bundle_id, host: found.origin, ...counts },
      help: commandFragment`${cliInvocation()} sync --dir ${commandToken(found.path)}`,
    });
  }
  return { checkout: found, folder: "present" };
}
