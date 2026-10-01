import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { withRetainedTarball, validateCliTarEntries } from "../../../scripts/cli-library-proof.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tarball = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Provide an existing tarball; this proof does not build or repack it");
const proof = await withRetainedTarball(tarball, async (snapshot, expectedDigest) => {
  const entries = execFileSync("tar", ["-tzf", snapshot], { encoding: "utf8" }).trim().split("\n");
  validateCliTarEntries(entries.filter(entry => entry !== "package/LICENSE" && entry !== "package/NOTICE"));
  for (const file of ["LICENSE", "NOTICE"]) assert.ok(entries.includes(`package/${file}`), `Missing packed ${file}`);
  const fixture = mkdtempSync(join(tmpdir(), "superbee-agent-surface-consumer-"));
  try {
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "external-surface-consumer", private: true, type: "module" }));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", snapshot], { cwd: fixture, stdio: "pipe" });
    for (const file of ["LICENSE", "NOTICE"]) {
      assert.deepEqual(readFileSync(join(fixture, "node_modules/@superbee/agent-surface", file)), readFileSync(join(repo, file)), `Packed ${file} must equal the repository original`);
      assert.deepEqual(readFileSync(join(repo, "packages/agent-surface", file)), readFileSync(join(repo, file)), `Package ${file} must equal the repository original`);
    }
    const manifest = JSON.parse(readFileSync(join(fixture, "node_modules/@superbee/agent-surface/package.json"), "utf8"));
    assert.equal(manifest.name, "@superbee/agent-surface");
    assert.deepEqual(Object.keys(manifest.exports), ["."]);
    assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
    assert.equal(Object.keys(manifest.peerDependencies ?? {}).length, 0);
    writeFileSync(join(fixture, "consumer.mjs"), `
  import assert from 'node:assert/strict';
  import { createSurfaceContext, createRevealPolicy, mountAssistantPanel } from '@superbee/agent-surface';
  assert.equal(globalThis.document, undefined);
  assert.equal(typeof mountAssistantPanel, 'function');
  const context = createSurfaceContext({ route: 'publication', validate() {} });
  const admit = context.begin('document');
  assert.equal(admit({ publicationDigest: 'immutable', documentId: 'notes/a' }), true);
  const lifetime = new AbortController();
  const policy = createRevealPolicy({ surface: { mode: () => 'follow', navigate: async () => true },
    lifetime: lifetime.signal, screenSignal: () => context.signal, resolve: target => ({ target }) });
  const tool = { name: 'read_context', description: 'Read admitted context', inputSchema: { type: 'object' },
    execute: async () => context.snapshot() };
  assert.equal((await tool.execute({})).documentId, 'notes/a');
  assert.equal((await policy.execute({ kind: 'document', documentId: 'notes/a' })).navigated, true);
  policy.dispose(); context.stop();
  `);
    execFileSync(process.execPath, ["consumer.mjs"], { cwd: fixture, stdio: "pipe" });
    writeFileSync(join(fixture, "consumer.ts"), `
  import { createSurfaceContext, createRevealPolicy } from '@superbee/agent-surface';
  import type { ToolDescriptor, AssistantEvent, AssistantSourceRef, NavigationRequest, AssistantPanelTransport } from '@superbee/agent-surface';
  const context = createSurfaceContext<'home'|'document', {documentId:string}>({ route:'home', validate(s) { s.documentId.toUpperCase(); } });
  const tool: ToolDescriptor = { name:'context', description:'Context', inputSchema:{type:'object'}, execute:async () => context.snapshot() };
  const event: AssistantEvent = {seq:1,at:'2026-10-01T00:00:00Z',type:'agent.text',payload:{text:'answer'}};
  const source: AssistantSourceRef = {sourceId:'s',kind:'portal-document',bundleId:'b',documentId:'d',artifactDigest:'a',snapshotDigest:'p'};
  const request: NavigationRequest = {sessionId:'s',turnId:'t',toolCallId:'c',surfaceId:'u',bindingId:'b',contextRevision:'r',target:{kind:'document',bundleId:'b',documentId:'d'},expiresAt:1};
  void [tool,event,source,request,createRevealPolicy];
  const transport: AssistantPanelTransport | undefined = undefined;
  void transport;
  `);
    execFileSync(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--lib", "ES2022,DOM", "consumer.ts"], { cwd: fixture, stdio: "pipe" });
    const browser = await build({ stdin: { contents: "export * from '@superbee/agent-surface'", resolveDir: fixture }, bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
    assert.ok(Object.keys(browser.metafile.inputs).every(name => !name.includes("node_modules") || name.includes("@superbee/agent-surface")));
    return { tarball, sha256: expectedDigest, verified: ["LICENSE/NOTICE presence and exact repository bytes", "offline external install", "inert ESM import", "direct invocation", "declaration imports", "browser bundle"] };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
console.log(JSON.stringify(proof));
