/**
 * DocPage pins (designs/doc-reader rev 2): header card renders kind + KIND-DECLARED chips only
 * (mechanism in the shell, meaning from the bundle), body renders through the bounded pipeline,
 * outbound edges render INLINE in the body as "verb → target-title" rows (no separate section),
 * backlinks list + navigate under "Cited by", unknown id lands in the honest not-found state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocPage } from "./DocPage.js";
import { ApiError, getDoc, listAllHeads } from "../api/client.js";
import { fetchEdges, fetchKinds } from "../api/pages.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client.js")>();
  return { ...original, getDoc: vi.fn(), listAllHeads: vi.fn(async () => []) };
});

vi.mock("../api/pages.js", () => ({
  fetchEdges: vi.fn(async () => []),
  fetchKinds: vi.fn(async () => []),
  invalidateKinds: vi.fn(),
}));

vi.mock("../pages/pageEvents.js", () => ({
  subscribeToChanges: vi.fn(() => () => {}),
  subscribeToResync: vi.fn(() => () => {}),
}));

const TASK_KIND = {
  id: "conventions/task",
  title: "Task",
  governs: "Task",
  fields: {
    required: ["title", "status"],
    optional: ["priority", "assignee", "superbee_updated_by", "updated_by"],
    values: {},
  },
  linkTypes: {},
};

describe("DocPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(getDoc).mockReset();
    vi.mocked(fetchEdges).mockReset();
    vi.mocked(fetchEdges).mockResolvedValue([]);
    vi.mocked(fetchKinds).mockReset();
    vi.mocked(fetchKinds).mockResolvedValue([]);
    vi.mocked(listAllHeads).mockReset();
    vi.mocked(listAllHeads).mockResolvedValue([]);
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

  async function render(docId: string): Promise<void> {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <DocPage docId={docId} />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("renders header (kind pill + declared chips only), body, and backlinks", async () => {
    vi.mocked(getDoc).mockResolvedValue({
      doc: {
        id: "tasks/alpha",
        frontmatter: {
          type: "Task",
          title: "Ship the reader",
          status: "in_progress",
          priority: "1",
          secret_internal: "never-a-chip",
          superbee_updated_by: "  alice  ",
          updated_by: "compat",
          actor: "mike",
          timestamp: "2026-07-21T10:00:00.000Z",
        },
        body: "# Progress\n\nSee [the design](../designs/doc-reader.md).",
      },
      version: "v1",
    });
    vi.mocked(fetchKinds).mockResolvedValue([TASK_KIND] as never);
    vi.mocked(fetchEdges).mockResolvedValue([{ from: "plans/doc-reader-build", to: "tasks/alpha", text: "implements" }]);

    await render("tasks/alpha");

    expect(container.querySelector(".doc-head h1")!.textContent).toBe("Ship the reader");
    expect(container.querySelector(".pill")!.textContent).toBe("Task");
    const chips = [...container.querySelectorAll(".doc-chip")].map((c) => c.textContent);
    expect(chips).toContain("status: in_progress");
    expect(chips).toContain("priority: 1");
    // An undeclared field is NEVER a chip — chips are the kind's vocabulary, not the doc's.
    expect(chips.join("|")).not.toContain("secret_internal");
    expect(chips.join("|")).not.toContain("updated_by");
    expect(container.querySelector(".doc-head-meta")!.textContent).toContain("alice");
    expect(container.querySelector(".doc-head-meta")!.textContent).not.toContain("mike");
    expect(container.querySelector(".doc-body h1")!.textContent).toBe("Progress");
    expect(container.querySelector(".doc-body a")!.getAttribute("href")).toBe("?view=doc&id=designs%2Fdoc-reader");
    expect(container.querySelector(".doc-backlinks")!.textContent).toContain("plans/doc-reader-build");
    expect(container.querySelector(".doc-backlinks")!.textContent).toContain("implements");
  });

  it("an unknown id renders the honest not-found state with a way home", async () => {
    vi.mocked(getDoc).mockRejectedValue(new ApiError(404, "NOT_FOUND", "no such doc"));
    await render("tasks/ghost");
    expect(container.textContent).toContain("No doc 'tasks/ghost' exists");
    expect(container.querySelector(".doc-terminal .page-back")).not.toBeNull();
    expect(container.querySelector(".doc-body")).toBeNull();
  });

  it("a non-404 failure reports the error without claiming absence", async () => {
    vi.mocked(getDoc).mockRejectedValue(new ApiError(502, "RUNTIME", "upstream broke"));
    await render("tasks/alpha");
    expect(container.textContent).toContain("Could not load 'tasks/alpha'");
    expect(container.textContent).not.toContain("No doc");
  });

  it("renders a bare concept-link block as an INLINE 'verb → target-title' edge list in the body — no separate section", async () => {
    vi.mocked(getDoc).mockResolvedValue({
      doc: {
        id: "roadmap-items/x",
        frontmatter: { type: "Roadmap Item", title: "X" },
        body: "Ships the inventory.\n\n[contains](../tasks/a.md)\n\n[contains](../tasks/b.md)",
      },
      version: "v1",
    });
    // Heads supply the target titles shown in the rows.
    vi.mocked(listAllHeads).mockResolvedValue([
      { id: "tasks/a", version: "v1", frontmatter: { type: "Task", title: "Inventory the resources" } },
      { id: "tasks/b", version: "v1", frontmatter: { type: "Task", title: "Verify the npm package" } },
    ] as never);
    vi.mocked(fetchEdges).mockResolvedValue([]); // no backlinks

    await render("roadmap-items/x");

    // Prose stays; the edges render inline in the body as an aligned edge list (NOT a separate section).
    expect(container.querySelector(".doc-body")!.textContent).toContain("Ships the inventory.");
    expect(container.querySelector(".doc-links")).toBeNull();
    const rows = [...container.querySelectorAll(".doc-body .doc-edge-list .doc-edge-row")];
    expect(rows).toHaveLength(2);
    // Each row shows the authored verb → the TARGET's title, and routes to the target.
    expect(rows[0]!.querySelector(".doc-edge-verb")!.textContent).toBe("contains");
    expect(rows[0]!.querySelector(".doc-edge-target")!.textContent).toBe("Inventory the resources");
    expect(rows[0]!.getAttribute("href")).toBe("?view=doc&id=tasks%2Fa");
    expect(rows[1]!.querySelector(".doc-edge-target")!.textContent).toBe("Verify the npm package");
  });

  it("an inline edge row falls back to the target id when no title is known, and still routes there (dangling target)", async () => {
    vi.mocked(getDoc).mockImplementation(async (id: string) => {
      if (id === "tasks/src") {
        return { doc: { id, frontmatter: { type: "Task", title: "Src" }, body: "[contains](../tasks/ghost.md)" }, version: "v1" };
      }
      throw new ApiError(404, "NOT_FOUND", "no such doc");
    });
    vi.mocked(listAllHeads).mockResolvedValue([]); // ghost has no head → no title

    await render("tasks/src");
    const row = container.querySelector(".doc-body .doc-edge-row") as HTMLAnchorElement;
    expect(row, "the dangling target still renders as an edge row").toBeTruthy();
    expect(row.querySelector(".doc-edge-target")!.textContent).toBe("tasks/ghost");
    expect(row.getAttribute("href")).toBe("?view=doc&id=tasks%2Fghost");
  });

  it("an inline concept link EMBEDDED in a sentence renders as prose, not an edge row", async () => {
    vi.mocked(getDoc).mockResolvedValue({
      doc: { id: "docs/x", frontmatter: { type: "Doc", title: "X" }, body: "The archive [contains](../refs/history.md) the history." },
      version: "v1",
    });
    await render("docs/x");
    expect(container.querySelector(".doc-edge-list")).toBeNull();
    expect(container.querySelector(".doc-body")!.textContent).toBe("The archive contains the history.");
    expect(container.querySelector(".doc-body a")!.getAttribute("href")).toBe("?view=doc&id=refs%2Fhistory");
  });

  it("a doc with no body edges and no backlinks shows the quiet Cited-by empty state", async () => {
    vi.mocked(getDoc).mockResolvedValue({ doc: { id: "notes/lonely", frontmatter: { type: "Context Note", title: "Lonely" }, body: "" }, version: "v1" });
    vi.mocked(fetchEdges).mockResolvedValue([]);
    await render("notes/lonely");
    expect(container.querySelector(".doc-links")).toBeNull();
    expect(container.querySelector(".doc-edge-list")).toBeNull();
    expect(container.querySelector(".doc-backlinks-empty")!.textContent).toBe("Nothing cites this doc yet.");
  });
});
