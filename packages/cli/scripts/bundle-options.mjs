import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p) => resolve(root, p);
export const workspaceAliases = {
      // jsonc-parser's package "main" points at a UMD build whose relative require() calls cannot
      // survive inside our one-file ESM artifact. Pin its published ESM entry for bundling while
      // ordinary TypeScript/tests continue to consume the package's declared typings.
      "jsonc-parser": r("../../node_modules/jsonc-parser/lib/esm/main.js"),
      // List browser-safe core subpaths before the package root so esbuild does not append the
      // subpath to `index.ts` (which would resolve as the impossible `index.ts/page`).
      "@superbee/core/engine": r("../core/src/engine.ts"),
      "@superbee/core/document-codec": r("../core/src/document-codec.ts"),
      "@superbee/core/recipes": r("../core/src/recipes.ts"),
      "@superbee/core/storage": r("../core/src/storage.ts"),
      "@superbee/core/view-admission": r("../core/src/view-admission.ts"),
      "@superbee/core/page": r("../core/src/page.ts"),
      "@superbee/core/links": r("../core/src/links.ts"),
      "@superbee/core/meaningful-change-time": r("../core/src/meaningful-change-time.ts"),
      "@superbee/core/mutation-attribution": r("../core/src/mutation-attribution.ts"),
      "@superbee/core/publication-filesystem": r("../core/src/publication-filesystem.ts"),
      "@superbee/core": r("../core/src/index.ts"),
      // The git tier lives in its own workspace package (board-git A1); alias to source so the
      // npm artifact stays ONE self-contained file with no dist pre-build.
      "@superbee/board-git": r("../board-git/src/index.ts"),
      // server/src/index.ts is guard-free re-exports (createRouter + serve) — its only deps are
      // core + node:http, so aliasing straight to it keeps the esbuild bundle ONE self-contained file.
      "@superbee/server": r("../server/src/index.ts"),
      // The experimental conversational View adapter is private workspace source. It is bundled
      // into the npm CLI exactly like the other internal packages, leaving no runtime workspace
      // dependency for users to install or resolve.
      "@superbee/mcp-app": r("../mcp-app/src/index.ts"),
      // Shared human-surface primitives are private workspace source too. Alias them explicitly
      // so a clean npm build never depends on sibling dist/ directories existing.
      "@superbee/markdown-renderer/static": r("../markdown-renderer/src/static.tsx"),
      "@superbee/markdown-renderer": r("../markdown-renderer/src/index.tsx"),
      "@superbee/view-runtime": r("../view-runtime/src/index.ts"),
      // The loopback UI runtime is a private workspace package; source-alias it so the npm CLI
      // remains one self-contained artifact with no workspace dependency at install time.
      "@superbee/ui-server": r("../ui-server/src/index.ts"),
    };

export const runtimeBanner = { js: "import { createRequire as ___createRequire } from 'node:module';\nconst require = ___createRequire(import.meta.url);" };
