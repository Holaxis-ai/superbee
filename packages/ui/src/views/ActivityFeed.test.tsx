/**
 * Activity feed tests (designs/home-surface): the pure projection (`feedRows` — filter, sort,
 * cap; `freshIds` — best-effort change marking) plus the component's live contract: an SSE change
 * DEBOUNCES into one refetch of the head list (the event carries no frontmatter, so
 * invalidate-and-refetch is the only honest semantics), and a resync refetches immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocHead } from "../api/types.js";
import type { KindConvention } from "@superbee/core/kinds";
import { ActivityFeed, FEED_LIMIT, FEED_REFETCH_DEBOUNCE_MS, feedRows, freshIds } from "./ActivityFeed.js";
import { listAllHeads } from "../api/client.js";
import { fetchKindContext } from "../api/pages.js";
import { subscribeToChanges, subscribeToResync } from "../pages/pageEvents.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api/client.js", () => ({
  listAllHeads: vi.fn(async () => []),
}));

const LEGACY_KINDS: KindConvention[] = ["Task", "Errand", "Review Request"].map((governs) => ({
  id: `conventions/${governs.toLowerCase().replaceAll(" ", "-")}`,
  title: governs,
  governs,
  fields: { required: ["title", "status"], optional: ["assignee"], values: {}, terminal: {}, descriptions: {} },
}));

vi.mock("../api/pages.js", () => ({
  fetchKindContext: vi.fn(async () => ({ okfVersion: "0.1", kinds: [] })),
}));

vi.mock("../pages/pageEvents.js", () => ({
  subscribeToChanges: vi.fn(() => () => {}),
  subscribeToResync: vi.fn(() => () => {}),
}));

function head(id: string, frontmatter: { type: string } & Record<string, unknown>, version = "v1"): DocHead {
  return { id, version, frontmatter };
}

describe("feedRows (pure projection)", () => {
  it("filters conventions and View/Page registry docs, sorts newest-first, caps at the limit", () => {
    const heads: DocHead[] = [
      head("conventions/task", { type: "Convention", title: "Task", timestamp: "2026-07-21T10:00:00Z" }),
      head("views-registry/board", { type: "View", title: "Board", entry: "views/b.html", timestamp: "2026-07-21T09:00:00Z" }),
      // A View registration at the LEGACY location — filtered like any registry doc. (A legacy
      // Page-TYPED doc is no longer a registered kind name and would show as ordinary content.)
      head("pages-registry/about", { type: "View", title: "About", entry: "pages/a.html", timestamp: "2026-07-21T08:00:00Z" }),
      head("tasks/older", { type: "Task", title: "Older", timestamp: "2026-07-20T10:00:00Z" }),
      head("tasks/newer", { type: "Task", title: "Newer", timestamp: "2026-07-21T10:00:00Z" }),
      head("notes/undated", { type: "Context Note", title: "Undated" }),
    ];
    const rows = feedRows(heads, "0.1", LEGACY_KINDS);
    expect(rows.map((r) => r.id)).toEqual(["tasks/newer", "tasks/older", "notes/undated"]);
    expect(rows[0]).toMatchObject({ kind: "Task", title: "Newer" });
  });

  it("projects ownership for ANY kind that carries it — Task is not special-cased", () => {
    // The contract is kind-GENERIC: the shell never privileges a kind by name, so a
    // bundle-declared kind nobody shipped must behave exactly like the built-in Task. An all-Task
    // fixture would let `type === "Task" ? … : undefined` pass the whole suite, so
    // the non-Task rows below are what actually enforce the claim.
    const KINDS_CARRYING_OWNERSHIP = ["Task", "Errand", "Review Request"] as const;
    const rows = feedRows(
      KINDS_CARRYING_OWNERSHIP.map((type, i) =>
        head(`things/${i}`, {
          type,
          title: `A ${type}`,
          actor: "codex",
          assignee: "brian",
          status: "todo",
          timestamp: `2026-07-23T1${i}:00:00Z`,
        }),
      ),
      "0.1",
      LEGACY_KINDS,
    );
    expect(rows).toHaveLength(KINDS_CARRYING_OWNERSHIP.length);
    for (const row of rows) {
      expect(row, `${row.kind} must project ownership like any other kind`).toMatchObject({
        actor: "codex",
        assignee: "brian",
        status: "todo",
      });
    }
  });

  it("shows current workflow progress without treating OKF lifecycle status as progress", () => {
    const currentKind: KindConvention = {
      id: "conventions/task",
      title: "Task",
      governs: "Task",
      fields: {
        required: ["title", "superbee_progress_status"],
        optional: ["status"],
        values: {},
        terminal: {},
        descriptions: {},
      },
    };
    const [row] = feedRows([
      head("tasks/current", {
        type: "Task",
        title: "Current",
        status: "stable",
        superbee_progress_status: "in_progress",
      }),
    ], "0.2", [currentKind]);
    expect(row!.status).toBe("in_progress");
  });

  it("omits the ownership fields a doc does not carry", () => {
    const [note] = feedRows([
      head("notes/y", { type: "Context Note", title: "A note", actor: "codex", timestamp: "2026-07-23T09:00:00Z" }),
    ], "0.1", LEGACY_KINDS);
    expect(note!.assignee).toBeUndefined();
    expect(note!.status).toBeUndefined();
    expect(note!.actor).toBe("codex");
  });

  it("resolves mutation attribution through the shared edition-neutral precedence", () => {
    const rows = feedRows([
      head("notes/v02", {
        type: "Context Note",
        title: "V02",
        superbee_updated_by: "  carol  ",
        updated_by: "alice",
        actor: "mike",
        timestamp: "2026-07-23T12:00:00Z",
      }),
      head("notes/compat", {
        type: "Context Note",
        title: "Compat",
        updated_by: " alice ",
        actor: "mike",
        timestamp: "2026-07-23T11:00:00Z",
      }),
      head("notes/v01", {
        type: "Context Note",
        title: "V01",
        actor: " mike ",
        timestamp: "2026-07-23T10:00:00Z",
      }),
      head("notes/none", {
        type: "Context Note",
        title: "None",
        timestamp: "2026-07-23T09:00:00Z",
      }),
    ], "0.1", LEGACY_KINDS);

    expect(rows.map(({ id, actor }) => ({ id, actor }))).toEqual([
      { id: "notes/v02", actor: "carol" },
      { id: "notes/compat", actor: "alice" },
      { id: "notes/v01", actor: "mike" },
      { id: "notes/none", actor: undefined },
    ]);
  });

  it("falls back to the id for an untitled doc and caps at FEED_LIMIT", () => {
    const heads = Array.from({ length: FEED_LIMIT + 3 }, (_, i) =>
      head(`docs/d${i}`, { type: "Doc", timestamp: `2026-07-0${(i % 9) + 1}T00:00:00Z` }),
    );
    const rows = feedRows(heads, "0.1", LEGACY_KINDS);
    expect(rows).toHaveLength(FEED_LIMIT);
    expect(rows[0]!.title).toBe(rows[0]!.id);
  });
});

describe("freshIds (pure change marking)", () => {
  const rows = feedRows([
    head("a", { type: "Doc", title: "A", timestamp: "2026-07-21T02:00:00Z" }, "v2"),
    head("b", { type: "Doc", title: "B", timestamp: "2026-07-21T01:00:00Z" }, "v1"),
  ], "0.1", LEGACY_KINDS);

  it("marks nothing on first load (null previous)", () => {
    expect(freshIds(rows, null).size).toBe(0);
  });

  it("marks new and version-changed ids, never unchanged ones", () => {
    const previous = new Map([["b", "v1"]]);
    const fresh = freshIds(rows, previous);
    expect(fresh.has("a"), "new id is fresh").toBe(true);
    expect(fresh.has("b"), "unchanged id is not fresh").toBe(false);
    expect(freshIds(rows, new Map([["a", "v1"], ["b", "v1"]])).has("a"), "version change is fresh").toBe(true);
  });
});

describe("ActivityFeed live contract", () => {
  let container: HTMLDivElement;
  let root: Root;
  let changeHandler: ((e: unknown) => void) | undefined;
  let resyncHandler: (() => void) | undefined;

  beforeEach(() => {
    vi.mocked(listAllHeads).mockClear();
    vi.mocked(fetchKindContext).mockResolvedValue({ okfVersion: "0.1", kinds: LEGACY_KINDS });
    vi.mocked(subscribeToChanges).mockImplementation((handler: (e: never) => void) => {
      changeHandler = handler as (e: unknown) => void;
      return () => {};
    });
    vi.mocked(subscribeToResync).mockImplementation((handler: () => void) => {
      resyncHandler = handler;
      return () => {};
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderFeed(): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ActivityFeed />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders rows from heads and an empty state when the bundle has none", async () => {
    vi.mocked(listAllHeads).mockResolvedValueOnce([
      head("tasks/x", { type: "Task", title: "Ship it", actor: "mike", timestamp: "2026-07-21T10:00:00Z" }),
    ]);
    await renderFeed();
    expect(container.textContent).toContain("Ship it");
    expect(container.textContent).toContain("mike");
    expect(container.querySelector(".feed-empty")).toBeNull();
  });

  it("a row shows WHO OWNS the work, and demotes the last writer to provenance", async () => {
    // The defect this pins: the row used to lead with the actor, so "codex Task 'Write the
    // onboarding docs'" read as codex being on it — when codex merely wrote the doc and brian owns
    // it. Ownership must be visible, and the actor must not sit in the subject position.
    // Deliberately a CUSTOM kind, not Task: the rendered row must be kind-agnostic too, so a
    // Task-only projection cannot satisfy this assertion either.
    vi.mocked(listAllHeads).mockResolvedValueOnce([
      head("errands/x", {
        type: "Errand",
        title: "Write the onboarding docs",
        actor: "codex",
        assignee: "brian",
        status: "todo",
        timestamp: "2026-07-23T10:00:00Z",
      }),
    ]);
    await renderFeed();

    expect(container.querySelector(".feed-kind")?.textContent).toBe("Errand");
    expect(container.querySelector(".feed-assignee")?.textContent).toBe("for brian");
    expect(container.querySelector(".feed-status")?.textContent).toBe("todo");
    // The actor is inside the provenance line, labeled — never a bare leading name.
    const provenance = container.querySelector(".feed-provenance");
    expect(provenance, "the actor must render as provenance").not.toBeNull();
    expect(provenance!.textContent).toContain("attributed to");
    expect(provenance!.querySelector(".feed-actor")?.textContent).toBe("codex");
    // Structural, not cosmetic: the row must not OPEN with the actor.
    const first = container.querySelector(".feed-row")!.firstElementChild!;
    expect(first.className, "the row must lead with the doc, not the writer").toBe("feed-meta");
    expect(first.textContent).not.toContain("codex");
  });

  it("omits ownership and provenance a doc does not carry — no empty labels", async () => {
    vi.mocked(listAllHeads).mockResolvedValueOnce([
      head("notes/y", { type: "Context Note", title: "Just a note", timestamp: "2026-07-23T10:00:00Z" }),
    ]);
    await renderFeed();
    expect(container.querySelector(".feed-assignee")).toBeNull();
    expect(container.querySelector(".feed-status")).toBeNull();
    expect(container.querySelector(".feed-actor")).toBeNull();
    expect(container.textContent).not.toContain("attributed to");
    expect(container.textContent).not.toContain("for ");
    expect(container.textContent).toContain("Just a note");
  });

  it("debounces a burst of SSE changes into ONE refetch; resync refetches immediately", async () => {
    await renderFeed();
    expect(container.querySelector(".feed-empty"), "empty bundle renders the empty state").not.toBeNull();
    const callsAfterMount = vi.mocked(listAllHeads).mock.calls.length;

    // A burst of three change frames within the debounce window → exactly one refetch.
    await act(async () => {
      const event = { docs: { changed: [{ id: "tasks/x", version: "v2" }], removed: [] }, blobs: { changed: [], removed: [] } };
      changeHandler!(event);
      changeHandler!(event);
      changeHandler!(event);
      await new Promise((resolve) => setTimeout(resolve, FEED_REFETCH_DEBOUNCE_MS + 100));
    });
    expect(vi.mocked(listAllHeads).mock.calls.length).toBe(callsAfterMount + 1);

    // A doc-free frame (blob-only change) never triggers a refetch.
    await act(async () => {
      changeHandler!({ docs: { changed: [], removed: [] }, blobs: { changed: [{ key: "views/x.html", version: "v2" }], removed: [] } });
      await new Promise((resolve) => setTimeout(resolve, FEED_REFETCH_DEBOUNCE_MS + 100));
    });
    expect(vi.mocked(listAllHeads).mock.calls.length).toBe(callsAfterMount + 1);

    // Resync = full refetch, immediately (the stream replays nothing).
    await act(async () => {
      resyncHandler!();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(vi.mocked(listAllHeads).mock.calls.length).toBe(callsAfterMount + 2);
  });

  it("unmount with a PENDING debounce clears the timer — no refetch after teardown (review follow-up)", async () => {
    await renderFeed();
    const callsAfterMount = vi.mocked(listAllHeads).mock.calls.length;
    await act(async () => {
      changeHandler!({ docs: { changed: [{ id: "tasks/x", version: "v2" }], removed: [] }, blobs: { changed: [], removed: [] } });
      root.unmount(); // before the debounce window elapses
      await new Promise((resolve) => setTimeout(resolve, FEED_REFETCH_DEBOUNCE_MS + 100));
    });
    expect(vi.mocked(listAllHeads).mock.calls.length).toBe(callsAfterMount);
    // afterEach unmounts again — recreate so it has a live root to tear down.
    root = createRoot(container);
  });
});
