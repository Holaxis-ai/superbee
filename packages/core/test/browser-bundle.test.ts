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
 * in sync with the SPA's runtime `@superbee/core/*` imports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

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
  };
  const backend = {
    readReserved: async () => ({
      content: "---\nokf_version: '0.2'\n---\n# Worker-safe\n",
      version: "proof",
    }),
  };
  assert.equal(await engine.readBundleOkfVersion(backend), "0.2");
});
