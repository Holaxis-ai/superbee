import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  DEFAULT_MAX_FRAME_HEIGHT,
  FRAME_SIZE_MESSAGE_TYPE,
  appendFrameSizingScript,
  clampFrameHeight,
  createFrameSizingSession,
  flexibleHostHeightLimit,
  hasFixedHostHeight,
  measureShellChromeHeight,
  readFrameSizeEvent,
  readFrameSizeMessage,
} from "../src/frame-sizing.js";

const session = createFrameSizingSession(
  "launch-current",
  7,
  "0123456789abcdef0123456789abcdef",
);

test("the injected observer reports initial and live intrinsic height with mount identity", () => {
  const source = `<!doctype html><html><body>
    <main>content</main>
    <script>
      window.__height = 42.2;
      window.__htmlScrollFloor = 0;
      window.__htmlClientHeight = 0;
      document.documentElement.getBoundingClientRect = () => ({ height: window.__height });
      document.body.getBoundingClientRect = () => ({ height: window.__height });
      Object.defineProperty(document.documentElement, "scrollHeight", {
        get: () => Math.max(window.__height, window.__htmlScrollFloor)
      });
      Object.defineProperty(document.documentElement, "clientHeight", {
        get: () => window.__htmlClientHeight
      });
      Object.defineProperty(document.body, "scrollHeight", {
        get: () => window.__height
      });
      window.requestAnimationFrame = (callback) => { callback(); return 1; };
      window.__messages = [];
      window.parent.postMessage = (message) => window.__messages.push(message);
      window.ResizeObserver = class {
        constructor(callback) { window.__resize = callback; }
        observe() {}
      };
      window.MutationObserver = class {
        constructor(callback) { window.__mutation = callback; }
        observe(target, options) { window.__mutationObservation = { target, options }; }
      };
    </script>
  </body></html>`;
  const instrumented = appendFrameSizingScript(source, session);
  const browser = new JSDOM(instrumented, { runScripts: "dangerously" });

  assert.deepEqual(JSON.parse(JSON.stringify(browser.window.__messages)), [
    {
      type: FRAME_SIZE_MESSAGE_TYPE,
      launchId: session.launchId,
      epoch: session.epoch,
      nonce: session.nonce,
      height: 43,
    },
  ]);

  browser.window.__height = 88.1;
  browser.window.__resize();
  assert.equal(browser.window.__messages.at(-1).height, 89);

  browser.window.__height = 101.1;
  browser.window.__mutation();
  assert.equal(
    browser.window.__messages.at(-1).height,
    102,
    "overflow-only DOM changes are remeasured even when observed boxes stay fixed",
  );
  assert.equal(
    browser.window.__mutationObservation.target,
    browser.window.document.documentElement,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(browser.window.__mutationObservation.options)),
    {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    },
  );

  browser.window.__height = 144.4;
  browser.window.dispatchEvent(new browser.window.Event("resize"));
  assert.equal(
    browser.window.__messages.at(-1).height,
    145,
    "viewport-driven reflow is measured through the window resize path",
  );

  browser.window.__height = 51.1;
  browser.window.__htmlScrollFloor = 900;
  browser.window.__htmlClientHeight = 900;
  browser.window.__resize();
  assert.equal(
    browser.window.__messages.at(-1).height,
    52,
    "content shrink is reported even when the root scroll height is floored by the applied viewport",
  );

  browser.window.__htmlScrollFloor = 1_000;
  browser.window.__htmlClientHeight = 900;
  browser.window.__mutation();
  assert.equal(
    browser.window.__messages.at(-1).height,
    1_000,
    "root overflow beyond the viewport remains part of intrinsic height",
  );

  browser.window.__resize();
  assert.equal(
    browser.window.__messages.length,
    6,
    "unchanged measurements are not re-posted",
  );
  assert.doesNotMatch(
    instrumented,
    /\.style\.height/,
    "measuring an observed document must not mutate its height and retrigger the observer",
  );
});

test("size messages are accepted only for the exact launch, epoch, and nonce", () => {
  const accepted = {
    type: FRAME_SIZE_MESSAGE_TYPE,
    launchId: session.launchId,
    epoch: session.epoch,
    nonce: session.nonce,
    height: 200.1,
  };
  assert.deepEqual(readFrameSizeMessage(accepted, session), {
    kind: "accepted",
    height: 201,
  });
  assert.deepEqual(readFrameSizeMessage({ type: "bridge", height: 200 }, session), {
    kind: "other",
  });

  for (const message of [
    { ...accepted, launchId: "launch-stale" },
    { ...accepted, epoch: session.epoch - 1 },
    { ...accepted, nonce: "fedcba9876543210fedcba9876543210" },
    { ...accepted, height: 0 },
    { ...accepted, height: -1 },
    { ...accepted, height: Number.NaN },
    { ...accepted, height: Number.POSITIVE_INFINITY },
    { ...accepted, height: "200" },
  ]) {
    assert.deepEqual(readFrameSizeMessage(message, session), { kind: "invalid" });
  }
});

test("size events must come from the currently mounted child window", () => {
  const expectedSource = {};
  const accepted = {
    type: FRAME_SIZE_MESSAGE_TYPE,
    launchId: session.launchId,
    epoch: session.epoch,
    nonce: session.nonce,
    height: 200,
  };

  assert.deepEqual(
    readFrameSizeEvent(
      accepted,
      expectedSource,
      expectedSource,
      session,
      session.epoch,
    ),
    { kind: "accepted", height: 200 },
  );
  assert.deepEqual(
    readFrameSizeEvent(accepted, {}, expectedSource, session, session.epoch),
    { kind: "invalid" },
  );
  assert.deepEqual(
    readFrameSizeEvent(
      accepted,
      expectedSource,
      expectedSource,
      session,
      session.epoch + 1,
    ),
    { kind: "invalid" },
    "retiring the mount epoch invalidates its otherwise matching size session",
  );
  assert.deepEqual(
    readFrameSizeEvent(
      { type: "bridge", height: 200 },
      {},
      expectedSource,
      session,
      session.epoch,
    ),
    { kind: "other" },
  );
});

test("fixed and flexible host height contracts stay distinct", () => {
  const fixedHostViewport = 288;
  const frameHeight = 288;
  const shellHeight = 341;
  const chromeHeight = measureShellChromeHeight(shellHeight, frameHeight);

  assert.equal(hasFixedHostHeight({ height: fixedHostViewport }), true);
  assert.equal(hasFixedHostHeight({ maxHeight: 800 }), false);
  assert.equal(hasFixedHostHeight(undefined), false);
  assert.equal(
    flexibleHostHeightLimit({ height: fixedHostViewport }),
    undefined,
    "fixed height is not an intrinsic-resize ceiling because the host owns that dimension",
  );
  assert.equal(flexibleHostHeightLimit({ maxHeight: 800 }), 800);
  assert.equal(
    chromeHeight,
    53,
    "unused fixed-host viewport space is not charged as shell chrome",
  );
  assert.equal(measureShellChromeHeight(Number.NaN, frameHeight), 0);
});

test("active View size reports are handled before the hidden-document bridge gate", async () => {
  const source = await readFile(
    new URL("../src/view.ts", import.meta.url),
    "utf8",
  );
  const handlerStart = source.indexOf('window.addEventListener("message"');
  const handlerEnd = source.indexOf(
    'document.addEventListener("visibilitychange"',
    handlerStart,
  );
  const handler = source.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.ok(
    handler.indexOf("if (frameSizingSession)") <
      handler.indexOf('document.visibilityState === "hidden"'),
    "layout-only reports must update active Views while hidden; only the durable bridge is gated",
  );
  assert.match(
    source,
    /if \(hasFixedHostHeight\(currentHostContext\?\.containerDimensions\)\) \{\s*frame\.style\.removeProperty\("height"\);\s*return;/,
    "a fixed host owns outer height and receives a fill-and-scroll child rather than resize pressure",
  );
  assert.match(
    source,
    /\{ availableDisplayModes: \["inline", "fullscreen"\] \}/,
    "the shell declares only the inline and explicit expansion modes it implements",
  );
  assert.match(
    source,
    /availableDisplayModes\?\.includes\(target\)/,
    "the expand control is exposed only when the host advertises the target mode",
  );
  assert.match(
    source,
    /app\.requestDisplayMode\(\{ mode: target \}\)/,
    "the trusted shell uses the standard host-mediated display-mode request",
  );
  const html = await readFile(
    new URL("../src/view.html", import.meta.url),
    "utf8",
  );
  assert.match(
    html,
    /html\[data-fixed-height\] iframe \{\s*flex: 1 1 auto;\s*height: auto;/,
    "a fixed host's frame fills the remaining card allocation",
  );
  assert.match(html, /Waiting for a Superbee View/, "the static MCP shell uses the current product identity");
  assert.match(html, /title="Superbee View"/, "the static iframe title uses the current product identity");
  assert.match(html, /Superbee confirmation/, "the static approval shell uses the current product identity");
  assert.doesNotMatch(html, /AgentState/, "the static MCP shell must not retain the prior product label");
  assert.match(
    html,
    /html\[data-fixed-height\], html\[data-fixed-height\] body \{\s*height: 100%;\s*overflow: hidden;/,
    "the trusted shell itself never creates a second outer scrollbar in fixed mode",
  );
  assert.match(
    source.slice(handlerEnd),
    /frameEpoch\+\+;\s+resetFrameSizing\(\);\s+stopPolling\(\);/,
    "suspended durable mounts invalidate their sizing session with their bridge epoch",
  );
});

test("height is capped by both the host and the product ceiling after shell chrome", () => {
  assert.equal(clampFrameHeight(120.1), 121);
  assert.equal(clampFrameHeight(100_000), DEFAULT_MAX_FRAME_HEIGHT);
  const flexibleLimit = flexibleHostHeightLimit({ maxHeight: 800 });
  const hostBoundFrame = clampFrameHeight(2_000, {
    hostHeightLimit: flexibleLimit,
    shellChromeHeight: 125.2,
  });
  assert.equal(hostBoundFrame, 674);
  const chromeDominatedFrame = clampFrameHeight(200, {
    hostHeightLimit: 100,
    shellChromeHeight: 500,
  });
  assert.equal(chromeDominatedFrame, 1);
  assert.equal(
    clampFrameHeight(200, {
      hostHeightLimit: Number.NaN,
      shellChromeHeight: Number.NaN,
    }),
    200,
  );
});

test("the product observer is inserted inside a valid body without rewriting source bytes", () => {
  const source = "<!doctype html><html><body><p>exact</p></body></html>";
  const instrumented = appendFrameSizingScript(source, session);

  assert.ok(instrumented.startsWith("<!doctype html><html><body><p>exact</p>"));
  assert.ok(instrumented.endsWith("</body></html>"));
  assert.match(instrumented, new RegExp(FRAME_SIZE_MESSAGE_TYPE));
  assert.ok(
    instrumented.indexOf("<script") > instrumented.indexOf("<p>exact</p>"),
  );
  assert.ok(instrumented.indexOf("<script") < instrumented.indexOf("</body>"));
});
