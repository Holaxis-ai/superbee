// The checkout's private store, opened only when no other command holds the checkout.
//
// A running `sync` holds the checkout lock (and the store) for its whole run. Readers that must not
// wait on it (`status`, the end-of-turn hook's local check, the local MCP app's write guard) try
// the lock without waiting and treat a held lock as "busy". One helper, so the three agree on how.
import { parseMarkdown, type JournaledBackend } from "@superbee/core";
import { FileJournaledBackend } from "@superbee/core/file-journaled-backend";
import { filesystemPushRoleLocks } from "@superbee/core/filesystem-push-role";

import { checkoutLockName, checkoutStoreDir, type CheckoutBinding } from "./binding.js";

/**
 * Run `read` on the checkout's store, opened read-only unless `readOnly: false`, while holding the
 * checkout lock; null, without waiting, when another command holds it.
 */
export async function withIdleCheckoutStore<T>(
  binding: CheckoutBinding,
  home: string,
  read: (store: JournaledBackend) => Promise<T>,
  options: { readonly readOnly?: boolean } = {},
): Promise<T | null> {
  return filesystemPushRoleLocks().request(checkoutLockName(binding.path), { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    const store = await FileJournaledBackend.open({ directory: checkoutStoreDir(home, binding.checkout_id), readOnly: options.readOnly ?? true });
    try {
      return await read(store);
    } finally {
      await store.close();
    }
  });
}

/** The OKF edition the checkout's root index declares, or undefined. */
export async function storeOkfVersion(store: JournaledBackend): Promise<"0.1" | "0.2" | undefined> {
  const root = await store.readReserved("", "index.md");
  if (!root) return undefined;
  try {
    const version = parseMarkdown(root.content, "index").frontmatter.okf_version;
    return version === "0.1" || version === "0.2" ? version : undefined;
  } catch {
    return undefined;
  }
}
