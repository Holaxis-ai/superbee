/** Finite local artifact approval and immutable generations; execution belongs to each caller. */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, opendir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { withCliFilesystemMutationLock } from "./filesystem-runtime.js";
import { readRegularFileNoFollowSync } from "./nofollow-read.js";
import { assertPathOutsidePrivateState } from "./private-state-bundle-boundary.js";
import { canonicalUserStateDir, ensureUserStateRoot, privateStateEntryIsSafe, readUserStateFile, writeReadyUserStateFileAtomic0600, type UserStateInput } from "./user-state.js";
import { sourceDigest } from "./source-local/state.js";

export const LOCAL_PLUGIN_LIMITS = Object.freeze({ manifest: 64 * 1024, file: 2 * 1024 * 1024, files: 256, depth: 8, total: 8 * 1024 * 1024 });
export const pluginRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const pluginExact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const pluginSlug = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{1,63}$/.test(v);
export const pluginRelativePath = (v: unknown): v is string => typeof v === "string" && v.length <= 256 && v !== "package.json" && v.split("/").length <= LOCAL_PLUGIN_LIMITS.depth && v.split("/").every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p));
export function pluginPackage(m: unknown): m is { name: string; version: string } & Record<string, unknown> {
    return pluginRecord(m) && typeof m.name === "string" && !!m.name.trim() && m.name.length <= 256 && typeof m.version === "string" && m.version.length <= 128 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(m.version);
}
export interface PluginPointer { v: 1; plugin: string; generation: string; digest: string }
export function pluginPointer(v: unknown): v is PluginPointer {
    return pluginRecord(v) && v.v === 1 && pluginSlug(v.plugin) && typeof v.generation === "string" && /^g-[a-f0-9]{64}-[a-f0-9]{16}$/.test(v.generation) && typeof v.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(v.digest);
}
export interface PluginSnapshotFile { path: string; bytes: string }
export interface PluginSnapshot<M> { manifest: M; files: PluginSnapshotFile[]; digest: string }
export interface VerifiedPlugin<M, P extends PluginPointer> extends PluginSnapshot<M> { root: string; pointer: P }
export interface LocalPluginPolicy<M, P extends PluginPointer> {
    active: string; area: string;
    refusal(reason: string): CliError;
    parse(raw: string): M;
    plan(manifest: M): { files: string[]; recipes: string[] };
    validate(snapshot: PluginSnapshot<M>): void;
    compatible(manifest: M): void;
    id(manifest: M): string;
    collisions(manifest: M): string[];
    decode(raw: string): P[];
    encode(rows: P[]): string;
    pointer(snapshot: PluginSnapshot<M>, generation: string): P;
    verifyPointer(pointer: P, snapshot: PluginSnapshot<M>): void;
}
export const pluginFileRows = (files: PluginSnapshotFile[]) => files.map(f => ({ path: f.path, digest: `sha256:${createHash("sha256").update(f.bytes).digest("hex")}` }));

export function trustedLocalPlugins<M, P extends PluginPointer>(policy: LocalPluginPolicy<M, P>) {
    const fail = policy.refusal;
    async function capture(root: string, input?: UserStateInput): Promise<PluginSnapshot<M>> {
        const files: PluginSnapshotFile[] = [], seen = new Set<string>();
        let total = 0, entries = 0;
        const count = () => { if (++entries > LOCAL_PLUGIN_LIMITS.files) throw fail("limit"); };
        const directory = async (dir: string) => {
            const s = await lstat(dir);
            if (!s.isDirectory() || s.isSymbolicLink() || input !== undefined && !privateStateEntryIsSafe(s, "directory", input)) throw fail("path_unsafe");
        };
        const read = async (rel: string, maximumBytes = LOCAL_PLUGIN_LIMITS.file) => {
            if (seen.has(rel)) throw fail("path_unsafe");
            seen.add(rel); count();
            for (let cursor = path.dirname(rel); cursor !== "."; cursor = path.dirname(cursor)) await directory(path.join(root, cursor));
            let bytes: string;
            if (input !== undefined) bytes = await readUserStateFile(input, path.join(root, rel), maximumBytes);
            else {
                const r = readRegularFileNoFollowSync(path.join(root, rel), { maximumBytes });
                if (r.state !== "present") throw fail("path_unsafe");
                bytes = new TextDecoder("utf-8", { fatal: true }).decode(r.bytes);
            }
            total += Buffer.byteLength(bytes);
            if (total > LOCAL_PLUGIN_LIMITS.total) throw fail("limit");
            files.push({ path: rel, bytes }); return bytes;
        };
        await directory(root);
        const manifest = policy.parse(await read("package.json", LOCAL_PLUGIN_LIMITS.manifest));
        const plan = policy.plan(manifest), paths = [...plan.files, ...plan.recipes];
        if (paths.some(p => !pluginRelativePath(p)) || paths.some((p, i) => paths.some((q, j) => i !== j && (p === q || p.startsWith(q + "/"))))) throw fail("path_unsafe");
        for (const file of plan.files) await read(file);
        const walk = async (rel: string, depth: number): Promise<void> => {
            if (depth > LOCAL_PLUGIN_LIMITS.depth || rel.split("/").length > LOCAL_PLUGIN_LIMITS.depth) throw fail("limit");
            count(); await directory(path.join(root, rel));
            for await (const e of await opendir(path.join(root, rel))) {
                if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(e.name) || e.isSymbolicLink()) throw fail("path_unsafe");
                const child = `${rel}/${e.name}`;
                if (!pluginRelativePath(child)) throw fail("path_unsafe");
                if (e.isDirectory()) await walk(child, depth + 1);
                else if (e.isFile() && e.name.endsWith(".md")) await read(child);
                else throw fail("path_unsafe");
            }
        };
        for (const recipe of plan.recipes) await walk(recipe, 0);
        files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const snapshot = { manifest, files, digest: sourceDigest(files) };
        policy.validate(snapshot); return snapshot;
    }
    async function active(input: UserStateInput): Promise<P[]> {
        let raw: string;
        try { raw = await readUserStateFile(input, path.join(canonicalUserStateDir(input), policy.active), 65536); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw fail("state_invalid"); }
        try {
            const rows = policy.decode(raw);
            if (rows.length > 128 || new Set(rows.map(a => a.plugin)).size !== rows.length) throw fail("state_invalid");
            return rows;
        } catch { throw fail("state_invalid"); }
    }
    async function verified(a: P, input: UserStateInput): Promise<VerifiedPlugin<M, P>> {
        try {
            const area = path.join(canonicalUserStateDir(input), policy.area);
            if (!privateStateEntryIsSafe(await lstat(area), "directory", input)) throw fail("path_unsafe");
            const root = path.join(area, a.generation), s = await capture(root, input);
            if (s.digest !== a.digest || policy.id(s.manifest) !== a.plugin) throw fail("changed");
            policy.verifyPointer(a, s);
            return { root, pointer: a, ...s };
        } catch (e) { if (e instanceof CliError) throw e; throw fail("changed"); }
    }
    async function list(input: UserStateInput) {
        const selected = [];
        for (const a of await active(input)) selected.push(await verified(a, input));
        return selected;
    }
    async function select(id: string, input: UserStateInput, matches: (m: M, id: string) => boolean) {
        for (const a of await active(input)) {
            const selected = await verified(a, input);
            if (!matches(selected.manifest, id)) continue;
            policy.compatible(selected.manifest); return selected;
        }
        return undefined;
    }
    async function register(folder: string, accept: string | undefined, input: UserStateInput) {
        try {
            assertPathOutsidePrivateState(folder, input);
            const s = await capture(path.resolve(folder)); policy.compatible(s.manifest);
            if (accept === undefined) return { snapshot: s, accepted: false as const };
            if (s.digest !== accept) throw fail("changed");
            const root = await ensureUserStateRoot(input);
            return await withCliFilesystemMutationLock(path.join(root, policy.active), async () => {
                const rows = await active(input), id = policy.id(s.manifest), retained = rows.filter(a => a.plugin !== id);
                const keys = new Set(policy.collisions(s.manifest));
                for (const old of retained) {
                    const other = await verified(old, input);
                    if (policy.collisions(other.manifest).some(key => keys.has(key))) throw fail("conflict");
                }
                if (retained.length >= 128) throw fail("limit");
                const area = path.join(root, policy.area);
                await mkdir(area, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
                if (!privateStateEntryIsSafe(await lstat(area), "directory", input)) throw fail("path_unsafe");
                const generation = `g-${s.digest.slice(7)}-${randomBytes(8).toString("hex")}`, target = path.join(area, `.pending-${randomBytes(8).toString("hex")}`);
                await mkdir(target, { mode: 0o700 });
                for (const f of s.files) {
                    await mkdir(path.dirname(path.join(target, f.path)), { recursive: true, mode: 0o700 });
                    await writeFile(path.join(target, f.path), f.bytes, { flag: "wx", mode: 0o600 });
                }
                if ((await capture(target, input)).digest !== s.digest) throw fail("changed");
                await rename(target, path.join(area, generation));
                const pointer = policy.pointer(s, generation);
                await verified(pointer, input);
                await writeReadyUserStateFileAtomic0600(input, policy.active, policy.encode([...retained, pointer]) + "\n");
                return { snapshot: s, accepted: true as const, generation };
            }, { portableRoot: root });
        } catch (e) { if (e instanceof CliError) throw e; throw fail("input_invalid"); }
    }
    async function remove(id: string, input: UserStateInput) {
        if (!pluginSlug(id)) throw fail("id_invalid");
        const root = await ensureUserStateRoot(input);
        return withCliFilesystemMutationLock(path.join(root, policy.active), async () => {
            const rows = await active(input), retained = rows.filter(a => a.plugin !== id);
            // Retained legacy metadata may be discarded only after proving its original authority.
            for (const a of retained) await verified(a, input);
            await writeReadyUserStateFileAtomic0600(input, policy.active, policy.encode(retained) + "\n");
            return rows.some(a => a.plugin === id);
        }, { portableRoot: root });
    }
    return { capture, active, verified, list, select, register, remove };
}
