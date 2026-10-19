import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { SOURCE_FEED_CONVENTION,signalConvention } from "../../core/test/record-overlay-helpers.js";
import { testSourceForAuthor } from "../src/integration-author/source-test.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSourcePlugin, listSourcePlugins, removeSourcePlugin, selectSourceProfile, registeredRecipe } from "../src/source-plugins.js";
import { canonicalUserStateDir } from "../src/user-state.js";
import { validateRecipeForAuthor } from "../src/integration-author/validate.js";
import { syntheticFeedDoc,pluginFixture, registerFixture } from "./source-plugin-fixture.js";
async function fixture(body: (base: string, home: string, root: string) => Promise<void>) { const base = await mkdtemp(join(tmpdir(), "plugin-lifecycle-")), home = join(base, "home"); await mkdir(home); try {
    await body(base, home, await pluginFixture(base));
}
finally {
    await rm(base, { recursive: true, force: true });
} }
const reason = (r: string) => (e: unknown) => (e as {
    details?: {
        reason: string;
    };
}).details?.reason === r;
test("preview, acceptance, list, snapshot recipe and author validation are inert", () => fixture(async (base, home, root) => {
    const module = join(root, "dist/profile.mjs");
    await writeFile(module, "throw new Error('execution sentinel');\n" + await readFile(module, "utf8"));
    const p = await registerSourcePlugin(root, undefined, home);
    assert.equal(p.accepted, false);
    assert.equal((await lstat(canonicalUserStateDir(home)).catch(() => null)), null);
    await registerSourcePlugin(root, p.digest as string, home);
    assert.equal(((await listSourcePlugins(home)).plugins as unknown[]).length, 1);
    assert.equal((await registeredRecipe("github:work-items", home))?.ok, true);
    const validation = await validateRecipeForAuthor(join(root, "recipes/work-items"), { stateInput: home });
    assert.equal(validation.ok, true, JSON.stringify(validation));
    assert.ok(validation.connectors.flatMap(c => c.sources).some(s => s.validation === "deferred"));
    await assert.rejects((await selectSourceProfile("github-issues", home))!.load(), reason("plugin_execution_failed"));
}));
test("source replacement, incompatibility and unsupported identities preserve prior activation", () => fixture(async (base, home, root) => {
    await registerFixture(root, home);
    const before = await listSourcePlugins(home);
    const p = await registerSourcePlugin(root, undefined, home);
    await writeFile(join(root, "dist/profile.mjs"), "throw new Error('changed sentinel');");
    await assert.rejects(registerSourcePlugin(root, p.digest as string, home), reason("plugin_changed"));
    assert.deepEqual(await listSourcePlugins(home), before);
    for (const transform of [(m: any) => { m.superbeeIntegration.core = "999.0.0"; }, (m: any) => { m.superbeeIntegration.contract = 2; }, (m: any) => { m.superbeeIntegration.profiles[0].id = "rest-json"; }, (m: any) => { m.superbeeIntegration.profiles[0].entry = "../escape.mjs"; }, (m: any) => { m.superbeeIntegration.extra = true; }]) {
        const m = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        transform(m);
        await writeFile(join(root, "package.json"), JSON.stringify(m));
        await assert.rejects(registerSourcePlugin(root, undefined, home));
        assert.deepEqual(await listSourcePlugins(home), before);
        await rm(join(base, "plugin-1.0.0"), { recursive: true });
        root = await pluginFixture(base);
    }
}));
test("links, executable recipe payload and bounded manifest refuse before registration", () => fixture(async (base, home, root) => {
    const entry = join(root, "dist/profile.mjs"), bytes = await readFile(entry);
    await rm(entry);
    await symlink(join(base, "outside"), entry);
    await assert.rejects(registerSourcePlugin(root, undefined, home));
    await rm(entry);
    await writeFile(entry, bytes);
    await writeFile(join(root, "recipes/source-feeds/execute.mjs"), "throw 1");
    await assert.rejects(registerSourcePlugin(root, undefined, home));
    await rm(join(root, "recipes/source-feeds/execute.mjs"));
    await writeFile(join(root, "package.json"), " ".repeat(65537));
    await assert.rejects(registerSourcePlugin(root, undefined, home));
}));
test("tamper refuses inert selection; a selected generation survives update and removal", () => fixture(async (base, home, root) => {
    await registerFixture(root, home);
    const selected = (await selectSourceProfile("github-issues", home))!;
    const second = await pluginFixture(base, { version: "1.1.0", prefix: "throw new Error('new-generation sentinel');\n" });
    await registerFixture(second, home);
    assert.equal((await selected.load()).id, "github-issues");
    await removeSourcePlugin("github", home);
    assert.equal(await selectSourceProfile("github-issues", home), undefined);
    assert.equal((await selected.load()).id, "github-issues");
    assert.deepEqual((await listSourcePlugins(home)).plugins, []);
    await registerFixture(root, home);
    const a = JSON.parse(await readFile(join(canonicalUserStateDir(home), "source-plugin-github.json"), "utf8"));
    const entry = join(canonicalUserStateDir(home), "source-plugins", a.generation, "dist/profile.mjs");
    await writeFile(entry, "throw new Error('tamper sentinel');", { mode: 0o600 });
    await assert.rejects(selectSourceProfile("github-issues", home), reason("plugin_changed"));
}));
test("failed publication preserves previous active pointer", () => fixture(async (base, home, root) => {
    await registerFixture(root, home);
    const before = await listSourcePlugins(home), second = await pluginFixture(base, { version: "1.1.0" });
    const area = join(canonicalUserStateDir(home), "source-plugins");
    await chmod(area, 0o755);
    const p = await registerSourcePlugin(second, undefined, home);
    await assert.rejects(registerSourcePlugin(second, p.digest as string, home), reason("plugin_path_unsafe"));
    await chmod(area, 0o700);
    assert.deepEqual(await listSourcePlugins(home), before);
}));
test("factory must match the admitted profile metadata", () => fixture(async (base, home, root) => {
 await writeFile(join(root,"dist/profile.mjs"),'export function createSourceProfile(h) { return {...h.restJsonProfile,id:"github-issues",version:2,kind:"extension"}; }');
 await registerFixture(root,home);
 await assert.rejects((await selectSourceProfile("github-issues",home))!.load(),reason("plugin_export_invalid"));
}));

test("source test defaults to the same accepted synthetic profile through recorded data",()=>fixture(async(base,home,root)=>{
 await registerFixture(root,home);const folder=join(base,"recorded");await mkdir(folder);
 const expected={receipt:{outcome:"provider_unavailable",reason:"server_error",pages:0,held:0,pending:0,pass:{resumed:false,ended:false,complete:false},changes:{new:0,changed:0,disappeared:0}},cursor:null,requests:[{url:"https://api.github.com/repos/example-org/widgets/issues",method:"GET",headers:{"x-github-api-version":"synthetic-v1","user-agent":"SuperbeeSourceFixture/1 (+https://superbee.example.org/source-fixture)"}}],changes:[],findings:[{key:"source:issues:provider_unavailable:server_error",title:"Source issues: provider unavailable (server error)",summary:"the provider did not answer usefully; nothing past the last committed page was read. Status 503. (https://api.github.com/repos/example-org/widgets/issues)",priority:"low",facts:{outcome:"provider_unavailable",reason:"server_error",status:503}}]};
 await writeFile(join(folder,"fixture.json"),JSON.stringify({version:1,connector:"connectors/github",source:"issues",feed:syntheticFeedDoc.id,documents:[syntheticFeedDoc,{id:"conventions/source-feed",body:"",frontmatter:SOURCE_FEED_CONVENTION},{id:"conventions/signal",body:"",frontmatter:signalConvention("superbee_progress_status")}],scenarios:[{name:"errors.server",runs:[{exchanges:[{request:{method:"GET",url:"https://api.github.com/repos/example-org/widgets/issues"},response:{status:503,body:""}}]}],expect:[expected]}]}));
 const report=await testSourceForAuthor(join(root,"recipes/work-items"),folder,{stateInput:home});
 assert.deepEqual(report.profile,{id:"github-issues",version:1,kind:"extension"});assert.equal(report.execution,"recorded");assert.deepEqual(report.diagnostics,[]);assert.equal(report.scenarios.length,1);assert.ok(report.scenarios.every(s=>s.ok),JSON.stringify(report));assert.equal(report.missing.length,13);assert.equal(report.ok,false);
}));
