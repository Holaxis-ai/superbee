// The checkout's private store, opened only when no other command holds the checkout.
//
// A running `sync` holds the checkout lock (and the store) for its whole run. Readers that must not
// wait on it (`status`, the end-of-turn hook's local check, the local MCP app's write guard) try
// the lock without waiting and treat a held lock as "busy". One helper, so the three agree on how.
import { readBundleOkfVersion, type JournaledBackend, type StorageBackend } from "@superbee/core";
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

/**
 * The OKF edition a backend's root index declares (core's `readBundleOkfVersion`), or undefined
 * for an absent, malformed or unknown one: the checkout's store, or its folder.
 */
export async function storeOkfVersion(store: StorageBackend): Promise<"0.1" | "0.2" | undefined> {
  const version = await readBundleOkfVersion({ root: "", backend: store }).catch(() => undefined);
  return version === "0.1" || version === "0.2" ? version : undefined;
}
