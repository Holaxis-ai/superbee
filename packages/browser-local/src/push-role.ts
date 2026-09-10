/**
 * The one-writer-per-store coordination for the IndexedDB working copy: only the realm that
 * holds the store's push role may run {@link push}. IndexedDB permits main-thread access, so a
 * page may hold the role itself, and the intent journal's compare-and-swap already prevents two
 * realms from settling one intent twice. The role is what keeps two tabs from racing that
 * primitive at all: one tab delivers, the other reports the role held elsewhere and does not
 * touch the journal.
 *
 * In a browser the role is a Web Lock (`navigator.locks`), which the user agent releases when
 * the holding page is closed, crashes, or navigates, so a terminated tab never leaves the role
 * stuck. A Node host has no Web Locks; an in-process table gives the Node proof the same
 * exclusive semantics within one process, which is what those tests need. An OPFS working copy
 * would need a worker-owned writer instead, because OPFS synchronous access handles are not
 * available on the main thread; that design is outside this module.
 */

/** The outcome of one attempt to run work under the push role. */
export type PushRoleResult<T> = { held: true; result: T } | { held: false; reason: "held-elsewhere" };

interface LockRequestOptions {
  ifAvailable?: boolean;
}

interface LockManagerLike {
  request<T>(name: string, options: LockRequestOptions, callback: (lock: { name: string } | null) => Promise<T>): Promise<T>;
}

function webLocks(): LockManagerLike | null {
  const navigatorLike = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  const locks = navigatorLike?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/** The Node fallback: names currently held in this process. */
const heldInProcess = new Set<string>();

/** The lock name for one working copy's push role. */
export function pushRoleName(databaseName: string): string {
  return `superbee:push:${databaseName}`;
}

/**
 * Run `fn` only if the push role named `name` is free right now; never wait for it. A realm
 * that is told the role is held elsewhere leaves delivery to the holder and may try again
 * later. The role is released when `fn` settles, whether it resolved or rejected.
 */
export async function withPushRole<T>(name: string, fn: () => Promise<T>): Promise<PushRoleResult<T>> {
  const locks = webLocks();
  if (locks) {
    return locks.request<PushRoleResult<T>>(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return { held: false, reason: "held-elsewhere" };
      return { held: true, result: await fn() };
    });
  }
  if (heldInProcess.has(name)) return { held: false, reason: "held-elsewhere" };
  heldInProcess.add(name);
  try {
    return { held: true, result: await fn() };
  } finally {
    heldInProcess.delete(name);
  }
}
