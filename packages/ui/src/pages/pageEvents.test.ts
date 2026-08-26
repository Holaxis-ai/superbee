/**
 * Reconnect/resync state machine of the shared SSE stream (tasks/ui-pages-spike P1 — connection
 * resilience), driven through a fake EventSource: a drop followed by a successful open MUST notify
 * the resync listeners exactly once (full-refresh contract), and a FATAL close (readyState CLOSED,
 * where the browser gives up) MUST re-create the stream on the retry timer. The real-network
 * behavior is proven end-to-end in `e2e/pages.spec.ts` (offline -> change -> online recovery).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChangeStream, type ChangeEvent, type EventSourceLike } from "./pageEvents.js";
import { __resetInterceptorForTests, getInterceptorStatus } from "../query/interceptor.js";

class FakeEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0; // CONNECTING
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** A retryable drop: the browser flips back to CONNECTING and keeps trying on its own. */
  dropRetryable(): void {
    this.readyState = 0;
    this.onerror?.();
  }
  /** A fatal close: the browser gives up (e.g. the reconnect got a non-200). */
  dropFatal(): void {
    this.readyState = 2;
    this.onerror?.();
  }
  emit(event: ChangeEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const CHANGE: ChangeEvent = { docs: { changed: [{ id: "a", version: "v2" }], removed: [] }, blobs: { changed: [], removed: [] } };

describe("createChangeStream", () => {
  let sources: FakeEventSource[];
  const stream = () =>
    createChangeStream((url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    });

  beforeEach(() => {
    sources = [];
    vi.useFakeTimers();
    __resetInterceptorForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fans change frames to subscribers; the first open fires NO resync", () => {
    const s = stream();
    const changes: ChangeEvent[] = [];
    const resyncs: number[] = [];
    s.subscribeToChanges((e) => changes.push(e));
    s.subscribeToResync(() => resyncs.push(1));

    expect(sources).toHaveLength(1);
    sources[0]!.open();
    sources[0]!.emit(CHANGE);

    expect(changes).toEqual([CHANGE]);
    expect(resyncs).toHaveLength(0);
  });

  it("a retryable drop followed by the browser's own reconnect fires resync exactly once", () => {
    const s = stream();
    const resyncs: number[] = [];
    s.subscribeToResync(() => resyncs.push(1));

    sources[0]!.open();
    sources[0]!.dropRetryable();
    sources[0]!.dropRetryable(); // repeated errors while the browser keeps retrying
    expect(resyncs).toHaveLength(0);

    sources[0]!.open(); // the browser's auto-retry succeeded — SAME EventSource
    expect(resyncs).toHaveLength(1);
    expect(sources).toHaveLength(1);

    sources[0]!.emit(CHANGE); // the stream still works after recovery
  });

  it("a FATAL close re-creates the EventSource on the retry timer, then resyncs on its open", () => {
    const s = stream();
    const resyncs: number[] = [];
    s.subscribeToResync(() => resyncs.push(1));

    sources[0]!.open();
    sources[0]!.dropFatal();
    expect(sources[0]!.closed).toBe(true);
    expect(sources).toHaveLength(1); // not yet — waits out the delay

    vi.advanceTimersByTime(3_000);
    expect(sources).toHaveLength(2); // a fresh EventSource replaced the dead one

    sources[1]!.open();
    expect(resyncs).toHaveLength(1);

    const changes: ChangeEvent[] = [];
    s.subscribeToChanges((e) => changes.push(e));
    sources[1]!.emit(CHANGE);
    expect(changes).toEqual([CHANGE]);
  });

  it("every drop probes the shell session without overlapping probes", async () => {
    let finishProbe!: () => void;
    const probeSession = vi.fn(async () => false);
    probeSession.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishProbe = () => resolve(false); }));
    const s = createChangeStream((url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    }, probeSession);
    s.subscribeToResync(() => {});

    sources[0]!.open();
    sources[0]!.dropRetryable();
    expect(probeSession).toHaveBeenCalledTimes(1);

    sources[0]!.dropRetryable();
    sources[0]!.dropFatal();
    expect(probeSession).toHaveBeenCalledTimes(1);

    finishProbe();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(3_000);
    expect(sources).toHaveLength(2);
    sources[1]!.dropFatal();
    expect(probeSession).toHaveBeenCalledTimes(2);
  });

  it("a failed session probe never suppresses the reconnect timer", async () => {
    const probeSession = vi.fn(async () => { throw new Error("server is offline"); });
    const s = createChangeStream((url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    }, probeSession);
    s.subscribeToResync(() => {});

    sources[0]!.open();
    sources[0]!.dropFatal();
    await Promise.resolve();
    vi.advanceTimersByTime(3_000);
    expect(sources).toHaveLength(2);
  });

  it("ignores a stale 403 after the stream has recovered under a current session", async () => {
    let finishProbe!: (expired: boolean) => void;
    const probeSession = vi.fn(() => new Promise<boolean>((resolve) => { finishProbe = resolve; }));
    const s = createChangeStream((url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    }, probeSession);
    s.subscribeToResync(() => {});

    sources[0]!.open();
    sources[0]!.dropRetryable();
    expect(probeSession).toHaveBeenCalledTimes(1);

    // A different tab/current printed URL can install the new cookie while the old probe waits.
    // Once this stream reopens, that old-cookie response is no longer authoritative.
    sources[0]!.open();
    finishProbe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(getInterceptorStatus()).toBe("ok");
  });

  it("surfaces a current 403 while the dropped stream is still unrecovered", async () => {
    const s = createChangeStream((url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    }, async () => true);
    s.subscribeToResync(() => {});

    sources[0]!.open();
    sources[0]!.dropRetryable();
    await Promise.resolve();
    await Promise.resolve();

    expect(getInterceptorStatus()).toBe("session_expired");
  });

  it("unsubscribing the last listener closes the stream and cancels a pending retry", () => {
    const s = stream();
    const unsub = s.subscribeToResync(() => {});
    sources[0]!.open();
    sources[0]!.dropFatal(); // schedules a retry

    unsub();
    vi.advanceTimersByTime(10_000);
    expect(sources).toHaveLength(1); // the pending retry was canceled, nothing re-created
    expect(sources[0]!.closed).toBe(true);
  });
});
