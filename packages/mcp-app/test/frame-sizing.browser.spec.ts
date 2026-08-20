import { readFile } from "node:fs/promises";

import { expect, test, type Frame, type Page } from "@playwright/test";
import { build } from "esbuild";

import {
  FRAME_SIZE_MESSAGE_TYPE,
  appendFrameSizingScript,
  createFrameSizingSession,
} from "../src/frame-sizing.ts";
import { buildMcpViewHtml } from "../scripts/build-view.mjs";

interface AppliedHeightReport {
  height: number;
  iframeHeight: number;
}

async function activeFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().filter((frame) => frame !== page.mainFrame()).length)
    .toBe(1);
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error("Expected one active View frame.");
  return frame;
}

async function lifecycleHost(
  page: Page,
  options: { initialVisibility?: DocumentVisibilityState; authorized?: boolean } = {},
): Promise<Frame> {
  const hostBundle = await build({
    entryPoints: [
      new URL("./fixtures/display-mode-host.ts", import.meta.url).pathname,
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  const hostScript = hostBundle.outputFiles?.[0]?.text;
  if (!hostScript) throw new Error("MCP lifecycle host build produced no JavaScript.");
  await page.setContent(
    `<!doctype html><html><body><iframe id="app"></iframe><script>window.__initialAuthorized = ${options.authorized === true};</script><script>${hostScript.replaceAll("</script", "<\\/script")}</script></body></html>`,
  );
  const visibilitySetup = options.initialVisibility === undefined
    ? ""
    : `
      window.__testVisibilityState = ${JSON.stringify(options.initialVisibility)};
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => window.__testVisibilityState,
      });
      Object.defineProperty(window, "__testVisibilityInstalled", { value: true });
    `;
  const html = (await buildMcpViewHtml()).replace(
    "<script>",
    `<script>
      if (typeof crypto.randomUUID !== "function") {
        crypto.randomUUID = () => "00000000-0000-4000-8000-000000000001";
      }
      ${visibilitySetup}
    </script><script>`,
  );
  await page.locator("#app").evaluate(
    (element, source) => {
      (element as HTMLIFrameElement).srcdoc = source;
    },
    html,
  );
  await expect
    .poll(() => page.evaluate(() => window.__hostInitialized === true))
    .toBe(true);
  const outer = page
    .frames()
    .find((frame) => frame.parentFrame() === page.mainFrame());
  if (!outer) throw new Error("Expected one MCP App frame.");
  return outer;
}

test("an authorized first result delivered while hidden resumes when visible", async ({
  page,
}) => {
  const outer = await lifecycleHost(page, {
    initialVisibility: "hidden",
    authorized: true,
  });
  await expect
    .poll(() => page.evaluate(() => window.__resumeRequests))
    .toEqual([]);
  await expect
    .poll(() => page.evaluate(() => window.__bridgeRequests))
    .toEqual([]);
  await expect
    .poll(async () => {
      const hiddenChild = page.frames().find((frame) => frame.parentFrame() === outer);
      return hiddenChild ? await hiddenChild.locator("#hello").count() : 0;
    })
    .toBe(0);

  await setDocumentVisibility(outer, "visible");
  await expect
    .poll(() => page.evaluate(() => window.__resumeRequests))
    .toEqual(["launch-inline"]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__bridgeRequests.map((entry) => {
          const call = entry as {
            launchId?: unknown;
            request?: { type?: unknown };
          };
          return { launchId: call.launchId, type: call.request?.type };
        }),
      ),
    )
    .toEqual([
      { launchId: "launch-resumed-1", type: "hello" },
      { launchId: "launch-resumed-1", type: "subscribe" },
    ]);
  await expect
    .poll(() => page.evaluate(() => window.__pollRequests))
    .toContain("launch-resumed-1");
  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .toContain("launch-inline");
  const active = page.frames().find((frame) => frame.parentFrame() === outer);
  if (!active) throw new Error("Expected the resumed View frame.");
  await expect(active.locator("#hello")).toHaveText("hello:result");
  await expect(active.locator("#subscribe")).toHaveText("subscribe:result");
});

async function setDocumentVisibility(
  frame: Frame,
  state: DocumentVisibilityState,
): Promise<void> {
  await frame.evaluate((next) => {
    const target = window as Window & {
      __testVisibilityState?: DocumentVisibilityState;
    };
    target.__testVisibilityState = next;
    if (!Object.hasOwn(target, "__testVisibilityInstalled")) {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => target.__testVisibilityState ?? "visible",
      });
      Object.defineProperty(target, "__testVisibilityInstalled", {
        value: true,
      });
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("a flexible parent can apply growth and still receive intrinsic shrink", async ({
  page,
}) => {
  const session = createFrameSizingSession(
    "browser-feedback-loop",
    1,
    "0123456789abcdef0123456789abcdef",
  );
  const source = appendFrameSizingScript(
    `<!doctype html><html><head><style>
      html, body { margin: 0; padding: 0; }
      #content { height: 150px; }
    </style></head><body><main id="content"></main></body></html>`,
    session,
  );

  await page.setContent(`<!doctype html><html><body>
    <iframe id="active-view" style="display:block;width:400px;height:150px;border:0"></iframe>
  </body></html>`);
  await page.evaluate(
    ({ html, messageType }) => {
      const frame = document.querySelector<HTMLIFrameElement>("#active-view");
      if (!frame) throw new Error("Missing active View frame.");
      window.__appliedHeightReports = [];
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.data?.type !== messageType) {
          return;
        }
        frame.style.height = `${event.data.height}px`;
        window.__appliedHeightReports.push({
          height: event.data.height,
          iframeHeight: frame.getBoundingClientRect().height,
        });
      });
      frame.srcdoc = html;
    },
    { html: source, messageType: FRAME_SIZE_MESSAGE_TYPE },
  );

  const child = await activeFrame(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__appliedHeightReports as AppliedHeightReport[] | undefined
          )?.at(-1)?.height,
      ),
    )
    .toBe(150);

  await child.locator("#content").evaluate((element) => {
    element.style.height = "900px";
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__appliedHeightReports as AppliedHeightReport[] | undefined
          )?.at(-1)?.height,
      ),
    )
    .toBe(900);

  await child.locator("#content").evaluate((element) => {
    element.style.height = "180px";
  });
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => {
      const frame =
        document.querySelector<HTMLIFrameElement>("#active-view");
      const documentElement = frame?.contentDocument?.documentElement;
      const body = frame?.contentDocument?.body;
      const content =
        frame?.contentDocument?.querySelector<HTMLElement>("#content");
      return {
        reports: window.__appliedHeightReports,
        iframeHeight: frame?.getBoundingClientRect().height,
        htmlScrollHeight: documentElement?.scrollHeight,
        bodyScrollHeight: body?.scrollHeight,
        htmlBounds: documentElement?.getBoundingClientRect().height,
        bodyBounds: body?.getBoundingClientRect().height,
        contentBounds: content?.getBoundingClientRect().height,
      };
    }),
  ).toEqual({
      reports: [
        { height: 150, iframeHeight: 150 },
        { height: 900, iframeHeight: 900 },
        { height: 180, iframeHeight: 180 },
      ],
      iframeHeight: 180,
      htmlScrollHeight: 180,
      bodyScrollHeight: 180,
      htmlBounds: 180,
      bodyBounds: 180,
      contentBounds: 180,
  });
});

test("a hidden first mount and a visible remount size without interaction", async ({
  page,
}) => {
  const instrument = (launchId: string, epoch: number) =>
    appendFrameSizingScript(
      `<!doctype html><html><head><style>
        html, body { margin: 0; padding: 0; }
        main { height: 220px; }
      </style></head><body><main></main></body></html>`,
      createFrameSizingSession(
        launchId,
        epoch,
        `${String(epoch).padStart(32, "0")}`,
      ),
    );
  const firstSource = instrument("hidden-first-mount", 1);
  const remountSource = instrument("visible-remount", 2);

  await page.setContent(`<!doctype html><html><body>
    <section id="slot" hidden></section>
    <script>
      window.__mountReports = [];
      window.addEventListener("message", (event) => {
        if (event.data?.type !== ${JSON.stringify(FRAME_SIZE_MESSAGE_TYPE)}) return;
        const frame = document.querySelector("#active-view");
        if (event.source !== frame?.contentWindow) return;
        frame.style.height = event.data.height + "px";
        window.__mountReports.push({
          launchId: event.data.launchId,
          height: event.data.height
        });
      });
    </script>
  </body></html>`);

  await page.evaluate((html) => {
    const slot = document.querySelector<HTMLElement>("#slot");
    if (!slot) throw new Error("Missing mount slot.");
    const frame = document.createElement("iframe");
    frame.id = "active-view";
    frame.style.cssText = "display:block;width:400px;height:1px;border:0";
    frame.srcdoc = html;
    slot.append(frame);
  }, firstSource);
  await page.locator("#slot").evaluate((slot) => {
    slot.hidden = false;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__mountReports as
              | Array<{ launchId: string; height: number }>
              | undefined
          )?.at(-1),
      ),
    )
    .toEqual({ launchId: "hidden-first-mount", height: 220 });

  await page.evaluate((html) => {
    const previous =
      document.querySelector<HTMLIFrameElement>("#active-view");
    previous?.remove();
    const frame = document.createElement("iframe");
    frame.id = "active-view";
    frame.style.cssText = "display:block;width:400px;height:1px;border:0";
    frame.srcdoc = html;
    document.querySelector("#slot")?.append(frame);
  }, remountSource);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__mountReports as
              | Array<{ launchId: string; height: number }>
              | undefined
          )?.at(-1),
      ),
    )
    .toEqual({ launchId: "visible-remount", height: 220 });
});

test("a 288px fixed host has no outer scroll and keeps child scrolling", async ({
  browser,
}) => {
  const page = await browser.newPage({
    viewport: { width: 640, height: 288 },
  });
  const viewHtml = await readFile(
    new URL("../src/view.html", import.meta.url),
    "utf8",
  );
  await page.setContent(
    viewHtml.replace("<!-- ASLITE_MCP_APP_SCRIPT -->", ""),
  );
  await page.evaluate(() => {
    document.documentElement.dataset.fixedHeight = "true";
    const frame =
      document.querySelector<HTMLIFrameElement>("#active-view");
    if (!frame) throw new Error("Missing active View frame.");
    frame.srcdoc = `<!doctype html><html><head><style>
      html, body { margin: 0; }
      main { height: 1200px; }
    </style></head><body><main>long content</main></body></html>`;
  });
  const child = await activeFrame(page);

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight))
    .toBe(288);
  const fixedLayout = await page.evaluate(() => ({
    outerClientHeight: document.documentElement.clientHeight,
    outerScrollHeight: document.documentElement.scrollHeight,
    shellHeight:
      document.querySelector(".shell")?.getBoundingClientRect().height,
    frameHeight:
      document.querySelector("#active-view")?.getBoundingClientRect().height,
  }));
  expect(fixedLayout.outerClientHeight).toBe(288);
  expect(fixedLayout.outerScrollHeight).toBe(288);
  expect(fixedLayout.shellHeight).toBe(288);
  expect(fixedLayout.frameHeight).toBeCloseTo(235.89, 1);
  await expect
    .poll(() =>
      child.evaluate(() => ({
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      })),
    )
    .toEqual({ clientHeight: 236, scrollHeight: 1200 });

  await child.evaluate(() => window.scrollTo(0, 400));
  await expect
    .poll(() => child.evaluate(() => document.documentElement.scrollTop))
    .toBe(400);
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  await page.close();
});

test("fullscreen visibility transitions rotate a fresh durable launch in both directions", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  const authorization = outer.locator("#authorization-apply");
  await expect(authorization).toBeVisible();
  await expect(authorization).toBeEnabled();
  await authorization.click();
  await expect(outer.locator("#status")).toContainText(
    "exact registered View",
  );
  await expect(outer.locator("#display-mode")).toHaveText("Expand");

  await outer.locator("#display-mode").click();
  await expect
    .poll(() => page.evaluate(() => window.__displayRequests))
    .toEqual(["fullscreen"]);
  await setDocumentVisibility(outer, "hidden");
  await setDocumentVisibility(outer, "visible");
  await expect(outer.locator("#status")).not.toContainText(
    "Reopen this View after suspension",
  );
  await expect(outer.locator("#display-mode")).toHaveText("Return inline");
  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .toContain("launch-inline");

  await page.evaluate(() => {
    window.__holdDisplayRequest = true;
  });
  await outer.locator("#display-mode").click();
  await expect
    .poll(() => page.evaluate(() => window.__displayRequests))
    .toEqual(["fullscreen", "inline"]);
  await setDocumentVisibility(outer, "hidden");
  await setDocumentVisibility(outer, "visible");
  await page.evaluate(() => {
    window.__releaseDisplayRequest();
  });
  await expect(outer.locator("#status")).not.toContainText(
    "Reopen this View after suspension",
  );
  await expect(outer.locator("#display-mode")).toHaveText("Expand");

  const nested = page
    .frames()
    .find((frame) => frame.parentFrame() === outer);
  if (!nested) throw new Error("Expected the resumed registered View frame.");
  await expect(nested.locator("#inside")).toBeVisible();

  await page.evaluate(() => {
    window.__holdResumeRequest = true;
  });
  await setDocumentVisibility(outer, "hidden");
  await setDocumentVisibility(outer, "visible");
  await expect
    .poll(() => page.evaluate(() => window.__resumeRequests))
    .toHaveLength(3);
  await setDocumentVisibility(outer, "hidden");
  await setDocumentVisibility(outer, "visible");
  await page.evaluate(() => {
    window.__holdResumeRequest = false;
    window.__releaseResumeRequest();
  });
  await expect
    .poll(() => page.evaluate(() => window.__resumeRequests))
    .toHaveLength(4);
  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .toContain("launch-resumed-3");
  await expect(outer.locator("#status")).not.toContainText("Reopen this View");
  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .toContain("launch-resumed-2");
});

test("authorization dialog reports registered and transient View provenance honestly", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  const description = outer.locator("#authorization-description");

  await expect(description).toContainText(
    "This registered View comes from the bundle",
  );
  await expect(description).not.toContainText("process-local");
  await expect(outer.locator("#authorization-view")).toHaveText(
    "pages-registry/roadmap",
  );

  await page.evaluate(() => window.__showTransientResult());
  await expect(description).toContainText(
    "agent-authored HTML created for this MCP session",
  );
  await expect(description).toContainText(
    "process-local and is not a registered bundle View",
  );
  await expect(outer.locator("#authorization-view")).toHaveText(
    "Transient process-local View",
  );
});

test("a bundleless access:none transient View renders without entering the approval lifecycle", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);

  await page.evaluate(() => window.__showBundlelessTransientResult());

  await expect(outer.locator("#authorization-backdrop")).toBeHidden();
  await expect
    .poll(() => page.frames().filter((frame) => frame.parentFrame() === outer).length)
    .toBe(1);
  const active = page.frames().find((frame) => frame.parentFrame() === outer);
  if (!active) throw new Error("Expected the bundleless transient View frame.");
  await expect(active.locator("#bundleless-control")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__authorizationRequests))
    .toEqual([]);
  await expect(outer.locator("#status")).not.toContainText(
    "invalid approved launch",
  );
});

test("open-page replaces the source with a fresh independently authorized registered View", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  await outer.locator("#authorization-apply").click();
  const sourceFrame = page.frames().find((frame) => frame.parentFrame() === outer);
  if (!sourceFrame) throw new Error("Expected the authorized source View frame.");

  await sourceFrame.locator("#navigate").click();
  await expect(outer.locator("#authorization-backdrop")).toBeVisible();
  await expect(outer.locator("#authorization-view")).toHaveText(
    "views-registry/target",
  );
  await expect(outer.locator("#status")).toContainText(
    "Waiting for local approval",
  );
  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .not.toContain("launch-navigation-target");

  await outer.locator("#authorization-apply").click();
  await expect(sourceFrame.locator("#target-control")).toBeVisible();
});

test("a delayed open-page result cannot replace a newer transient View", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  await outer.locator("#authorization-apply").click();
  const sourceFrame = page.frames().find((frame) => frame.parentFrame() === outer);
  if (!sourceFrame) throw new Error("Expected the authorized source View frame.");
  await page.evaluate(() => {
    window.__holdNavigationRequest = true;
  });

  await sourceFrame.locator("#navigate").click();
  await expect
    .poll(() => page.evaluate(() => window.__bridgeRequests.length))
    .toBe(1);
  await page.evaluate(() => window.__showTransientResult());
  await expect(outer.locator("#authorization-view")).toHaveText(
    "Transient process-local View",
  );
  await page.evaluate(() => window.__releaseNavigationRequest());

  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .toContain("launch-navigation-target");
  await expect(outer.locator("#authorization-view")).toHaveText(
    "Transient process-local View",
  );
  await expect(outer.locator("#status")).toContainText(
    "Waiting for local approval",
  );
});

test("bundle-propose active Views receive only a human-confirmed terminal action result", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  await page.evaluate(() => window.__showActionResult());
  await expect(outer.locator("#authorization-access")).toHaveText("bundle-propose");
  await expect(outer.locator("#authorization-description")).toContainText(
    "propose version-guarded changes that still require a separate human confirmation",
  );
  const authorization = outer.locator("#authorization-apply");
  await expect(authorization).toBeEnabled();
  await authorization.click();

  await expect
    .poll(() => page.frames().filter((frame) => frame.parentFrame() === outer).length)
    .toBe(1);
  const active = page.frames().find((frame) => frame.parentFrame() === outer);
  if (!active) throw new Error("Expected the active View frame.");
  await active.locator("#propose").click();

  await expect
    .poll(() => page.evaluate(() => window.__preparedActions.length))
    .toBe(1);
  await expect(outer.locator("#confirmation-document")).toContainText("Alpha");
  await expect(outer.locator("#confirmation-before")).toHaveText("todo");
  await expect(outer.locator("#confirmation-after")).toHaveText("done");
  await expect
    .poll(() => page.evaluate(() => window.__finishedActions.length))
    .toBe(0);

  const apply = outer.locator("#confirmation-apply");
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect
    .poll(() => page.evaluate(() => window.__finishedActions.length))
    .toBe(1);
  await expect(active.locator("#result")).toHaveText("committed");
});

test("active View proposals serialize before preparation and cancel on payload replacement", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  await page.evaluate(() => window.__showActionResult());
  await outer.locator("#authorization-apply").click();
  const active = page.frames().find((frame) => frame.parentFrame() === outer);
  if (!active) throw new Error("Expected the active View frame.");

  await active.locator("#propose").evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect
    .poll(() => page.evaluate(() => window.__preparedActions.length))
    .toBe(1);
  await expect(outer.locator("#confirmation-document")).toContainText("Alpha");

  await page.evaluate(() => window.__showTransientResult());
  await expect(outer.locator("#confirmation-backdrop")).toBeHidden();
  await expect(outer.locator("#authorization-view")).toHaveText(
    "Transient process-local View",
  );
  await expect
    .poll(() => page.evaluate(() => window.__finishedActions))
    .toEqual([
      expect.objectContaining({
        launchId: "launch-action",
        approvalToken: "approval-1",
        decision: "cancel",
      }),
    ]);
});

test("a delayed finish cannot overwrite a replacement View", async ({ page }) => {
  const outer = await lifecycleHost(page);
  await page.evaluate(() => window.__showActionResult());
  await outer.locator("#authorization-apply").click();
  const active = page.frames().find((frame) => frame.parentFrame() === outer);
  if (!active) throw new Error("Expected the active View frame.");
  await active.locator("#propose").click();
  await expect(outer.locator("#confirmation-apply")).toBeEnabled();
  await page.evaluate(() => {
    window.__holdFinishRequest = true;
  });
  await outer.locator("#confirmation-apply").click();
  await expect
    .poll(() => page.evaluate(() => window.__finishedActions.length))
    .toBe(1);

  await page.evaluate(() => window.__showTransientResult());
  await expect(outer.locator("#authorization-backdrop")).toBeVisible();
  await expect(outer.locator("#authorization-view")).toHaveText(
    "Transient process-local View",
  );
  await expect(outer.locator("#status")).toContainText(
    "Waiting for local approval",
  );

  await page.evaluate(() => window.__releaseFinishRequest());
  await page.waitForTimeout(50);
  await expect(outer.locator("#authorization-backdrop")).toBeVisible();
  await expect(outer.locator("#status")).toContainText(
    "Waiting for local approval",
  );
});

test("replayed results cannot reactivate a quarantined or retired durable launch", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  const authorization = outer.locator("#authorization-apply");
  await expect(authorization).toBeVisible();
  await expect(authorization).toBeEnabled();
  await authorization.click();
  await expect(outer.locator("#status")).toContainText(
    "exact registered View",
  );

  await page.evaluate(() => {
    window.__holdResumeRequest = true;
  });
  await setDocumentVisibility(outer, "hidden");
  await setDocumentVisibility(outer, "visible");
  await expect
    .poll(() => page.evaluate(() => window.__resumeRequests))
    .toEqual(["launch-inline"]);
  await page.evaluate(() => window.__replayOriginalResult());
  await page.evaluate(() => {
    window.__holdResumeRequest = false;
    window.__releaseResumeRequest();
  });
  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .toContain("launch-inline");

  await page.evaluate(() => window.__replayOriginalResult());
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__closedLaunches)).not.toContain(
    "launch-resumed-1",
  );
});

test("newer host display context wins over a delayed request result", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  const displayMode = outer.locator("#display-mode");
  await expect(displayMode).toHaveText("Expand");
  await page.evaluate(() => {
    window.__holdDisplayRequest = true;
    window.__displayResponseMode = "fullscreen";
    window.__suppressDisplayContextOnResolve = true;
  });
  await displayMode.click();
  await expect
    .poll(() => page.evaluate(() => window.__displayRequests))
    .toEqual(["fullscreen"]);

  await page.evaluate(() => window.__emitDisplayMode("fullscreen"));
  await expect(displayMode).toHaveText("Return inline");
  await page.evaluate(() => window.__emitDisplayMode("inline"));
  await expect(displayMode).toHaveText("Expand");
  await page.evaluate(() => window.__releaseDisplayRequest());
  await expect(displayMode).toBeEnabled();
  await expect(displayMode).toHaveText("Expand");
});

test("a stale display rejection cannot overwrite status after newer host success", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  const authorization = outer.locator("#authorization-apply");
  await expect(authorization).toBeVisible();
  await expect(authorization).toBeEnabled();
  await authorization.click();
  const status = outer.locator("#status");
  await expect(status).toContainText("exact registered View");

  const displayMode = outer.locator("#display-mode");
  await expect(displayMode).toHaveText("Expand");
  await page.evaluate(() => {
    window.__holdDisplayRequest = true;
    window.__displayRequestError = "late host rejection";
  });
  await displayMode.click();
  await expect
    .poll(() => page.evaluate(() => window.__displayRequests))
    .toEqual(["fullscreen"]);

  await page.evaluate(() => window.__emitDisplayMode("fullscreen"));
  await expect(displayMode).toHaveText("Return inline");
  await page.evaluate(() => window.__releaseDisplayRequest());
  await expect(displayMode).toBeEnabled();
  await expect(displayMode).toHaveText("Return inline");
  await expect(status).toContainText("exact registered View");
  await expect(status).not.toContainText("late host rejection");
});

test("explicit resource teardown waits for the durable launch to close", async ({
  page,
}) => {
  const outer = await lifecycleHost(page);
  const authorization = outer.locator("#authorization-apply");
  await expect(authorization).toBeVisible();
  await expect(authorization).toBeEnabled();
  await authorization.click();
  await expect(outer.locator("#status")).toContainText(
    "exact registered View",
  );

  await page.evaluate(() => {
    window.__holdCloseRequest = true;
    window.__startTeardown();
  });
  await expect
    .poll(() => page.evaluate(() => window.__closedLaunches))
    .toContain("launch-inline");
  await expect
    .poll(() => page.evaluate(() => window.__teardownSettled))
    .toBe(false);
  await page.evaluate(() => {
    window.__holdCloseRequest = false;
    window.__releaseCloseRequest();
  });
  await expect
    .poll(() => page.evaluate(() => window.__teardownSettled))
    .toBe(true);
});

declare global {
  interface Window {
    __appliedHeightReports?: AppliedHeightReport[];
    __closedLaunches: string[];
    __bridgeRequests: unknown[];
    __authorizationRequests: string[];
    __preparedActions: unknown[];
    __finishedActions: unknown[];
    __displayRequestError: string | null;
    __displayResponseMode: "inline" | "fullscreen" | null;
    __displayRequests: string[];
    __pollRequests: string[];
    __resumeRequests: string[];
    __holdCloseRequest: boolean;
    __holdNavigationRequest: boolean;
    __holdDisplayRequest: boolean;
    __holdResumeRequest: boolean;
    __hostInitialized?: boolean;
    __mountReports?: Array<{ launchId: string; height: number }>;
    __suppressDisplayContextOnResolve: boolean;
    __teardownSettled: boolean;
    __emitDisplayMode: (mode: "inline" | "fullscreen") => void;
    __replayOriginalResult: () => Promise<void>;
    __releaseCloseRequest: () => void;
    __releaseNavigationRequest: () => void;
    __releaseDisplayRequest: () => void;
    __releaseResumeRequest: () => void;
    __startTeardown: () => void;
    __showTransientResult: () => Promise<void>;
    __showBundlelessTransientResult: () => Promise<void>;
    __showActionResult: () => Promise<void>;
  }
}
