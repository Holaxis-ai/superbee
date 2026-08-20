/**
 * PageFrame launch-revocation race tests. A reload must revoke the old launch synchronously, and
 * an asynchronous server-bridge reply must remain fenced to the iframe generation that requested
 * it. These component tests control both gaps with real iframe/postMessage boundaries.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PageFrame, VIEW_LOAD_DEADLINE_MS } from "./PageFrame.js";
import { getDoc, listAllHeads } from "../api/client.js";
import { authorizeViewLaunch, cancelTrustedAction, commitTrustedAction, mintPageNonce, prepareTrustedAction, resolvePageTarget } from "../api/pages.js";
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
  authorizeViewLaunch: vi.fn(async () => ({ required: true, authorized: true })),
  verifyViewLaunch: vi.fn(async () => ({ required: true, authorized: true })),
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

describe("PageFrame: bridge revocation race (P1)", () => {
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
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps a data-bearing View open once its exact frame posts a readiness message", async () => {
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { bridge: "v0", id: "hello-1", type: "hello" },
    })));
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
    expect(container.textContent).not.toContain("This View's content did not finish loading");
  });

  it("times out a data-bearing View that never proves its frame script loaded", async () => {
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "bundle-read" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();

    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("This View's content did not finish loading");
  });

  it("does not treat iframe load as readiness for an access:none View", async () => {
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "none" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();

    act(() => iframe.dispatchEvent(new Event("load")));
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("This View's content did not finish loading");
  });

  it("keeps an access:none View open after the exact served frame posts the host readiness signal", async () => {
    vi.useFakeTimers();
    vi.mocked(getDoc).mockResolvedValueOnce(pageDoc({ access: "none" }));
    await act(async () => {
      root.render(<PageFrame pageId="pages-registry/p" />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const iframe = container.querySelector("iframe.page-frame-iframe") as HTMLIFrameElement;
    expect(iframe).toBeTruthy();

    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { type: "superbee.view-ready.v1" },
    })));
    act(() => vi.advanceTimersByTime(VIEW_LOAD_DEADLINE_MS));

    expect(container.querySelector("iframe.page-frame-iframe")).toBeTruthy();
    expect(container.textContent).not.toContain("This View's content did not finish loading");
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
        new MessageEvent("message", { data: { bridge: "v0", id: "q1", type: "query", params: {} }, source: contentWindow }),
      );
    });
    await flush();

    // The old document is no longer active as soon as reload advances the generation: no dep and
    // no diagnostic reply cross the boundary.
    expect(listAllHeads).not.toHaveBeenCalled();
    expect(postSpy.mock.calls.find(([msg]) => (msg as { id?: string }).id === "q1")).toBeUndefined();

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
        new MessageEvent("message", { data: { bridge: "v0", id: "q1", type: "query", params: {} }, source: firstContentWindow }),
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
    const leaked = postSpy.mock.calls.find(([msg]) => (msg as { id?: string; type?: string }).id === "q1");
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
      window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/target" } }));
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
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe("/__page/new-active-view");
  });

  it("navigates at most once per source generation when resolutions race", async () => {
    const source = await mount();
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    vi.mocked(resolvePageTarget).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const push = vi.spyOn(window.history, "pushState");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/first" } }));
      window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/second" } }));
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
      window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/first" } }));
      await flush();
    });
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/second" } }));
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
      window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/p" } }));
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
      window.dispatchEvent(new MessageEvent("message", {
        source,
        data: {
          bridge: "v1",
          type: "action.propose",
          requestId: "action-1",
          action: { kind: "document.set-field", docId: "tasks/alpha", field: "status", value: "done", expectedVersion: "dv1" },
        },
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
      expect.objectContaining({ bridge: "v1", requestId: "action-1", type: "action.result", result: expect.objectContaining({ status: "committed", version: "dv2" }) }),
      "*",
    ]);
  });

  it("drops navigation whose source generation became stale during validation", async () => {
    const source = await mount();
    const pending = deferred<boolean>();
    vi.mocked(resolvePageTarget).mockImplementationOnce(() => pending.promise);
    const push = vi.spyOn(window.history, "pushState");
    act(() => window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/target" } })));
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
      window.dispatchEvent(new MessageEvent("message", { source, data: { bridge: "v0", type: "open-page", pageId: "pages-registry/target" } }));
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
