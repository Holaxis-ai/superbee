/** Explicit approval of finite source artifacts. Selection remains inert until feed consent. */
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSourceProfile, restJsonProfile, nextLinkTarget, SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { unsupportedContent, type SourceProfile } from "@superbee/core/source-engine";
import { parseRecipeFiles, type LoadResult } from "@superbee/core/recipes";
import { CliError } from "./errors.js";
import type { UserStateInput } from "./user-state.js";
import { trustedLocalPlugins, pluginRecord as record, pluginExact as exact, pluginSlug, pluginRelativePath, pluginPackage, pluginPointer, pluginFileRows, type PluginPointer, type PluginSnapshot } from "./trusted-local-plugins.js";

export const SOURCE_PLUGIN_TRUST = "Accepting trusts these reviewed local plugin bytes as code running in this process with ambient authority. The package name and digest do not authenticate publisher origin or provide a sandbox. Acquisition is external; registration grants no feed binding or credentials.";
interface ProfileDeclaration { id: string; version: number; entry: string }
interface Manifest { name: string; version: string; superbeeIntegration: { contract: 1; id: string; core: string; profiles: ProfileDeclaration[]; recipes: Record<string, string> } }
interface LegacyActive extends PluginPointer { package: string; version: string; contract: 1; core: string; profile: { id: string; version: number } }
interface Active extends PluginPointer { legacy?: LegacyActive }
export function pluginRefusal(reason: string): CliError { return new CliError("USAGE", `Source plugin operation refused (${reason}).`, { details: { reason }, help: "Build a reviewed pinned integration folder externally, then run superbee source plugin register <built-folder> and explicitly accept its digest." }); }
const refusal = (reason: string) => pluginRefusal(`plugin_${reason}`);
function manifest(raw: string): Manifest {
    let m: unknown; try { m = JSON.parse(raw); } catch { throw refusal("manifest_invalid"); }
    if (!pluginPackage(m)) throw refusal("manifest_invalid");
    const d = m.superbeeIntegration;
    if (!record(d) || !exact(d, ["contract", "id", "core", "profiles", "recipes"]) || d.contract !== 1 || !pluginSlug(d.id) || typeof d.core !== "string" || !d.core || d.core.length > 128) throw refusal("incompatible");
    if (!Array.isArray(d.profiles) || !d.profiles.length || d.profiles.length > 32) throw refusal("profile_invalid");
    const ids = new Set(), entries = new Set();
    for (const p of d.profiles) {
        if (!record(p) || !exact(p, ["id", "version", "entry"]) || !pluginSlug(p.id) || getSourceProfile(p.id) || !Number.isSafeInteger(p.version) || (p.version as number) < 1 || !pluginRelativePath(p.entry) || !p.entry.endsWith(".mjs") || ids.has(p.id) || entries.has(p.entry)) throw refusal("profile_invalid");
        ids.add(p.id); entries.add(p.entry);
    }
    if (!record(d.recipes) || Object.keys(d.recipes).length > 32 || Object.entries(d.recipes).some(([id, root]) => !pluginSlug(id) || !pluginRelativePath(root))) throw refusal("recipe_invalid");
    return m as unknown as Manifest;
}
function recipe(s: PluginSnapshot<Manifest>, name: string): LoadResult {
    const prefix = s.manifest.superbeeIntegration.recipes[name] + "/";
    return parseRecipeFiles(s.files.filter(f => f.path.startsWith(prefix)).map(f => ({ path: f.path.slice(prefix.length), bytes: f.bytes })), "registered source plugin", { okfVersion: "0.2" });
}
/** Retirement: tasks/retire-legacy-source-plugin-pointer-codec; decoding alone grants no authority. */
function decodeSourcePointers(raw: string): Active[] {
    const a: unknown = JSON.parse(raw);
    if (a === null) return [];
    if (record(a) && exact(a, ["v", "plugins"]) && a.v === 2 && Array.isArray(a.plugins)) {
        if (a.plugins.some(p => !record(p) || !exact(p, ["v", "plugin", "generation", "digest"]) || !pluginPointer(p))) throw refusal("state_invalid");
        return a.plugins as Active[];
    }
    if (!record(a) || !exact(a, ["v", "plugin", "generation", "digest", "package", "version", "contract", "core", "profile"]) || !pluginPointer(a) || a.plugin !== "github" || a.package !== "@superbee/integration-github" || typeof a.version !== "string" || a.contract !== 1 || typeof a.core !== "string" || !a.core || !record(a.profile) || !exact(a.profile, ["id", "version"]) || a.profile.id !== "github-issues" || !Number.isSafeInteger(a.profile.version) || (a.profile.version as number) < 1) throw refusal("state_invalid");
    return [{ v: 1, plugin: a.plugin, generation: a.generation, digest: a.digest, legacy: a as unknown as LegacyActive }];
}
function verifySourcePointer(a: Active, s: PluginSnapshot<Manifest>) {
    if (!a.legacy) return;
    const old = a.legacy, m = s.manifest, d = m.superbeeIntegration, p = d.profiles[0];
    if (m.name !== old.package || m.version !== old.version || d.core !== old.core || d.contract !== old.contract || d.profiles.length !== 1 || !p || p.id !== old.profile.id || p.version !== old.profile.version || p.entry !== "dist/profile.mjs" || !exact(d.recipes, ["source-feeds", "work-items"]) || d.recipes["source-feeds"] !== "recipes/source-feeds" || d.recipes["work-items"] !== "recipes/work-items") throw refusal("changed");
}
const lifecycle = trustedLocalPlugins<Manifest, Active>({
    active: "source-plugin-github.json", area: "source-plugins", refusal, parse: manifest,
    plan: m => ({ files: m.superbeeIntegration.profiles.map(p => p.entry), recipes: Object.values(m.superbeeIntegration.recipes) }),
    validate(s) { for (const name of Object.keys(s.manifest.superbeeIntegration.recipes)) if (!recipe(s, name).ok) throw refusal("recipe_invalid"); },
    compatible(m) { if (m.superbeeIntegration.core !== SOURCE_PLUGIN_CORE_VERSION) throw refusal("incompatible"); },
    id: m => m.superbeeIntegration.id, collisions: m => m.superbeeIntegration.profiles.map(p => p.id),
    decode: decodeSourcePointers,
    encode: rows => JSON.stringify({ v: 2, plugins: rows.map(({ v, plugin, generation, digest }) => ({ v, plugin, generation, digest })) }),
    pointer: (s, generation) => ({ v: 1, plugin: s.manifest.superbeeIntegration.id, generation, digest: s.digest }),
    verifyPointer: verifySourcePointer,
});
function receipt(s: PluginSnapshot<Manifest>) { return { plugin: s.manifest.superbeeIntegration.id, package: s.manifest.name, version: s.manifest.version, contract: 1, core: s.manifest.superbeeIntegration.core, profiles: s.manifest.superbeeIntegration.profiles.map(({ id, version }) => ({ id, version })), digest: s.digest, files: pluginFileRows(s.files), trust: SOURCE_PLUGIN_TRUST }; }
export async function registerSourcePlugin(folder: string, accept?: string, input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    const result = await lifecycle.register(folder, accept, input);
    return { operation: "source plugin register", ...receipt(result.snapshot), accepted: result.accepted };
}
export async function listSourcePlugins(input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    const plugins = (await lifecycle.list(input)).map(s => {
        const d = s.manifest.superbeeIntegration, profiles = d.profiles.map(({ id, version }) => ({ id, version }));
        return { plugin: d.id, package: s.manifest.name, version: s.manifest.version, core: d.core, ...(profiles.length === 1 ? { profile: profiles[0] } : {}), profiles, digest: s.digest };
    });
    return { operation: "source plugin list", plugins };
}
export async function removeSourcePlugin(id: string, input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    return { operation: "source plugin remove", plugin: id, removed: await lifecycle.remove(id, input) };
}
export interface SelectedSourceProfile {
    id: string;
    version: number;
    kind: "generic" | "extension";
    implementation: Record<string, unknown>;
    load(): Promise<SourceProfile>;
}
async function loadRegisteredSourceProfile(selected: { root: string; entry: string }, a: Active & { profile: ProfileDeclaration }, input: UserStateInput): Promise<SourceProfile> {
    try {
        const current = await lifecycle.verified(a, input);
        const declaration = current.manifest.superbeeIntegration.profiles.find(profile => profile.id === a.profile.id);
        if (!declaration || declaration.entry !== selected.entry || declaration.version !== a.profile.version || current.root !== selected.root) throw pluginRefusal("plugin_changed");
        const m = await import(pathToFileURL(path.join(current.root, declaration.entry)).href);
        if (typeof m.createSourceProfile !== "function") throw pluginRefusal("plugin_export_invalid");
        const p: unknown = m.createSourceProfile(Object.freeze({ restJsonProfile, nextLinkTarget, unsupportedContent }));
        if (!record(p) || p.id !== a.profile.id || p.version !== a.profile.version || p.kind !== "extension" || typeof p.validateSpec !== "function" || typeof p.hostsFor !== "function" || typeof p.observe !== "function") throw pluginRefusal("plugin_export_invalid");
        return p as unknown as SourceProfile;
    } catch (e) { if (e instanceof CliError) throw e; throw pluginRefusal("plugin_execution_failed"); }
}
/** Selection verifies data only. A caller must establish feed consent before invoking load. */
export async function selectSourceProfile(id: string, input: UserStateInput = homedir()): Promise<SelectedSourceProfile | undefined> {
    const builtin = getSourceProfile(id);
    if (builtin) return { id: builtin.id, version: builtin.version, kind: builtin.kind, implementation: { kind: "builtin", core: SOURCE_PLUGIN_CORE_VERSION }, load: async () => builtin };
    const snapshot = await lifecycle.select(id, input, (m, key) => m.superbeeIntegration.profiles.some(p => p.id === key));
    if (!snapshot) return undefined;
    const profile = snapshot.manifest.superbeeIntegration.profiles.find(p => p.id === id)!, a = { ...snapshot.pointer, profile }, selected = { root: snapshot.root, entry: profile.entry };
    const m = snapshot.manifest;
    return { id: profile.id, version: profile.version, kind: "extension", implementation: { kind: "registered", package: m.name, version: m.version, digest: snapshot.digest, contract: m.superbeeIntegration.contract, core: m.superbeeIntegration.core }, load: () => loadRegisteredSourceProfile(selected, a, input) };
}
export async function registeredRecipe(ref: string, input: UserStateInput = homedir()): Promise<LoadResult | null> {
    const parts = ref.split(":");
    if (parts.length !== 2 || !parts.every(pluginSlug)) return null;
    const plugin = parts[0]!, name = parts[1]!;
    const selected = await lifecycle.select(plugin, input, (m, id) => m.superbeeIntegration.id === id && Object.hasOwn(m.superbeeIntegration.recipes, name));
    return selected ? recipe(selected, name) : null;
}
