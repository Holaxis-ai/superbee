/** Explicit trust of finite, self-contained local operation bundles. Discovery never imports code. */
import { createHash } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SOURCE_PLUGIN_CORE_VERSION } from "@superbee/core/source-profiles";
import { canonicalJson, siteCapabilityDescriptor, siteCapabilityMetadataProblem, DEFAULT_SITE_CAPABILITY_LIMITS, type SiteCapabilityMetadata } from "@superbee/core/site-capabilities";
import { CliError } from "./errors.js";
import { withCliFilesystemMutationLock } from "./filesystem-runtime.js";
import { assertPathOutsidePrivateState } from "./private-state-bundle-boundary.js";
import { canonicalUserStateDir, ensureUserStateRoot, privateStateEntryIsSafe, readUserStateFile, writeReadyUserStateFileAtomic0600, type UserStateInput } from "./user-state.js";
import { boundedPluginSnapshotReader, installPluginSnapshot, SOURCE_PLUGIN_LIMITS, type PluginSnapshotFile } from "./source-plugins.js";
import { sourceDigest } from "./source-local/state.js";

export const LOCAL_OPERATION_HELPER_VERSION = 1;
export const LOCAL_OPERATION_TRUST = "Acceptance trusts these reviewed local bytes with ambient process authority. Digests identify bytes, not publisher authenticity or isolation. Registration grants no tool or resource binding. Assets must be UTF-8; the entry must be self-contained.";
const ACTIVE = "operation-plugins.json", AREA = "operation-plugins";
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const slug = /^[a-z][a-z0-9-]{1,63}$/;
const relative = (v: unknown): v is string => typeof v === "string" && v.length <= 256 && v.split("/").length <= SOURCE_PLUGIN_LIMITS.depth && v.split("/").every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p)) && v !== "package.json";
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
interface Active { v: 1; kind: "local-operation"; plugin: string; generation: string; digest: string }
function refusal(reason: string): CliError { return new CliError("USAGE", `Local operation registration refused (${reason}).`, { details: { reason }, help: "Register a reviewed self-contained local operation bundle, preview its digest, then explicitly accept that digest. Changed code requires registration and rebinding." }); }
function parse(raw: string): LocalOperationManifest {
    let m: unknown; try { m = JSON.parse(raw); } catch { throw refusal("operation_manifest_invalid"); }
    if (!record(m) || typeof m.name !== "string" || !m.name.trim() || m.name.length > 256 || typeof m.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(m.version) || m.version.length > 128) throw refusal("operation_manifest_invalid");
    const d = m.superbeeLocalOperations;
    if (!record(d) || !exact(d, ["contract", "id", "core", "helper", "entry", "assets", "operations"]) || d.contract !== 1 || typeof d.id !== "string" || !slug.test(d.id) || typeof d.core !== "string" || !d.core || (!Number.isSafeInteger(d.helper) || (d.helper as number) < 1) || !relative(d.entry) || !d.entry.endsWith(".mjs") || !Array.isArray(d.assets) || !d.assets.every(relative) || new Set([d.entry, ...d.assets]).size !== d.assets.length + 1 || d.assets.length + 2 > SOURCE_PLUGIN_LIMITS.files) throw refusal("operation_manifest_invalid");
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
async function capture(root: string, input?: UserStateInput) {
    const reader = await boundedPluginSnapshotReader(root, input);
    const manifest = parse(await reader.read("package.json", SOURCE_PLUGIN_LIMITS.manifest));
    const d = manifest.superbeeLocalOperations;
    for (const file of [d.entry, ...d.assets]) await reader.read(file);
    reader.files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { manifest, files: reader.files, digest: sourceDigest(reader.files) };
}
async function active(input: UserStateInput): Promise<Active[]> {
    let raw: string; try { raw = await readUserStateFile(input, path.join(canonicalUserStateDir(input), ACTIVE), 65536); } catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw refusal("operation_state_invalid"); }
    let rows: unknown; try { rows = JSON.parse(raw); } catch { throw refusal("operation_state_invalid"); }
    if (!Array.isArray(rows) || rows.length > 128 || rows.some(a => !record(a) || !exact(a,["v","kind","plugin","generation","digest"]) || a.v !== 1 || a.kind !== "local-operation" || typeof a.plugin !== "string" || !slug.test(a.plugin) || typeof a.generation !== "string" || !/^g-[a-f0-9]{64}-[a-f0-9]{16}$/.test(a.generation) || typeof a.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(a.digest)) || new Set(rows.map(a => a.plugin)).size !== rows.length) throw refusal("operation_state_invalid");
    return rows as Active[];
}
async function verified(a: Active, input: UserStateInput) {
    try {
        const area = path.join(canonicalUserStateDir(input), AREA);
        if (!privateStateEntryIsSafe(await lstat(area), "directory", input)) throw refusal("operation_path_unsafe");
        const root = path.join(area, a.generation), s = await capture(root,input);
        if (s.digest !== a.digest || s.manifest.superbeeLocalOperations.id !== a.plugin) throw refusal("operation_changed");
        return { root, ...s };
    } catch(e) { if (e instanceof CliError) throw e; throw refusal("operation_changed"); }
}
const assetRows = (files: PluginSnapshotFile[]) => files.map(f => ({ path: f.path, digest: `sha256:${createHash("sha256").update(f.bytes).digest("hex")}` }));
const receipt = (s: Awaited<ReturnType<typeof capture>>) => ({ plugin: s.manifest.superbeeLocalOperations.id, package: s.manifest.name, version: s.manifest.version, ...s.manifest.superbeeLocalOperations, digest: s.digest, files: assetRows(s.files), trust: LOCAL_OPERATION_TRUST });
export async function registerOperationPlugin(folder: string, accept?: string, input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    try {
        assertPathOutsidePrivateState(folder,input);
        const s = await capture(path.resolve(folder)), d = s.manifest.superbeeLocalOperations;
        if (d.core !== SOURCE_PLUGIN_CORE_VERSION || d.helper !== LOCAL_OPERATION_HELPER_VERSION) throw refusal("operation_incompatible");
        if (!accept) return { operation: "op register", ...receipt(s), accepted: false };
        if (accept !== s.digest) throw refusal("operation_changed");
        const root = await ensureUserStateRoot(input);
        return await withCliFilesystemMutationLock(path.join(root,ACTIVE), async () => {
            const rows = await active(input);
            for (const old of rows.filter(a => a.plugin !== d.id)) {
                const other = await verified(old,input);
                if (other.manifest.superbeeLocalOperations.operations.some(o => d.operations.some(n => n.id === o.id || n.capability.name === o.capability.name))) throw refusal("operation_conflict");
            }
            if (rows.length >= 128 && !rows.some(a => a.plugin === d.id)) throw refusal("operation_limit");
            const {generation,target} = await installPluginSnapshot(root,AREA,s.files,s.digest,input);
            if ((await capture(target,input)).digest !== s.digest) throw refusal("operation_changed");
            await rename(target,path.join(root,AREA,generation));
            const a: Active = {v:1,kind:"local-operation",plugin:d.id,generation,digest:s.digest};
            await verified(a,input);
            await writeReadyUserStateFileAtomic0600(input,ACTIVE,JSON.stringify([...rows.filter(a => a.plugin !== d.id),a])+"\n");
            return {operation:"op register",...receipt(s),accepted:true,generation};
        },{portableRoot:root});
    } catch(e) { if(e instanceof CliError) throw e; throw refusal("operation_input_invalid"); }
}
export async function listOperationPlugins(input: UserStateInput = homedir()): Promise<Record<string, unknown>> {
    const plugins = [];
    for (const a of await active(input)) { const s = await verified(a,input); plugins.push({...receipt(s),generation:a.generation}); }
    return {operation:"op registered",plugins};
}
export async function removeOperationPlugin(id: string, input: UserStateInput = homedir()): Promise<Record<string,unknown>> {
    if (!slug.test(id)) throw refusal("operation_id_invalid");
    const root = await ensureUserStateRoot(input);
    return withCliFilesystemMutationLock(path.join(root,ACTIVE),async () => {const rows = await active(input); await writeReadyUserStateFileAtomic0600(input,ACTIVE,JSON.stringify(rows.filter(a => a.plugin !== id))+"\n"); return {operation:"op unregister",plugin:id,removed:rows.some(a => a.plugin === id)};},{portableRoot:root});
}
export async function selectLocalOperation(id: string, input: UserStateInput = homedir()): Promise<LocalOperationSelection | undefined> {
    for (const a of await active(input)) {
        const s = await verified(a,input), d = s.manifest.superbeeLocalOperations, op = d.operations.find(o => o.id === id);
        if (!op) continue;
        if (d.core !== SOURCE_PLUGIN_CORE_VERSION || d.helper !== LOCAL_OPERATION_HELPER_VERSION) throw refusal("operation_incompatible");
        return Object.freeze({...op,capability:freeze(op.capability),capabilities:freeze(d.operations.map(o => o.capability)),plugin:a.plugin,generation:a.generation,digest:a.digest,core:d.core,helper:LOCAL_OPERATION_HELPER_VERSION,rootPath:s.root,entryPath:path.join(s.root,d.entry),assets:assetRows(s.files)});
    }
    return undefined;
}
function freeze<T>(v:T):T { if(v && typeof v === "object") { for(const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; }
