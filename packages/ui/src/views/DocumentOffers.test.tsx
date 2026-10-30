import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentOffers } from "./DocumentOffers.js";
import { readShellJson } from "../api/pages.js";
import type { DocumentOffersSnapshot } from "@superbee/ui-server";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const callbacks = vi.hoisted(() => ({ offer: undefined as ((snapshot: DocumentOffersSnapshot) => void) | undefined }));
vi.mock("../api/pages.js", () => ({ readShellJson: vi.fn() }));
vi.mock("../pages/pageEvents.js", async (original) => ({
  ...await original<typeof import("../pages/pageEvents.js")>(),
  subscribeToDocumentOffers: (handler: typeof callbacks.offer) => { callbacks.offer = handler; return () => { callbacks.offer = undefined; }; },
  subscribeToResync: () => () => {},
}));
afterEach(() => { vi.resetAllMocks(); });

it("preserves the current page and a newer offer through a stale initial snapshot, then opens only on choice", async () => {
  window.history.replaceState({}, "", "/?view=doc&id=docs/original");
  let finish!: (value: unknown) => void;
  vi.mocked(readShellJson).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<DocumentOffers />); });
    await act(async () => {
      callbacks.offer!({ revision: 2, offers: [{ documentId: "docs/new", expiresAt: Date.now() + 60_000 }] });
      finish({ revision: 1, offers: [{ documentId: "docs/old", expiresAt: Date.now() + 60_000 }] });
    });
    expect(container.textContent).toContain("docs/new");
    expect(container.textContent).not.toContain("docs/old");
    expect(new URLSearchParams(window.location.search).get("id")).toBe("docs/original");
    const open = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open")!;
    await act(async () => { open.click(); });
    expect(new URLSearchParams(window.location.search).get("id")).toBe("docs/new");
    expect(container.textContent).not.toContain("docs/new");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
