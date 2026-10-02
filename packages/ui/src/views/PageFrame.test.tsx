/**
 * PageFrame launch-revocation race tests. A reload must revoke the old launch synchronously, and
 * an asynchronous server-bridge reply must remain fenced to the iframe generation that requested
 * it. These component tests control both gaps with real iframe/postMessage boundaries. The iframe
 * the shell owns is the View host; tests play the host's side of the envelope protocol.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageFrame } from "./PageFrame.js";
import { VIEW_DELIVERY_RETRY_MS, VIEW_LOAD_DEADLINE_MS } from "./viewReadiness.js";
import { getDoc, listAllHeads } from "../api/client.js";
import { authorizeViewLaunch, cancelTrustedAction, commitTrustedAction, fetchViewBytes, mintPageNonce, prepareTrustedAction, resolvePageTarget, verifyViewDelivery, ViewBytesMismatchError } from "../api/pages.js";
import { VIEW_HOST_PATH, VIEW_HOST_PROTOCOL } from "@superbee/view-runtime/view-host";
import { subscribeToChanges } from "../pages/pageEvents.js";
import { __resetInterceptorForTests } from "../query/interceptor.js";

// No @testing-library/react in this workspace (see package.json) — a bare react-dom/client
// render still needs this flag set for `act` to batch/flush synchronously instead of warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client.js")>();
  return { ...actual, getDoc: vi.fn(), listAllHeads: vi.fn() };
});

vi.mock("../api/pages.js", () => ({
  mintPageNonce: vi.fn(async (registryId: string) => {
    const loaded = await getDoc(registryId);
    const fm = loaded.doc.frontmatter;
    if (fm.type !== "View" || typeof fm.entry !== "string") {
      throw new Error(`page '${registryId}' is not a usable registered Page`);
    }
    const capability =
      fm.access === "bundle-read" || fm.access === "bundle-propose" ? fm.access : "none";
    return {
      url: `/__page/nonce-${registryId}`,
      launchId: `launch-${registryId}`,
      title: typeof fm.title === "string" ? fm.title : registryId,
      entry: fm.entry,
      capability,
      authorization: { required: capability !== "none", authorized: true, contentVersion: "bv1" },
    };
  }),
  fetchViewBytes: vi.fn(async () => ({
    bytes: new TextEncoder().encode("<!doctype html><p>view</p>").buffer,
    contentType: "text/html; charset=utf-8",
  })),
  ViewBytesMismatchError: class ViewBytesMismatchError extends Error {},
  authorizeViewLaunch: vi.fn(async () => ({ required: true, authorized: true })),
  verifyViewLaunch: vi.fn(async () => ({ required: true, authorized: true })),
  verifyViewDelivery: vi.fn(async () => ({ delivered: true })),
  sendViewBridge: vi.fn(async (_launchId: string, request: Record<string, unknown>) => {
    if (request.type === "open-page") {
      return (await resolvePageTarget(request.pageId as string))
        ? { reply: null, openPageId: request.pageId as string }
        : { reply: { bridge: "v0", type: "error" } };
    }
    if (request.type === "query") {
      const rows = await listAllHeads(request.params as Record<string, unknown>);
      return {
        reply: {
          bridge: "v0",
          id: request.id,
          type: "query:result",
          result: { rows, count: rows.length },
        },
      };
    }
    return { reply: null };
  }),
  prepareTrustedAction: vi.fn(),
  commitTrustedAction: vi.fn(),
  cancelTrustedAction: vi.fn(async () => ({ status: "cancelled", action: "document.set-field" })),
  fetchConfig: vi.fn(async () => ({ root: "/tmp/b", name: "b", mode: "dir" })),
  fetchKinds: vi.fn(async () => []),
  fetchEdges: vi.fn(async () => []),
  invalidateKinds: vi.fn(),
  resolvePageTarget: vi.fn(async () => true),
}));

// `subscribeToChanges`/`subscribeToResync` open a real EventSource on first subscribe (jsdom ships
// none) — stub them so PageFrame's live-update effects mount cleanly, and so the test can invoke
// the captured listener directly to simulate an SSE frame without a real stream.
vi.mock("../pages/pageEvents.js", () => ({
  subscribeToChanges: vi.fn(() => () => {}),
  subscribeToResync: vi.fn(() => () => {}),
}));

function pageDoc(overrides: Record<string, unknown> = {}) {
  return {
    doc: { id: "pages-registry/p", frontmatter: { type: "View", title: "P", entry: "pages/p.html", access: "bundle-read", ...overrides }, body: "" },
    version: "v1",
  };
}

/** An externally-resolvable promise, for controlling exactly when an async dep settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Flush pending microtask chains (our mocks resolve via plain Promises, not real timers). */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

/** Drain the mint -> byte fetch -> mount chain under fake timers. */
async function microtasks(turns = 8) {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

/** A View message as its host relays it to the shell. */
function viewMessage(message: unknown) {
  return { protocol: VIEW_HOST_PROTOCOL, type: "view-message", message };
}

function sendFromHost(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { origin: "null", source: iframe.contentWindow, data }));
}

/** Play the host: ask for this generation's bytes, then report that the child frame loaded them. */
async function completeHostLoad(iframe: HTMLIFrameElement) {
  const spy = vi.spyOn(iframe.contentWindow!, "postMessage");
  act(() => sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "ready" }));
  const load = spy.mock.calls
    .map(([message]) => message as { type?: string; deliveryId?: string })
    .find((message) => message.type === "load");
  spy.mockRestore();
  expect(load?.deliveryId).toEqual(expect.any(String));
  await act(async () => {
    sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "loaded", deliveryId: load!.deliveryId });
    await Promise.resolve();
  });
}

describe("PageFrame: bridge revocation race (P1)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootMounted: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetInterceptorForTests();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (rootMounted) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
  });

  it("keeps the single delivery retry inside the load deadline", () => {
    expect(VIEW_DELIVERY_RETRY_MS).toBeGreaterThan(0);
    expect(VIEW_DELIVERY_RETRY_MS).toBeLessThan(VIEW_LOAD_DEADLINE_MS);
  });

  it("keeps a data-bearing View open once its exact frame posts a readiness message", async () => {
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });

    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null",
      source: iframe.contentWindow,
      data: viewMessage({ bridge: "v0", id: "hello-1", type: "hello" }),
    })));
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
    expect(container.textContent).not.toContain("could not confirm that this View finished loading");
  });

  it("skips delivery probing when message readiness arrives before the frame load event", async () => {
    vi.useFakeTimers();
    // A negative receipt makes any probe that DOES run visibly harmful. It is a persistent value
    // restored in `finally`, deliberately not a one-shot: this row never consumes it (that is the
    // point), and an unconsumed one-shot outlives clearAllMocks and would be served to the next
    // row's probe ahead of that row's own receipt.
    vi.mocked(verifyViewDelivery).mockResolvedValue({ delivered: false });
    try {
      vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
      await act(async () => {
        root.render(<PageFrame pageId="pages-registry/p" />);
        await microtasks();
      });

      const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
      expect(iframe).toBeTruthy();
      act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null",
        source: iframe.contentWindow,
        data: viewMessage({ bridge: "v0", id: "hello-before-load", type: "hello" }),
      })));
      await completeHostLoad(iframe);
      act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

      expect(verifyViewDelivery).not.toHaveBeenCalled();
      expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
    } finally {
      vi.mocked(verifyViewDelivery).mockResolvedValue({ delivered: true }); // the factory default
    }
  });

  it("readiness proven by generation N never suppresses the probe for a quiet, hot-reloaded generation N+1", async () => {
    // The guard is generation-fenced, not a one-time latch: a generation-blind guard
    // (frameReadySeqRef !== null) would pass the row above and fail this one.
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();

    // Generation 1 proves itself by message, then fires load: no probe.
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null",
      source: iframe.contentWindow,
      data: viewMessage({ bridge: "v0", id: "hello-gen1", type: "hello" }),
    })));
    await completeHostLoad(iframe);
    expect(verifyViewDelivery).not.toHaveBeenCalled();

    // A blob hot reload of this page's own HTML runs loadPage() -> generation 2 on the same DOM
    // node. Take the LAST change listener: the effect re-subscribed once entryKey resolved.
    // The reload re-reads the registry doc, so it needs its own resolved read.
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    const calls = vi.mocked(subscribeToChanges).mock.calls;
    const changeListener = calls[calls.length - 1]![0];
    const mintsBefore = vi.mocked(getDoc).mock.calls.length;
    await act(async () => {
      changeListener({
        docs: { changed: [], removed: [] },
        blobs: { changed: [{ key: "pages/p.html" }], removed: [] },
      } as never);
      await microtasks();
    });
    const reloaded = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(reloaded).toBeTruthy();
    expect(vi.mocked(getDoc).mock.calls.length).toBeGreaterThan(mintsBefore); // the generation really bumped

    // Generation 2 is QUIET (no View message): its host's loaded report MUST start a receipt probe.
    await completeHostLoad(reloaded);
    await act(async () => {
      await Promise.resolve();
    });
    expect(verifyViewDelivery).toHaveBeenCalledTimes(1);
    expect(verifyViewDelivery).toHaveBeenCalledWith("launch-pages-registry/p");

    // The good receipt keeps the reloaded View alive past the deadline.
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));
    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
    expect(container.textContent).not.toContain("could not confirm that this View finished loading");
  });

  it("ignores wrong-source readiness messages and times out without a current-frame proof", async () => {
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();

    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null",
      source: window,
      data: viewMessage({ bridge: "v0", id: "wrong-source", type: "hello" }),
    })));

    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("could not confirm that this View finished loading");
  });

  it("times out after two negative delivery checks", async () => {
    vi.useFakeTimers();
    vi.mocked(verifyViewDelivery)
      .mockResolvedValueOnce({ delivered: false })
      .mockResolvedValueOnce({ delivered: false });
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "none" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();

    await completeHostLoad(iframe);
    await act(async () => {
      vi.advanceTimersByTime(VIEW_DELIVERY_RETRY_MS);
      await Promise.resolve();
    });
    expect(verifyViewDelivery).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS - VIEW_DELIVERY_RETRY_MS));

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("could not confirm that this View finished loading");
  });

  it("keeps an access:none View open after the shell verifies the host delivery receipt", async () => {
    vi.useFakeTimers();
    vi.mocked(verifyViewDelivery).mockResolvedValueOnce({ delivered: true });
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "none" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();

    await completeHostLoad(iframe);
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
    expect(container.textContent).not.toContain("could not confirm that this View finished loading");
  });

  it("keeps a quiet data-bearing View open after transport delivery is verified", async () => {
    vi.useFakeTimers();
    vi.mocked(verifyViewDelivery).mockResolvedValueOnce({ delivered: true });
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;

    await completeHostLoad(iframe);
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(verifyViewDelivery).toHaveBeenCalledWith("launch-pages-registry/p");
    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
    expect(container.textContent).not.toContain("could not confirm that this View finished loading");
  });

  it.each(["false", "rejection"] as const)("recovers when the first delivery check ends in %s", async (firstOutcome) => {
    vi.useFakeTimers();
    if (firstOutcome === "false") {
      vi.mocked(verifyViewDelivery).mockResolvedValueOnce({ delivered: false });
    } else {
      vi.mocked(verifyViewDelivery).mockRejectedValueOnce(new Error("receipt race"));
    }
    vi.mocked(verifyViewDelivery).mockResolvedValueOnce({ delivered: true });
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;

    await completeHostLoad(iframe);
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(VIEW_DELIVERY_RETRY_MS);
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(verifyViewDelivery).toHaveBeenCalledTimes(2);
    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
  });

  it("cancels an old generation's scheduled delivery retry on replacement", async () => {
    vi.useFakeTimers();
    vi.mocked(verifyViewDelivery).mockResolvedValueOnce({ delivered: false });
    vi.mocked(getDoc).mockResolvedValue(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const oldFrame = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    await completeHostLoad(oldFrame);

    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/replacement" />);
      await microtasks();
    });
    act(() => vi.advanceTimersByTime(VIEW_DELIVERY_RETRY_MS));

    expect(verifyViewDelivery).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(VIEW_HOST_PATH);
    expect(fetchViewBytes).toHaveBeenLastCalledWith("/__page/nonce-pages-registry/replacement", "bv1");
  });

  it("does not let a stale delivery result settle a replacement generation", async () => {
    vi.useFakeTimers();
    const oldDelivery = deferred<{ delivered: boolean }>();
    vi.mocked(verifyViewDelivery).mockImplementationOnce(() => oldDelivery.promise);
    vi.mocked(getDoc).mockResolvedValue(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const oldFrame = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    await completeHostLoad(oldFrame);

    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/replacement" />);
      await microtasks();
      oldDelivery.resolve({ delivered: true });
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("could not confirm that this View finished loading");
  });

  it("cancels a scheduled delivery retry on unmount", async () => {
    vi.useFakeTimers();
    vi.mocked(verifyViewDelivery).mockResolvedValueOnce({ delivered: false });
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    await completeHostLoad(iframe);
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });
    rootMounted = false;
    act(() => vi.advanceTimersByTime(VIEW_DELIVERY_RETRY_MS));

    expect(verifyViewDelivery).toHaveBeenCalledTimes(1);
  });

  it("registry-doc bundle-read -> none: a bridge request received during the async reload gap is DENIED, never answered under the stale grant", async () => {
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    vi.mocked(listAllHeads).mockResolvedValue([]);

    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await flush();
    });

    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    const contentWindow = iframe.contentWindow!;
    const postSpy = vi.spyOn(contentWindow, "postMessage");

    // The registry doc is edited live (bridge flips to "none") — simulate the SSE change event
    // that fires `loadPage()` again. Defer its `getDoc` resolution so we can send a bridge
    // request INTO the async gap between the edit landing and the reload completing.
    const changeListener = vi.mocked(subscribeToChanges).mock.calls[0]![0];
    const pending = deferred<ReturnType<typeof pageDoc>>();
    vi.mocked(getDoc).mockImplementationOnce(() => pending.promise);

    act(() => {
      changeListener({
        docs: { changed: [{ id: "pages-registry/p", version: "v2" }], removed: [] },
        blobs: { changed: [], removed: [] },
      });
    });

    // The reload is now in flight (getDoc pending) — a page->shell request arriving in exactly
    // this gap must not retain the OLD "bundle-read" capability, which was
    // still standing (only reset once getDoc resolved), so this would have been answered for
    // real. Post-fix, `loadPage` pre-revokes synchronously before its first `await`.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { origin: "null", data: viewMessage({ bridge: "v0", id: "q1", type: "query", params: {} }), source: contentWindow }),
      );
    });
    await flush();

    // The old document is no longer active as soon as reload advances the generation: no dep and
    // no diagnostic reply cross the boundary.
    expect(listAllHeads).not.toHaveBeenCalled();
    expect(postSpy.mock.calls.find(([msg]) => (msg as { message?: { id?: string } }).message?.id === "q1")).toBeUndefined();

    // Let the reload settle so no promise is left dangling.
    pending.resolve(pageDoc({ access: "none" }));
    await act(async () => {
      await flush();
    });
  });

  it("an in-flight bundle-read reply whose epoch advanced (page reloaded to bridge: none) is DROPPED — never delivered to the downgraded frame", async () => {
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));

    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await flush();
    });

    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    const firstContentWindow = iframe.contentWindow!;

    // A `query` request arrives while this page is still `bundle-read` — captured (correctly) at
    // receipt time — but its dep call is held open so the reload below can race ahead of it.
    const pendingQuery = deferred<[]>();
    vi.mocked(listAllHeads).mockImplementationOnce(() => pendingQuery.promise);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { origin: "null", data: viewMessage({ bridge: "v0", id: "q1", type: "query", params: {} }), source: firstContentWindow }),
      );
    });
    await flush();
    expect(listAllHeads).toHaveBeenCalledTimes(1); // in flight, not yet resolved

    // The page reloads to a DIFFERENT (downgraded) capability BEFORE that reply is ready — this
    // reload's own getDoc/mint resolve promptly and retarget `entry`, which navigates the SAME
    // iframe DOM node to a fresh `src` (jsdom mints a brand-new `contentWindow` object per
    // navigation, unlike a real browser's stable WindowProxy — either way, whatever window is
    // CURRENT when the stale reply is finally ready is the one that must never receive it).
    const changeListener = vi.mocked(subscribeToChanges).mock.calls[0]![0];
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "none", entry: "pages/p2.html" }));
    await act(async () => {
      changeListener({
        docs: { changed: [{ id: "pages-registry/p", version: "v3" }], removed: [] },
        blobs: { changed: [], removed: [] },
      });
      await flush();
    });

    // The reload navigated the iframe — re-read its (now different, `none`-capability) window and
    // watch IT: this is exactly what the component's own `frame.contentWindow` read (at delivery
    // time, inside the broker's `.then()`) resolves to.
    const currentIframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    const secondContentWindow = currentIframe.contentWindow!;
    const postSpy = vi.spyOn(secondContentWindow, "postMessage");

    // NOW the stale query's dep resolves — its reply was computed for the OLD (bundle-read)
    // generation, but the frame has since moved on to a `none` (content) page.
    await act(async () => {
      pendingQuery.resolve([]);
      await flush();
    });

    // The stale reply must never reach the (new, downgraded) frame — post-fix, the epoch check
    // drops it before `postMessage` is ever called for it.
    const leaked = postSpy.mock.calls.find(([msg]) => (msg as { message?: { id?: string } }).message?.id === "q1");
    expect(leaked).toBeUndefined();
  });
});

describe("PageFrame: registered Page navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetInterceptorForTests();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function mount(overrides: Record<string, unknown> = {}) {
    vi.mocked(getDoc).mockResolvedValue(pageDoc(overrides));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await flush();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    return iframe.contentWindow!;
  }

  it("allows a bridge:none Page to navigate through the shell", async () => {
    const source = await mount({ access: "none" });
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/target" }) }));
      await flush();
    });
    expect(resolvePageTarget).toHaveBeenCalledWith("pages-registry/target");
    expect(window.location.search).toBe("?view=page&id=pages-registry%2Ftarget");
  });

  it("mounts new active HTML only after trusted-shell approval", async () => {
    vi.mocked(getDoc).mockResolvedValue(pageDoc({ access: "bundle-read" }));
    vi.mocked(mintPageNonce).mockResolvedValueOnce({
      url: "/__page/new-active-view",
      launchId: "launch-new-active-view",
      title: "P",
      entry: "pages/p.html",
      capability: "bundle-read",
      authorization: {
        required: true,
        authorized: false,
        contentVersion: "sha256:new-html",
      },
    });
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await flush();
    });

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("Allow this View to read bundle data?");
    const allow = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Allow this View",
    )!;
    expect(allow.disabled).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(allow.disabled).toBe(false);
    await act(async () => {
      allow.click();
      await flush();
    });
    expect(authorizeViewLaunch).toHaveBeenCalledWith("launch-new-active-view");
    expect(fetchViewBytes).toHaveBeenCalledWith("/__page/new-active-view", "sha256:new-html");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(VIEW_HOST_PATH);
  });

  it("navigates at most once per source generation when resolutions race", async () => {
    const source = await mount();
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    vi.mocked(resolvePageTarget).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const push = vi.spyOn(window.history, "pushState");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/first" }) }));
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/second" }) }));
    });
    await act(async () => { second.resolve(true); await flush(); });
    await act(async () => { first.resolve(true); await flush(); });
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain("second");
  });

  it("ignores a second navigation message from the same old contentWindow after the first push", async () => {
    const source = await mount();
    const push = vi.spyOn(window.history, "pushState");
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/first" }) }));
      await flush();
    });
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/second" }) }));
      await flush();
    });
    expect(resolvePageTarget).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain("first");
  });

  it("treats self-navigation as an idempotent no-op", async () => {
    const source = await mount();
    const push = vi.spyOn(window.history, "pushState");
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/p" }) }));
      await flush();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps approval in trusted shell chrome and posts only the terminal action result", async () => {
    const source = await mount({ type: "View", access: "bundle-propose" });
    const postSpy = vi.spyOn(source, "postMessage");
    vi.mocked(prepareTrustedAction).mockResolvedValue({
      status: "prepared",
      approvalToken: "shell-secret-token",
      expiresAt: Date.now() + 60_000,
      confirmation: {
        source: { kind: "registered", id: "pages-registry/p", title: "P", version: "rv1", contentVersion: "bv1" },
        target: { docId: "tasks/alpha", title: "Alpha", kind: "Task", version: "dv1" },
        field: "status",
        before: "todo",
        after: "done",
        actor: "mike/test",
        timestamp: "2026-07-18T12:00:00.000Z",
      },
    });
    vi.mocked(commitTrustedAction).mockResolvedValue({
      status: "committed",
      action: "document.set-field",
      docId: "tasks/alpha",
      field: "status",
      changed: true,
      version: "dv2",
      confirmed: true,
    });

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null",
        source,
        data: viewMessage({
          bridge: "v1",
          type: "action.propose",
          requestId: "action-1",
          action: { kind: "document.set-field", docId: "tasks/alpha", field: "status", value: "done", expectedVersion: "dv1" },
        }),
      }));
      await flush();
    });

    expect(prepareTrustedAction).toHaveBeenCalledWith("launch-pages-registry/p", expect.objectContaining({ field: "status", value: "done" }));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Apply this bundle change?");
    expect(container.textContent).toContain("mike/test");
    expect(JSON.stringify(postSpy.mock.calls)).not.toContain("shell-secret-token");

    const apply = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Apply change")!;
    const cancel = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!;
    expect(apply.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    apply.click();
    expect(commitTrustedAction).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(apply.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
    await act(async () => {
      apply.click();
      await flush();
    });
    expect(commitTrustedAction).toHaveBeenCalledWith("shell-secret-token");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(postSpy.mock.calls).toContainEqual([
      {
        protocol: VIEW_HOST_PROTOCOL,
        type: "deliver",
        message: expect.objectContaining({ bridge: "v1", requestId: "action-1", type: "action.result", result: expect.objectContaining({ status: "committed", version: "dv2" }) }),
      },
      "*",
    ]);
  });

  it("drops navigation whose source generation became stale during validation", async () => {
    const source = await mount();
    const pending = deferred<boolean>();
    vi.mocked(resolvePageTarget).mockImplementationOnce(() => pending.promise);
    const push = vi.spyOn(window.history, "pushState");
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/target" }) })));
    const reload = deferred<ReturnType<typeof pageDoc>>();
    vi.mocked(getDoc).mockImplementationOnce(() => reload.promise);
    act(() => vi.mocked(subscribeToChanges).mock.calls[0]![0]({ docs: { changed: [{ id: "pages-registry/p", version: "v2" }], removed: [] }, blobs: { changed: [], removed: [] } }));
    await act(async () => { pending.resolve(true); await flush(); });
    expect(push).not.toHaveBeenCalled();
    reload.resolve(pageDoc());
    await act(async () => await flush());
  });

  it("rejects a fresh open-page from the old document while registry reload is unresolved", async () => {
    const source = await mount();
    const reload = deferred<ReturnType<typeof pageDoc>>();
    vi.mocked(getDoc).mockImplementationOnce(() => reload.promise);
    const push = vi.spyOn(window.history, "pushState");
    act(() => vi.mocked(subscribeToChanges).mock.calls[0]![0]({ docs: { changed: [{ id: "pages-registry/p", version: "v2" }], removed: [] }, blobs: { changed: [], removed: [] } }));

    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/target" }) }));
      await flush();
    });
    expect(resolvePageTarget).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    reload.resolve(pageDoc());
    await act(async () => await flush());
  });

  it("revalidates at mount and refuses a non-Page deep link even when its entry is safe", async () => {
    vi.mocked(getDoc).mockResolvedValue(pageDoc({ type: "Design", entry: "pages/p.html" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await flush();
    });
    expect(mintPageNonce).toHaveBeenCalledWith("pages-registry/p");
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("not a usable registered Page");
  });
});

describe("PageFrame: shell-fetched View delivery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetInterceptorForTests();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
  });

  async function mount(overrides: Record<string, unknown> = {}) {
    vi.mocked(getDoc).mockResolvedValue(pageDoc(overrides));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await flush();
    });
    return container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement | null;
  }

  it("fetches the launch's bytes against its approved version and mounts an unsandboxed-by-attribute host, never the nonce URL", async () => {
    const iframe = await mount();
    expect(fetchViewBytes).toHaveBeenCalledTimes(1);
    expect(fetchViewBytes).toHaveBeenCalledWith("/__page/nonce-pages-registry/p", "bv1");
    expect(iframe?.getAttribute("src")).toBe(VIEW_HOST_PATH);
    expect(iframe?.hasAttribute("sandbox")).toBe(false);
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("hands the verified bytes to the current host exactly once, by transfer, with a per-delivery id", async () => {
    const iframe = (await mount())!;
    const host = iframe.contentWindow!;
    const postSpy = vi.spyOn(host, "postMessage");
    act(() => sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "ready" }));
    act(() => sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "ready" }));
    const loads = postSpy.mock.calls.filter(([message]) => (message as { type?: string }).type === "load");
    expect(loads).toHaveLength(1);
    const [message, targetOrigin, transfer] = loads[0] as unknown as [unknown, string, unknown[]];
    const load = message as { bytes: ArrayBuffer; contentType: string; deliveryId: string; title: string };
    expect(targetOrigin).toBe("*");
    expect(transfer).toEqual([load.bytes]);
    expect(new TextDecoder().decode(load.bytes)).toBe("<!doctype html><p>view</p>");
    expect(load.contentType).toBe("text/html; charset=utf-8");
    expect(load.deliveryId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(postSpy.mock.calls)).not.toContain("launch-pages-registry/p");
  });

  it("ignores a ready or View message from any window but the current host", async () => {
    const iframe = (await mount())!;
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source: window, data: { protocol: VIEW_HOST_PROTOCOL, type: "ready" } })));
    expect(postSpy).not.toHaveBeenCalled();
    // A View that posts straight to the top window (bypassing its host) is not the host.
    const stray = document.createElement("iframe");
    document.body.appendChild(stray);
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { origin: "null", source: stray.contentWindow, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/target" }) }));
      await flush();
    });
    stray.remove();
    expect(resolvePageTarget).not.toHaveBeenCalled();
    // Unenveloped data from the host itself is not a View message either.
    await act(async () => {
      sendFromHost(iframe, { bridge: "v0", type: "open-page", pageId: "pages-registry/target" });
      await flush();
    });
    expect(resolvePageTarget).not.toHaveBeenCalled();
  });

  it("does not probe delivery for a loaded report carrying another delivery id", async () => {
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValue(pageDoc({ access: "none" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await microtasks();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    act(() => sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "ready" }));
    await act(async () => {
      sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "loaded", deliveryId: "forged" });
      await Promise.resolve();
    });
    expect(verifyViewDelivery).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("could not confirm that this View finished loading");
    expect(container.textContent).toContain("open the URL that `superbee ui` printed in a regular browser");
  });

  it("refuses bytes that do not match the approved version and never mounts a host", async () => {
    vi.mocked(fetchViewBytes).mockRejectedValueOnce(new ViewBytesMismatchError());
    const iframe = await mount();
    expect(iframe).toBeNull();
    expect(container.textContent).toContain("did not match the version that was approved");
  });

  it("names a failed byte fetch and points at a regular browser", async () => {
    vi.mocked(fetchViewBytes).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const iframe = await mount();
    expect(iframe).toBeNull();
    expect(container.textContent).toContain("could not fetch this View's HTML (Failed to fetch)");
    expect(container.textContent).toContain("open the URL that `superbee ui` printed in a regular browser");
  });

  it("fetches an unapproved data-bearing View's bytes only after approval", async () => {
    vi.mocked(mintPageNonce).mockResolvedValueOnce({
      url: "/__page/pending",
      launchId: "launch-pending",
      title: "P",
      entry: "pages/p.html",
      capability: "bundle-read",
      authorization: { required: true, authorized: false, contentVersion: "sha256:pending" },
    });
    await mount();
    expect(fetchViewBytes).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("PageFrame: host fail-closed checks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetInterceptorForTests();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function mount() {
    vi.mocked(getDoc).mockResolvedValue(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await flush();
    });
    return container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
  }

  it("never sends bytes to, or brokers for, a host that is not opaque", async () => {
    const iframe = await mount();
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");
    for (const origin of [window.location.origin, "", "http://127.0.0.1:1"]) {
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { origin, source: iframe.contentWindow, data: { protocol: VIEW_HOST_PROTOCOL, type: "ready" } }));
        window.dispatchEvent(new MessageEvent("message", { origin, source: iframe.contentWindow, data: viewMessage({ bridge: "v0", type: "open-page", pageId: "pages-registry/target" }) }));
        await flush();
      });
    }
    expect(postSpy).not.toHaveBeenCalled();
    expect(resolvePageTarget).not.toHaveBeenCalled();
  });

  it("shows the host's reported refusal instead of a blank frame", async () => {
    const iframe = await mount();
    const spy = vi.spyOn(iframe.contentWindow!, "postMessage");
    act(() => sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "ready" }));
    const load = spy.mock.calls.map(([m]) => m as { type?: string; deliveryId?: string }).find((m) => m.type === "load")!;
    spy.mockRestore();
    await act(async () => {
      sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "failed", deliveryId: "other", reason: "ignored" });
      await flush();
    });
    expect(container.querySelector("iframe")).toBeTruthy();
    await act(async () => {
      sendFromHost(iframe, { protocol: VIEW_HOST_PROTOCOL, type: "failed", deliveryId: load.deliveryId, reason: "the browser refused to load the View frame (frame-src)" });
      await flush();
    });
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("refused to show the View");
    expect(container.textContent).toContain("open the URL that `superbee ui` printed in a regular browser");
  });
});
