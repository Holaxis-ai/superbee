/** Explicit trust of a finite installed artifact. Acquisition and publisher authentication stay external. */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, opendir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSourceProfile, restJsonProfile, nextLinkTarget, SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { unsupportedContent, type SourceProfile } from "@superbee/core/source-engine";
import { parseRecipeFiles, type LoadResult } from "@superbee/core/recipes";
import { CliError } from "./errors.js";
import { withCliFilesystemMutationLock } from "./filesystem-runtime.js";
import { readRegularFileNoFollowSync } from "./nofollow-read.js";
import { assertPathOutsidePrivateState } from "./private-state-bundle-boundary.js";
import { canonicalUserStateDir, ensureUserStateRoot, privateStateEntryIsSafe, readUserStateFile, writeReadyUserStateFileAtomic0600, type UserStateInput } from "./user-state.js";
import { sourceDigest } from "./source-local/state.js";
const ACTIVE = "source-plugin-github.json", AREA = "source-plugins";
export const SOURCE_PLUGIN_LIMITS = Object.freeze({ manifest: 64 * 1024, file: 2 * 1024 * 1024, files: 256, depth: 8, total: 8 * 1024 * 1024 });
export const SOURCE_PLUGIN_TRUST = "Accepting trusts these local bytes as reviewed GitHub plugin code running in this process with ambient authority. The package name and digest do not authenticate publisher origin or provide a sandbox. Installation is external; registration grants no feed binding or credentials.";
type Descriptor = {
    contract: 1;
    id: "github";
    core: string;
    profiles: [
        {
            id: "github-issues";
            version: number;
            entry: "dist/profile.mjs";
        }
    ];
    recipes: {
        "source-feeds": "recipes/source-feeds";
        "work-items": "recipes/work-items";
    };
};
type Manifest = {
    name: "@superbee/integration-github";
    version: string;
    superbeeIntegration: Descriptor;
};
type Snapshot = {
    manifest: Manifest;
    files: Array<{
        path: string;
        bytes: string;
    }>;
    digest: string;
};
type Active = {
    v: 1;
    plugin: "github";
    generation: string;
    digest: string;
    package: string;
    version: string;
    contract: 1;
    core: string;
    profile: {
        id: string;
        version: number;
    };
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function pluginRefusal(reason: string): CliError { return new CliError("USAGE", `Source plugin operation refused (${reason}).`, { details: { reason }, help: "Install the reviewed @superbee/integration-github package externally, then run superbee source plugin register <installed-package-directory> and explicitly accept its digest." }); }
function manifest(raw: string): Manifest {
    let m: unknown;
    try {
        m = JSON.parse(raw);
    }
    catch {
        throw pluginRefusal("plugin_manifest_invalid");
    }
    if (!record(m) || m.name !== "@superbee/integration-github" || typeof m.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(m.version) || m.version.length > 128)
        throw pluginRefusal("plugin_manifest_invalid");
    const d = m.superbeeIntegration;
    if (!record(d) || !exact(d, ["contract", "id", "core", "profiles", "recipes"]) || d.contract !== 1 || d.id !== "github" || d.core !== SOURCE_PLUGIN_CORE_VERSION)
        throw pluginRefusal("plugin_incompatible");
    const p = Array.isArray(d.profiles) && d.profiles.length === 1 ? d.profiles[0] : null;
    if (!record(p) || !exact(p, ["id", "version", "entry"]) || p.id !== "github-issues" || !Number.isSafeInteger(p.version) || (p.version as number) < 1 || p.entry !== "dist/profile.mjs" || getSourceProfile(p.id))
        throw pluginRefusal("plugin_profile_invalid");
    const r = d.recipes;
    if (!record(r) || !exact(r, ["source-feeds", "work-items"]) || r["source-feeds"] !== "recipes/source-feeds" || r["work-items"] !== "recipes/work-items")
        throw pluginRefusal("plugin_recipe_invalid");
    return m as unknown as Manifest;
}
/** Every artifact component is checked; unrelated node_modules/package metadata are never walked. */
async function snapshot(root: string, input?: UserStateInput): Promise<Snapshot> {
    const privateRead = input !== undefined;
    const directory = async (dir: string) => {
        const s = await lstat(dir);
        if (!s.isDirectory() || s.isSymbolicLink() || privateRead && !privateStateEntryIsSafe(s, "directory", input))
            throw pluginRefusal("plugin_path_unsafe");
    };
    await directory(root);
    const files: Snapshot["files"] = [];
    let total = 0, entries = 0;
    const read = async (rel: string, limit = SOURCE_PLUGIN_LIMITS.file) => {
        if (++entries > SOURCE_PLUGIN_LIMITS.files)
            throw pluginRefusal("plugin_limit");
        for (let cursor = path.dirname(rel); cursor !== "."; cursor = path.dirname(cursor))
            await directory(path.join(root, cursor));
        const file = path.join(root, rel);
        let bytes: string;
        if (privateRead)
            bytes = await readUserStateFile(input!, file, limit);
        else {
            const r = readRegularFileNoFollowSync(file, { maximumBytes: limit });
            if (r.state !== "present")
                throw pluginRefusal("plugin_path_unsafe");
            bytes = new TextDecoder("utf-8", { fatal: true }).decode(r.bytes);
        }
        total += Buffer.byteLength(bytes);
        if (total > SOURCE_PLUGIN_LIMITS.total)
            throw pluginRefusal("plugin_limit");
        files.push({ path: rel, bytes });
        return bytes;
    };
    const m = manifest(await read("package.json", SOURCE_PLUGIN_LIMITS.manifest));
    await read("dist/profile.mjs");
    const walk = async (rel: string, depth: number): Promise<void> => {
        if (depth > SOURCE_PLUGIN_LIMITS.depth)
            throw pluginRefusal("plugin_limit");
        await directory(path.join(root, rel));
        for await (const e of await opendir(path.join(root, rel))) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(e.name) || e.isSymbolicLink())
                throw pluginRefusal("plugin_path_unsafe");
            const child = `${rel}/${e.name}`;
            if (e.isDirectory()) {
                if (++entries > SOURCE_PLUGIN_LIMITS.files)
                    throw pluginRefusal("plugin_limit");
                await walk(child, depth + 1);
            }
            else if (e.isFile() && e.name.endsWith(".md"))
                await read(child);
            else
                throw pluginRefusal("plugin_path_unsafe");
        }
    };
    for (const recipe of Object.values(m.superbeeIntegration.recipes))
        await walk(recipe, 0);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const recipe of Object.values(m.superbeeIntegration.recipes)) {
        const parsed = parseRecipeFiles(files.filter(f => f.path.startsWith(recipe + "/")).map(f => ({ path: f.path.slice(recipe.length + 1), bytes: f.bytes })), "registered GitHub plugin", { okfVersion: "0.2" });
        if (!parsed.ok)
            throw pluginRefusal("plugin_recipe_invalid");
    }
    return { manifest: m, files, digest: sourceDigest(files) };
}
function receipt(s: Snapshot) { return { plugin: "github", package: s.manifest.name, version: s.manifest.version, contract: 1, core: s.manifest.superbeeIntegration.core, profiles: s.manifest.superbeeIntegration.profiles.map(({ id, version }) => ({ id, version })), digest: s.digest, files: s.files.map(f => ({ path: f.path, digest: `sha256:${createHash("sha256").update(f.bytes).digest("hex")}` })), trust: SOURCE_PLUGIN_TRUST }; }
async function active(input: UserStateInput): Promise<Active | null> {
    let raw: string;
    try {
        raw = await readUserStateFile(input, path.join(canonicalUserStateDir(input), ACTIVE), 16384);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
            return null;
        throw pluginRefusal("plugin_state_invalid");
    }
    let a: unknown;
    try {
        a = JSON.parse(raw);
    }
    catch {
        throw pluginRefusal("plugin_state_invalid");
    }
    if (a === null)
        return null;
    if (!record(a) || !exact(a, ["v", "plugin", "generation", "digest", "package", "version", "contract", "core", "profile"]) || a.v !== 1 || a.plugin !== "github" || typeof a.generation !== "string" || !/^g-[a-f0-9]{64}-[a-f0-9]{16}$/.test(a.generation) || typeof a.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(a.digest) || a.package !== "@superbee/integration-github" || typeof a.version !== "string" || a.contract !== 1 || a.core !== SOURCE_PLUGIN_CORE_VERSION || !record(a.profile) || !exact(a.profile, ["id", "version"]) || a.profile.id !== "github-issues" || !Number.isSafeInteger(a.profile.version) || (a.profile.version as number) < 1)
        throw pluginRefusal("plugin_state_invalid");
    return a as unknown as Active;
}
async function verified(a: Active, input: UserStateInput): Promise<{
    root: string;
    snapshot: Snapshot;
}> {
    try {
    const area = path.join(canonicalUserStateDir(input), AREA);
    if (!privateStateEntryIsSafe(await lstat(area), "directory", input))
        throw pluginRefusal("plugin_path_unsafe");
    const root = path.join(area, a.generation), s = await snapshot(root, input);
    if (s.digest !== a.digest || s.manifest.version !== a.version || s.manifest.superbeeIntegration.profiles[0].version !== a.profile.version)
        throw pluginRefusal("plugin_changed");
    return { root, snapshot: s };
    } catch(e) {
        if(e instanceof CliError) throw e;
        throw pluginRefusal("plugin_changed");
    }
}
export async function registerSourcePlugin(folder: string, accept?: string, input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    try {
        assertPathOutsidePrivateState(folder, input);
        const s = await snapshot(path.resolve(folder));
        if (!accept)
            return { operation: "source plugin register", ...receipt(s), accepted: false };
        if (s.digest !== accept)
            throw pluginRefusal("plugin_changed");
        const root = await ensureUserStateRoot(input);
        return await withCliFilesystemMutationLock(path.join(root, ACTIVE), async () => {
            const area = path.join(root, AREA);
            await mkdir(area, { mode: 0o700 }).catch(e => {
                if (e.code !== "EEXIST")
                    throw e;
            });
            if (!privateStateEntryIsSafe(await lstat(area), "directory", input))
                throw pluginRefusal("plugin_path_unsafe");
            const generation = `g-${s.digest.slice(7)}-${randomBytes(8).toString("hex")}`, target = path.join(area, `.pending-${randomBytes(8).toString("hex")}`);
            await mkdir(target, { mode: 0o700 });
            for (const f of s.files) {
                await mkdir(path.dirname(path.join(target, f.path)), { recursive: true, mode: 0o700 });
                await writeFile(path.join(target, f.path), f.bytes, { flag: "wx", mode: 0o600 });
            }
            const a: Active = { v: 1, plugin: "github", generation, digest: s.digest, package: s.manifest.name, version: s.manifest.version, contract: 1, core: s.manifest.superbeeIntegration.core, profile: { id: "github-issues", version: s.manifest.superbeeIntegration.profiles[0].version } };
            if ((await snapshot(target, input)).digest !== s.digest)
                throw pluginRefusal("plugin_changed");
            await rename(target, path.join(area, generation));
            await verified(a, input);
            await writeReadyUserStateFileAtomic0600(input, ACTIVE, JSON.stringify(a) + "\n");
            return { operation: "source plugin register", ...receipt(s), accepted: true };
        }, { portableRoot: root });
    }
    catch (e) {
        if (e instanceof CliError)
            throw e;
        throw pluginRefusal("plugin_input_invalid");
    }
}
export async function listSourcePlugins(input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    const a = await active(input);
    return { operation: "source plugin list", plugins: a ? [{ plugin: a.plugin, package: a.package, version: a.version, core: a.core, profile: a.profile, digest: a.digest }] : [] };
}
export async function removeSourcePlugin(id: string, input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    if (id !== "github")
        throw pluginRefusal("plugin_unsupported");
    const root = await ensureUserStateRoot(input);
    return withCliFilesystemMutationLock(path.join(root, ACTIVE), async () => { const a = await active(input); await writeReadyUserStateFileAtomic0600(input, ACTIVE, "null\n"); return { operation: "source plugin remove", plugin: id, removed: a !== null }; }, { portableRoot: root });
}
export interface SelectedSourceProfile {
    id: string;
    version: number;
    kind: "generic" | "extension";
    implementation: Record<string, unknown>;
    load(): Promise<SourceProfile>;
}
async function loadRegisteredSourceProfile(selected: {
    root: string;
}, a: Active, input: UserStateInput): Promise<SourceProfile> {
    try {
        await verified(a, input);
        const m = await import(pathToFileURL(path.join(selected.root, "dist/profile.mjs")).href);
        if (typeof m.createSourceProfile !== "function")
            throw pluginRefusal("plugin_export_invalid");
        const p: unknown = m.createSourceProfile(Object.freeze({ restJsonProfile, nextLinkTarget, unsupportedContent }));
        if (!record(p) || p.id !== a.profile.id || p.version !== a.profile.version || p.kind !== "extension" || typeof p.validateSpec !== "function" || typeof p.hostsFor !== "function" || typeof p.observe !== "function")
            throw pluginRefusal("plugin_export_invalid");
        return p as unknown as SourceProfile;
    }
    catch (e) {
        if (e instanceof CliError)
            throw e;
        throw pluginRefusal("plugin_execution_failed");
    }
}
/** Selection verifies data only. A caller must establish feed consent before invoking load. */
export async function selectSourceProfile(id: string, input: UserStateInput = homedir()): Promise<SelectedSourceProfile | undefined> {
    const builtin = getSourceProfile(id);
    if (builtin)
        return { id: builtin.id, version: builtin.version, kind: builtin.kind, implementation: { kind: "builtin", core: SOURCE_PLUGIN_CORE_VERSION }, load: async () => builtin };
    if (id !== "github-issues")
        return undefined;
    try {
        const a = await active(input);
        if (!a)
            return undefined;
        const selected = await verified(a, input);
        return { id: a.profile.id, version: a.profile.version, kind: "extension", implementation: { kind: "registered", package: a.package, version: a.version, digest: a.digest, contract: a.contract, core: a.core }, load: () => loadRegisteredSourceProfile(selected, a, input) };
    }
    catch (e) {
        if (e instanceof CliError)
            throw e;
        throw pluginRefusal("plugin_changed");
    }
}
export async function registeredRecipe(ref: string, input: UserStateInput = homedir()): Promise<LoadResult | null> {
    if (!["github:source-feeds", "github:work-items"].includes(ref))
        return null;
    const name = ref.slice("github:".length);
    const a = await active(input);
    if (!a)
        return null;
    const s = await verified(a, input), prefix = `recipes/${name}/`;
    return parseRecipeFiles(s.snapshot.files.filter(f => f.path.startsWith(prefix)).map(f => ({ path: f.path.slice(prefix.length), bytes: f.bytes })), "registered GitHub plugin", { okfVersion: "0.2" });
}
