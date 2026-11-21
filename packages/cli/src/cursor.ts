import { AsyncLocalStorage } from "node:async_hooks";
import { accessSync, constants, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CliError } from "./errors.js";
import { BOARD_STATE_DIR_ENV, currentBoardStateLocation } from "./runtime-context.js";
import { assertBoardStatePlacement } from "./private-state-bundle-boundary.js";
import {
  canonicalUserStateDir,
  inspectUserStateRootSync,
  privateStateEntryIsSafe,
  readPrivateStateFile,
  readUserStateFile,
  writeFileAtomic0600,
  writeUserStateFileAtomic0600,
} from "./user-state.js";
import {
  createSyncStore,
  bundleKey,
  listSavedCopies,
  REANCHOR_NOTE,
  SELF_ACTORS_CAP,
  SYNC_EXPORTS_DIR_NAME,
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

/** The subdirectory of the private Superbee state root holding per-bundle sync state files. */
export const SYNC_STATE_DIR_NAME = "sync";

/** The directory holding one board state file per clone. */
export function syncStateDir(home?: string): string {
  const location = home === undefined ? currentBoardStateLocation() : undefined;
  if (location) {
    if ("dir" in location) return location.dir;
    assertBoardStatePlacement();
  }
  return join(canonicalUserStateDir(home), SYNC_STATE_DIR_NAME);
}

const optionalWrites = new AsyncLocalStorage<((error: unknown) => void) | undefined>();

/** Marker, cursor and awareness writes are bookkeeping. Conflict copies use separate storage. */
export function withOptionalBoardState<T>(body: () => T, warn: (error: unknown) => void): T {
  return optionalWrites.run(warn, body);
}

/** An optional user-facing hint still requires persistence to be issued only once. */
export function withStrictBoardState<T>(body: () => T): T {
  return optionalWrites.run(undefined, body);
}

function privateBoardDirectory(dir: string, create: boolean): void {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!privateStateEntryIsSafe(lstatSync(dir), "directory")) {
    throw new CliError("CONFLICT", `Expected a private Git board directory at ${dir}`, {
      details: { reason: "unsafe_board_state_directory", path: dir },
      help: `Set ${BOARD_STATE_DIR_ENV} to a private directory with owner-only access outside the Git checkout.`,
    });
  }
}

function boardStateError(dir: string, error: unknown, conflict?: "read" | "save"): CliError {
  const cause = error instanceof Error ? error.message : String(error);
  return new CliError("RUNTIME", `cannot ${conflict ? `${conflict} Git board conflict copies` : "write Git board bookkeeping"} at ${dir}: ${cause}`, {
    details: { reason: conflict ? "board_conflict_storage_unavailable" : "board_state_unavailable", path: dir },
    help: `Make the location writable and private or set ${BOARD_STATE_DIR_ENV} to a private, persistent directory outside the Git checkout, then rerun sync.`,
  });
}

function storeForHome(home?: string): SyncStore {
  const configured = () => home === undefined && currentBoardStateLocation() !== undefined;
  return createSyncStore({
    stateDir: () => syncStateDir(home),
    readText: (file) => {
      if (!configured()) return readUserStateFile(home ?? homedir(), file, 1024 * 1024);
      assertBoardStatePlacement();
      privateBoardDirectory(syncStateDir(home), false);
      return readPrivateStateFile(file, 1024 * 1024, undefined, undefined, true);
    },
    writeAtomic: async (dir, fileName, content) => {
      if (configured()) assertBoardStatePlacement();
      try {
        if (!configured()) {
          await writeUserStateFileAtomic0600(home ?? homedir(), dir, fileName, content);
        } else {
          privateBoardDirectory(dir, true);
          await writeFileAtomic0600(dir, fileName, content, {
            beforeCommit: () => {
              privateBoardDirectory(dir, false);
              return true;
            },
          });
        }
      } catch (error) {
        const failure = error instanceof CliError ? error : boardStateError(dir, error);
        const warn = home === undefined ? optionalWrites.getStore() : undefined;
        const errno = (error as NodeJS.ErrnoException | undefined)?.code;
        const unavailable = errno === "EPERM" || errno === "EACCES" || errno === "EROFS"
          || errno === "ENOSPC" || errno === "EDQUOT" || failure.details?.reason === "state_dir_not_writable";
        if (!warn || !unavailable) throw failure;
        warn(failure);
      }
    },
  });
}

/** The absolute path of the state file for `key` (filename = truncated sha256 of the key). */
export function syncStatePath(key: string, home?: string): string {
  return storeForHome(home).statePath(key);
}

/** The per-clone conflict copy location. */
export function syncExportsDir(key: string, home?: string): string {
  return storeForHome(home).exportsDir(key);
}

/** Parent of every per-clone conflict export directory. */
export function syncExportsRoot(home?: string): string {
  return join(syncStateDir(home), SYNC_EXPORTS_DIR_NAME);
}

/** Guard the export-only exception to the private-state content ingress boundary. */
export function privateBoardExportsRoot(home?: string): string | undefined {
  let root: string | undefined;
  try {
    root = syncExportsRoot(home);
    const location = home === undefined ? currentBoardStateLocation() : undefined;
    if (location) assertBoardStatePlacement();
    privateBoardDirectory(syncStateDir(home), false);
    privateBoardDirectory(root, false);
    return root;
  } catch (error) {
    // A missing export should follow the ordinary missing-file path, as on an empty install.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? root : undefined;
  }
}

function verifyBoardConflictStorage(checkout: string, create: boolean): void {
  assertBoardStatePlacement(checkout);
  const location = currentBoardStateLocation();
  privateBoardDirectory(syncStateDir(), create && location !== undefined);
  if (create && location === undefined && inspectUserStateRootSync() !== "ready") {
    throw new Error("the Superbee account state root is not recognized");
  }
  privateBoardDirectory(syncExportsRoot(), create);
}

/** Recovery bytes must be saved successfully before Git can discard local work. */
export function saveBoardConflictCopy<T>(dir: string, checkout: string, save: () => T): T {
  try {
    verifyBoardConflictStorage(checkout, true);
    privateBoardDirectory(dir, true);
    accessSync(dir, constants.W_OK);
    return save();
  } catch (error) {
    throw boardStateError(dir, error, "save");
  }
}

export function readBoardConflictCopies(dir: string, checkout: string, required = false): ReturnType<typeof listSavedCopies> {
  try {
    verifyBoardConflictStorage(checkout, false);
    return listSavedCopies(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    const failure = boardStateError(dir, error, "read");
    if (required) throw failure;
    optionalWrites.getStore()?.(failure);
    return [];
  }
}

export const defaultSyncStore = storeForHome();

// ── per-home projections (the historical free-function surface; same one implementation) ──

/** See {@link SyncStore.readSyncState}. */
export async function readSyncState(key: string, home?: string): Promise<SyncState> {
  return storeForHome(home).readSyncState(key);
}

/** See {@link SyncStore.readCursor}. */
export async function readCursor(key: string, home?: string): Promise<SyncCursor | null> {
  return storeForHome(home).readCursor(key);
}

/** See {@link SyncStore.readCache}. */
export async function readCache(
  key: string,
  opts?: ReadOptions,
  home?: string,
): Promise<AwarenessCache | null> {
  return storeForHome(home).readCache(key, opts);
}

/** See {@link SyncStore.readMarker}. */
export async function readMarker(
  key: string,
  opts?: ReadOptions,
  home?: string,
): Promise<BoardPendingMarker | null> {
  return storeForHome(home).readMarker(key, opts);
}

/** See {@link SyncStore.writeSyncState}. */
export async function writeSyncState(
  key: string,
  patch: Partial<SyncState>,
  home?: string,
): Promise<SyncState> {
  return storeForHome(home).writeSyncState(key, patch);
}

/** See {@link SyncStore.writeCursor}. */
export async function writeCursor(
  key: string,
  cursor: SyncCursor,
  home?: string,
): Promise<void> {
  return storeForHome(home).writeCursor(key, cursor);
}

/** See {@link SyncStore.writeCache}. */
export async function writeCache(
  key: string,
  cache: AwarenessCache,
  home?: string,
): Promise<void> {
  return storeForHome(home).writeCache(key, cache);
}

/** See {@link SyncStore.refreshMarker}. */
export async function refreshMarker(
  key: string,
  home?: string,
  now: () => Date = () => new Date(),
): Promise<BoardPendingMarker> {
  return storeForHome(home).refreshMarker(key, now);
}

/** See {@link SyncStore.readSelfActors}. */
export async function readSelfActors(key: string, home?: string): Promise<string[]> {
  return storeForHome(home).readSelfActors(key);
}

/** See {@link SyncStore.recordSelfActors}. */
export async function recordSelfActors(
  key: string,
  actors: string[],
  home?: string,
): Promise<string[]> {
  return storeForHome(home).recordSelfActors(key, actors);
}

/** See {@link SyncStore.recordReanchor}. */
export async function recordReanchor(
  key: string,
  cursor: SyncCursor,
  counts: { unpushedCount: number; uncommittedCount: number },
  home?: string,
  now: () => Date = () => new Date(),
): Promise<AwarenessCache> {
  return storeForHome(home).recordReanchor(key, cursor, counts, now);
}
