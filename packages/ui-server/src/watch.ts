// Change detection for the loopback UI server's live-update surface (tasks/ui-pages-spike): take a
// SNAPSHOT of every doc's + page-blob's version token, and on each filesystem event (`--dir`) or
// poll tick (`--remote`) diff a fresh snapshot against the last to derive a minimal change delta,
// which `server.ts` broadcasts to the shell over SSE. Version tokens are content-addressed, so a
// changed token means changed bytes — no timestamps, no content compare.
//
// The pure {@link diffSnapshots} is the unit-tested core; the watcher driver around it is a thin
// fs.watch (recursive, verified on this macOS node) / poll loop with a debounce. Snapshots ride
// the SAME head projection `list` uses (`queryHeads` — no bodies), so a scan is cheap.
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { listBlobs, readBlob, queryHeads, type Bundle } from "@superbee/core";
import { PAGE_BLOB_PREFIXES } from "./pages.js";

/** A point-in-time map of every doc id -> version and every page-blob key -> version. */
export interface Snapshot {
  docs: Map<string, string>;
  blobs: Map<string, string>;
}

/** The delta between two snapshots: what changed/appeared, and what was removed, on each side. */
export interface ChangeEvent {
  docs: { changed: { id: string; version: string }[]; removed: string[] };
  blobs: { changed: { key: string; version: string }[]; removed: string[] };
}

/** Diff two snapshots into a {@link ChangeEvent}. A key present in `next` with a different (or new) version is `changed`; a key only in `prev` is `removed`. Pure — the unit-tested core of the watcher. */
export function diffSnapshots(prev: Snapshot, next: Snapshot): ChangeEvent {
  const docsChanged: { id: string; version: string }[] = [];
  for (const [id, version] of next.docs) {
    if (prev.docs.get(id) !== version) docsChanged.push({ id, version });
  }
  const docsRemoved: string[] = [];
  for (const id of prev.docs.keys()) {
    if (!next.docs.has(id)) docsRemoved.push(id);
  }
  const blobsChanged: { key: string; version: string }[] = [];
  for (const [key, version] of next.blobs) {
    if (prev.blobs.get(key) !== version) blobsChanged.push({ key, version });
  }
  const blobsRemoved: string[] = [];
  for (const key of prev.blobs.keys()) {
    if (!next.blobs.has(key)) blobsRemoved.push(key);
  }
  return {
    docs: { changed: docsChanged, removed: docsRemoved },
    blobs: { changed: blobsChanged, removed: blobsRemoved },
  };
}

/** True when a diff carries nothing on either side — the watcher suppresses these (no empty SSE frames). */
export function isEmptyChange(e: ChangeEvent): boolean {
  return (
    e.docs.changed.length === 0 && e.docs.removed.length === 0 && e.blobs.changed.length === 0 && e.blobs.removed.length === 0
  );
}

/** Snapshot a local bundle: doc heads via `queryHeads` (no bodies), page-blob versions via `listBlobs` over each accepted page prefix (`views/` + the legacy `pages/` location) + `readBlob` (pages are small; only the hot-reloadable prefixes are scanned). Routes through core's engine wrappers, so the pluggable storage seam is honored. */
export async function snapshotBundle(bundle: Bundle): Promise<Snapshot> {
  const heads = await queryHeads(bundle, {});
  const docs = new Map<string, string>(heads.map((h) => [h.id, h.version]));
  const blobs = new Map<string, string>();
  const keys: string[] = [];
  for (const prefix of PAGE_BLOB_PREFIXES) {
    try {
      keys.push(...(await listBlobs(bundle, prefix)));
    } catch {
      // an unreadable prefix contributes nothing to this snapshot
    }
  }
  for (const key of keys) {
    try {
      const r = await readBlob(bundle, key);
      if (r) blobs.set(key, r.version);
    } catch {
      // a blob that vanished mid-scan is simply absent from this snapshot
    }
  }
  return { docs, blobs };
}

export interface WatcherHandle {
  stop: () => Promise<void>;
}

interface CommonWatcherOptions {
  onChange: (e: ChangeEvent) => void;
  onError?: (err: unknown) => void;
}

export type WatcherOptions = CommonWatcherOptions & { mode: "dir"; bundle: Bundle; debounceMs?: number };

async function takeSnapshot(opts: WatcherOptions): Promise<Snapshot> {
  return snapshotBundle(opts.bundle);
}

/**
 * Start watching for changes, emitting a {@link ChangeEvent} to `opts.onChange` whenever a doc or
 * page blob's version token moves. This entry point is deliberately local-only: it uses `fs.watch`
 * recursively (debounced) with a 2s poll fallback if the platform rejects a recursive watch. It
 * awaits a baseline snapshot before resolving, so the first change is diffed against real state.
 *
 * Snapshot runs are serialized. A filesystem event received while a run is active schedules one
 * catch-up run instead of overlapping it, and `stop()` suppresses every later emission.
 */
export async function startWatcher(opts: WatcherOptions): Promise<WatcherHandle> {
  if ((opts as { mode: string }).mode !== "dir") {
    throw new Error("remote bundle watching is not supported; remote targets are read on demand");
  }
  let last = await takeSnapshot(opts);
  let stopped = false;
  let running = false;
  let rerun = false;

  const emitDiff = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      rerun = true; // never overlap — the active run re-runs once it finishes
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        const next = await takeSnapshot(opts);
        if (stopped) return;
        const change = diffSnapshots(last, next);
        last = next;
        if (!isEmptyChange(change)) opts.onChange(change);
      } while (rerun && !stopped);
    } catch (err) {
      if (!stopped) opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  const debounceMs = opts.debounceMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void emitDiff();
    }, debounceMs);
    timer.unref?.();
  };

  let watcher: FSWatcher | undefined;
  let pollFallback: ReturnType<typeof setInterval> | undefined;
  const startPollFallback = (): void => {
    if (pollFallback) return;
    pollFallback = setInterval(() => void emitDiff(), 2000);
    pollFallback.unref?.();
  };
  try {
    watcher = fsWatch(opts.bundle.root, { recursive: true }, () => trigger());
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      startPollFallback();
    });
  } catch {
    startPollFallback();
  }

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      if (pollFallback) clearInterval(pollFallback);
    },
  };
}
