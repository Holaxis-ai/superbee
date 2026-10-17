// Vite build config for the `ui` SPA (plans/ui-v1.md rev 3.2).
//
// `publicDir: false` — this SPA has no pass-through public assets. Its real index and bundled
// assets come only from the Vite build below, which keeps the CLI embed input explicit.
//
// Deterministic, hashed asset filenames (Vite's default) are what makes the CLI's embed step
// reproducible byte-for-byte given identical source (see packages/cli/scripts/embed-ui-assets.mjs).
// `vitest/config`'s `defineConfig` merges Vite's `UserConfig` with the `test` block's type —
// a drop-in replacement for `vite`'s own `defineConfig` that also typechecks `test` below.
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Ship every self-hosted font's OFL license text alongside its woff2 in dist/
 * (embed-ui-assets.mjs gzips whatever lands in dist/ into the npm CLI bundle) — OFL 1.1 §2
 * requires the copyright and license notice travel with the Font Software, including a
 * subsetted/modified copy, and a sibling file that stays in `src/` (never built) does not
 * satisfy the npm distribution. Each font's own name-table IDs 0/13/14 carry a copy too
 * (belt); this is the plain-text suspenders, readable without a font parser.
 *
 * DERIVED from the directory, never a hardcoded list: this app self-hosts three faces and will
 * gain or lose others, and a missing license is a compliance failure that no test would catch.
 * The empty-directory guard turns a silently unlicensed build into a loud one.
 */
function shipFontLicense(): Plugin {
  const dir = new URL("./src/assets/fonts/", import.meta.url);
  return {
    name: "ship-font-license",
    generateBundle() {
      const licenses = readdirSync(dir).filter((f) => f.endsWith("-OFL.txt"));
      if (licenses.length === 0) {
        this.error("no *-OFL.txt found in src/assets/fonts — refusing to ship unlicensed fonts");
      }
      for (const name of licenses) {
        this.emitFile({
          type: "asset" as const,
          fileName: `assets/fonts/${name}`,
          source: readFileSync(new URL(name, dir)),
        });
      }
    },
  };
}

/**
 * Record every module this build actually rendered into dist/, as absolute paths, in a sidecar
 * OUTSIDE dist/ (dist/ is embedded byte-for-byte). The CLI distribution build reads it to name the
 * third-party packages whose code it ships inside the embedded UI (packages/superbee/build.mjs).
 * An empty set means the plugin saw nothing, which would silently drop every notice: fail loudly.
 */
const BUNDLED_MODULES_FILE = fileURLToPath(new URL("./build-meta/bundled-modules.json", import.meta.url));
function recordBundledModules(): Plugin {
  return {
    name: "record-bundled-modules",
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, rendered] of Object.entries(output.modules)) {
          const path = id.replace(/^\0/, "").replace(/\?.*$/, "");
          if (rendered.renderedLength > 0 && path.startsWith("/")) modules.add(path);
        }
      }
      if (modules.size === 0) this.error("no rendered modules recorded — refusing to drop third-party notices");
      mkdirSync(dirname(BUNDLED_MODULES_FILE), { recursive: true });
      writeFileSync(BUNDLED_MODULES_FILE, JSON.stringify([...modules].sort(), null, 2) + "\n");
    },
  };
}

export default defineConfig({
  plugins: [react(), shipFontLicense(), recordBundledModules()],
  publicDir: false,
  build: {
    outDir: "dist",
    sourcemap: false,
    // No inline scripts in the emitted HTML — required by the strict CSP the `ui` server sets
    // on every asset response (default-src 'self', no 'unsafe-inline').
    modulePreload: { polyfill: false },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
