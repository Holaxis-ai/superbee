// `cursor.ts` — the per-bundle sync/awareness state store's CLI WIRING (board-git A0 seam
// prep; the neutral module moved into the package at A1).
//
// The neutral store implementation (the `createSyncStore` factory, the store interface, the
// cursor/cache/marker record types, key derivation and schema validation) lives in
// `@superbee/board-git`. THIS module is what stays behind: it wires the neutral factory to the
// CLI's own credentials discipline (`~/.agentstate/sync`, `writeFileAtomic0600`), exposes
// `defaultSyncStore` — THE production instance every consumer (sync, establish, autopull,
// session-start, home) uses — and re-exports the neutral types/factory so every existing import
// site keeps working unchanged.
import { homedir } from "node:os";
import { join } from "node:path";

import { credentialsDir, writeFileAtomic0600 } from "./credentials.js";
import {
  createSyncStore,
  bundleKey,
  REANCHOR_NOTE,
  SELF_ACTORS_CAP,
  type AwarenessCache,
  type AwarenessDeltaRow,
  type BoardPendingMarker,
  type BundleKeySource,
  type ReadOptions,
  type SyncCursor,
  type SyncState,
  type SyncStore,
  type SyncStoreOptions,
} from "@superbee/board-git";

export {
  createSyncStore,
  bundleKey,
  REANCHOR_NOTE,
  SELF_ACTORS_CAP,
  type AwarenessCache,
  type AwarenessDeltaRow,
  type BoardPendingMarker,
  type BundleKeySource,
  type ReadOptions,
  type SyncCursor,
  type SyncState,
  type SyncStore,
  type SyncStoreOptions,
};

/** The subdirectory of `~/.agentstate/` holding per-bundle sync state files. */
export const SYNC_STATE_DIR_NAME = "sync";

/** `~/.agentstate/sync` — the 0700 directory holding one state file per bundle key. */
export function syncStateDir(home: string = homedir()): string {
  return join(credentialsDir(home), SYNC_STATE_DIR_NAME);
}

/** A store over `home`'s `~/.agentstate/sync` with the credentials-grade atomic write. */
function storeForHome(home: string): SyncStore {
  return createSyncStore({ stateDir: () => syncStateDir(home), writeAtomic: writeFileAtomic0600 });
}

/** The absolute path of the state file for `key` (filename = truncated sha256 of the key). */
export function syncStatePath(key: string, home: string = homedir()): string {
  return storeForHome(home).statePath(key);
}

/**
 * `~/.agentstate/sync/exports/<key-digest>` — the per-bundle directory sync's CONVERGING conflict
 * mechanic exports the LOCAL version of each conflicted doc into ("yours saved at <path>").
 * Deliberately OUTSIDE any worktree (the board worktree must end every sync pristine) and under
 * the same per-clone key discipline as the cursor/cache/marker state — exports for two different
 * bundles (or two clones of ONE bundle: each clone's conflicted local version is its own "yours")
 * can never collide. Stable per doc (no per-run timestamp): a re-conflict on the same doc
 * overwrites the export with the NEWER local version, which is what "yours" means at that point,
 * and nothing accumulates unboundedly. This module only names the path; the git layer creates it.
 */
export function syncExportsDir(key: string, home: string = homedir()): string {
  return storeForHome(home).exportsDir(key);
}

/**
 * THE production instance every consumer (sync, establish, autopull, session-start, home) uses.
 * `stateDir` is a thunk so the home directory resolves PER OPERATION (the `HOME`-swapping test
 * pattern keeps working), exactly as the old per-call `home = homedir()` defaults did.
 */
export const defaultSyncStore: SyncStore = createSyncStore({
  stateDir: () => syncStateDir(),
  writeAtomic: writeFileAtomic0600,
});

// ── per-home projections (the historical free-function surface; same one implementation) ──

/** See {@link SyncStore.readSyncState}. */
export async function readSyncState(key: string, home: string = homedir()): Promise<SyncState> {
  return storeForHome(home).readSyncState(key);
}

/** See {@link SyncStore.readCursor}. */
export async function readCursor(key: string, home: string = homedir()): Promise<SyncCursor | null> {
  return storeForHome(home).readCursor(key);
}

/** See {@link SyncStore.readCache}. */
export async function readCache(
  key: string,
  opts?: ReadOptions,
  home: string = homedir(),
): Promise<AwarenessCache | null> {
  return storeForHome(home).readCache(key, opts);
}

/** See {@link SyncStore.readMarker}. */
export async function readMarker(
  key: string,
  opts?: ReadOptions,
  home: string = homedir(),
): Promise<BoardPendingMarker | null> {
  return storeForHome(home).readMarker(key, opts);
}

/** See {@link SyncStore.writeSyncState}. */
export async function writeSyncState(
  key: string,
  patch: Partial<SyncState>,
  home: string = homedir(),
): Promise<SyncState> {
  return storeForHome(home).writeSyncState(key, patch);
}

/** See {@link SyncStore.writeCursor}. */
export async function writeCursor(
  key: string,
  cursor: SyncCursor,
  home: string = homedir(),
): Promise<void> {
  return storeForHome(home).writeCursor(key, cursor);
}

/** See {@link SyncStore.writeCache}. */
export async function writeCache(
  key: string,
  cache: AwarenessCache,
  home: string = homedir(),
): Promise<void> {
  return storeForHome(home).writeCache(key, cache);
}

/** See {@link SyncStore.refreshMarker}. */
export async function refreshMarker(
  key: string,
  home: string = homedir(),
  now: () => Date = () => new Date(),
): Promise<BoardPendingMarker> {
  return storeForHome(home).refreshMarker(key, now);
}

/** See {@link SyncStore.readSelfActors}. */
export async function readSelfActors(key: string, home: string = homedir()): Promise<string[]> {
  return storeForHome(home).readSelfActors(key);
}

/** See {@link SyncStore.recordSelfActors}. */
export async function recordSelfActors(
  key: string,
  actors: string[],
  home: string = homedir(),
): Promise<string[]> {
  return storeForHome(home).recordSelfActors(key, actors);
}

/** See {@link SyncStore.recordReanchor}. */
export async function recordReanchor(
  key: string,
  cursor: SyncCursor,
  counts: { unpushedCount: number; uncommittedCount: number },
  home: string = homedir(),
  now: () => Date = () => new Date(),
): Promise<AwarenessCache> {
  return storeForHome(home).recordReanchor(key, cursor, counts, now);
}

/** See {@link SyncStore.readAutoPullAttemptAt}. */
export async function readAutoPullAttemptAt(key: string, home: string = homedir()): Promise<string | null> {
  return storeForHome(home).readAutoPullAttemptAt(key);
}

/** See {@link SyncStore.recordAutoPullAttempt}. */
export async function recordAutoPullAttempt(
  key: string,
  home: string = homedir(),
  now: () => Date = () => new Date(),
): Promise<void> {
  return storeForHome(home).recordAutoPullAttempt(key, now);
}

/** See {@link SyncStore.readHookHintedAt}. */
export async function readHookHintedAt(key: string, home: string = homedir()): Promise<string | null> {
  return storeForHome(home).readHookHintedAt(key);
}

/** See {@link SyncStore.recordHookHinted}. */
export async function recordHookHinted(
  key: string,
  home: string = homedir(),
  now: () => Date = () => new Date(),
): Promise<void> {
  return storeForHome(home).recordHookHinted(key, now);
}
