// Change detection for the loopback UI server's live-update surface (tasks/ui-pages-spike): take a
// SNAPSHOT of every doc's + page-blob's version token, and on each filesystem event (`--dir`) or
// poll tick (`--remote`) diff a fresh snapshot against the last to derive a minimal change delta,
// which `server.ts` broadcasts to the shell over SSE. Version tokens are content-addressed, so a
// changed token means changed bytes — no timestamps, no content compare.
//
// Native filesystem notifications accelerate updates; periodic reconciliation also catches changes
// when a successfully attached watcher silently misses a notification. Snapshots ride
// the same head projection `list` uses (`queryHeads`), with all storage reads owned by the engine.
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { classifyChangedPath, listBlobs, readBlob, queryHeads, toPosix, type Bundle } from "@superbee/core";
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

/** Snapshot a local bundle: doc heads via `queryHeads` (no bodies), page-blob versions via `listBlobs` over each accepted page prefix (`views/` + the legacy `pages/` location) + `readBlob` (pages are small; only the hot-reloadable prefixes are scanned). Routes through core's engine wrappers, so the pluggable storage seam is honored. */
export async function snapshotBundle(bundle: Bundle): Promise<Snapshot> {
  // A malformed document is absent from the snapshot (it has no head to watch) rather than failing
  // every poll; it reappears as a change once it parses again.
  const heads = await queryHeads(bundle, {}, { onSkip: () => {} });
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

/** Native notifications are injectable independently of the bundle's storage backend. */
export type WatchDirectory = (root: string, onChange: (filename?: string | null) => void) => Pick<FSWatcher, "on" | "close">;

export const watchDirectory: WatchDirectory = (root, onChange) =>
  fsWatch(root, { recursive: true }, (_event, filename) => onChange(filename));

/**
 * Longest a held hint waits once the scan before it settles. The rest scales with measured scan
 * cost, so without this bound one stalled scan would hold every later update for ten times the
 * stall. Periodic reconciliation keeps the uncapped rest.
 */
export const HELD_HINT_MAX_WAIT_MS = 20_000;

function hasEntriesBeneath(snapshot: Snapshot, relPath: string): boolean {
  const prefix = `${relPath}/`;
  for (const id of snapshot.docs.keys()) if (id.startsWith(prefix)) return true;
  for (const key of snapshot.blobs.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * Whether a native notification can change what {@link snapshotBundle} reads. The backend owns what
 * its walk sees; this adds only the snapshot's own blob scope. Anything it cannot rule out counts,
 * including a platform that names no path. A false positive costs one rested scan. A false negative
 * delays the change until periodic reconciliation, which remains the delivery guarantee.
 */
function hintCanChangeSnapshot(
  bundle: Bundle,
  filename: string | null | undefined,
  lastSnapshot: () => Snapshot,
): boolean | Promise<boolean> {
  if (filename === null || filename === undefined) return true;
  const relPath = toPosix(filename);
  const walkClass = classifyChangedPath(bundle, relPath);
  if (walkClass === "hidden") return false;
  if (walkClass !== "other" || PAGE_BLOB_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  // A plain file here is outside the snapshot. A directory is not, whatever its name: renaming or
  // removing one moves every document beneath it, and the platform may report only the directory.
  // A path already gone cannot say which it was, and a plain file may have just replaced a
  // directory the last snapshot read.
  return lstat(path.join(bundle.root, relPath)).then(
    (entry) => !entry.isFile() || hasEntriesBeneath(lastSnapshot(), relPath),
    () => true,
  );
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
  | (CommonWatcherOptions & { mode: "dir"; bundle: Bundle; debounceMs?: number; watch?: WatchDirectory })
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
 * page blob's version token moves. `--dir` uses `fs.watch` recursively (debounced) plus periodic
 * reconciliation, resting at least 2s or ten times the last scan's duration after each scan;
 * `--remote` polls on a fixed interval. Awaits
 * a baseline snapshot before resolving, so the first change is diffed against real state.
 *
 * A `--dir` hint the snapshot can see scans at once unless the last hint-answering scan is still
 * resting, so a lone edit stays prompt while a sustained stream scans once per rest, or once per
 * {@link HELD_HINT_MAX_WAIT_MS} when the rest is longer. A hint held by a rest or an active scan is
 * answered when that ends, never dropped. A hint may scan straight after a periodic scan, so one
 * scan per rest can follow another without a pause.
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
  let lastScanMs = 0;
  const timedSnapshot = async (signal: AbortSignal): Promise<Snapshot> => {
    const started = performance.now();
    try {
      return await takeSnapshot(opts, signal);
    } finally {
      lastScanMs = performance.now() - started;
    }
  };
  let last = await timedSnapshot(bootSignal);
  let stopped = false;
  let running = false;
  let rerun = false;
  let onSettled = (): void => {};

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
        const next = await timedSnapshot(aborter.signal);
        if (stopped) return;
        const change = diffSnapshots(last, next);
        last = next;
        if (!isEmptyChange(change)) opts.onChange(change);
      } while (rerun && !stopped);
    } catch (err) {
      if (!stopped) opts.onError?.(err);
    } finally {
      running = false;
      onSettled();
    }
  };

  if (opts.mode === "dir") {
    const debounceMs = opts.debounceMs ?? 150;
    const bundle = opts.bundle;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A relevant hint no started scan has covered yet.
    let hintPending = false;
    let scanAnswersHint = false;
    // Running from a hint-answering scan's settlement; later hints wait for it.
    let hintRest: ReturnType<typeof setTimeout> | undefined;
    const startScan = (): void => {
      if (hintRest) clearTimeout(hintRest);
      hintRest = undefined;
      scanAnswersHint = hintPending;
      hintPending = false;
      void emitDiff();
    };
    const armDebounce = (): void => {
      if (stopped) return;
      // An armed timer stays armed: restarting it would let a stream of close hints starve the scan.
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        hintPending = true;
        if (!running && !hintRest) startScan();
      }, debounceMs);
      timer.unref?.();
    };
    const trigger = (filename?: string | null): void => {
      if (stopped) return;
      const relevant = hintCanChangeSnapshot(bundle, filename, () => last);
      if (relevant === true) armDebounce();
      else if (relevant !== false) void relevant.then((answer) => { if (answer) armDebounce(); });
    };

    let watcher: ReturnType<WatchDirectory> | undefined;
    // A successful native watch is not a delivery guarantee. Keep the same serialized snapshot
    // path running even without hints, including after a transient scan error or attachment gap.
    let reconciliation: ReturnType<typeof setTimeout> | undefined;
    const restMs = (): number => Math.max(2000, 10 * lastScanMs);
    const scheduleReconciliation = (): void => {
      if (stopped) return;
      if (reconciliation) clearTimeout(reconciliation);
      reconciliation = setTimeout(() => {
        reconciliation = undefined;
        // Periodic ticks must not keep a large, unchanged bundle scanning without a pause.
        if (running) return; // the active scan rearms on settlement
        startScan();
      }, restMs());
      reconciliation.unref?.();
    };
    // Every scan, failed or not, pushes the next periodic scan a full rest away. Scaling with
    // measured cost keeps large bundles from spending most of their time taking snapshots. Only a
    // hint-answering scan makes later hints wait, and for at most the cap; a periodic scan does not,
    // or a lone edit would wait for up to a whole rest on a watcher that had seen no other change.
    // Each wait is a timer armed at settlement, so a stall or a machine sleep before that point
    // cannot use it up, and nothing compares timestamps taken on either side of one.
    onSettled = (): void => {
      if (stopped) return;
      if (scanAnswersHint) {
        hintRest = setTimeout(() => {
          hintRest = undefined;
          if (hintPending && !running) startScan();
        }, Math.min(restMs(), HELD_HINT_MAX_WAIT_MS));
        hintRest.unref?.();
      }
      scheduleReconciliation();
      if (hintPending && !hintRest) startScan();
    };
    scheduleReconciliation();
    try {
      watcher = (opts.watch ?? watchDirectory)(opts.bundle.root, trigger);
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // Periodic reconciliation remains active if native watching is unavailable.
    }

    return {
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (hintRest) clearTimeout(hintRest);
        watcher?.close();
        watcher = undefined;
        if (reconciliation) clearTimeout(reconciliation);
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
