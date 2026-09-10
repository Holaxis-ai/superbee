/**
 * Isomorphic-boundary gate: every core subpath the BROWSER runtime-imports must bundle for the
 * browser with no `node:*` builtin. The SPA (packages/ui) runtime-imports `@superbee/core`
 * subpaths — `links` (resolveConceptId), `meaningful-change-time`
 * (meaningfulChangeTimeValue), `page` (parseRegistration), `query-selection`
 * (applyQuerySelectionFilters), `kinds` (isTerminal) — into a bundle where node builtins do not
 * resolve.
 *
 * This DECLARES that isomorphic surface once and gates it, rather than discovering a Node-only
 * import the hard way at build time (the `links.ts` → `node:path` break, designs/doc-reader HIGH-1,
 * cost a real detour). Each subpath is bundled with esbuild `platform: "browser"`; any node builtin
 * sneaking in fails with "Could not resolve" (red-on-regression). Requires a prior root build — the
 * sibling-dist convention other core tests document.
 *
 * ADD A SUBPATH HERE when the browser starts runtime-importing a new core subpath — keep this list
 * in sync with the SPA's runtime `@superbee/core/*` imports. `versioning` and `memory-backend`
 * are the browser-local working copy's token minting and store for SaaS mode, `indexeddb-backend`
 * its persistent store candidate; `mutation`, `bundle-ops` and `document-mutation` are its
 * read/decide/CAS document mutation path; `uncertain-write` is the shared unknown-outcome
 * primitive its sync component pushes intents through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { build } from "esbuild";

import { stringifyDoc } from "../src/frontmatter.js";
import { contentVersion } from "../src/versioning.js";
import type { OkfDocument } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** subpath dist module -> a symbol the bundle must still carry (proves the entry resolved, not an empty file). */
const BROWSER_SUBPATHS: Array<{ module: string; symbol: string }> = [
  { module: "engine.js", symbol: "writeDocVersioned" },
  { module: "links.js", symbol: "resolveConceptId" },
  { module: "meaningful-change-time.js", symbol: "meaningfulChangeTimeValue" },
  { module: "page.js", symbol: "parseRegistration" },
  { module: "query-filter.js", symbol: "matchesFilter" },
  { module: "query-selection.js", symbol: "applyQuerySelectionFilters" },
  { module: "kinds.js", symbol: "isTerminal" },
  { module: "remote.js", symbol: "RemoteBackend" },
  { module: "storage.js", symbol: "assertSafeConceptId" },
  { module: "versioning.js", symbol: "contentVersion" },
  { module: "memory-backend.js", symbol: "MemoryBackend" },
  { module: "indexeddb-backend.js", symbol: "IndexedDbBackend" },
  { module: "mutation.js", symbol: "versionedMutation" },
  { module: "bundle-ops.js", symbol: "backendFor" },
  { module: "document-mutation.js", symbol: "mutateDocument" },
  { module: "uncertain-write.js", symbol: "performUncertainWrite" },
];

for (const { module, symbol } of BROWSER_SUBPATHS) {
  test(`core/${module} bundles for the browser with no node builtins`, async () => {
    const result = await build({
      entryPoints: [path.resolve(here, "../dist", module)],
      bundle: true,
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0, `${module}: ${JSON.stringify(result.errors, null, 2)}`);
    assert.ok(result.outputFiles[0]!.text.includes(symbol), `${module}: bundled output must carry ${symbol}`);
  });
}

test("core/versioning mints Node-identical tokens in a sandbox with no process, Buffer, or node:crypto", async () => {
  const result = await build({
    entryPoints: [path.resolve(here, "../dist/versioning.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeVersioning",
    write: false,
    logLevel: "silent",
  });
  const sandbox: Record<string, unknown> = { TextEncoder };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  runInNewContext(result.outputFiles[0]!.text, sandbox);
  const versioning = sandbox.SuperbeeVersioning as {
    contentVersion(doc: { id: string; frontmatter: Record<string, unknown>; body: string }): string;
    blobVersion(bytes: Uint8Array): string;
    defaultActor(): string;
  };
  const doc = { id: "browser/proof", frontmatter: { type: "Proof", title: "Ünïcödé 🐝" }, body: "same bytes, same token\n" };
  assert.equal(
    versioning.contentVersion(doc),
    `sha256:${createHash("sha256").update(stringifyDoc(doc.frontmatter, doc.body), "utf8").digest("hex")}`,
  );
  const blob = new Uint8Array([0x80, 0xff, 0xfe, 0x00]);
  assert.equal(versioning.blobVersion(blob), `sha256:${createHash("sha256").update(blob).digest("hex")}`);
  assert.equal(versioning.defaultActor(), "local");
});

test("core/engine executes bundle-version parsing with no Buffer global", async () => {
  const result = await build({
    entryPoints: [path.resolve(here, "../dist/engine.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeEngine",
    write: false,
    logLevel: "silent",
  });
  const sandbox: Record<string, unknown> = {};
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  runInNewContext(result.outputFiles[0]!.text, sandbox);
  const engine = sandbox.SuperbeeEngine as {
    readBundleOkfVersion(backend: unknown): Promise<string | undefined>;
    writeDocVersioned(
      backend: unknown,
      doc: { id: string; frontmatter: Record<string, unknown>; body: string },
    ): Promise<{ doc: { frontmatter: Record<string, unknown> }; version: string }>;
  };
  let written: { frontmatter: Record<string, unknown> } | undefined;
  const backend = {
    readReserved: async () => ({
      content: "\uFEFF---\nokf_version: '0.2'\n---\n# Worker-safe\n",
      version: "proof",
    }),
    write: async (_id: string, doc: { frontmatter: Record<string, unknown> }) => {
      written = doc;
      return "sha256:proof";
    },
  };
  assert.equal(await engine.readBundleOkfVersion(backend), "0.2");
  const resultDoc = await engine.writeDocVersioned(backend, {
    id: "worker/bom-proof",
    frontmatter: { type: "Proof" },
    body: "v0.2 stays v0.2",
  });
  assert.equal(resultDoc.doc.frontmatter.timestamp, undefined);
  assert.equal(written?.frontmatter.timestamp, undefined);
});

test("core/document-mutation updates a document body over MemoryBackend in a sandbox with no process, Buffer, or node builtins, minting Node's version", async () => {
  // One bundle for the mutation path and the store, so the sandbox shares a single class graph
  // (VersionConflict, MemoryBackend) exactly as a browser working copy would.
  const result = await build({
    stdin: {
      contents: [
        'export { mutateDocument } from "./document-mutation.js";',
        'export { backendFor } from "./bundle-ops.js";',
        'export { MemoryBackend } from "./memory-backend.js";',
      ].join("\n"),
      resolveDir: path.resolve(here, "../dist"),
      loader: "js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "SuperbeeMutation",
    write: false,
    logLevel: "silent",
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors, null, 2));
  // TextEncoder is a web platform global. structuredClone is too, but Node's clones carry the
  // outer realm's prototypes and the engine's mapping checks are per realm, so the sandbox gets
  // an in-realm clone shim and the whole proof runs inside that one realm, as a browser would.
  const sandbox: Record<string, unknown> = { TextEncoder };
  assert.equal(runInNewContext("typeof process", sandbox), "undefined");
  assert.equal(runInNewContext("typeof Buffer", sandbox), "undefined");
  assert.equal(runInNewContext("typeof require", sandbox), "undefined");
  runInNewContext("globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));", sandbox);
  runInNewContext(result.outputFiles[0]!.text, sandbox);

  // No Node entry ran in the sandbox, so a bare { root } has no filesystem default to fall back on.
  // The sandbox realm has its own Error constructor, so identify the refusal by name, not instanceof.
  const refusal = runInNewContext(
    "(() => { try { SuperbeeMutation.backendFor({ root: '/nowhere' }); return null; } catch (error) { return { name: error.name, message: error.message }; } })()",
    sandbox,
  ) as { name: string; message: string } | null;
  assert.equal(refusal?.name, "InvalidInputError");
  assert.match(refusal?.message ?? "", /pass bundle\.backend explicitly/);

  const proof = (await runInNewContext(
    `(async () => {
      const { mutateDocument, MemoryBackend } = SuperbeeMutation;
      const backend = new MemoryBackend();
      await backend.writeReserved("", "index.md", "---\\nokf_version: '0.2'\\n---\\n# Browser proof\\n");
      const bundle = { root: "browser-working-copy", backend };
      const registry = { kinds: new Map(), warnings: [] };
      const id = "browser/proof";
      const created = await mutateDocument({
        bundle, id, mode: "create-only", registry, strict: false, actor: "process:browser",
        now: () => "2026-09-10T12:00:00.000Z",
        buildCandidate: () => ({ frontmatter: { type: "Proof", title: "\u00dcn\u00efc\u00f6d\u00e9 \u{1F41D}" }, body: "first body\\n" }),
      });
      const updated = await mutateDocument({
        bundle, id, mode: "patch", registry, strict: false, actor: "process:browser",
        now: () => "2026-09-10T12:05:00.000Z",
        buildCandidate: (existing) => ({ frontmatter: { ...existing.frontmatter }, body: "second body\\n" }),
      });
      const head = await backend.read(id);
      const history = await backend.versions(id);
      return JSON.stringify({ created, updated, headVersion: head.version, historyLength: history.length });
    })()`,
    sandbox,
  )) as string;
  const { created, updated, headVersion, historyLength } = JSON.parse(proof) as {
    created: { doc: OkfDocument; changed: boolean; version: string };
    updated: { doc: OkfDocument; changed: boolean; version: string };
    headVersion: string;
    historyLength: number;
  };
  assert.equal(created.changed, true);
  assert.equal(created.version, contentVersion(created.doc));

  assert.equal(updated.changed, true);
  assert.equal(updated.doc.body, "second body\n");
  assert.equal(updated.doc.frontmatter.title, "\u00dcn\u00efc\u00f6d\u00e9 \u{1F41D}");
  assert.notEqual(updated.version, created.version);
  assert.equal(updated.version, contentVersion(updated.doc), "sandbox token equals the Node engine's contentVersion");
  assert.equal(
    updated.version,
    `sha256:${createHash("sha256").update(stringifyDoc(updated.doc.frontmatter, updated.doc.body), "utf8").digest("hex")}`,
    "sandbox token equals node:crypto over the same serialized bytes",
  );
  assert.equal(headVersion, updated.version, "the store's head is the write the sandbox reported");
  assert.equal(historyLength, 2, "one create and one CAS update, no retries");
});
