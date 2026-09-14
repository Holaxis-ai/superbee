/**
 * Test-time module resolver: map relative `./x.js` specifiers to their `./x.ts`
 * sibling when present, so Node's built-in TypeScript type-stripping can run the
 * `src/` sources directly (the project uses NodeNext `.js` import specifiers).
 *
 * Used only for `npm test` (see package.json). Production builds go through esbuild
 * (`build.mjs`). Copied verbatim from `packages/core/test/ts-loader.mjs`.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      const tsSpecifier = specifier.slice(0, -3) + ".ts";
      try {
        const url = new URL(tsSpecifier, context.parentURL).href;
        if (existsSync(fileURLToPath(url))) {
          return nextResolve(tsSpecifier, context);
        }
      } catch {
        /* fall through to default resolution */
      }
    }
    return nextResolve(specifier, context);
  },
});
