/**
 * The shell's single SSE connection to `/events` (tasks/ui-pages-spike, "Live updates"). ONLY the
 * shell holds this — pages have `connect-src 'none'` and cannot open an EventSource. The server's
 * version-token watcher pushes one `data:` frame per change; every subscriber (the launcher's page
 * list, each open PageFrame) gets the same {@link ChangeEvent}, then decides what to refetch or fan
 * into its iframe over the bridge.
 *
 * One lazily-opened, reference-counted EventSource shared across subscribers: opened on the first
 * subscribe, closed when the last unsubscribes.
 *
 * RESILIENCE (tasks/ui-pages-spike P1 — connection resilience): a dropped stream must never
 * permanently stale an open page. The server keeps no replay buffer, so any frame emitted during a
 * gap is GONE — reconnecting alone is not recovery. Three mechanisms close that:
 *   1. Reconnect always: the browser auto-retries a dropped-but-retryable stream itself
 *      (readyState CONNECTING); a FATALLY closed one (readyState CLOSED — e.g. the reconnect got a
 *      non-200 after a server restart) is re-created here on a timer.
 *   2. Resync on every reconnect: the first successful (re)open after ANY drop notifies the
 *      {@link subscribeToResync} listeners, whose contract is a FULL refresh (re-query/reload) —
 *      never "trust the stream caught you up".
 *   3. Probe the shell session after a drop: a stable-port restart can rotate the session secret,
 *      making every reconnect fail before another ordinary request wakes the interceptor. The
 *      existing config endpoint distinguishes that authenticated refusal from an offline host.
 */

import { setInterceptorStatus } from "../query/interceptor.js";

export interface ChangeEvent {
  docs: { changed: { id: string; version: string }[]; removed: string[] };
  blobs: { changed: { key: string; version: string }[]; removed: string[] };
}

type ChangeListener = (e: ChangeEvent) => void;
type ResyncListener = () => void;

/** The slice of `EventSource` the stream needs — injectable so the reconnect state machine is unit-testable without a real network (jsdom ships no EventSource). */
export interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close(): void;
}

/** How long after a FATAL close (readyState CLOSED — the browser will not retry) before re-creating the stream. */
const RECONNECT_DELAY_MS = 3_000;

/** `EventSource.CLOSED` — inlined so {@link EventSourceLike} fakes need no static constants. */
const READY_STATE_CLOSED = 2;

export interface ChangeStream {
  /** Subscribe to change deltas. Returns an unsubscribe that closes the shared stream once no one is listening. */
  subscribeToChanges(listener: ChangeListener): () => void;
  /** Subscribe to reconnect notifications: fired on the first successful (re)open after a drop — the listener owes a FULL refresh of whatever it derives from the stream. */
  subscribeToResync(listener: ResyncListener): () => void;
}

/** The real EventSource IS an EventSourceLike at runtime (our handlers take no/fewer args and `MessageEvent` carries `.data`); the cast only bridges the DOM lib's `this`/event-typed handler slots to the minimal seam. */
const domEventSource = (url: string): EventSourceLike => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

async function probeShellSession(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/__ui/config", { credentials: "same-origin", signal });
  return response.status === 403;
}

export function createChangeStream(
  newEventSource: (url: string) => EventSourceLike = domEventSource,
  probeSession: (signal: AbortSignal) => Promise<boolean> = probeShellSession,
): ChangeStream {
  const changeListeners = new Set<ChangeListener>();
  const resyncListeners = new Set<ResyncListener>();
  let source: EventSourceLike | null = null;
  let dropped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let probeController: AbortController | null = null;
  let recoveryGeneration = 0;

  const anySubscriber = (): boolean => changeListeners.size + resyncListeners.size > 0;

  function advanceRecoveryGeneration(): void {
    recoveryGeneration += 1;
    probeController?.abort();
    probeController = null;
  }

  function probeCurrentSession(): void {
    if (probeController) return;
    const controller = new AbortController();
    probeController = controller;
    const generation = recoveryGeneration;
    // Offline/unreachable remains a reconnect condition. Only the session-gated endpoint's
    // explicit 403 trips the terminal recovery UI. A successful stream reopen or teardown makes
    // an older response stale: another tab may have installed a fresh session cookie while the
    // old request was in flight, so never let that delayed 403 poison the recovered session.
    void probeSession(controller.signal)
      .then((expired) => {
        if (!controller.signal.aborted && expired && generation === recoveryGeneration && dropped && anySubscriber()) {
          setInterceptorStatus("session_expired");
        }
      })
      .catch(() => {})
      .finally(() => {
        if (probeController === controller) probeController = null;
      });
  }

  function connect(): void {
    if (source) return;
    const es = newEventSource("/events");
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      advanceRecoveryGeneration();
      if (!dropped) return; // first-ever open: subscribers are loading fresh anyway
      dropped = false;
      for (const l of resyncListeners) l();
    };
    es.onmessage = (ev) => {
      if (source !== es) return;
      let parsed: ChangeEvent;
      try {
        parsed = JSON.parse(ev.data) as ChangeEvent;
      } catch {
        return;
      }
      for (const l of changeListeners) l(parsed);
    };
    es.onerror = () => {
      if (source !== es) return;
      dropped = true;
      probeCurrentSession();
      // CONNECTING: the browser is auto-retrying this same EventSource — onopen will fire on
      // success and trigger the resync. CLOSED: the browser gave up (fatal response); re-create.
      if (es.readyState === READY_STATE_CLOSED) {
        es.close();
        if (source === es) source = null;
        scheduleReconnect();
      }
    };
  }

  function scheduleReconnect(): void {
    if (retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (anySubscriber()) connect();
    }, RECONNECT_DELAY_MS);
  }

  function teardownIfIdle(): void {
    if (anySubscriber()) return;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    source?.close();
    source = null;
    dropped = false;
    advanceRecoveryGeneration();
  }

  return {
    subscribeToChanges(listener: ChangeListener): () => void {
      changeListeners.add(listener);
      connect();
      return () => {
        changeListeners.delete(listener);
        teardownIfIdle();
      };
    },
    subscribeToResync(listener: ResyncListener): () => void {
      resyncListeners.add(listener);
      connect();
      return () => {
        resyncListeners.delete(listener);
        teardownIfIdle();
      };
    },
  };
}

const defaultStream = createChangeStream();

/** Subscribe to change events on the app's shared stream. */
export const subscribeToChanges: ChangeStream["subscribeToChanges"] = (listener) => defaultStream.subscribeToChanges(listener);

/** Subscribe to reconnect (full-refresh) notifications on the app's shared stream. */
export const subscribeToResync: ChangeStream["subscribeToResync"] = (listener) => defaultStream.subscribeToResync(listener);
