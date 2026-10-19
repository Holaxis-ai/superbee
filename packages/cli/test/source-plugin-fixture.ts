/** Synthetic installed artifact for loader tests; no provider implementation or community recipe bytes. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { SOURCE_FEED_CONVENTION, signalConvention } from "../../core/test/record-overlay-helpers.js";
import { registerSourcePlugin } from "../src/source-plugins.js";
export const syntheticResource = "https://github.com/example-org/widgets";
export const syntheticFeed = "source-feeds/github";
export const syntheticRecords = [{ id: "synthetic-42", title: "Synthetic changed title", key: "synthetic-key-42" }];
export const syntheticConnector = { type: "Connector", title: "Synthetic loader fixture", version: "1", auth: { kind: "token", provider: "github" }, record_sources: [{ name: "issues", profile: "github-issues", target_kind: "Ticket", mode: "overlay", identity: { resource: "https://github.com/{owner}/{repo}", id: "{id}" }, fields: { title: "title", key: "key" }, completeness: "complete", request: { host: "api.github.com", method: "GET", path: "/repos/{owner}/{repo}/issues", items: "", headers: { "x-github-api-version": "synthetic-v1" }, paging: { kind: "link-header" }, complete: "always" } }] };
export const syntheticFeedDoc = { id: syntheticFeed, body: "", frontmatter: { type: "Source Feed", title: "Synthetic feed", feed_kind: "connector", connector: "connectors/github", source: "issues", url: syntheticResource, owned_fields: ["title", "key"], exclude_pattern: "never-match" } };
const markdown = (frontmatter: unknown) => `---\n${JSON.stringify(frontmatter)}\n---\nSynthetic test data.\n`;
export function syntheticRecipeFiles(name: "source-feeds" | "work-items") {
    const files: Record<string, string> = { "recipe.md": markdown({ type: "Recipe", id: name === "source-feeds" ? "synthetic-feeds" : "synthetic-items", title: "Synthetic fixture", version: "1", summary: "Loader fixture definitions.", content_policy: "definitions-only", ...(name === "work-items" ? { connectors: ["connectors/github.md"] } : {}) }) };
    if (name === "source-feeds")
        Object.assign(files, { "conventions/source-feed.md": markdown(SOURCE_FEED_CONVENTION), "conventions/signal.md": markdown(signalConvention("superbee_progress_status")) });
    else
        Object.assign(files, { "conventions/ticket.md": markdown({ type: "Convention", title: "Ticket", governs: "Ticket", path: "tickets/", fields: { required: ["title"], optional: ["key"] } }), "connectors/github.md": markdown(syntheticConnector) });
    return files;
}
export async function writeSyntheticRecipe(root: string, name: "source-feeds" | "work-items") { for (const [file, bytes] of Object.entries(syntheticRecipeFiles(name))) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), bytes);
} return root; }
export async function pluginFixture(base: string, options: {
    version?: string;
    prefix?: string;
    suffix?: string;
} = {}) {
    const root = join(base, `plugin-${options.version ?? "1.0.0"}`);
    await mkdir(join(root, "dist"), { recursive: true });
    for (const name of ["source-feeds", "work-items"] as const)
        await writeSyntheticRecipe(join(root, "recipes", name), name);
    const m = { name: "@superbee/integration-github", version: options.version ?? "1.0.0", superbeeIntegration: { contract: 1, id: "github", core: SOURCE_PLUGIN_CORE_VERSION, profiles: [{ id: "github-issues", version: 1, entry: "dist/profile.mjs" }], recipes: { "source-feeds": "recipes/source-feeds", "work-items": "recipes/work-items" } } };
    await writeFile(join(root, "package.json"), JSON.stringify(m));
    await writeFile(join(root, "dist/profile.mjs"), (options.prefix ?? "") + 'export function createSourceProfile(h) { return {...h.restJsonProfile,id:"github-issues",version:1,kind:"extension"}; }' + (options.suffix ?? ""));
    return root;
}
export async function registerFixture(root: string, home: string) { const p = await registerSourcePlugin(root, undefined, home); return registerSourcePlugin(root, p.digest as string, home); }
