/**
 * Page-side driver for the measurement harness (`measure.ts`). It builds a runtime of either
 * execution mode over a served authority exactly as the proof driver does, mounts the proof
 * presentation over it, and times each measured operation in the page with `performance.now()`
 * so the numbers exclude the Playwright round trip. Long tasks are counted with a
 * `PerformanceObserver` over `longtask` entries where the browser supports them. Every reply is
 * plain JSON. Request counts are not measured here: the Node side counts them at the served
 * fixture, where every request the page sent is observed.
 */

import type { QueryFilter } from "@superbee/core";
import type { ExecutionMode, PlatformRuntime } from "@superbee/core/platform";
import { RemoteBackend } from "@superbee/core/remote";
import { createRemoteOperationTransport } from "@superbee/core/remote-operations";
import type { OperationTransport } from "@superbee/core/uncertain-write";

import { bootstrap, openLocalBundle, pull, pushWithRole, type LocalBundle } from "../../src/local-bundle.ts";
import { createBrowserLocalRuntime, createRequestDrivenRuntime } from "../../src/platform/index.ts";
import { mountPresentation, type Presentation } from "./presentation.ts";

const REMOTE_BUNDLE = "default";
const ACTOR = "process:measure";
const FIRST_SCREEN = 20;
const immediate = { lookupDelayMs: 0 };

export interface MeasureError {
  error: { name: string; message: string };
}

function describeError(error: unknown): MeasureError {
  const err = error as { name?: unknown; message?: unknown };
  return {
    error: {
      name: typeof err?.name === "string" ? err.name : "Error",
      message: typeof err?.message === "string" ? err.message : String(error),
    },
  };
}

async function attempt<T>(work: () => Promise<T>): Promise<T | MeasureError> {
  try {
    return await work();
  } catch (error) {
    return describeError(error);
  }
}

interface Session {
  mode: ExecutionMode;
  runtime: PlatformRuntime;
  /** Set by `mount`, after `open`. */
  presentation: Presentation | null;
  remote: RemoteBackend;
  local: LocalBundle | null;
  transport: OperationTransport | null;
}

let session: Session | null = null;

function sessionOrThrow(): Session {
  if (!session) throw new Error("measure driver: call open(mode, remoteBaseUrl, name) first");
  return session;
}

function closeSession(): void {
  session?.presentation?.root.remove();
  session?.local?.close();
  session = null;
}

/** Count `longtask` entries from now until `stop`; `null` when the browser does not report them. */
function longTasks(): { stop(): Promise<number | null> } {
  let count = 0;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      count += list.getEntries().length;
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    observer = null;
  }
  return {
    async stop() {
      if (!observer) return null;
      // Entries are delivered in a later task; yield once so the last task's entry can arrive.
      await new Promise((resolve) => setTimeout(resolve, 0));
      count += observer.takeRecords().length;
      observer.disconnect();
      return count;
    },
  };
}

export interface StorageReply {
  usage: number | null;
  quota: number | null;
  /** Chromium's non-standard per-system breakdown, when present; `indexedDB` is the store's own bytes. */
  usageDetails: Record<string, number> | null;
}

export interface PageReply {
  /**
   * Whether the page is cross-origin isolated (COOP same-origin plus COEP require-corp). When
   * true, Chromium resolves `performance.now()` to 5 us; otherwise it is coarsened to 100 us,
   * which is the floor a fast IndexedDB read sits at.
   */
  crossOriginIsolated: boolean;
}

export interface OpenReply {
  mode: ExecutionMode;
  /** Wall time of the mode's cold open: bootstrap (browser-local) or capabilities plus list plus the first screen's reads (request-driven). */
  coldOpenMs: number;
  /** Documents the cold open covered: the whole bundle for a bootstrap, the list plus the first screen for request-driven. */
  documents: number;
  /** Long tasks during the cold open, or `null` when unsupported. */
  longTasksDuringColdOpen: number | null;
  /** Browser-local only: list plus the first screen's reads from the working copy after bootstrap. */
  firstScreenAfterBootstrapMs: number | null;
}

export interface MountReply {
  /** Mounting the presentation and its first refresh (query, selection, status) over the runtime. */
  presentationMountMs: number;
}

export interface SamplesReply {
  samplesMs: number[];
  longTasks: number | null;
}

export interface QueriesReply {
  samplesMs: number[];
  rows: number[];
}

export interface ReconcileReply {
  pushMs: number;
  pullMs: number;
  ms: number;
  delivered: number;
  refreshed: number;
}

export interface ClickReply {
  /** From the commit button's click to the selected document's badge being re-rendered. */
  ms: number;
  badge: string;
}

async function firstScreen(runtime: PlatformRuntime): Promise<number> {
  const rows = await runtime.query();
  for (const row of rows.slice(0, FIRST_SCREEN)) await runtime.read(row.id);
  return rows.length;
}

const driver = {
  storage: async (): Promise<StorageReply> => {
    const storage = navigator.storage;
    const estimate = storage && typeof storage.estimate === "function" ? await storage.estimate() : null;
    const details = (estimate as { usageDetails?: Record<string, number> } | null)?.usageDetails;
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, usageDetails: details ? { ...details } : null };
  },

  page: (): PageReply => ({ crossOriginIsolated: globalThis.crossOriginIsolated === true }),

  /**
   * Build a runtime of `mode` over the authority and time its cold open. The presentation is
   * mounted by the separate `mount` call, so the Node side can count the cold open's requests
   * apart from the mount's own query and reads.
   */
  open: (mode: ExecutionMode, remoteBaseUrl: string, name: string) =>
    attempt<OpenReply>(async () => {
      closeSession();
      const remote = new RemoteBackend({ baseUrl: remoteBaseUrl, bundle: REMOTE_BUNDLE, fetchImpl: (request) => fetch(request), maxRetries: 0 });
      let runtime: PlatformRuntime;
      let local: LocalBundle | null = null;
      let transport: OperationTransport | null = null;
      let coldOpenMs: number;
      let documents: number;
      let firstScreenAfterBootstrapMs: number | null = null;
      const tasks = longTasks();
      if (mode === "request-driven") {
        const started = performance.now();
        runtime = await createRequestDrivenRuntime({ remote, actor: ACTOR });
        documents = await firstScreen(runtime);
        coldOpenMs = performance.now() - started;
      } else {
        local = openLocalBundle(name);
        transport = createRemoteOperationTransport(remote);
        const started = performance.now();
        const marker = await bootstrap(remote, local);
        coldOpenMs = performance.now() - started;
        documents = marker.documentCount ?? 0;
        runtime = createBrowserLocalRuntime({ local, remote, transport, write: immediate, actor: ACTOR });
        const screenStarted = performance.now();
        await firstScreen(runtime);
        firstScreenAfterBootstrapMs = performance.now() - screenStarted;
      }
      const longTasksDuringColdOpen = await tasks.stop();
      session = { mode, runtime, presentation: null, remote, local, transport };
      return { mode, coldOpenMs, documents, longTasksDuringColdOpen, firstScreenAfterBootstrapMs };
    }),

  /** Mount the presentation over the open runtime and time its first refresh. */
  mount: () =>
    attempt<MountReply>(async () => {
      const current = sessionOrThrow();
      if (current.presentation) throw new Error("mount: the presentation is already mounted");
      const mountStarted = performance.now();
      const presentation = mountPresentation(document.body, current.runtime);
      await presentation.refresh();
      const presentationMountMs = performance.now() - mountStarted;
      current.presentation = presentation;
      return { presentationMountMs };
    }),

  reads: (ids: string[]) =>
    attempt<SamplesReply>(async () => {
      const { runtime } = sessionOrThrow();
      const tasks = longTasks();
      const samplesMs: number[] = [];
      for (const id of ids) {
        const started = performance.now();
        await runtime.read(id);
        samplesMs.push(performance.now() - started);
      }
      return { samplesMs, longTasks: await tasks.stop() };
    }),

  queries: (filters: QueryFilter[]) =>
    attempt<QueriesReply>(async () => {
      const { runtime } = sessionOrThrow();
      const samplesMs: number[] = [];
      const rows: number[] = [];
      for (const filter of filters) {
        const started = performance.now();
        const result = await runtime.query(filter);
        samplesMs.push(performance.now() - started);
        rows.push(result.length);
      }
      return { samplesMs, rows };
    }),

  /** Commits through the runtime verb, call to return; no premise, so each mode reads then writes. */
  commits: (edits: Array<{ id: string; body: string }>) =>
    attempt<SamplesReply>(async () => {
      const { runtime } = sessionOrThrow();
      const samplesMs: number[] = [];
      for (const edit of edits) {
        const started = performance.now();
        await runtime.commit(edit.id, { body: edit.body });
        samplesMs.push(performance.now() - started);
      }
      return { samplesMs, longTasks: null };
    }),

  /** Browser-local only: push every pending intent under the push role, then pull the authority's heads. */
  reconcile: () =>
    attempt<ReconcileReply>(async () => {
      const { local, remote, transport } = sessionOrThrow();
      if (!local || !transport) throw new Error("reconcile: not a browser-local session");
      const started = performance.now();
      const pushed = await pushWithRole(local, transport, { remote, write: immediate });
      const pushMs = performance.now() - started;
      const pullStarted = performance.now();
      const pulled = await pull(local, remote);
      const pullMs = performance.now() - pullStarted;
      const delivered = pushed.held ? pushed.result.settled.length : 0;
      return { pushMs, pullMs, ms: performance.now() - started, delivered, refreshed: pulled.refreshed.length };
    }),

  /** Select `id` in the presentation, type `body`, click Commit, and time the badge's re-render. */
  commitClick: (id: string, body: string) =>
    attempt<ClickReply>(async () => {
      const { presentation } = sessionOrThrow();
      if (!presentation) throw new Error("commitClick: call mount() first");
      await presentation.select(id);
      const root = presentation.root;
      const editor = root.querySelector<HTMLTextAreaElement>('[data-role="editor"]')!;
      const button = root.querySelector<HTMLButtonElement>('[data-role="commit"]')!;
      const badge = root.querySelector<HTMLElement>('[data-role="document"] [data-role="badge"]')!;
      editor.value = body;
      const rendered = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("commitClick: the badge was not re-rendered within 120 s"));
        }, 120_000);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          observer.disconnect();
          resolve(performance.now());
        });
        observer.observe(badge, { childList: true, characterData: true, subtree: true });
      });
      const started = performance.now();
      button.click();
      const finished = await rendered;
      return { ms: finished - started, badge: badge.textContent ?? "" };
    }),

  unmount: () => {
    closeSession();
    return { ok: true as const };
  },
};

export type MeasureDriver = typeof driver;

declare global {
  interface Window {
    superbeeMeasure: MeasureDriver;
  }
}

window.superbeeMeasure = driver;
