import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  });

  it("sends a refused tab back to the terminal, never to a removed remote flow", async () => {
    await act(async () => {
      root.render(<ReloginScreen kind="unauthorized" />);
      await flush();
    });

    const text = container.textContent ?? "";
    expect(text).toContain("rerun the ui command");
    expect(text).not.toContain("--remote");
    expect(text).not.toContain("SUPERBEE_API_KEY");
  });
});
