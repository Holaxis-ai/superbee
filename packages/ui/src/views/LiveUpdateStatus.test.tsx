import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { StreamStatus } from "../pages/pageEvents.js";
import { LiveUpdateStatus } from "./LiveUpdateStatus.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const store = vi.hoisted(() => ({ status: "connecting" as StreamStatus, notify: () => {} }));
vi.mock("../pages/pageEvents.js", () => ({
  getStreamStatus: () => store.status,
  subscribeToStreamStatus: (notify: () => void) => { store.notify = notify; return () => {}; },
}));

it("shows disconnection without replacing content and clears it on recovery", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<><LiveUpdateStatus /><p>Current document remains open</p></>); });
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => { store.status = "disconnected"; store.notify(); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Refresh the page");
    expect(container.textContent).toContain("Current document remains open");
    await act(async () => { store.status = "live"; store.notify(); });
    expect(container.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
