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

/** The single-bundle reference router's bundle segment (mirrors the SPA client's `BUNDLE`). */
const REMOTE_BUNDLE = "default";

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

/** Snapshot a local bundle: doc heads via `queryHeads` (no bodies), page-blob versions via `listBlobs` over each accepted page prefix (`views/` + the legacy `pages/` location) + `readBlob` (pages are small; only the hot-reloadable prefixes are scanned). Routes through core's engine wrappers, so a pluggable backend is honored (gate 3). */
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

/**
 * Snapshot a remote over the wire: doc heads via the `GET /docs?fields=frontmatter` projection,
 * paginated to exhaustion. Remote page-blob hot-reload is a LABELED follow-up (v0 ships live DOC
 * updates over `--remote`; blob-change hot-reload stays local-mode only), so `blobs` is empty here.
 * `signal` cancels an in-flight request — the watcher aborts it on `stop()` instead of leaving a
 * dangling fetch past shutdown.
 */
export async function snapshotRemote(base: string, apiKey?: string, signal?: AbortSignal): Promise<Snapshot> {
  const docs = new Map<string, string>();
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let cursor: string | undefined;
  do {
    const url = new URL(`${base}/v0/bundles/${REMOTE_BUNDLE}/docs`);
    url.searchParams.set("fields", "frontmatter");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw new Error(`remote snapshot failed with status ${res.status}`);
    const body = (await res.json()) as { docs: { id: string; version: string }[]; next_cursor: string | null };
    for (const d of body.docs) docs.set(d.id, d.version);
    cursor = body.next_cursor ?? undefined;
  } while (cursor);
  return { docs, blobs: new Map() };
}

export interface WatcherHandle {
  stop: () => Promise<void>;
}

interface CommonWatcherOptions {
  onChange: (e: ChangeEvent) => void;
  onError?: (err: unknown) => void;
}

/**
 * Bound on `--remote` mode's boot-time INITIAL snapshot fetch: `startWatcher` is awaited directly by
 * `bootUiServer`, and a dead/unreachable upstream left this fetch on undici's default (~300s) timeout
 * — a hung remote hung the entire `ui` boot. Exported so a test can assert on the exact bound rather
 * than a magic number duplicated at the call site; `bootTimeoutMs` on `WatcherOptions` overrides it
 * (a test seam — production callers get this default).
 */
export const DEFAULT_REMOTE_BOOT_TIMEOUT_MS = 5_000;

export type WatcherOptions =
  | (CommonWatcherOptions & { mode: "dir"; bundle: Bundle; debounceMs?: number })
  | (CommonWatcherOptions & {
      mode: "remote";
      remoteBase: string;
      apiKey?: string;
      pollMs?: number;
      /** Override {@link DEFAULT_REMOTE_BOOT_TIMEOUT_MS} for the boot-time initial snapshot only — never the ongoing poll. */
      bootTimeoutMs?: number;
    });

async function takeSnapshot(opts: WatcherOptions, signal?: AbortSignal): Promise<Snapshot> {
  return opts.mode === "dir" ? snapshotBundle(opts.bundle) : snapshotRemote(opts.remoteBase, opts.apiKey, signal);
}

/**
 * Start watching for changes, emitting a {@link ChangeEvent} to `opts.onChange` whenever a doc or
 * page blob's version token moves. `--dir` uses `fs.watch` recursively (debounced) with a 2s poll
 * fallback if the platform rejects a recursive watch; `--remote` polls on a fixed interval. Awaits
 * a baseline snapshot before resolving, so the first change is diffed against real state.
 *
 * Snapshot runs are SERIALIZED (tasks/ui-pages-spike P1 — remote concurrency): two overlapping
 * runs could complete out of order — the LATER-started (fresher) one lands first, then the
 * earlier (staler) one both emits a regression delta AND poisons `last` with the older state, so
 * the next tick re-emits the same change (the observed C -> B -> C). A tick that fires while a
 * run is in flight marks a rerun instead of overlapping; `stop()` aborts any in-flight remote
 * request and suppresses every later emission.
 */
export async function startWatcher(opts: WatcherOptions): Promise<WatcherHandle> {
  const aborter = new AbortController();
  // Only the BOOT-time initial snapshot is time-boxed — `--dir` mode never leaves the process
  // (no bound needed), and `--remote` mode's ONGOING polls already recover on their own schedule
  // (a stuck poll just means the next tick tries again); it is specifically the unbounded FIRST
  // fetch, awaited synchronously by `bootUiServer`, that could hang boot forever. On timeout,
  // `takeSnapshot` throws and `startWatcher`'s own promise rejects — the caller (`bootWatcher` in
  // server.ts) already treats any boot-time throw as a best-effort watcher failure: log to stderr,
  // resolve the UI boot WITHOUT a watcher rather than hang it.
  const bootSignal =
    opts.mode === "remote" ? AbortSignal.timeout(opts.bootTimeoutMs ?? DEFAULT_REMOTE_BOOT_TIMEOUT_MS) : aborter.signal;
  let last = await takeSnapshot(opts, bootSignal);
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
        const next = await takeSnapshot(opts, aborter.signal);
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

  if (opts.mode === "dir") {
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
        aborter.abort();
      },
    };
  }

  const pollMs = opts.pollMs ?? 3000;
  const timer = setInterval(() => void emitDiff(), pollMs);
  timer.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      aborter.abort(); // cancel any in-flight snapshot request — nothing dangles past shutdown
    },
  };
}
