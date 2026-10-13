/**
 * DocumentBrowser behavior pins (designs/document-discovery Decision 1): a browse_collapsed kind
 * starts CLOSED and toggles open; an expanded kind caps rows with a "show all" expander; the filter
 * flattens across kinds; a row navigates to the reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentBrowser, GROUP_CAP } from "./DocumentBrowser.js";
import { listAllHeadsReport } from "../api/client.js";
import { fetchKinds } from "../api/pages.js";
import { navigate } from "../routing.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client.js")>();
  return { ...original, listAllHeadsReport: vi.fn(async () => ({ heads: [], skipped: [] })) };
});
vi.mock("../api/pages.js", () => ({ fetchKinds: vi.fn(async () => []), invalidateKinds: vi.fn() }));
vi.mock("../pages/pageEvents.js", () => ({
  subscribeToChanges: vi.fn(() => () => {}),
  subscribeToResync: vi.fn(() => () => {}),
}));
vi.mock("../routing.js", () => ({ navigate: vi.fn() }));

const head = (id: string, type: string, title: string, timestamp: string) => ({ id, version: "v1", frontmatter: { type, title, timestamp } });

// One Design, eight Tasks (to exercise the cap), two Context Notes (collapsed).
const HEADS = [
  head("designs/a", "Design", "The design", "2026-07-21T00:00:00Z"),
  ...Array.from({ length: 8 }, (_, i) => head(`tasks/t${i}`, "Task", `Task ${i}`, `2026-07-${10 + i}T00:00:00Z`)),
  head("notes/n1", "Context Note", "Note one", "2026-07-22T00:00:00Z"),
  head("notes/n2", "Context Note", "Note two", "2026-07-22T01:00:00Z"),
];
const KINDS = [
  { id: "conventions/context-note", governs: "Context Note", title: "Context Note", fields: { required: [], optional: [], values: {} }, browseCollapsed: true },
];

describe("DocumentBrowser", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(listAllHeadsReport).mockReset();
    vi.mocked(listAllHeadsReport).mockResolvedValue({ heads: HEADS, skipped: [] } as never);
    vi.mocked(fetchKinds).mockReset();
    vi.mocked(fetchKinds).mockResolvedValue(KINDS as never);
    vi.mocked(navigate).mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <DocumentBrowser />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  }

  const groupByKind = (kind: string): HTMLElement =>
    [...container.querySelectorAll(".browse-group")].find((g) => g.querySelector(".browse-group-kind")?.textContent === kind) as HTMLElement;

  it("names a document the listing skipped for invalid frontmatter, above the rest of the bundle", async () => {
    vi.mocked(listAllHeadsReport).mockResolvedValue({
      heads: HEADS,
      skipped: [{ id: "tasks/broken", reason: "bad indentation of a mapping entry" }],
    } as never);
    await render();
    const alert = container.querySelector(".browse-unreadable")!;
    expect(alert.textContent).toContain("1 document could not be read");
    expect(alert.textContent).toContain("tasks/broken: bad indentation of a mapping entry");
    expect(groupByKind("Task").querySelector(".browse-count")!.textContent).toBe("8");
  });

  it("groups by kind; an expanded kind shows its rows, a browse_collapsed kind starts CLOSED", async () => {
    await render();
    const task = groupByKind("Task");
    expect(task.querySelector(".browse-count")!.textContent).toBe("8");
    expect(task.querySelectorAll(".browse-row").length).toBeGreaterThan(0); // expanded → rows visible
    const notes = groupByKind("Context Note");
    expect(notes.querySelector(".browse-count")!.textContent).toBe("2");
    expect(notes.querySelectorAll(".browse-row")).toHaveLength(0); // collapsed → no rows until opened
    expect(notes.querySelector(".browse-group-head")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking a collapsed group's header opens it", async () => {
    await render();
    const notes = groupByKind("Context Note");
    await act(async () => (notes.querySelector(".browse-group-head") as HTMLButtonElement).click());
    expect(notes.querySelectorAll(".browse-row")).toHaveLength(2);
  });

  it("an expanded group caps at GROUP_CAP with a 'show all N'; clicking shows all", async () => {
    await render();
    const task = groupByKind("Task");
    expect(task.querySelectorAll(".browse-row")).toHaveLength(GROUP_CAP); // 6 of 8
    const showAll = task.querySelector(".browse-show-all") as HTMLButtonElement;
    expect(showAll.textContent).toContain("show all 8");
    await act(async () => showAll.click());
    expect(task.querySelectorAll(".browse-row")).toHaveLength(8);
  });

  it("typing in the filter FLATTENS to matching rows across kinds", async () => {
    await render();
    const filter = container.querySelector(".browse-filter") as HTMLInputElement;
    // React tracks the input value via a prototype setter it overrides — set through the NATIVE
    // setter so its onChange actually fires (a raw `.value =` is a no-op to React's tracker).
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      nativeSetter.call(filter, "note");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Grouped view gone; flat results show both notes (title match), no groups.
    expect(container.querySelector(".browse-groups")).toBeNull();
    expect(container.querySelectorAll(".browse-results .browse-row")).toHaveLength(2);
    expect(container.querySelector(".browse-results-count")!.textContent).toContain("2 match");
  });

  it("waits for the kinds registry before rendering groups — collapse state must be known first (F1)", async () => {
    // Heads resolve but kinds is still pending: rendering groups now would open a browse_collapsed
    // kind (empty collapsed set). The browser must show loading until kinds lands.
    vi.mocked(fetchKinds).mockReturnValue(new Promise(() => {}) as never); // never resolves
    await render();
    expect(container.querySelector(".browse-groups")).toBeNull();
    expect(container.textContent).toContain("Loading documents");
  });

  it("clicking a row navigates to the doc reader", async () => {
    await render();
    const firstRow = groupByKind("Design").querySelector(".browse-row") as HTMLButtonElement;
    await act(async () => firstRow.click());
    expect(navigate).toHaveBeenCalledWith({ view: "doc", id: "designs/a" });
  });
});
