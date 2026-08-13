import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReloginScreen } from "./ReloginScreen.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ReloginScreen", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("directs a rejected remote key through the supported env-and-relaunch path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mode: "remote", remoteUrl: "https://remote.example" }),
      })),
    );

    await act(async () => {
      root.render(<ReloginScreen kind="unauthorized" />);
      await flush();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("SUPERBEE_API_KEY");
    expect(text).toContain("ui --remote");
    expect(text).toContain("https://remote.example");
    expect(text).not.toContain("agentstate-lite login");
    expect(text).not.toContain("agentstate-lite ui");
  });
});
