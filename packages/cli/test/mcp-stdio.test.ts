import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { initBundle, writeBlob, writeDoc } from "@superbee/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cliVersion } from "../src/build-identity.js";
import { addCatalogEntry } from "../src/catalog.js";

const CLI = fileURLToPath(new URL("../dist/superbee.mjs", import.meta.url));

async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("built npm CLI serves the fixed MCP App contract over clean stdio", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aslite-mcp-stdio-"));
  const bundle = await initBundle(root);
  await writeDoc(bundle, {
    id: "tasks/stdio",
    frontmatter: {
      type: "Task",
      title: "STDIO proof",
      status: "todo",
      timestamp: "2026-07-26T12:00:00.000Z",
    },
    body: "# Goal\n\nProve the installed command's transport.",
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--dir", root, "--actor", "mike/test"],
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-proof", version: "test" }, { capabilities: {} });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, cliVersion());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    "show_document",
    "list_views",
    "show_view",
    "authorize_durable_view",
    "save_transient_view",
    "durable_view_bridge",
    "resume_durable_view",
    "poll_durable_view",
    "close_durable_view",
    "prepare_view_action",
    "finish_view_action",
    "resolve_document",
    "resolve_launch",
  ]);
  assert.deepEqual(
    tools.tools
      .filter((tool) => tool._meta?.ui?.visibility?.includes("app"))
      .map((tool) => tool._meta?.ui?.visibility),
    Array.from({ length: 9 }, () => ["app"]),
    "lifecycle and bridge tools belong to the trusted App",
  );

  const document = await client.callTool({
    name: "show_document",
    arguments: { docId: "tasks/stdio" },
  });
  assert.equal(document.isError, undefined);
  assert.equal(document.structuredContent, undefined, "the model-facing result stays compact");
  const documentText = document.content[0]?.type === "text" ? document.content[0].text : "";
  const documentClaim = /\[agentstate-claim:v1:([A-Za-z0-9_-]+)\]/.exec(documentText)?.[1];
  assert.ok(documentClaim);
  const recoveredDocument = await client.callTool({
    name: "resolve_document",
    arguments: { claim: documentClaim },
  });
  assert.equal(
    (recoveredDocument.structuredContent as { schemaVersion: string }).schemaVersion,
    "superbee.document-presentation.v1",
  );
  assert.match(
    ((recoveredDocument.structuredContent as { document: { html: string } }).document.html),
    /<h1>Goal<\/h1><p>Prove the installed command&#x27;s transport\.<\/p>/,
  );
  assert.deepEqual(
    tools.tools.find((tool) => tool.name === "save_transient_view")?._meta?.ui?.visibility,
    ["model"],
    "the model can explicitly request persistence after the human approved the transient View",
  );

  const result = await client.callTool({
    name: "show_view",
    arguments: {
      mode: "transient",
      title: "Transport proof",
      html: "<h1>STDIO works</h1>",
      access: "bundle-read",
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(
    (result.structuredContent as { schemaVersion: string }).schemaVersion,
    "agentstate.transient-view-launch.v1",
  );
});

test("built bare MCP server resolves documents and Views through the private workspace catalog", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "superbee-mcp-unbound-"));
  const home = path.join(base, "home");
  const requestedRoot = path.join(base, "bundle");
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const bundle = await initBundle(root);
  await writeDoc(bundle, {
    id: "docs/brief",
    frontmatter: { type: "Document", title: "Catalog brief" },
    body: "# Brief\n\nOpened through an explicit workspace.",
  });
  await writeDoc(bundle, {
    id: "views-registry/brief",
    frontmatter: {
      type: "View",
      title: "Catalog brief View",
      entry: "views/brief.html",
      access: "bundle-read",
    },
    body: "",
  });
  await writeBlob(
    bundle,
    "views/brief.html",
    new TextEncoder().encode("<!doctype html><title>Catalog brief View</title>"),
    "text/html; charset=utf-8",
  );
  await addCatalogEntry("planning", root, { home });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.HOME = home;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "unbound-stdio-proof", version: "test" }, { capabilities: {} });
  t.after(async () => {
    await client.close();
    await rm(base, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    "list_workspaces",
    "show_document",
    "list_views",
    "show_view",
    "authorize_durable_view",
    "save_transient_view",
    "durable_view_bridge",
    "resume_durable_view",
    "poll_durable_view",
    "close_durable_view",
    "prepare_view_action",
    "finish_view_action",
    "resolve_document",
    "resolve_launch",
  ]);
  const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
  assert.match(JSON.stringify(listed.structuredContent), /planning/);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const shown = await client.callTool({
    name: "show_document",
    arguments: { workspace: "planning", docId: "docs/brief" },
  });
  assert.equal(shown.isError, undefined);
  assert.match(JSON.stringify(shown), /Catalog brief/);

  const missingWorkspace = await client.callTool({
    name: "show_view",
    arguments: { viewId: "views-registry/brief" },
  });
  assert.equal(missingWorkspace.isError, true);
  const launched = await client.callTool({
    name: "show_view",
    arguments: { workspace: "planning", viewId: "views-registry/brief" },
  });
  const launchId = (launched.structuredContent as {
    launch: { launchId: string };
  }).launch.launchId;
  const approved = await client.callTool({
    name: "authorize_durable_view",
    arguments: { launchId },
  });
  assert.equal(approved.isError, undefined);
  const hello = await client.callTool({
    name: "durable_view_bridge",
    arguments: {
      launchId,
      request: { bridge: "v0", type: "hello", id: "catalog-hello" },
    },
  });
  assert.equal(
    (hello.structuredContent as {
      outcome: { reply: { result: { grant: string } } };
    }).outcome.reply.result.grant,
    "read",
  );
});

test("literal PATH `aslite mcp` reports the selected CLI release and never rewrites host config", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aslite-mcp-path-"));
  const root = path.join(base, "bundle");
  const binDir = path.join(base, "bin");
  const home = path.join(base, "home");
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await symlink(CLI, path.join(binDir, "aslite"));
  const sentinel = path.join(home, ".claude", "mcp.json");
  const sentinelBytes = '{"command":"/old/plugin/cache/0.1.0/scripts/agentstate-lite.mjs"}\n';
  await writeFile(sentinel, sentinelBytes);
  await initBundle(root);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    ASLITE_NO_UPDATE_CHECK: "1",
  };
  const selected = spawn("aslite", ["version", "--json"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let versionStdout = "";
  let versionStderr = "";
  selected.stdout.setEncoding("utf8");
  selected.stderr.setEncoding("utf8");
  selected.stdout.on("data", (chunk: string) => (versionStdout += chunk));
  selected.stderr.on("data", (chunk: string) => (versionStderr += chunk));
  const selectedCode = await new Promise<number | null>((resolve, reject) => {
    selected.once("error", reject);
    selected.once("close", resolve);
  });
  assert.equal(selectedCode, 0, versionStderr);
  const selectedVersion = JSON.parse(versionStdout).identity.package.version as string;

  const transport = new StdioClientTransport({
    command: "aslite",
    args: ["mcp", "--dir", root, "--actor", "path/test"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "path-proof", version: "test" }, { capabilities: {} });
  t.after(async () => {
    await client.close();
    await rm(base, { recursive: true, force: true });
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, selectedVersion);
  assert.equal(await readFile(sentinel, "utf8"), sentinelBytes);
});

test("built npm CLI keeps MCP stdout byte-empty for usage and bundle startup failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aslite-mcp-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const rows = [
    {
      name: "usage",
      args: ["mcp", "--nope"],
      code: 2,
      envelopeCode: "USAGE",
    },
    {
      name: "bundle resolution",
      args: ["mcp", "--dir", path.join(root, "missing")],
      code: 6,
      envelopeCode: "NOT_FOUND",
    },
  ];

  for (const row of rows) {
    const result = await runCli(row.args, root);
    assert.equal(result.code, row.code, row.name);
    assert.equal(result.stdout, "", `${row.name}: JSON-RPC stdout must remain pristine`);
    assert.match(result.stderr, /^error:\n/, `${row.name}: stderr envelope`);
    assert.match(result.stderr, new RegExp(`code: ${row.envelopeCode}`), row.name);
  }
});
