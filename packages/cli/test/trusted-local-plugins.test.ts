import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { registerSourcePlugin, listSourcePlugins, removeSourcePlugin, selectSourceProfile } from "../src/source-plugins.js";
import { registerOperationPlugin, listOperationPlugins, removeOperationPlugin, selectLocalOperation } from "../src/operation-plugins.js";
import { canonicalUserStateDir } from "../src/user-state.js";
import { sourceDigest } from "../src/source-local/state.js";
import { withCliFilesystemMutationLock } from "../src/filesystem-runtime.js";
import { trustedLocalPlugins, type PluginPointer } from "../src/trusted-local-plugins.js";
import { CliError } from "../src/errors.js";
import { pluginFixture } from "./source-plugin-fixture.js";

for (const kind of ["source", "operation"] as const) {
    const register = kind === "source" ? registerSourcePlugin : registerOperationPlugin;
    const list = kind === "source" ? listSourcePlugins : listOperationPlugins;
    const remove = kind === "source" ? removeSourcePlugin : removeOperationPlugin;
    const active = kind === "source" ? "source-plugin-github.json" : "operation-plugins.json";
    const area = kind === "source" ? "source-plugins" : "operation-plugins";
    async function artifact(base: string, id = "fixture", version = "1.0.0", collision = false) {
        if (kind === "source") return pluginFixture(base, { id, version, profiles: [{ id: collision ? "fixture-records" : `${id}-records`, version: 1, entry: "dist/profile.mjs" }], prefix: "throw Error('inert sentinel');\n" });
        const root = join(base, `${id}-${version}`); await mkdir(join(root, "dist"), { recursive: true });
        await writeFile(join(root, "package.json"), JSON.stringify({ name: id, version, superbeeLocalOperations: { contract: 1, id, core: SOURCE_PLUGIN_CORE_VERSION, helper: 1, entry: "dist/profile.mjs", assets: [], operations: [{ id: `local.fixture.${collision ? "fixture" : id}.v1`, capability: { name: `fixture_${collision ? "fixture" : id}`, implementationId: "fixture/1", description: "Finite fixture", inputSchema: { type: "object" } } }] } }));
        await writeFile(join(root, "dist/profile.mjs"), "throw Error('inert sentinel');"); return root;
    }
    const select = (home: string, id = "fixture") => kind === "source" ? selectSourceProfile(`${id}-records`, home) : selectLocalOperation(`local.fixture.${id}.v1`, home);
    async function fixture(run: (base: string, home: string, root: string) => Promise<void>) {
        const base = await mkdtemp(join(tmpdir(), `trusted-${kind}-`)), home = join(base, "home"); await mkdir(home);
        try { await run(base, home, await artifact(base)); } finally { await rm(base, { recursive: true, force: true }); }
    }
    async function accept(root: string, home: string) { const p = await register(root, undefined, home); return register(root, p.digest as string, home); }
    test(`${kind}: finite preview/list/selection are inert; failed publication and changed acceptance retain state`, () => fixture(async (base, home, root) => {
        const p = await register(root, undefined, home); assert.equal(p.accepted, false); assert.equal(await lstat(canonicalUserStateDir(home)).catch(() => null), null);
        await accept(root, home); const before = await list(home); assert.ok(await select(home));
        await writeFile(join(root, "dist/profile.mjs"), "throw Error('replacement');");
        await assert.rejects(register(root, p.digest as string, home)); assert.deepEqual(await list(home), before);
        const replacement = await artifact(base, "fixture", "1.1.0"); await chmod(join(canonicalUserStateDir(home), area), 0o755);
        await assert.rejects(accept(replacement, home)); await chmod(join(canonicalUserStateDir(home), area), 0o700); assert.deepEqual(await list(home), before);
    }));
    test(`${kind}: links, non-UTF8, bounds, unsafe declarations and generation tamper refuse`, () => fixture(async (_base, home, root) => {
        await accept(root, home); const original = await readFile(join(root, "dist/profile.mjs"));
        await rm(join(root, "dist/profile.mjs")); await symlink("missing", join(root, "dist/profile.mjs")); await assert.rejects(register(root, undefined, home)); await rm(join(root, "dist/profile.mjs"));
        for (const bytes of [Buffer.from([255]), Buffer.from("x".repeat(2 * 1024 * 1024 + 1))]) { await writeFile(join(root, "dist/profile.mjs"), bytes); await assert.rejects(register(root, undefined, home)); }
        await writeFile(join(root, "dist/profile.mjs"), original);
        const manifest = await readFile(join(root, "package.json"), "utf8"), m = JSON.parse(manifest);
        for (const entry of ["../outside.mjs", "/absolute.mjs", "dist\\entry.mjs", "dist//entry.mjs", "package.json"]) {
            const next = structuredClone(m); if (kind === "source") next.superbeeIntegration.profiles[0].entry = entry; else next.superbeeLocalOperations.entry = entry;
            await writeFile(join(root, "package.json"), JSON.stringify(next)); await assert.rejects(register(root, undefined, home));
        }
        await writeFile(join(root, "package.json"), " ".repeat(65537)); await assert.rejects(register(root, undefined, home)); await writeFile(join(root, "package.json"), manifest);
        const pointer = JSON.parse(await readFile(join(canonicalUserStateDir(home), active), "utf8")), row = kind === "source" ? pointer.plugins[0] : pointer[0];
        await writeFile(join(canonicalUserStateDir(home), area, row.generation, "dist/profile.mjs"), "changed"); await assert.rejects(select(home));
        assert.equal((await remove("fixture", home)).removed, true); assert.equal(await select(home), undefined);
    }));
    test(`${kind}: incompatible accepted metadata remains inspectable; selection refuses without rewriting`, () => fixture(async (_base, home, root) => {
        await accept(root, home);
        const file = join(canonicalUserStateDir(home), active), pointers = JSON.parse(await readFile(file, "utf8")), row = kind === "source" ? pointers.plugins[0] : pointers[0];
        const generation = join(canonicalUserStateDir(home), area, row.generation), m = JSON.parse(await readFile(join(generation, "package.json"), "utf8"));
        m[kind === "source" ? "superbeeIntegration" : "superbeeLocalOperations"].core = "future-core";
        await writeFile(join(generation, "package.json"), JSON.stringify(m));
        const proposal = await register(root, undefined, home), files = [];
        for (const f of proposal.files as { path: string }[]) files.push({ path: f.path, bytes: await readFile(join(generation, f.path), "utf8") });
        row.digest = sourceDigest(files); await writeFile(file, JSON.stringify(pointers));
        const before = await readFile(file, "utf8"); assert.equal(((await list(home)).plugins as { core: string }[])[0]!.core, "future-core"); await assert.rejects(select(home)); assert.equal(await readFile(file, "utf8"), before);
    }));
    test(`${kind}: aggregate and declared entry counts are finite`, () => fixture(async (_base, home, root) => {
        const file=join(root,"package.json"), original=JSON.parse(await readFile(file,"utf8")), m=structuredClone(original);
        const entries=Array.from({length:5},(_,i)=>`dist/large-${i}.mjs`);
        if(kind==="source") m.superbeeIntegration.profiles=entries.map((entry,i)=>({id:`large-${i}`,version:1,entry}));
        else m.superbeeLocalOperations.assets=entries;
        for(const entry of entries)await writeFile(join(root,entry),"x".repeat(2*1024*1024));
        await writeFile(file,JSON.stringify(m));await assert.rejects(register(root,undefined,home));
        if(kind==="source") {
            await writeFile(file,JSON.stringify(original));
            for(let i=0;i<260;i++)await writeFile(join(root,"recipes/work-items",`extra-${i}.md`),"inert");
        } else {original.superbeeLocalOperations.assets=Array.from({length:256},(_,i)=>`asset-${i}.txt`);await writeFile(file,JSON.stringify(original));}
        await assert.rejects(register(root,undefined,home));
    }));
    test(`${kind}: queued independent mutations retain rows and collisions have one winner`, () => fixture(async (base, home, root) => {
        await accept(root, home); const second = await artifact(base, "second"), third = await artifact(base, "third");
        const proposals = await Promise.all([second, third].map(folder => register(folder, undefined, home)));
        let unlock!: () => void, locked!: () => void;
        const acquired = new Promise<void>(resolve => { locked = resolve; }), release = new Promise<void>(resolve => { unlock = resolve; });
        const lock = withCliFilesystemMutationLock(join(canonicalUserStateDir(home), active), async () => { locked(); await release; }, { portableRoot: canonicalUserStateDir(home) });
        await acquired;
        const queued = [register(second, proposals[0]!.digest as string, home), register(third, proposals[1]!.digest as string, home)]; unlock(); await lock; await Promise.all(queued);
        assert.equal(((await list(home)).plugins as unknown[]).length, 3);
        const left = await artifact(base, "left", "1.0.0", true), right = await artifact(base, "right", "1.0.0", true);
        await remove("fixture", home);
        const result = await Promise.allSettled([accept(left, home), accept(right, home)]); assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
        await Promise.all([remove("second", home), remove("third", home)]); assert.equal(((await list(home)).plugins as unknown[]).length, 1);
    }));
}

test("captured candidates wait for the owning lock and reread the pointer after its holder mutates", async () => {
    const base=await mkdtemp(join(tmpdir(),"trusted-transaction-")), home=join(base,"home");await mkdir(home);
    type Manifest={id:string};let captured!:()=>void, unlock!:()=>void, locked!:()=>void, count=0, capturing=false;
    const ready=new Promise<void>(resolve=>{captured=resolve;}), release=new Promise<void>(resolve=>{unlock=resolve;}), acquired=new Promise<void>(resolve=>{locked=resolve;});
    const store=trustedLocalPlugins<Manifest,PluginPointer>({active:"agreement-plugins.json",area:"agreement-plugins",refusal:r=>new CliError("USAGE",r),parse:raw=>JSON.parse(raw),plan:()=>({files:["entry.mjs"],recipes:[]}),validate(s){if(capturing&&s.manifest.id!=="initial"&&++count===2)captured();},compatible(){},id:m=>m.id,collisions:m=>[m.id],decode:raw=>JSON.parse(raw),encode:rows=>JSON.stringify(rows),pointer:(s,generation)=>({v:1,plugin:s.manifest.id,generation,digest:s.digest}),verifyPointer(){}});
    try {
        const candidates=[];
        for(const id of ["initial","second","third"]){const folder=join(base,id);await mkdir(folder);await writeFile(join(folder,"package.json"),JSON.stringify({id}));await writeFile(join(folder,"entry.mjs"),"inert");const proposal=await store.register(folder,undefined,home);candidates.push({folder,digest:proposal.snapshot.digest});}
        count=0;await store.register(candidates[0]!.folder,candidates[0]!.digest,home);
        const pointer=join(canonicalUserStateDir(home),"agreement-plugins.json"), before=await readFile(pointer,"utf8");
        const owner=withCliFilesystemMutationLock(pointer,async()=>{locked();await release;await writeFile(pointer,"[]\n",{mode:0o600});},{portableRoot:canonicalUserStateDir(home)});
        await acquired;
        capturing=true;const pending=candidates.slice(1).map(c=>store.register(c.folder,c.digest,home));await ready;
        assert.equal(await readFile(pointer,"utf8"),before);unlock();await owner;await Promise.all(pending);
        assert.deepEqual((await store.list(home)).map(s=>s.pointer.plugin).sort(),["second","third"]);
    } finally {unlock();await rm(base,{recursive:true,force:true});}
});
