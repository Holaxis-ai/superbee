/** Typed local operation declarations; the shared host owns finite artifact approval. */
import { homedir } from "node:os";
import path from "node:path";
import { SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { canonicalJson, siteCapabilityDescriptor, siteCapabilityMetadataProblem, DEFAULT_SITE_CAPABILITY_LIMITS, type SiteCapabilityMetadata } from "@superbee/core/site-capabilities";
import { CliError } from "./errors.js";
import type { UserStateInput } from "./user-state.js";
import { trustedLocalPlugins, LOCAL_PLUGIN_LIMITS, pluginRecord as record, pluginExact as exact, pluginSlug, pluginRelativePath as relative, pluginPointer, pluginPackage, pluginFileRows, type PluginPointer, type PluginSnapshot } from "./trusted-local-plugins.js";
export const LOCAL_OPERATION_HELPER_VERSION = 1;
export const LOCAL_OPERATION_TRUST = "Acceptance trusts these reviewed local bytes with ambient process authority. Digests identify bytes, not publisher authenticity or isolation. Registration grants no tool or resource binding. Assets must be UTF-8; the entry must be self-contained.";
export interface LocalOperationDeclaration { id: string; capability: SiteCapabilityMetadata }
export interface LocalOperationManifest {
    name: string; version: string;
    superbeeLocalOperations: { contract: 1; id: string; core: string; helper: number; entry: string; assets: string[]; operations: LocalOperationDeclaration[] };
}
export interface LocalOperationSelection extends LocalOperationDeclaration {
    plugin: string; generation: string; digest: string; core: string; helper: 1;
    capabilities: readonly SiteCapabilityMetadata[];
    rootPath: string; entryPath: string; assets: { path: string; digest: string }[];
}
interface Active extends PluginPointer { kind: "local-operation" }
function refusal(reason: string): CliError { return new CliError("USAGE", `Local operation registration refused (${reason}).`, { details: { reason }, help: "Register a reviewed self-contained local operation bundle, preview its digest, then explicitly accept that digest. Changed code requires registration and rebinding." }); }
function parse(raw: string): LocalOperationManifest {
    let m: unknown; try { m = JSON.parse(raw); } catch { throw refusal("operation_manifest_invalid"); }
    if (!pluginPackage(m)) throw refusal("operation_manifest_invalid");
    const d = m.superbeeLocalOperations;
    if (!record(d) || !exact(d, ["contract", "id", "core", "helper", "entry", "assets", "operations"]) || d.contract !== 1 || typeof d.id !== "string" || !pluginSlug(d.id) || typeof d.core !== "string" || !d.core || (!Number.isSafeInteger(d.helper) || (d.helper as number) < 1) || !relative(d.entry) || !d.entry.endsWith(".mjs") || !Array.isArray(d.assets) || !d.assets.every(relative) || new Set([d.entry, ...d.assets]).size !== d.assets.length + 1 || d.assets.length + 2 > LOCAL_PLUGIN_LIMITS.files) throw refusal("operation_manifest_invalid");
    if (!Array.isArray(d.operations) || !d.operations.length || d.operations.length > DEFAULT_SITE_CAPABILITY_LIMITS.maxTools) throw refusal("operation_descriptor_invalid");
    const ids = new Set(), names = new Set(); let total = 0;
    for (const op of d.operations) {
        if (!record(op) || !exact(op, ["id", "capability"]) || typeof op.id !== "string" || !/^local\.[a-z][a-z0-9]{1,15}\.[a-z][a-z0-9-]{1,63}\.v[1-9]\d*$/.test(op.id) || !record(op.capability) || Object.keys(op.capability).some(k => !["name", "implementationId", "title", "description", "inputSchema", "outputSchema", "annotations", "maximumOutputBytes"].includes(k)) || siteCapabilityMetadataProblem(op.capability)) throw refusal("operation_descriptor_invalid");
        const c = op.capability as unknown as SiteCapabilityMetadata;
        if (!c.name.startsWith(op.id.split(".")[1] + "_") || c.name.startsWith("superbee_") || ids.has(op.id) || names.has(c.name)) throw refusal("operation_descriptor_invalid");
        ids.add(op.id); names.add(c.name);
        const size = Buffer.byteLength(canonicalJson(siteCapabilityDescriptor(c))); total += size;
        if (size > DEFAULT_SITE_CAPABILITY_LIMITS.maxDescriptorBytes) throw refusal("operation_descriptor_limit");
    }
    if (total > DEFAULT_SITE_CAPABILITY_LIMITS.maxTotalDescriptorBytes) throw refusal("operation_descriptor_limit");
    return m as unknown as LocalOperationManifest;
}
const lifecycle = trustedLocalPlugins<LocalOperationManifest, Active>({
    active: "operation-plugins.json", area: "operation-plugins", refusal: reason => refusal(`operation_${reason}`), parse,
    plan: m => ({ files: [m.superbeeLocalOperations.entry, ...m.superbeeLocalOperations.assets], recipes: [] }),
    validate() {},
    compatible(m) { if (m.superbeeLocalOperations.core !== SOURCE_PLUGIN_CORE_VERSION || m.superbeeLocalOperations.helper !== LOCAL_OPERATION_HELPER_VERSION) throw refusal("operation_incompatible"); },
    id: m => m.superbeeLocalOperations.id,
    collisions: m => m.superbeeLocalOperations.operations.flatMap(o => [`id:${o.id}`, `name:${o.capability.name}`]),
    decode(raw) {
        const rows: unknown = JSON.parse(raw);
        if (!Array.isArray(rows) || rows.some(a => !record(a) || !exact(a, ["v", "kind", "plugin", "generation", "digest"]) || !pluginPointer(a) || a.kind !== "local-operation")) throw refusal("operation_state_invalid");
        return rows as Active[];
    },
    encode: rows => JSON.stringify(rows),
    pointer: (s, generation) => ({ v: 1, kind: "local-operation", plugin: s.manifest.superbeeLocalOperations.id, generation, digest: s.digest }),
    verifyPointer() {},
});
const receipt = (s: PluginSnapshot<LocalOperationManifest>) => ({ plugin: s.manifest.superbeeLocalOperations.id, package: s.manifest.name, version: s.manifest.version, ...s.manifest.superbeeLocalOperations, digest: s.digest, files: pluginFileRows(s.files), trust: LOCAL_OPERATION_TRUST });
export async function registerOperationPlugin(folder: string, accept?: string, input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    const result = await lifecycle.register(folder, accept, input);
    return { operation: "op register", ...receipt(result.snapshot), accepted: result.accepted, ...("generation" in result ? { generation: result.generation } : {}) };
}
export async function listOperationPlugins(input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    return { operation: "op registered", plugins: (await lifecycle.list(input)).map(s => ({ ...receipt(s), generation: s.pointer.generation })) };
}
export async function removeOperationPlugin(id: string, input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    return { operation: "op unregister", plugin: id, removed: await lifecycle.remove(id, input) };
}
export async function selectLocalOperation(id: string, input: UserStateInput = homedir()): Promise<LocalOperationSelection | undefined> {
    const s = await lifecycle.select(id, input, (m, key) => m.superbeeLocalOperations.operations.some(o => o.id === key));
    if (!s) return undefined;
    const d = s.manifest.superbeeLocalOperations, op = d.operations.find(o => o.id === id)!;
    return Object.freeze({ ...op, capability: freeze(op.capability), capabilities: freeze(d.operations.map(o => o.capability)), plugin: s.pointer.plugin, generation: s.pointer.generation, digest: s.digest, core: d.core, helper: LOCAL_OPERATION_HELPER_VERSION, rootPath: s.root, entryPath: path.join(s.root, d.entry), assets: pluginFileRows(s.files) });
}
function freeze<T>(v: T): T { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
