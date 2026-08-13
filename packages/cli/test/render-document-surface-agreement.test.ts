import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryBackend,
  writeBlob,
  writeDoc,
  type Bundle,
  type ConceptId,
  type ReadResult,
} from "@superbee/core";
import { renderDocumentToStaticHtml } from "@superbee/markdown-renderer/static";
import {
  AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
  DURABLE_VIEW_BRIDGE_TOOL_NAME,
  SHOW_VIEW_TOOL_NAME,
  createMcpAppServer,
} from "@superbee/mcp-app";
import { createRouter } from "@superbee/server";
import { bootUiServer } from "@superbee/ui-server";
import { SessionViewAuthorizationStore } from "@superbee/view-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const T = "2026-08-02T00:00:00.000Z";
const SECRET = "render-document-agreement-secret";

class LaunchChangingBackend extends MemoryBackend {
  private changeOnTargetRead = false;

  armLaunchChange(): void {
    this.changeOnTargetRead = true;
  }

  override async read(id: ConceptId): Promise<ReadResult> {
    const result = await super.read(id);
    if (this.changeOnTargetRead && id === "docs/change") {
      this.changeOnTargetRead = false;
      await this.writeBlob(
        "views/agreement.html",
        new TextEncoder().encode("<!doctype html><p>changed while rendering</p>"),
        "text/html; charset=utf-8",
      );
    }
    return result;
  }
}

interface Surface {
  authorize(): Promise<void>;
  request(docId: string): Promise<Record<string, any>>;
  navigate(): Promise<Record<string, any>>;
  armLaunchChange(): void;
  close(): Promise<void>;
}

async function seed(): Promise<{ bundle: Bundle; backend: LaunchChangingBackend }> {
  const backend = new LaunchChangingBackend();
  const bundle: Bundle = { root: "mem://render-document-agreement", backend };
  await writeDoc(bundle, {
    id: "views-registry/agreement",
    frontmatter: {
      type: "View",
      title: "Agreement",
      entry: "views/agreement.html",
      access: "bundle-read",
      timestamp: T,
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/agreement.html",
    new TextEncoder().encode("<!doctype html><p>agreement</p>"),
    "text/html; charset=utf-8",
  );
  await writeDoc(bundle, {
    id: "views-registry/target",
    frontmatter: {
      type: "View",
      title: "Target",
      entry: "views/target.html",
      access: "bundle-read",
      timestamp: T,
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/target.html",
    new TextEncoder().encode("<!doctype html><p>target</p>"),
    "text/html; charset=utf-8",
  );
  await writeDoc(bundle, {
    id: "docs/success",
    frontmatter: { type: "Doc", title: "Success", timestamp: T },
    body: "# Success\n\n[Next](./next.md)",
  });
  await writeDoc(bundle, {
    id: "docs/bounded",
    frontmatter: { type: "Doc", title: "Bounded", timestamp: T },
    body: `${"> ".repeat(45)}deep`,
  });
  await writeDoc(bundle, {
    id: "docs/change",
    frontmatter: { type: "Doc", title: "Change", timestamp: T },
    body: "# Change",
  });
  return { bundle, backend };
}

async function webSurface(): Promise<Surface> {
  const { bundle, backend } = await seed();
  const server = await bootUiServer({
    mode: "dir",
    bundle,
    router: createRouter(bundle),
    sessionSecret: SECRET,
    renderDocument: renderDocumentToStaticHtml,
    viewAuthorization: new SessionViewAuthorizationStore(),
    serveAsset: () => ({
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: new Uint8Array(),
    }),
  });
  const post = async (path: string, body: unknown): Promise<Record<string, any>> => {
    const response = await fetch(`http://${server.host}:${server.port}${path}`, {
      method: "POST",
      headers: {
        cookie: `aslite_ui_session=${SECRET}`,
        "content-type": "application/json",
        "x-requested-with": "agentstate-lite-ui",
      },
      body: JSON.stringify(body),
    });
    return await response.json() as Record<string, any>;
  };
  const minted = await post("/__page/mint", { registryId: "views-registry/agreement" });
  return {
    async authorize() {
      const result = await post("/__ui/views/authorize", { launchId: minted.launchId });
      assert.equal(result.authorized, true);
    },
    async request(docId) {
      const result = await post("/__ui/views/bridge", {
        launchId: minted.launchId,
        request: { bridge: "v0", type: "render-document", id: docId, docId },
      });
      return result.reply;
    },
    async navigate() {
      return await post("/__ui/views/bridge", {
        launchId: minted.launchId,
        request: {
          bridge: "v0",
          type: "open-page",
          id: "open-target",
          pageId: "views-registry/target",
        },
      });
    },
    armLaunchChange: () => backend.armLaunchChange(),
    close: () => server.close(),
  };
}

async function mcpSurface(): Promise<Surface> {
  const { bundle, backend } = await seed();
  const server = createMcpAppServer({
    bundle,
    version: "agreement",
    viewAuthorization: new SessionViewAuthorizationStore(),
  });
  const client = new Client({ name: "agreement", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/agreement" },
  });
  const launchId = (shown.structuredContent as { launch: { launchId: string } }).launch.launchId;
  return {
    async authorize() {
      const result = await client.callTool({
        name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
        arguments: { launchId },
      });
      assert.equal(result.isError, undefined);
    },
    async request(docId) {
      const result = await client.callTool({
        name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
        arguments: {
          launchId,
          request: { bridge: "v0", type: "render-document", id: docId, docId },
        },
      });
      return (result.structuredContent as { outcome: { reply: Record<string, any> } }).outcome.reply;
    },
    async navigate() {
      const result = await client.callTool({
        name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
        arguments: {
          launchId,
          request: {
            bridge: "v0",
            type: "open-page",
            id: "open-target",
            pageId: "views-registry/target",
          },
        },
      });
      const structured = result.structuredContent as {
        outcome: { openPageId?: string };
        navigation?: {
          status?: string;
          view?: {
            source?: { viewId?: string };
            launch?: { authorization?: { authorized?: boolean } };
          };
        };
      };
      return {
        openPageId: structured.outcome.openPageId,
        navigationStatus: structured.navigation?.status,
        targetViewId: structured.navigation?.view?.source?.viewId,
        targetAuthorized: structured.navigation?.view?.launch?.authorization?.authorized,
      };
    },
    armLaunchChange: () => backend.armLaunchChange(),
    async close() {
      await client.close();
      await server.close();
    },
  };
}

type Scenario = "denial" | "success" | "not-found" | "bounded" | "changed-launch";

async function runScenario(factory: () => Promise<Surface>, scenario: Scenario): Promise<unknown> {
  const surface = await factory();
  try {
    if (scenario !== "denial") await surface.authorize();
    if (scenario === "changed-launch") surface.armLaunchChange();
    const docId = scenario === "not-found"
      ? "docs/missing"
      : scenario === "bounded"
        ? "docs/bounded"
        : scenario === "changed-launch"
          ? "docs/change"
          : "docs/success";
    const reply = await surface.request(docId);
    if (reply.type === "error") {
      return { type: "error", code: reply.error.code };
    }
    return {
      type: reply.type,
      document: reply.result.document,
      bounded: reply.result.bounded,
      hasHeading: reply.result.html.includes("<h1>Success</h1>"),
      hasConceptMarker: reply.result.html.includes('data-aslite-doc-id="docs/next"'),
      hasActiveMarkup: /<script|<a\b|<input\b/.test(reply.result.html),
    };
  } finally {
    await surface.close();
  }
}

test("web and MCP durable Views agree on every render-document outcome", async (t) => {
  const scenarios: Scenario[] = ["denial", "success", "not-found", "bounded", "changed-launch"];
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const web = await runScenario(webSurface, scenario);
      const mcp = await runScenario(mcpSurface, scenario);
      assert.deepEqual(web, mcp);
      if (scenario === "denial") assert.deepEqual(web, { type: "error", code: "FORBIDDEN" });
      if (scenario === "not-found") assert.deepEqual(web, { type: "error", code: "NOT_FOUND" });
      if (scenario === "changed-launch") assert.deepEqual(web, { type: "error", code: "REVOKED" });
      if (scenario === "success") {
        assert.deepEqual(web, {
          type: "render-document:result",
          document: (web as any).document,
          bounded: false,
          hasHeading: true,
          hasConceptMarker: true,
          hasActiveMarkup: false,
        });
        assert.match((web as any).document.version, /^sha256:/);
      }
      if (scenario === "bounded") assert.equal((web as any).bounded, true);
    });
  }
});

test("web and MCP select the same registered target for open-page", async () => {
  const web = await webSurface();
  const mcp = await mcpSurface();
  try {
    await web.authorize();
    await mcp.authorize();
    const webSelection = await web.navigate();
    const mcpSelection = await mcp.navigate();
    assert.equal(webSelection.openPageId, "views-registry/target");
    assert.deepEqual(mcpSelection, {
      openPageId: webSelection.openPageId,
      navigationStatus: "opened",
      targetViewId: webSelection.openPageId,
      targetAuthorized: false,
    });
  } finally {
    await web.close();
    await mcp.close();
  }
});
