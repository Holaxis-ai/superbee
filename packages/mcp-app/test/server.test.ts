import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  MemoryBackend,
  deleteDoc,
  readBlob,
  readDocVersioned,
  versionOfBytes,
  writeBlob,
  writeDoc,
  type Bundle,
} from "@superbee/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { extractClaimId } from "../src/result-recovery.js";
import { MCP_DOCUMENT_HTML } from "../src/generated/document-html.generated.js";
import { MCP_VIEW_HTML } from "../src/generated/view-html.generated.js";
import {
  AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
  CLOSE_DURABLE_VIEW_TOOL_NAME,
  DURABLE_VIEW_BRIDGE_TOOL_NAME,
  FINISH_VIEW_ACTION_TOOL_NAME,
  MCP_DOCUMENT_RESOURCE_URI,
  MCP_VIEW_RESOURCE_URI,
  LIST_VIEWS_TOOL_NAME,
  POLL_DURABLE_VIEW_TOOL_NAME,
  PREPARE_VIEW_ACTION_TOOL_NAME,
  RESUME_DURABLE_VIEW_TOOL_NAME,
  RESOLVE_DOCUMENT_TOOL_NAME,
  RESOLVE_LAUNCH_TOOL_NAME,
  SAVE_TRANSIENT_VIEW_TOOL_NAME,
  SHOW_DOCUMENT_TOOL_NAME,
  SHOW_VIEW_TOOL_NAME,
  createMcpAppServer,
  resolveDurableViewLaunch,
} from "../src/index.js";
import { SessionViewAuthorizationStore } from "@superbee/view-runtime";

const T = "2026-07-26T12:00:00.000Z";

test("the App shell resource URI is derived from its exact HTML bytes", () => {
  const digest = versionOfBytes(MCP_VIEW_HTML).slice("sha256:".length);
  assert.equal(
    MCP_VIEW_RESOURCE_URI,
    `ui://agentstate/view-host/v1/${digest}.html`,
  );
  const changedDigest = versionOfBytes(`${MCP_VIEW_HTML} `).slice(
    "sha256:".length,
  );
  assert.notEqual(
    MCP_VIEW_RESOURCE_URI,
    `ui://agentstate/view-host/v1/${changedDigest}.html`,
  );
});

test("the document reader resource URI is derived from its exact HTML bytes", () => {
  const digest = versionOfBytes(MCP_DOCUMENT_HTML).slice("sha256:".length);
  assert.equal(
    MCP_DOCUMENT_RESOURCE_URI,
    `ui://superbee/document-reader/v1/${digest}.html`,
  );
});

function memoryBundle(): Bundle {
  return { root: "mem://mcp-app-test", backend: new MemoryBackend() };
}

async function seed(bundle: Bundle): Promise<void> {
  await writeDoc(bundle, {
    id: "conventions/task",
    frontmatter: {
      type: "Convention",
      title: "Task",
      governs: "Task",
      path: "tasks/",
      fields: {
        required: ["title", "status"],
        optional: [],
        values: { status: ["todo", "done"] },
        terminal: { status: ["done"] },
      },
      timestamp: T,
    },
    body: "",
  });
  await writeDoc(bundle, {
    id: "tasks/alpha",
    frontmatter: { type: "Task", title: "Alpha", status: "todo", timestamp: T },
    body: "# Goal\n\nFirst task.",
  });
  await writeDoc(bundle, {
    id: "tasks/beta",
    frontmatter: { type: "Task", title: "Beta", status: "done", timestamp: T },
    body: "# Goal\n\nCompleted task.",
  });
  await writeDoc(bundle, {
    id: "tasks/gamma",
    frontmatter: { type: "Task", title: "Gamma", status: "todo", timestamp: T },
    body: "# Goal\n\nAnother task.",
  });
  await writeDoc(bundle, {
    id: "roadmap-items/views",
    frontmatter: { type: "Roadmap Item", title: "Conversational Views", status: "active", timestamp: T },
    body: "# Outcome\n\nUseful views in chat.",
  });
  await writeDoc(bundle, {
    id: "views-registry/roadmap",
    frontmatter: {
      type: "View",
      title: "Roadmap",
      entry: "views/roadmap.html",
      access: "bundle-read",
      timestamp: T,
    },
    body: "Existing durable Roadmap View.",
  });
  await writeBlob(
    bundle,
    "views/roadmap.html",
    new Uint8Array(
      await readFile(new URL("../../../examples/views/roadmap.html", import.meta.url)),
    ),
    "text/html; charset=utf-8",
  );
}

async function seedNavigationTarget(
  bundle: Bundle,
  id = "views-registry/target",
  access: "none" | "bundle-read" | "bundle-propose" = "bundle-read",
): Promise<void> {
  const suffix = id.slice("views-registry/".length);
  await writeDoc(bundle, {
    id,
    frontmatter: {
      type: "View",
      title: `Target ${suffix}`,
      entry: `views/${suffix}.html`,
      access,
      timestamp: T,
    },
    body: "",
  });
  await writeBlob(
    bundle,
    `views/${suffix}.html`,
    new TextEncoder().encode(`<!doctype html><title>Target ${suffix}</title>`),
    "text/html; charset=utf-8",
  );
}

test("list_views is bounded, continues deterministically, and every listed id is invokable", async (t) => {
  const bundle = memoryBundle();
  await writeBlob(
    bundle,
    "views/shared.html",
    new TextEncoder().encode("<!doctype html><title>Shared</title>"),
    "text/html; charset=utf-8",
  );
  for (let index = 0; index < 21; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await writeDoc(bundle, {
      id: `views-registry/view-${suffix}`,
      frontmatter: {
        type: "View",
        title: `View ${suffix}`,
        entry: "views/shared.html",
        access: index === 0 ? "bundle-propose" : "bundle-read",
        ...(index === 0 ? { presentation: "inline" } : {}),
      },
      body: "",
    });
  }
  await writeDoc(bundle, {
    id: "views-registry/content-only",
    frontmatter: { type: "View", title: "Content", entry: "views/shared.html", access: "none" },
    body: "",
  });
  await writeDoc(bundle, {
    id: "docs/invalid-view",
    frontmatter: { type: "View", title: "Invalid", entry: "views/shared.html", access: "bundle-read" },
    body: "",
  });
  await writeDoc(bundle, {
    id: "views-registry/dangling",
    frontmatter: {
      type: "View",
      title: "Dangling",
      entry: "views/missing.html",
      access: "bundle-read",
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/not-html.txt",
    new TextEncoder().encode("not HTML"),
    "text/plain; charset=utf-8",
  );
  await writeDoc(bundle, {
    id: "views-registry/not-html",
    frontmatter: {
      type: "View",
      title: "Not HTML",
      entry: "views/not-html.txt",
      access: "bundle-read",
    },
    body: "",
  });

  const server = createMcpAppServer({ bundle });
  const client = new Client({ name: "catalog-test", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const first = await client.callTool({ name: LIST_VIEWS_TOOL_NAME, arguments: {} });
  const firstPage = first.structuredContent as {
    views: Array<{ id: string; access: string; presentation?: string }>;
    registeredTotal: number;
    shown: number;
    excluded: number;
    invalidRegistrations: number;
    pageUnavailableEntries: number;
    skippedDocuments: number;
    examined: number;
    truncated: boolean;
    nextCursor: string;
  };
  assert.equal(firstPage.registeredTotal, 23);
  assert.equal(firstPage.shown, 20);
  assert.equal(firstPage.excluded, 1);
  assert.equal(firstPage.invalidRegistrations, 1);
  assert.equal(firstPage.pageUnavailableEntries, 2);
  assert.equal(firstPage.skippedDocuments, 0);
  assert.equal(firstPage.examined, 22);
  assert.equal(firstPage.truncated, true);
  assert.equal(firstPage.views[0]?.id, "views-registry/view-00");
  assert.equal(firstPage.views[0]?.access, "bundle-propose");
  assert.equal(firstPage.views[0]?.presentation, "inline");

  for (const row of firstPage.views) {
    const shown = await client.callTool({
      name: SHOW_VIEW_TOOL_NAME,
      arguments: { viewId: row.id },
    });
    assert.equal(shown.isError, undefined, row.id);
  }

  const second = await client.callTool({
    name: LIST_VIEWS_TOOL_NAME,
    arguments: { cursor: firstPage.nextCursor },
  });
  const secondPage = second.structuredContent as {
    views: Array<{ id: string }>;
    shown: number;
    examined: number;
    pageUnavailableEntries: number;
    truncated: boolean;
    nextCursor?: string;
  };
  assert.deepEqual(secondPage.views.map((row) => row.id), ["views-registry/view-20"]);
  assert.equal(secondPage.shown, 1);
  assert.equal(secondPage.examined, 1);
  assert.equal(secondPage.pageUnavailableEntries, 0);
  assert.equal(secondPage.truncated, false);
  assert.equal(secondPage.nextCursor, undefined);
});

test("MCP contract exposes fixed View and document App resources with invocation-specific results", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const server = createMcpAppServer({ bundle, version: "test" });
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    SHOW_DOCUMENT_TOOL_NAME,
    LIST_VIEWS_TOOL_NAME,
    SHOW_VIEW_TOOL_NAME,
    AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    SAVE_TRANSIENT_VIEW_TOOL_NAME,
    DURABLE_VIEW_BRIDGE_TOOL_NAME,
    RESUME_DURABLE_VIEW_TOOL_NAME,
    POLL_DURABLE_VIEW_TOOL_NAME,
    CLOSE_DURABLE_VIEW_TOOL_NAME,
    PREPARE_VIEW_ACTION_TOOL_NAME,
    FINISH_VIEW_ACTION_TOOL_NAME,
    RESOLVE_DOCUMENT_TOOL_NAME,
    RESOLVE_LAUNCH_TOOL_NAME,
  ]);
  const showDocumentTool = tools.tools.find(
    (tool) => tool.name === SHOW_DOCUMENT_TOOL_NAME,
  );
  const listTool = tools.tools.find((tool) => tool.name === LIST_VIEWS_TOOL_NAME);
  const showTool = tools.tools.find((tool) => tool.name === SHOW_VIEW_TOOL_NAME);
  const authorizeTool = tools.tools.find(
    (tool) => tool.name === AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
  );
  const saveTool = tools.tools.find(
    (tool) => tool.name === SAVE_TRANSIENT_VIEW_TOOL_NAME,
  );
  const bridgeTool = tools.tools.find(
    (tool) => tool.name === DURABLE_VIEW_BRIDGE_TOOL_NAME,
  );
  const pollTool = tools.tools.find(
    (tool) => tool.name === POLL_DURABLE_VIEW_TOOL_NAME,
  );
  const closeTool = tools.tools.find(
    (tool) => tool.name === CLOSE_DURABLE_VIEW_TOOL_NAME,
  );
  assert.deepEqual(listTool?._meta?.ui?.visibility, ["model"]);
  assert.equal(showDocumentTool?._meta?.ui?.resourceUri, MCP_DOCUMENT_RESOURCE_URI);
  assert.deepEqual(showDocumentTool?._meta?.ui?.visibility, ["model"]);
  assert.equal(showDocumentTool?.annotations?.readOnlyHint, true);
  const resumeTool = tools.tools.find(
    (tool) => tool.name === RESUME_DURABLE_VIEW_TOOL_NAME,
  );
  const prepareTool = tools.tools.find((tool) => tool.name === PREPARE_VIEW_ACTION_TOOL_NAME);
  const finishTool = tools.tools.find((tool) => tool.name === FINISH_VIEW_ACTION_TOOL_NAME);
  const resolveDocumentTool = tools.tools.find(
    (tool) => tool.name === RESOLVE_DOCUMENT_TOOL_NAME,
  );
  assert.equal(showTool?._meta?.ui?.resourceUri, MCP_VIEW_RESOURCE_URI);
  assert.equal(showTool?.annotations?.readOnlyHint, true);
  assert.deepEqual(saveTool?._meta?.ui?.visibility, ["model"]);
  assert.equal(saveTool?.annotations?.readOnlyHint, false);
  assert.equal(saveTool?.annotations?.idempotentHint, true);
  assert.equal(
    Object.hasOwn(
      (saveTool?.inputSchema.properties ?? {}) as Record<string, unknown>,
      "html",
    ),
    false,
    "the save contract cannot accept replacement source bytes",
  );
  assert.deepEqual(authorizeTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(bridgeTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(pollTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(resumeTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(closeTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(prepareTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(finishTool?._meta?.ui?.visibility, ["app"]);
  assert.deepEqual(resolveDocumentTool?._meta?.ui?.visibility, ["app"]);
  assert.equal(finishTool?.annotations?.readOnlyHint, false);

  const resource = await client.readResource({ uri: MCP_VIEW_RESOURCE_URI });
  const content = resource.contents[0];
  assert.ok(content && "text" in content);
  assert.equal(content.uri, MCP_VIEW_RESOURCE_URI);
  assert.match(content.text, /id="active-view"[\s\S]*\bsandbox\b/);
  assert.doesNotMatch(content.text, /sandbox="allow-scripts"/);
  assert.doesNotMatch(content.text, /data-aslite-(?:text|markdown)/);
  assert.match(content.text, /id="confirmation-backdrop"/);
  assert.match(content.text, /id="authorization-backdrop"/);
  assert.match(content.text, /Trust this View with bundle data\?/);
  assert.match(
    content.text,
    /http-equiv="Content-Security-Policy"[\s\S]*connect-src 'none'[\s\S]*frame-src blob:/,
  );
  assert.match(content.text, /authorize_durable_view/);
  assert.match(content.text, /durable_view_bridge/);
  assert.match(content.text, /poll_durable_view/);
  assert.match(content.text, /close_durable_view/);
  assert.match(content.text, /prepare_view_action/);
  assert.match(content.text, /finish_view_action/);
  assert.match(content.text, /navigated away from its approved document/);
  assert.match(content.text, /agentstate\.frame-size\.v1/);
  assert.match(content.text, /style-src 'unsafe-inline'/);
  const scriptStart = content.text.indexOf("<script>") + "<script>".length;
  const scriptEnd = content.text.lastIndexOf("</script>");
  assert.ok(scriptStart >= "<script>".length && scriptEnd > scriptStart);
  assert.doesNotThrow(() => new Function(content.text.slice(scriptStart, scriptEnd)));
  assert.deepEqual(content._meta?.ui?.csp?.frameDomains, ["blob:"]);
  assert.deepEqual(content._meta?.ui?.csp?.connectDomains, []);

  const documentResource = await client.readResource({ uri: MCP_DOCUMENT_RESOURCE_URI });
  const documentContent = documentResource.contents[0];
  assert.ok(documentContent && "text" in documentContent);
  assert.equal(documentContent.uri, MCP_DOCUMENT_RESOURCE_URI);
  assert.match(documentContent.text, /id="document"/);
  assert.match(documentContent.text, /Superbee Document Reader/);
  assert.match(
    documentContent.text,
    /http-equiv="Content-Security-Policy"[\s\S]*connect-src 'none'[\s\S]*frame-src 'none'/,
  );
  assert.doesNotMatch(documentContent.text, /<iframe\b/);
  assert.deepEqual(documentContent._meta?.ui?.csp?.frameDomains, []);
  assert.match(documentContent.text, /resolve_document/);
  const documentScriptStart = documentContent.text.indexOf("<script>") + "<script>".length;
  const documentScriptEnd = documentContent.text.lastIndexOf("</script>");
  assert.ok(
    documentScriptStart >= "<script>".length && documentScriptEnd > documentScriptStart,
  );
  assert.doesNotThrow(
    () => new Function(documentContent.text.slice(documentScriptStart, documentScriptEnd)),
  );

  const shownDocument = await client.callTool({
    name: SHOW_DOCUMENT_TOOL_NAME,
    arguments: { docId: "tasks/alpha" },
  });
  assert.equal(shownDocument.isError, undefined);
  const shownText = shownDocument.content[0]?.type === "text"
    ? shownDocument.content[0].text
    : "";
  assert.match(shownText, /Displayed Superbee document "Alpha" \(tasks\/alpha\)/);
  assert.doesNotMatch(shownText, /First task/);
  assert.equal(shownDocument.structuredContent, undefined);
  const expectedDocumentPayload = {
    schemaVersion: "superbee.document-presentation.v1",
    document: {
      id: "tasks/alpha",
      version: (await readDocVersioned(bundle, "tasks/alpha")).version,
      title: "Alpha",
      type: "Task",
      html: '<div data-aslite-rendered-document=""><h1>Goal</h1><p>First task.</p></div>',
      bounded: false,
    },
  };
  const documentClaim = extractClaimId(shownDocument);
  assert.ok(documentClaim);
  const recoveredDocument = await client.callTool({
    name: RESOLVE_DOCUMENT_TOOL_NAME,
    arguments: { claim: documentClaim },
  });
  assert.deepEqual(recoveredDocument.structuredContent, expectedDocumentPayload);
  const reusedDocumentClaim = await client.callTool({
    name: RESOLVE_DOCUMENT_TOOL_NAME,
    arguments: { claim: documentClaim },
  });
  assert.equal(reusedDocumentClaim.isError, true);

  const first = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: {
      mode: "transient",
      title: "One task",
      html: "<h1>One</h1>",
      access: "bundle-read",
    },
  });
  assert.equal(first.isError, undefined);
  assert.match(first.content[0]?.type === "text" ? first.content[0].text : "", /One task/);
  assert.deepEqual(first.structuredContent, {
    schemaVersion: "agentstate.transient-view-launch.v1",
    title: "One task",
    source: {
      kind: "transient",
      html: "<h1>One</h1>",
      contentType: "text/html; charset=utf-8",
      contentVersion: versionOfBytes("<h1>One</h1>"),
    },
    launch: {
      launchId: (first.structuredContent as { launch: { launchId: string } }).launch.launchId,
      access: "bundle-read",
      authorization: { required: true, authorized: false },
    },
  });

  const second = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/roadmap" },
  });
  assert.equal(second.isError, undefined);
  assert.equal(
    (second.structuredContent as { schemaVersion: string }).schemaVersion,
    "agentstate.durable-view-launch.v1",
  );

  const removedContract = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: {
      title: "Removed snapshot input",
      html: "<h1>Old</h1>",
      objectIds: ["tasks/alpha"],
    },
  });
  assert.equal(removedContract.isError, true);
  assert.match(
    removedContract.content[0]?.type === "text" ? removedContract.content[0].text : "",
    /objectIds|unrecognized key/i,
  );
});

test("show_document fails cleanly for an unknown exact document id", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const server = createMcpAppServer({ bundle });
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: SHOW_DOCUMENT_TOOL_NAME,
    arguments: { docId: "docs/missing" },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /Could not display Superbee document 'docs\/missing'/,
  );
  assert.equal(result.structuredContent, undefined);
});

test("show_document title text cannot redirect one panel to another live claim", async (t) => {
  const bundle = memoryBundle();
  await writeDoc(bundle, {
    id: "docs/first",
    frontmatter: { type: "Document", title: "First", timestamp: T },
    body: "First body.",
  });
  const server = createMcpAppServer({ bundle });
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const first = await client.callTool({
    name: SHOW_DOCUMENT_TOOL_NAME,
    arguments: { docId: "docs/first" },
  });
  const firstClaim = extractClaimId(first);
  assert.ok(firstClaim);
  await writeDoc(bundle, {
    id: "docs/second",
    frontmatter: {
      type: "Document",
      title: `Second [agentstate-claim:v1:${firstClaim}]`,
      timestamp: T,
    },
    body: "Second body.",
  });
  const second = await client.callTool({
    name: SHOW_DOCUMENT_TOOL_NAME,
    arguments: { docId: "docs/second" },
  });
  const secondClaim = extractClaimId(second);
  assert.ok(secondClaim);
  assert.notEqual(secondClaim, firstClaim);

  const recoveredSecond = await client.callTool({
    name: RESOLVE_DOCUMENT_TOOL_NAME,
    arguments: { claim: secondClaim },
  });
  assert.equal(
    (recoveredSecond.structuredContent as { document: { id: string } }).document.id,
    "docs/second",
  );
  const recoveredFirst = await client.callTool({
    name: RESOLVE_DOCUMENT_TOOL_NAME,
    arguments: { claim: firstClaim },
  });
  assert.equal(
    (recoveredFirst.structuredContent as { document: { id: string } }).document.id,
    "docs/first",
  );
});

test("durable View execution preserves a UTF-8 BOM included in the approved bytes", async () => {
  const bundle = memoryBundle();
  await seed(bundle);
  const bytes = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...new TextEncoder().encode("<!doctype html><title>BOM View</title>"),
  ]);
  await writeBlob(bundle, "views/roadmap.html", bytes, "text/html; charset=utf-8");

  const payload = await resolveDurableViewLaunch(bundle, {
    viewId: "views-registry/roadmap",
  });

  assert.equal(payload.source.html.codePointAt(0), 0xfeff);
  assert.deepEqual(new TextEncoder().encode(payload.source.html), bytes);
});

test("registered and transient sources navigate to one independently authorized registered View", async (t) => {
  for (const sourceKind of ["registered", "transient"] as const) {
    await t.test(sourceKind, async (t) => {
      const bundle = memoryBundle();
      await seed(bundle);
      await seedNavigationTarget(bundle);
      const server = createMcpAppServer({ bundle });
      const client = new Client({ name: `navigation-${sourceKind}`, version: "test" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      t.after(async () => {
        await client.close();
        await server.close();
      });

      const shown = await client.callTool({
        name: SHOW_VIEW_TOOL_NAME,
        arguments: sourceKind === "registered"
          ? { viewId: "views-registry/roadmap" }
          : {
              mode: "transient",
              title: "Transient source",
              html: "<!doctype html><title>Transient source</title>",
              access: "bundle-read",
            },
      });
      const source = shown.structuredContent as {
        launch: { launchId: string; authorization: { authorized: boolean } };
      };
      assert.equal(source.launch.authorization.authorized, false);
      await client.callTool({
        name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
        arguments: { launchId: source.launch.launchId },
      });

      const opened = await client.callTool({
        name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
        arguments: {
          launchId: source.launch.launchId,
          request: {
            bridge: "v0",
            type: "open-page",
            id: `open-${sourceKind}`,
            pageId: "views-registry/target",
          },
        },
      });
      const result = opened.structuredContent as {
        outcome: { openPageId: string; reply: null };
        navigation: {
          status: string;
          view: {
            schemaVersion: string;
            source: { viewId: string };
            launch: { launchId: string; authorization: { authorized: boolean } };
          };
        };
      };
      assert.equal(result.outcome.openPageId, "views-registry/target");
      assert.equal(result.outcome.reply, null);
      assert.equal(result.navigation.status, "opened");
      assert.equal(result.navigation.view.schemaVersion, "agentstate.durable-view-launch.v1");
      assert.equal(result.navigation.view.source.viewId, "views-registry/target");
      assert.equal(
        result.navigation.view.launch.authorization.authorized,
        false,
        "source approval never authorizes the target identity",
      );

      const retiredSource = await client.callTool({
        name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
        arguments: {
          launchId: source.launch.launchId,
          request: { bridge: "v0", type: "hello", id: "retired-source" },
        },
      });
      assert.equal(
        (retiredSource.structuredContent as {
          outcome: { reply: { error: { code: string } } };
        }).outcome.reply.error.code,
        "FORBIDDEN",
      );

      const targetBeforeApproval = await client.callTool({
        name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
        arguments: {
          launchId: result.navigation.view.launch.launchId,
          request: { bridge: "v0", type: "hello", id: "target-before-approval" },
        },
      });
      assert.equal(
        (targetBeforeApproval.structuredContent as {
          outcome: { reply: { error: { code: string } } };
        }).outcome.reply.error.code,
        "FORBIDDEN",
      );
      const approved = await client.callTool({
        name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
        arguments: { launchId: result.navigation.view.launch.launchId },
      });
      assert.equal(
        (approved.structuredContent as {
          view: { launch: { authorization: { authorized: boolean } } };
        }).view.launch.authorization.authorized,
        true,
      );
    });
  }
});

test("concurrent open-page requests consume one source generation and select at most one target", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  await seedNavigationTarget(bundle, "views-registry/first");
  await seedNavigationTarget(bundle, "views-registry/second");
  const server = createMcpAppServer({ bundle });
  const client = new Client({ name: "navigation-race", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/roadmap" },
  });
  const launchId = (shown.structuredContent as { launch: { launchId: string } }).launch.launchId;
  await client.callTool({
    name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId },
  });

  const responses = await Promise.all(
    ["first", "second"].map((target) =>
      client.callTool({
        name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
        arguments: {
          launchId,
          request: {
            bridge: "v0",
            type: "open-page",
            id: `open-${target}`,
            pageId: `views-registry/${target}`,
          },
        },
      }),
    ),
  );
  const opened = responses.flatMap((response) => {
    const navigation = (response.structuredContent as {
      navigation?: { status?: string; view?: { source?: { viewId?: string }; launch?: { launchId?: string } } };
    }).navigation;
    return navigation?.status === "opened" && navigation.view
      ? [navigation.view]
      : [];
  });
  assert.ok(opened.length >= 1);
  assert.equal(new Set(opened.map((view) => view.source?.viewId)).size, 1);
  assert.equal(new Set(opened.map((view) => view.launch?.launchId)).size, 1);
});

test("open-page failures stay bounded and never expose or preserve an unlaunchable target", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  await writeDoc(bundle, {
    id: "views-registry/dangling-target",
    frontmatter: {
      type: "View",
      title: "Dangling target",
      entry: "views/missing-target.html",
      access: "bundle-read",
      timestamp: T,
    },
    body: "",
  });
  const server = createMcpAppServer({ bundle });
  const client = new Client({ name: "navigation-failure", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const show = async () => {
    const shown = await client.callTool({
      name: SHOW_VIEW_TOOL_NAME,
      arguments: { viewId: "views-registry/roadmap" },
    });
    const launchId = (shown.structuredContent as { launch: { launchId: string } }).launch.launchId;
    await client.callTool({
      name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
      arguments: { launchId },
    });
    return launchId;
  };

  const missingSource = await show();
  const missing = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: missingSource,
      request: {
        bridge: "v0",
        type: "open-page",
        id: "missing",
        pageId: "views-registry/missing",
      },
    },
  });
  const missingNavigation = (missing.structuredContent as {
    navigation: { status: string; message: string; view?: unknown };
  }).navigation;
  assert.equal(missingNavigation.status, "failed");
  assert.match(missingNavigation.message, /No registered View/i);
  assert.equal(missingNavigation.view, undefined);
  const missingRetired = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: missingSource,
      request: { bridge: "v0", type: "hello", id: "missing-retired" },
    },
  });
  assert.equal(
    (missingRetired.structuredContent as {
      outcome: { reply: { error: { code: string } } };
    }).outcome.reply.error.code,
    "FORBIDDEN",
  );

  const danglingSource = await show();
  const dangling = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: danglingSource,
      request: {
        bridge: "v0",
        type: "open-page",
        id: "dangling",
        pageId: "views-registry/dangling-target",
      },
    },
  });
  const navigation = (dangling.structuredContent as {
    navigation: { status: string; message: string; view?: unknown };
  }).navigation;
  assert.equal(navigation.status, "failed");
  assert.match(navigation.message, /no View bytes found/i);
  assert.ok(navigation.message.length <= 500);
  assert.equal(navigation.view, undefined);
  const retired = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: danglingSource,
      request: { bridge: "v0", type: "hello", id: "retired" },
    },
  });
  assert.equal(
    (retired.structuredContent as {
      outcome: { reply: { error: { code: string } } };
    }).outcome.reply.error.code,
    "FORBIDDEN",
  );
});

test("registered Roadmap View runs from unchanged source through the authorized active bridge", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const authorization = new SessionViewAuthorizationStore();
  const expectedSource = await readFile(
    new URL("../../../examples/views/roadmap.html", import.meta.url),
    "utf8",
  );
  const direct = await resolveDurableViewLaunch(
    bundle,
    { viewId: "views-registry/roadmap" },
    undefined,
    authorization,
  );
  assert.equal(direct.source.html, expectedSource);
  assert.equal(direct.source.entry, "views/roadmap.html");
  assert.equal(direct.launch.authorization.authorized, false);

  const server = createMcpAppServer({
    bundle,
    version: "test",
    bundleName: "Proof bundle",
    viewAuthorization: authorization,
  });
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/roadmap" },
  });
  assert.equal(shown.isError, undefined);
  const view = shown.structuredContent as {
    source: { html: string; contentVersion: string };
    launch: {
      launchId: string;
      authorization: { required: boolean; authorized: boolean };
    };
  };
  assert.equal(view.source.html, expectedSource);
  assert.equal(view.launch.authorization.required, true);
  assert.equal(view.launch.authorization.authorized, false);

  const beforeApproval = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: { bridge: "v0", type: "hello", id: "hello-before" },
    },
  });
  assert.deepEqual(
    (beforeApproval.structuredContent as {
      outcome: { reply: { error: { code: string } } };
    }).outcome.reply.error.code,
    "FORBIDDEN",
  );

  const approved = await client.callTool({
    name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: view.launch.launchId },
  });
  assert.equal(approved.isError, undefined);
  const approvedView = (approved.structuredContent as {
    view: {
      source: { html: string; contentVersion: string };
      launch: { authorization: { authorized: boolean } };
    };
  }).view;
  assert.equal(approvedView.source.html, expectedSource);
  assert.equal(approvedView.source.contentVersion, view.source.contentVersion);
  assert.equal(approvedView.launch.authorization.authorized, true);

  const hello = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: { bridge: "v0", type: "hello", id: "hello" },
    },
  });
  assert.deepEqual(
    (hello.structuredContent as {
      outcome: {
        reply: {
          result: {
            bundle: { root: null; name: string };
            mode: string;
            grant: string;
          };
        };
      };
    }).outcome.reply.result,
    {
      bundle: { root: null, name: "Proof bundle" },
      mode: "local-mcp",
      protocol: "v0",
      grant: "read",
    },
  );

  const query = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: {
        bridge: "v0",
        type: "query",
        id: "tasks",
        params: { type: "Task", open: true, limit: 10 },
      },
    },
  });
  assert.deepEqual(
    (
      query.structuredContent as {
        outcome: { reply: { result: { rows: Array<{ id: string }> } } };
      }
    ).outcome.reply.result.rows.map((row) => row.id),
    ["tasks/alpha", "tasks/gamma"],
  );

  const read = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: { bridge: "v0", type: "read", id: "read", docId: "tasks/alpha" },
    },
  });
  assert.equal(
    (
      read.structuredContent as {
        outcome: { reply: { result: { body: string } } };
      }
    ).outcome.reply.result.body,
    "# Goal\n\nFirst task.",
  );

  const rendered = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: {
        bridge: "v0",
        type: "render-document",
        id: "render",
        docId: "tasks/alpha",
      },
    },
  });
  const renderedResult = (
    rendered.structuredContent as {
      outcome: {
        reply: {
          result: {
            document: { id: string; version: string };
            html: string;
            bounded: boolean;
          };
        };
      };
    }
  ).outcome.reply.result;
  assert.equal(renderedResult.document.id, "tasks/alpha");
  assert.match(renderedResult.document.version, /^sha256:/);
  assert.match(renderedResult.html, /data-aslite-rendered-document/);
  assert.match(renderedResult.html, /<h1>Goal<\/h1>/);
  assert.doesNotMatch(renderedResult.html, /<script|<a\b|<input\b/);
  assert.equal(renderedResult.bounded, false);

  const actionProtocol = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: {
        bridge: "v1",
        type: "read-versioned",
        id: "versioned",
        docId: "tasks/alpha",
      },
    },
  });
  assert.equal(
    (
      actionProtocol.structuredContent as {
        outcome: { reply: { result: { doc: { id: string }; version: string } } };
      }
    ).outcome.reply.result.doc.id,
    "tasks/alpha",
  );
  assert.match(
    (
      actionProtocol.structuredContent as {
        outcome: { reply: { result: { version: string } } };
      }
    ).outcome.reply.result.version,
    /^sha256:/,
  );
  const subscribed = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: { bridge: "v0", type: "subscribe", id: "subscribe" },
    },
  });
  assert.equal(
    (
      subscribed.structuredContent as {
        outcome: { subscribed: boolean };
      }
    ).outcome.subscribed,
    true,
  );
  const unchanged = await client.callTool({
    name: POLL_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: view.launch.launchId },
  });
  assert.equal(
    (unchanged.structuredContent as { poll: { status: string } }).poll.status,
    "unchanged",
  );

  await writeDoc(bundle, {
    id: "tasks/alpha",
    frontmatter: { type: "Task", title: "Alpha", status: "done", timestamp: T },
    body: "# Goal\n\nCompleted during the proof.",
  });
  const changed = await client.callTool({
    name: POLL_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: view.launch.launchId },
  });
  const change = (changed.structuredContent as {
    poll: {
      status: string;
      generation: string;
      message: { event: { changes: Array<{ id: string }> } };
    };
  }).poll;
  assert.equal(change.status, "change");
  assert.deepEqual(change.message.event.changes.map((entry) => entry.id), ["tasks/alpha"]);

  const replayed = await client.callTool({
    name: POLL_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: view.launch.launchId },
  });
  assert.deepEqual(
    (replayed.structuredContent as { poll: unknown }).poll,
    change,
    "a change remains pending until the host acknowledges its generation",
  );
  const acknowledged = await client.callTool({
    name: POLL_DURABLE_VIEW_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      acknowledgeGeneration: change.generation,
    },
  });
  assert.equal(
    (acknowledged.structuredContent as { poll: { status: string } }).poll.status,
    "unchanged",
  );

  await writeBlob(
    bundle,
    "views/roadmap.html",
    new TextEncoder().encode("<!doctype html><p>changed source</p>"),
    "text/html; charset=utf-8",
  );
  const revoked = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: { bridge: "v0", type: "hello", id: "stale" },
    },
  });
  assert.equal(
    (
      revoked.structuredContent as {
        outcome: { reply: { error: { code: string } } };
      }
    ).outcome.reply.error.code,
    "FORBIDDEN",
  );

  const closed = await client.callTool({
    name: CLOSE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: view.launch.launchId },
  });
  assert.deepEqual(closed.structuredContent, { closed: true });
});

test("transient HTML uses the registered active-View bridge without a synthetic registration", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  let persistentStoreCalls = 0;
  const server = createMcpAppServer({
    bundle,
    version: "test",
    bundleName: "Transient proof bundle",
    actor: "mike/test",
    viewAuthorization: {
      async isAuthorized() {
        persistentStoreCalls += 1;
        return false;
      },
      async authorize() {
        persistentStoreCalls += 1;
      },
    },
  });
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const html = "<!doctype html><title>Transient</title><script>parent.postMessage({bridge:'v0',type:'query',id:'q',params:{type:'Task'}}, '*')</script>";
  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { mode: "transient", title: "Transient proof", html },
  });
  assert.notEqual(shown.isError, true);
  const view = shown.structuredContent as {
    schemaVersion: string;
    source: { kind: string; html: string; contentVersion: string; viewId?: string };
    launch: { launchId: string; authorization: { authorized: boolean } };
  };
  assert.equal(view.schemaVersion, "agentstate.transient-view-launch.v1");
  assert.equal(view.source.kind, "transient");
  assert.equal(view.source.html, html);
  assert.equal(view.source.viewId, undefined);
  assert.match(view.source.contentVersion, /^sha256:/);
  assert.equal(view.launch.authorization.authorized, false);
  assert.equal(persistentStoreCalls, 0, "transient approval never reaches the persistent registered-View store");

  const beforeApproval = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: { bridge: "v0", type: "hello", id: "before" },
    },
  });
  assert.equal(
    (beforeApproval.structuredContent as { outcome: { reply: { error: { code: string } } } })
      .outcome.reply.error.code,
    "FORBIDDEN",
  );

  const approved = await client.callTool({
    name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: view.launch.launchId },
  });
  const approvedView = (approved.structuredContent as { view: typeof view }).view;
  assert.equal(approvedView.schemaVersion, "agentstate.transient-view-launch.v1");
  assert.equal(approvedView.launch.authorization.authorized, true);
  assert.equal(persistentStoreCalls, 0);

  const rendered = await client.callTool({
    name: DURABLE_VIEW_BRIDGE_TOOL_NAME,
    arguments: {
      launchId: view.launch.launchId,
      request: {
        bridge: "v0",
        type: "render-document",
        id: "render",
        docId: "tasks/alpha",
      },
    },
  });
  assert.match(
    (rendered.structuredContent as { outcome: { reply: { result: { html: string } } } })
      .outcome.reply.result.html,
    /<h1>Goal<\/h1>/,
  );

  const resumed = await client.callTool({
    name: RESUME_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: view.launch.launchId },
  });
  const resumedView = (resumed.structuredContent as { view: typeof view }).view;
  assert.notEqual(resumedView.launch.launchId, view.launch.launchId);
  assert.equal(resumedView.source.contentVersion, view.source.contentVersion);
  assert.equal(resumedView.source.html, html);
  assert.equal(resumedView.launch.authorization.authorized, true);
  assert.equal(persistentStoreCalls, 0);

  const target = await readDocVersioned(bundle, "tasks/alpha");
  const readOnlyProposal = await client.callTool({
    name: PREPARE_VIEW_ACTION_TOOL_NAME,
    arguments: {
      launchId: resumedView.launch.launchId,
      requestId: "read-only-proposal",
      action: {
        kind: "document.set-field",
        docId: "tasks/alpha",
        field: "status",
        value: "done",
        expectedVersion: target.version,
      },
    },
  });
  assert.equal(
    (readOnlyProposal.structuredContent as { result: { status: string } }).result.status,
    "revoked",
    "bundle-read can read but cannot prepare a change",
  );

  const mixedContract = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: {
      mode: "transient",
      title: "Ambiguous",
      html: "<p>x</p>",
      objectIds: ["tasks/alpha"],
    },
  });
  assert.equal(mixedContract.isError, true, "transient input rejects removed snapshot fields");
});

test("save_transient_view persists server-owned exact bytes and returns a freshly unauthorized durable View", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const server = createMcpAppServer({ bundle, actor: "openai/codex" });
  const client = new Client({ name: "save-test", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const html = "<!doctype html><title>Save me</title><script>parent.postMessage({bridge:'v0',type:'query',id:'q',params:{type:'Task'}}, '*')</script>";
  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { mode: "transient", title: "Saved from chat", html },
  });
  const transient = shown.structuredContent as {
    source: { contentVersion: string };
    launch: { launchId: string };
  };

  const beforeApproval = await client.callTool({
    name: SAVE_TRANSIENT_VIEW_TOOL_NAME,
    arguments: {
      launchId: transient.launch.launchId,
      viewId: "views-registry/saved-from-chat",
    },
  });
  assert.equal(beforeApproval.isError, true);
  assert.match(
    beforeApproval.content[0]?.type === "text" ? beforeApproval.content[0].text : "",
    /must be locally approved/,
  );
  assert.equal(await readBlob(bundle, "views/saved-from-chat.html"), null);

  await client.callTool({
    name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: transient.launch.launchId },
  });

  const replacementBytes = await client.callTool({
    name: SAVE_TRANSIENT_VIEW_TOOL_NAME,
    arguments: {
      launchId: transient.launch.launchId,
      viewId: "views-registry/saved-from-chat",
      html: "<p>replacement bytes must never be accepted</p>",
    },
  });
  assert.equal(replacementBytes.isError, true);
  assert.match(
    replacementBytes.content[0]?.type === "text" ? replacementBytes.content[0].text : "",
    /unrecognized key.*html/i,
  );
  assert.equal(await readBlob(bundle, "views/saved-from-chat.html"), null);

  const savedResult = await client.callTool({
    name: SAVE_TRANSIENT_VIEW_TOOL_NAME,
    arguments: {
      launchId: transient.launch.launchId,
      viewId: "views-registry/saved-from-chat",
      description: "A durable View saved unchanged from its chat preview.",
    },
  });
  assert.notEqual(savedResult.isError, true);
  const saved = (savedResult.structuredContent as {
    saved: {
      viewId: string;
      entry: string;
      sourceVersion: string;
      entryVersion: string;
      entryCreated: boolean;
      registryCreated: boolean;
    };
  }).saved;
  assert.equal(saved.viewId, "views-registry/saved-from-chat");
  assert.equal(saved.entry, "views/saved-from-chat.html");
  assert.equal(saved.sourceVersion, transient.source.contentVersion);
  assert.equal(saved.entryVersion, transient.source.contentVersion);
  assert.equal(saved.entryCreated, true);
  assert.equal(saved.registryCreated, true);
  const bytes = await readBlob(bundle, saved.entry);
  assert.ok(bytes);
  assert.equal(new TextDecoder().decode(bytes.bytes), html);

  const durableResult = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: saved.viewId },
  });
  const durable = durableResult.structuredContent as {
    schemaVersion: string;
    source: { viewId: string; html: string; contentVersion: string };
    launch: { authorization: { authorized: boolean } };
  };
  assert.equal(durable.schemaVersion, "agentstate.durable-view-launch.v1");
  assert.equal(durable.source.viewId, saved.viewId);
  assert.equal(durable.source.html, html);
  assert.equal(durable.source.contentVersion, transient.source.contentVersion);
  assert.equal(
    durable.launch.authorization.authorized,
    false,
    "the durable registry identity requires fresh local approval",
  );

  const catalog = await client.callTool({ name: LIST_VIEWS_TOOL_NAME, arguments: {} });
  assert.ok(
    (catalog.structuredContent as { views: Array<{ id: string }> }).views.some(
      (entry) => entry.id === saved.viewId,
    ),
    "the saved View is discoverable through the shared web/MCP catalog",
  );
});

test("one bundle-propose action works from transient bytes and their exact saved durable View", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const server = createMcpAppServer({ bundle, actor: "openai/codex" });
  const client = new Client({ name: "active-action-test", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const html = "<!doctype html><title>Task action</title><script>/* uses the standard v1 action bridge */</script>";
  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: {
      mode: "transient",
      title: "Transient task action",
      html,
      access: "bundle-propose",
    },
  });
  const transient = shown.structuredContent as {
    source: { contentVersion: string };
    launch: { launchId: string; access: string; authorization: { authorized: boolean } };
  };
  assert.equal(transient.launch.access, "bundle-propose");
  assert.equal(transient.launch.authorization.authorized, false);
  await client.callTool({
    name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: transient.launch.launchId },
  });

  const runAction = async (launchId: string, value: "todo" | "done") => {
    const target = await readDocVersioned(bundle, "tasks/alpha");
    const prepared = await client.callTool({
      name: PREPARE_VIEW_ACTION_TOOL_NAME,
      arguments: {
        launchId,
        requestId: `set-${value}`,
        action: {
          kind: "document.set-field",
          docId: "tasks/alpha",
          field: "status",
          value,
          expectedVersion: target.version,
        },
      },
    });
    const result = (prepared.structuredContent as {
      result: { status: string; approvalToken?: string; confirmation?: { actor: string } };
    }).result;
    assert.equal(result.status, "prepared");
    assert.equal(result.confirmation?.actor, "openai/codex");
    assert.equal((await readDocVersioned(bundle, "tasks/alpha")).version, target.version);
    const finished = await client.callTool({
      name: FINISH_VIEW_ACTION_TOOL_NAME,
      arguments: {
        launchId,
        approvalToken: result.approvalToken,
        decision: "commit",
      },
    });
    assert.equal(
      (finished.structuredContent as { result: { status: string } }).result.status,
      "committed",
    );
    assert.equal((await readDocVersioned(bundle, "tasks/alpha")).doc.frontmatter.status, value);
  };

  await runAction(transient.launch.launchId, "done");

  const saved = await client.callTool({
    name: SAVE_TRANSIENT_VIEW_TOOL_NAME,
    arguments: {
      launchId: transient.launch.launchId,
      viewId: "views-registry/saved-task-action",
    },
  });
  assert.equal(
    (saved.structuredContent as { saved: { access: string } }).saved.access,
    "bundle-propose",
  );
  const registered = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/saved-task-action" },
  });
  const durable = registered.structuredContent as {
    source: { html: string; contentVersion: string };
    launch: { launchId: string; access: string; authorization: { authorized: boolean } };
  };
  assert.equal(durable.source.html, html);
  assert.equal(durable.source.contentVersion, transient.source.contentVersion);
  assert.equal(durable.launch.access, "bundle-propose");
  assert.equal(durable.launch.authorization.authorized, false);
  await client.callTool({
    name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: durable.launch.launchId },
  });
  await runAction(durable.launch.launchId, "todo");
});

test("durable resume rotates to fresh current bytes and recomputes authorization", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const authorization = new SessionViewAuthorizationStore();
  const server = createMcpAppServer({
    bundle,
    viewAuthorization: authorization,
  });
  const client = new Client(
    { name: "test-client", version: "test" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/roadmap" },
  });
  const original = shown.structuredContent as {
    source: { contentVersion: string };
    launch: { launchId: string };
  };
  const unknown = await client.callTool({
    name: RESUME_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: "unknown-launch" },
  });
  assert.equal(unknown.isError, true);
  const unapproved = await client.callTool({
    name: RESUME_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: original.launch.launchId },
  });
  assert.equal(unapproved.isError, true);
  await client.callTool({
    name: AUTHORIZE_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: original.launch.launchId },
  });

  const resumed = await client.callTool({
    name: RESUME_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: original.launch.launchId },
  });
  const current = (resumed.structuredContent as {
    view: {
      source: { contentVersion: string };
      launch: {
        launchId: string;
        authorization: { authorized: boolean };
      };
    };
  }).view;
  assert.notEqual(current.launch.launchId, original.launch.launchId);
  assert.equal(current.source.contentVersion, original.source.contentVersion);
  assert.equal(current.launch.authorization.authorized, true);

  await writeBlob(
    bundle,
    "views/roadmap.html",
    new TextEncoder().encode("<!doctype html><p>changed during suspension</p>"),
    "text/html; charset=utf-8",
  );
  const changed = await client.callTool({
    name: RESUME_DURABLE_VIEW_TOOL_NAME,
    arguments: { launchId: original.launch.launchId },
  });
  const changedView = (changed.structuredContent as {
    view: {
      source: { contentVersion: string };
      launch: { authorization: { authorized: boolean } };
    };
  }).view;
  assert.notEqual(
    changedView.source.contentVersion,
    original.source.contentVersion,
  );
  assert.equal(changedView.launch.authorization.authorized, false);
});

test("resolve_launch redeems a durable launch with its current authorization state", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const server = createMcpAppServer({ bundle, version: "test" });
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const shown = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/roadmap" },
  });
  const shownPayload = shown.structuredContent;
  assert.equal(shownPayload?.schemaVersion, "agentstate.durable-view-launch.v1");
  const claim = extractClaimId(shown);
  assert.ok(claim, "durable show_view results carry the claim marker too");

  const resolved = await client.callTool({ name: RESOLVE_LAUNCH_TOOL_NAME, arguments: { claim } });
  assert.notEqual(resolved.isError, true);
  const payload = resolved.structuredContent;
  assert.equal(payload?.schemaVersion, "agentstate.durable-view-launch.v1");
  assert.equal(payload?.launch?.launchId, shownPayload.launch.launchId);
  assert.equal(payload?.launch?.authorization?.authorized, false);
  assert.equal(payload?.source?.viewId, "views-registry/roadmap");
});

test("a failed show_view records no claim ticket", async (t) => {
  const bundle = memoryBundle();
  await seed(bundle);
  const server = createMcpAppServer({ bundle, version: "test" });
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const failed = await client.callTool({
    name: SHOW_VIEW_TOOL_NAME,
    arguments: { viewId: "views-registry/does-not-exist" },
  });
  assert.equal(failed.isError, true);
  const failedText = (failed.content as Array<{ text?: string }>)[0]?.text ?? "";
  assert.match(failedText, /No registered View with ID 'views-registry\/does-not-exist'\./);
  assert.match(failedText, /Call list_views to discover the available View IDs\./);
  assert.doesNotMatch(failedText, /ENOENT|\.md|mem:\/\//);
  assert.equal(extractClaimId(failed), null, "a failed show_view carries no claim marker");

  const resolved = await client.callTool({
    name: RESOLVE_LAUNCH_TOOL_NAME,
    arguments: { claim: "claim-that-was-never-minted" },
  });
  assert.equal(resolved.isError, true, "no pending launch may be minted by a failed show_view");
});
