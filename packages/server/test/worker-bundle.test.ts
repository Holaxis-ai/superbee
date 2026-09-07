import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

test("server/router dry-bundles for browser and Worker runtimes without Node builtins", async () => {
  for (const platform of ["browser", "neutral"] as const) {
    const result = await build({
      entryPoints: [path.resolve(here, "../dist/router.js")],
      bundle: true,
      platform,
      conditions: platform === "neutral" ? ["worker", "browser", "import"] : ["browser", "import"],
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.outputFiles[0]!.text.includes("resolveWireRequest"));
    assert.ok(
      Object.keys(result.metafile.inputs).every((input) => !input.startsWith("node:")),
      `${platform} graph contains a Node builtin`,
    );
  }
});
