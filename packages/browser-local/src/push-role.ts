/**
 * The one-writer-per-store coordination for the browser-local working copy: only the realm that
 * holds the store's push role may run {@link push}. IndexedDB permits main-thread access, so a
 * page may hold the role itself, and the intent journal's compare-and-swap already prevents two
 * realms from settling one intent twice. The role is what keeps two tabs from racing that
 * primitive at all: one tab delivers, the other reports the role held elsewhere and does not
 * touch the journal.
 *
 * The role is a Web Lock wherever the host exposes a `LockManager` (`navigator.locks`): every
 * current browser, and Node 22 and later, which implement the same API. A user agent releases
 * the lock when the holding page is closed, crashes, or navigates, so a terminated tab never
 * leaves the role stuck. A host without a `LockManager` falls back to an in-process table with
 * the same exclusive semantics within one process; it is also what a test selects explicitly
 * (`locks: null`) to exercise the fallback on a host that does have Web Locks. An OPFS working
 * copy would need a worker-owned writer instead, because OPFS synchronous access handles are not
 * available on the main thread; that design is outside this module.
 */

/** The outcome of one attempt to run work under the push role. */
export type PushRoleResult<T> = { held: true; result: T } | { held: false; reason: "held-elsewhere" };

interface LockRequestOptions {
  ifAvailable?: boolean;
}

/** The subset of the Web Locks `LockManager` the push role uses. */
export interface LockManagerLike {
  request<T>(name: string, options: LockRequestOptions, callback: (lock: { name: string } | null) => Promise<T>): Promise<T>;
}

export interface PushRoleOptions {
  /**
   * The lock manager that owns the role. Omitted: the host's `navigator.locks` when present,
   * otherwise the in-process fallback. `null`: the in-process fallback regardless of the host.
   * Any other value: that manager, which is how a test stands in for a permissive or absent
   * user agent.
   */
  locks?: LockManagerLike | null;
}

/** The host's `LockManager`, or `null` when this host has no Web Locks. */
export function hostLocks(): LockManagerLike | null {
  const navigatorLike = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  const locks = navigatorLike?.locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

/** The in-process fallback: names currently held in this process. */
const heldInProcess = new Set<string>();

/** The lock name for one working copy's push role, from the working copy's name. */
export function pushRoleName(name: string): string {
  return `superbee:push:${name}`;
}

/**
 * Run `fn` only if the push role named `name` is free right now; never wait for it. A realm
 * that is told the role is held elsewhere leaves delivery to the holder and may try again
 * later. The role is released when `fn` settles, whether it resolved or rejected.
 */
export async function withPushRole<T>(name: string, fn: () => Promise<T>, options: PushRoleOptions = {}): Promise<PushRoleResult<T>> {
  const locks = options.locks === undefined ? hostLocks() : options.locks;
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
