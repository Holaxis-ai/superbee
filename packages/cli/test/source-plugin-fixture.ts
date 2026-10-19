/** Test-only synthetic installed package: real standalone code, independently mutable package bytes. */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { registerSourcePlugin } from "../src/source-plugins.js";
const repo = fileURLToPath(new URL("../../..", import.meta.url));
export async function pluginFixture(base: string, options: {
    version?: string;
    prefix?: string;
    suffix?: string;
} = {}) {
    const root = join(base, `plugin-${options.version ?? "1.0.0"}`);
    await mkdir(join(root, "dist"), { recursive: true });
    for (const name of ["source-feeds", "work-items"])
        await cp(join(repo, "examples/recipes", name), join(root, "recipes", name), { recursive: true });
    const m = { name: "@superbee/integration-github", version: options.version ?? "1.0.0", superbeeIntegration: { contract: 1, id: "github", core: SOURCE_PLUGIN_CORE_VERSION, profiles: [{ id: "github-issues", version: 1, entry: "dist/profile.mjs" }], recipes: { "source-feeds": "recipes/source-feeds", "work-items": "recipes/work-items" } } };
    await writeFile(join(root, "package.json"), JSON.stringify(m));
    await writeFile(join(root, "dist/profile.mjs"), (options.prefix ?? "") + await readFile(join(repo, "packages/integration-github/dist/profile.mjs"), "utf8") + (options.suffix ?? ""));
    return root;
}
export async function registerFixture(root: string, home: string) { const p = await registerSourcePlugin(root, undefined, home); return registerSourcePlugin(root, p.digest as string, home); }
