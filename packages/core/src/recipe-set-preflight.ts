/** Read-only structural checks over explicitly supplied snapshots. No storage or admission. */
import { parseRecipeFiles, type LoadedRecipe } from './recipes.js';
import { parseMarkdown } from './frontmatter.js';
import { buildKindRegistry, isConventionId, CONVENTION_TYPE, CONVENTIONS_PREFIX, type KindRegistry } from './kinds.js';
import { isBundleAlias } from './dependencies.js';
import { assertSafeConceptId } from './paths.js';
import { prepareRecipeInstall, inspectRecipeInstallTarget, definitionDigest, type PreparedRecipeInstall } from './recipe-lifecycle/index.js';
import { sha256Hex } from './versioning.js';
import type { OkfDocument } from './types.js';
export const RECIPE_PREFLIGHT_SCHEMA = 'recipe-set-preflight/v1' as const;
export const RECIPE_PREFLIGHT_DIGEST_SCHEME = 'fixture-envelope-v1/utf16-code-unit-sorted-keys-and-file-paths/sha256' as const;
export interface ArtifactFile {
    path: string;
    bytes: string;
    digest: string;
}
export interface RecipeArtifact {
    identity: {
        publisher: string;
        recipeId: string;
        release: string;
    };
    files: ArtifactFile[];
}
export interface SelectedRecipe {
    key: string;
    publisher: string;
    recipeId: string;
    release: string;
    role: 'base' | 'extension';
    artifactDigest: string;
    artifact?: RecipeArtifact | null;
}
export interface Requirement {
    id: string;
    provider: string;
    kind: string;
    required: boolean;
    fields?: string[];
    links?: {
        label: string;
        target: {
            provider: string;
            kind: string;
        };
    }[];
    unsupported?: string[];
    [operator: string]: unknown;
}
export interface Consumer {
    id: string;
    owner: string;
    descriptorDigest: string;
    requirements: Requirement[] | null;
}
export interface Endpoint {
    id: string;
    consumer: string;
    requirement: string;
    placement: 'local' | 'qualified';
    alias?: string;
}
/** Selected-provider evidence, separate from the complete placement collision inventory. */
export interface Observation {
    id: string;
    provider: string;
    scope: string;
    bundleId?: string;
    expectedBundleId?: string;
    availability: 'available' | 'unavailable' | 'unknown';
    complete: boolean;
    observedVersion?: string;
    definitions: {
        id: string;
        bytes: string;
    }[];
}
export interface PlacementInventory {
    id: string;
    scope: string;
    bundleId?: string;
    expectedBundleId?: string;
    availability: 'available' | 'unavailable' | 'unknown';
    complete: boolean;
    observedVersion?: string;
    files: {
        path: string;
        bytes: string;
    }[];
}
export interface RecipePreflightInput {
    schema: typeof RECIPE_PREFLIGHT_SCHEMA;
    selected: SelectedRecipe[];
    consumers: Consumer[];
    endpoints: Endpoint[];
    observations: Observation[];
    placementInventories?: PlacementInventory[];
}
export interface PreflightIssue {
    level: 'partial' | 'refused';
    code: string;
    at: string;
}
export interface PreflightResult {
    schema: 'recipe-set-preflight-result/v1';
    verdict: 'valid' | 'partial' | 'refused';
    structuralComplete: boolean;
    scope: 'declared-structural-input-only';
    digestScheme: typeof RECIPE_PREFLIGHT_DIGEST_SCHEME;
    inputs: {
        selected: {
            key: string;
            publisher: string;
            recipeId: string;
            release: string;
            artifactDigest: string;
        }[];
        consumers: {
            id: string;
            descriptorDigest: string;
        }[];
        observations: {
            id: string;
            observedVersion?: string;
        }[];
        placementInventories: {
            id: string;
            observedVersion?: string;
        }[];
    };
    externalConsumers: 'unknown-out-of-scope';
    issues: PreflightIssue[];
    parserWarnings: {
        provider: string;
        code: string;
        field?: string;
    }[];
}
const MALFORMED_MODEL_DIAGNOSTICS = new Set([
    'KIND_CONVENTION_MALFORMED', 'KIND_CONVENTION_BAD_SHAPE', 'KIND_CONVENTION_BAD_MEMBER',
    'KIND_CONVENTION_MISPLACED_KEY', 'KIND_DUPLICATE_GOVERNS', 'KIND_HORIZON_MALFORMED',
    'KIND_CONVENTION_TERMINAL_UNDECLARED_FIELD', 'KIND_CONVENTION_TERMINAL_VALUE',
    'KIND_CONVENTION_UNDECLARED_DESCRIPTION_FIELD', 'KIND_CONVENTION_UNDECLARED_LINK_DESCRIPTION',
    'KIND_CONVENTION_UNDECLARED_TYPES_FIELD', 'KIND_CONVENTION_UNDECLARED_VALUES_FIELD',
    'KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_FIELD', 'KIND_CONVENTION_UNDECLARED_VALUE_DESCRIPTION_VALUE',
    'KIND_CONVENTION_VALUES_TYPE_MISMATCH', 'OKF_WORKFLOW_STATUS_COLLISION',
]);
const modelDiagnosticLevel = (code: string): PreflightIssue['level'] => MALFORMED_MODEL_DIAGNOSTICS.has(code) ? 'refused' : 'partial';
const compareCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        const ordered = value.every(v => record(v) && typeof v.path === 'string')
            ? [...value].sort((a, b) => compareCodeUnits(a.path, b.path)) : value;
        return '[' + ordered.map(canonicalJson).join(',') + ']';
    }
    if (record(value)) {
        // Rebuilding an object would let JSON.stringify reorder integer-like keys numerically.
        return '{' + Object.keys(value).sort(compareCodeUnits)
            .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}
/** This envelope identity is separate from Core source/definition digests and Studio packaging. */
export function recipePreflightDigest(value: unknown): string {
    if (!jsonValue(value))
        throw new TypeError('Digest input must be finite JSON data');
    return 'sha256:' + sha256Hex(typeof value === 'string' ? value : canonicalJson(value));
}
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function jsonValue(value: unknown, seen = new Set<object>()): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value))
        return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let ok: boolean;
    if (Array.isArray(value)) {
        const length = descriptors.length?.value;
        ok = Number.isSafeInteger(length) && length >= 0 && Reflect.ownKeys(value).length === length + 1;
        // JSON observes every index, including nonenumerable indices, but never inherited holes.
        if (ok) for (let index = 0; index < length; index++) {
            const descriptor = descriptors[String(index)];
            if (!descriptor || !('value' in descriptor) || !jsonValue(descriptor.value, seen)) {
                ok = false;
                break;
            }
        }
    } else {
        ok = record(value) && Reflect.ownKeys(value).every(k => typeof k === 'string' && ('value' in descriptors[k]!)) && Object.values(value).every(v => jsonValue(v, seen));
    }
    seen.delete(value);
    return ok;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const pin = (v: unknown) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(text);
/** Shape refusals precede semantic evaluation; unknown requirement operators remain partial. */
function shape(input: unknown): string[] {
    const errors: string[] = [];
    const check = (ok: unknown, at: string) => { if (!ok)
        errors.push(at); };
    const obj = (v: unknown, keys: string[], at: string): v is Record<string, any> => { if (!record(v)) {
        errors.push(at);
        return false;
    } for (const k of Object.keys(v))
        check(keys.includes(k), at + '.' + k); return true; };
    if (!jsonValue(input))
        return ['input'];
    if (!obj(input, ['schema', 'selected', 'consumers', 'endpoints', 'observations', 'placementInventories'], 'input'))
        return errors;
    for (const k of ['selected', 'consumers', 'endpoints', 'observations'])
        check(Array.isArray(input[k]), k);
    if (errors.length)
        return errors;
    for (const [i, s] of input.selected.entries())
        if (obj(s, ['key', 'publisher', 'recipeId', 'release', 'role', 'artifactDigest', 'artifact'], `selected[${i}]`)) {
            for (const k of ['key', 'publisher', 'recipeId', 'release'])
                check(text(s[k]), `selected[${i}].${k}`);
            check(['base', 'extension'].includes(s.role), `selected[${i}].role`);
            check(typeof s.release === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(s.release) && !/^(latest|next)$/i.test(s.release) && !/(^|[.])[xX]($|[.])/.test(s.release), `selected[${i}].release`);
            check(pin(s.artifactDigest), `selected[${i}].artifactDigest`);
            if (s.artifact != null && obj(s.artifact, ['identity', 'files'], `selected[${i}].artifact`)) {
                if (obj(s.artifact.identity, ['publisher', 'recipeId', 'release'], `selected[${i}].identity`))
                    for (const k of ['publisher', 'recipeId', 'release'])
                        check(text(s.artifact.identity[k]), `selected[${i}].identity.${k}`);
                check(Array.isArray(s.artifact.files), `selected[${i}].files`);
                if (Array.isArray(s.artifact.files))
                    for (const [j, f] of s.artifact.files.entries())
                        if (obj(f, ['path', 'bytes', 'digest'], `selected[${i}].files[${j}]`)) {
                            check(text(f.path) && safePath(f.path), `selected[${i}].files[${j}].path`);
                            check(typeof f.bytes === 'string', `selected[${i}].files[${j}].bytes`);
                            check(pin(f.digest), `selected[${i}].files[${j}].digest`);
                        }
            }
        }
    for (const [i, c] of input.consumers.entries())
        if (obj(c, ['id', 'owner', 'descriptorDigest', 'requirements'], `consumers[${i}]`)) {
            check(text(c.id) && text(c.owner) && pin(c.descriptorDigest), `consumers[${i}]`);
            check(c.requirements === null || Array.isArray(c.requirements), `consumers[${i}].requirements`);
            if (Array.isArray(c.requirements))
                for (const [j, r] of c.requirements.entries()) {
                    const at = `consumers[${i}].requirements[${j}]`;
                    if (!record(r)) {
                        errors.push(at);
                        continue;
                    }
                    check(text(r.id) && text(r.provider) && text(r.kind) && typeof r.required === 'boolean', at);
                    if (r.fields !== undefined)
                        check(strings(r.fields), at + '.fields');
                    if (r.unsupported !== undefined)
                        check(strings(r.unsupported), at + '.unsupported');
                    if (r.links !== undefined) {
                        check(Array.isArray(r.links), at + '.links');
                        if (Array.isArray(r.links))
                            for (const l of r.links)
                                if (obj(l, ['label', 'target'], at + '.links')) {
                                    check(text(l.label), at + '.links.label');
                                    if (obj(l.target, ['provider', 'kind'], at + '.links.target'))
                                        check(text(l.target.provider) && text(l.target.kind), at + '.links.target');
                                }
                    }
                }
        }
    for (const [i, e] of input.endpoints.entries())
        if (obj(e, ['id', 'consumer', 'requirement', 'placement', 'alias'], `endpoints[${i}]`)) {
            check(text(e.id) && text(e.consumer) && text(e.requirement) && ['local', 'qualified'].includes(e.placement), `endpoints[${i}]`);
            check(e.alias === undefined || text(e.alias), `endpoints[${i}].alias`);
        }
    for (const [i, o] of input.observations.entries())
        if (obj(o, ['id', 'provider', 'scope', 'bundleId', 'expectedBundleId', 'availability', 'complete', 'observedVersion', 'definitions'], `observations[${i}]`)) {
            check(text(o.id) && text(o.provider) && text(o.scope) && typeof o.complete === 'boolean' && ['available', 'unavailable', 'unknown'].includes(o.availability), `observations[${i}]`);
            for (const k of ['bundleId', 'expectedBundleId', 'observedVersion'])
                check(o[k] === undefined || text(o[k]), `observations[${i}].${k}`);
            check(Array.isArray(o.definitions), `observations[${i}].definitions`);
            if (Array.isArray(o.definitions))
                for (const d of o.definitions)
                    if (obj(d, ['id', 'bytes'], `observations[${i}].definitions`))
                        check(text(d.id) && safeId(d.id) && typeof d.bytes === 'string', `observations[${i}].definitions`);
        }
    if (input.placementInventories !== undefined) {
        check(Array.isArray(input.placementInventories), 'placementInventories');
        if (Array.isArray(input.placementInventories))
            for (const [i, o] of input.placementInventories.entries())
                if (obj(o, ['id', 'scope', 'bundleId', 'expectedBundleId', 'availability', 'complete', 'observedVersion', 'files'], `placementInventories[${i}]`)) {
                    check(text(o.id) && text(o.scope) && typeof o.complete === 'boolean' && ['available', 'unavailable', 'unknown'].includes(o.availability), `placementInventories[${i}]`);
                    for (const k of ['bundleId', 'expectedBundleId', 'observedVersion'])
                        check(o[k] === undefined || text(o[k]), `placementInventories[${i}].${k}`);
                    check(Array.isArray(o.files), `placementInventories[${i}].files`);
                    if (Array.isArray(o.files))
                        for (const f of o.files)
                            if (obj(f, ['path', 'bytes'], `placementInventories[${i}].files`))
                                check(text(f.path) && safePath(f.path) && typeof f.bytes === 'string', `placementInventories[${i}].files`);
                }
    }
    return errors;
}
function safeId(id: string): boolean { try {
    assertSafeConceptId(id);
    return true;
}
catch {
    return false;
} }
function safePath(path: string): boolean { return safeId(path) && !path.startsWith('/'); }
function ownedDocs(prepared: PreparedRecipeInstall): OkfDocument[] { return [...prepared.docs, ...prepared.connectors.map(c => c.doc), ...prepared.references.map(r => r.doc)]; }
function assets(prepared: PreparedRecipeInstall): Map<string, OkfDocument | string> {
    return new Map<string, OkfDocument | string>([...ownedDocs(prepared).map(d => [`${d.id}.md`, d] as [
            string,
            OkfDocument
        ]), ...prepared.pages.flatMap(p => [[`${p.registry.id}.md`, p.registry], [p.entry, p.html]] as [
            string,
            OkfDocument | string
        ][])]);
}
/** Async for a uniform portable consumer contract; performs no IO, writes, or permission checks. */
export async function preflightRecipeSet(value: unknown): Promise<PreflightResult> {
    let malformed: string[];
    try { malformed = shape(value); } catch { malformed = ['input']; }
    if (malformed.length)
        return { schema: 'recipe-set-preflight-result/v1', verdict: 'refused', structuralComplete: false, scope: 'declared-structural-input-only', digestScheme: RECIPE_PREFLIGHT_DIGEST_SCHEME, inputs: { selected: [], consumers: [], observations: [], placementInventories: [] }, externalConsumers: 'unknown-out-of-scope', issues: malformed.sort(compareCodeUnits).map(at => ({ level: 'refused', code: 'INPUT_SHAPE', at })), parserWarnings: [] };
    const input = value as RecipePreflightInput;
    const issues: PreflightIssue[] = [], parserWarnings: PreflightResult["parserWarnings"] = [];
    const recipes = new Map<string, SelectedRecipe & {
        parsed: LoadedRecipe;
        prepared: PreparedRecipeInstall;
    }>();
    const inventories = new Map<string, {
        o: Observation;
        docs: OkfDocument[];
        registry: KindRegistry;
    }>();
    const issue = (level: PreflightIssue['level'], code: string, at: string) => { issues.push({ level, code, at }); };
    if (input.schema !== 'recipe-set-preflight/v1')
        issue('refused', 'SCHEMA', 'schema');
    if (input.selected.length === 0)
        issue('partial', 'SELECTED_SET_UNKNOWN', 'selected');
    const unique = (rows: readonly object[], key: string, at: string) => { const seen = new Set(); for (const r of rows) {
        if (seen.has((r as Record<string, unknown>)[key]))
            issue('refused', 'DUPLICATE_ID', `${at}:${(r as Record<string, unknown>)[key]}`);
        seen.add((r as Record<string, unknown>)[key]);
    } };
    unique(input.selected, 'key', 'selected');
    unique(input.selected, 'recipeId', 'recipeIds');
    unique(input.consumers, 'id', 'consumers');
    if (input.consumers.length === 0 && input.selected.some(s => s.role === 'extension'))
        issue('partial', 'CONSUMER_REQUIREMENTS_UNKNOWN', 'consumers');
    for (const s of input.selected) {
        if (!s.artifact) {
            issue('partial', 'ARTIFACT_UNAVAILABLE', s.key);
            continue;
        }
        if (recipePreflightDigest(s.artifact) !== s.artifactDigest)
            issue('refused', 'ARTIFACT_DIGEST', s.key);
        if ((['publisher', 'recipeId', 'release'] as const).some(k => s[k] !== s.artifact!.identity[k]))
            issue('refused', 'ARTIFACT_IDENTITY', s.key);
        unique(s.artifact.files, 'path', `files:${s.key}`);
        for (const f of s.artifact.files)
            if (recipePreflightDigest(f.bytes) !== f.digest)
                issue('refused', 'FILE_DIGEST', `${s.key}:${f.path}`);
        try {
            const p = parseRecipeFiles(s.artifact.files, `${s.publisher}/${s.recipeId}@${s.release}`, { okfVersion: '0.2' });
            if (!p.ok) {
                issue('refused', p.error.code, s.key);
                continue;
            }
            if (p.recipe.id !== s.recipeId || p.recipe.version !== s.release)
                issue('refused', 'MANIFEST_IDENTITY', s.key);
            parserWarnings.push(...p.recipe.warnings.map(w => ({ provider: s.key, code: w.code, field: w.field })));
            for (const w of p.recipe.warnings)
                issue(w.code === 'KIND_CONVENTION_MALFORMED' || w.code === 'KIND_DUPLICATE_GOVERNS' ? 'refused' : 'partial', w.code === 'RECIPE_MANIFEST_RESERVED_KEY' ? 'MANIFEST_SEMANTICS_NOT_APPLIED' : 'PARSER_DIAGNOSTIC_UNCLASSIFIED', `${s.key}:${w.code}`);
            const registry = buildKindRegistry(p.recipe.docs);
            for (const w of registry.warnings)
                issue(modelDiagnosticLevel(w.code), w.code, s.key);
            recipes.set(s.key, { ...s, parsed: p.recipe, prepared: prepareRecipeInstall(p.recipe, { okfVersion: '0.2', now: '1970-01-01T00:00:00.000Z' }) });
        }
        catch {
            issue('refused', 'PARSE_FAILURE', s.key);
        }
    }
    // Caller-supplied observations are structural evidence only, never access grants or reads.
    unique(input.observations, 'id', 'observations');
    unique(input.endpoints, 'id', 'endpoints');
    for (const selected of input.selected)
        if (!input.observations.some(o => o.provider === selected.key))
            issue('partial', 'SELECTED_PLACEMENT_UNKNOWN', selected.key);
    for (const o of input.observations) {
        if (!['available', 'unavailable', 'unknown'].includes(o.availability)) {
            issue('refused', 'AVAILABILITY', o.id);
            continue;
        }
        if (!input.selected.some(s => s.key === o.provider))
            issue('refused', 'OBSERVATION_PROVIDER_UNKNOWN', o.id);
        if (o.scope !== 'local' && !isBundleAlias(o.scope))
            issue('refused', 'ENDPOINT_BINDING', o.id);
        if (o.availability !== 'available') {
            issue('partial', 'OBSERVATION_UNAVAILABLE', o.id);
            continue;
        }
        if (o.complete !== true)
            issue('partial', 'INVENTORY_INCOMPLETE', o.id);
        if (typeof o.observedVersion !== 'string' || !o.observedVersion)
            issue('partial', 'OBSERVED_VERSION_UNKNOWN', o.id);
        if (o.scope !== 'local' && (!o.bundleId || o.bundleId !== o.expectedBundleId))
            issue('refused', 'BUNDLE_IDENTITY', o.id);
        const s = recipes.get(o.provider);
        if (!s) {
            issue('partial', 'PROVIDER_ARTIFACT_UNAVAILABLE', o.id);
            continue;
        }
        unique(o.definitions, 'id', `definitions:${o.id}`);
        const docs: OkfDocument[] = [];
        for (const d of o.definitions) {
            const desired = ownedDocs(s.prepared).find(x => x.id === d.id);
            if (!desired) {
                issue('refused', 'UNOWNED_DEFINITION', `${o.id}:${d.id}`);
                continue;
            }
            try {
                const doc = { id: d.id, ...parseMarkdown(d.bytes, d.id, { okfVersion: '0.2' }) };
                const checked = inspectRecipeInstallTarget(doc, desired, s.prepared);
                if (definitionDigest(doc) !== definitionDigest(desired))
                    issue('refused', 'LOCAL_ADAPTATION', `${o.id}:${d.id}`);
                if (checked.stamp === 'missing')
                    issue('partial', 'STAMP_UNAVAILABLE', `${o.id}:${d.id}`);
                else if (checked.stamp !== 'current')
                    issue('refused', 'FOREIGN_OR_DIVERGENT_STAMP', `${o.id}:${d.id}`);
                if (checked.stampIntegrity === 'unknown')
                    issue('partial', 'STAMP_RULES_UNKNOWN', `${o.id}:${d.id}`);
                else if (checked.stampIntegrity === 'diverged')
                    issue('refused', 'STAMP_DEFINITION_DIVERGED', `${o.id}:${d.id}`);
                docs.push(doc);
            }
            catch {
                issue('refused', 'OBSERVATION_PARSE', `${o.id}:${d.id}`);
            }
        }
        // Catch omitted definitions instead of interpreting an incomplete observation as complete.
        for (const d of ownedDocs(s.prepared))
            if (!o.definitions.some(x => x.id === d.id))
                issue(o.complete ? 'refused' : 'partial', 'DEFINITION_UNOBSERVED', `${o.id}:${d.id}`);
        const registry = buildKindRegistry(docs.filter(d => isConventionId(d.id) && d.frontmatter.type === CONVENTION_TYPE));
        for (const w of registry.warnings)
            issue(modelDiagnosticLevel(w.code), w.code, o.id);
        inventories.set(o.id, { o, docs, registry });
    }
    // Full placement inventories prevent selected-provider filtering from hiding local collisions.
    const placements = input.placementInventories ?? [];
    unique(placements, 'id', 'placementInventories');
    for (const scope of new Set([...input.observations.map(o => o.scope), ...placements.map(p => p.scope)])) {
        const matches = placements.filter(p => p.scope === scope);
        if (matches.length !== 1) {
            issue(matches.length ? 'refused' : 'partial', matches.length ? 'PLACEMENT_INVENTORY_AMBIGUOUS' : 'PLACEMENT_INVENTORY_UNKNOWN', scope);
            continue;
        }
        const placement = matches[0]!;
        if (scope !== 'local' && (!isBundleAlias(scope) || !placement.bundleId || placement.bundleId !== placement.expectedBundleId))
            issue('refused', 'BUNDLE_IDENTITY', placement.id);
        if (placement.availability !== 'available') {
            issue('partial', 'PLACEMENT_INVENTORY_UNKNOWN', placement.id);
            continue;
        }
        if (!placement.complete)
            issue('partial', 'PLACEMENT_INVENTORY_INCOMPLETE', placement.id);
        if (!placement.observedVersion)
            issue('partial', 'OBSERVED_VERSION_UNKNOWN', placement.id);
        unique(placement.files, 'path', `placement:${placement.id}`);
        const files = new Map(placement.files.map(f => [f.path, f.bytes]));
        const documents: OkfDocument[] = [];
        for (const file of placement.files.filter(f => f.path.startsWith(CONVENTIONS_PREFIX) && f.path.endsWith('.md'))) {
            try {
                documents.push({ id: file.path.slice(0, -3), ...parseMarkdown(file.bytes, undefined, { okfVersion: '0.2' }) });
            }
            catch {
                issue('refused', 'OBSERVATION_PARSE', `${placement.id}:${file.path}`);
            }
        }
        for (const warning of buildKindRegistry(documents.filter(d => isConventionId(d.id) && d.frontmatter.type === CONVENTION_TYPE)).warnings)
            issue(modelDiagnosticLevel(warning.code), warning.code, placement.id);
        const claims = new Map<string, string>();
        const scopes = input.observations.filter(o => o.scope === scope);
        for (const observation of scopes) {
            if (scope !== 'local' && (observation.bundleId !== placement.bundleId || observation.expectedBundleId !== placement.expectedBundleId))
                issue('refused', 'BUNDLE_IDENTITY', observation.id);
            for (const definition of observation.definitions) {
                const file = files.get(`${definition.id}.md`);
                if (file !== undefined && file !== definition.bytes)
                    issue('refused', 'INVENTORY_INCONSISTENT', `${observation.id}:${definition.id}`);
                if (file === undefined)
                    issue(placement.complete ? 'refused' : 'partial', 'PLACEMENT_DEFINITION_UNOBSERVED', `${observation.id}:${definition.id}`);
            }
            const recipe = recipes.get(observation.provider);
            if (!recipe)
                continue;
            for (const [path, expected] of assets(recipe.prepared)) {
                const previous = claims.get(path);
                if (previous !== undefined && previous !== observation.provider)
                    issue('refused', 'DEFINITION_ID_COLLISION', `${scope}:${path}`);
                claims.set(path, observation.provider);
                const actual = files.get(path);
                if (actual === undefined) {
                    issue(placement.complete ? 'refused' : 'partial', 'PLACEMENT_ASSET_UNOBSERVED', `${scope}:${path}`);
                    continue;
                }
                if (typeof expected === 'string') {
                    if (actual !== expected)
                        issue('refused', 'LOCAL_ADAPTATION', `${scope}:${path}`);
                }
                else {
                    try {
                        const doc = { id: path.slice(0, -3), ...parseMarkdown(actual, undefined, { okfVersion: '0.2' }) };
                        if (definitionDigest(doc) !== definitionDigest(expected as OkfDocument))
                            issue('refused', 'LOCAL_ADAPTATION', `${scope}:${path}`);
                        // The installer stamps owned definitions, but not View registry documents.
                        if (ownedDocs(recipe.prepared).some(d => `${d.id}.md` === path)) {
                            const checked = inspectRecipeInstallTarget(doc, expected as OkfDocument, recipe.prepared);
                            if (checked.stamp === 'missing')
                                issue('partial', 'STAMP_UNAVAILABLE', `${scope}:${path}`);
                            else if (checked.stamp !== 'current')
                                issue('refused', 'FOREIGN_OR_DIVERGENT_STAMP', `${scope}:${path}`);
                            if (checked.stampIntegrity === 'unknown')
                                issue('partial', 'STAMP_RULES_UNKNOWN', `${scope}:${path}`);
                            else if (checked.stampIntegrity === 'diverged')
                                issue('refused', 'STAMP_DEFINITION_DIVERGED', `${scope}:${path}`);
                        }
                    }
                    catch {
                        issue('refused', 'OBSERVATION_PARSE', `${scope}:${path}`);
                    }
                }
            }
        }
        const selectedDocs = [...inventories.values()].filter(x => x.o.scope === scope).flatMap(x => x.docs);
        const ids = new Set<string>();
        for (const doc of selectedDocs) {
            if (ids.has(doc.id))
                issue('refused', 'DEFINITION_ID_COLLISION', `${scope}:${doc.id}`);
            ids.add(doc.id);
        }
        for (const warning of buildKindRegistry(selectedDocs.filter(d => isConventionId(d.id) && d.frontmatter.type === CONVENTION_TYPE)).warnings)
            issue(modelDiagnosticLevel(warning.code), warning.code, scope);
    }
    const scopeOf = (e: Endpoint) => e.placement === 'local' ? 'local' : e.alias;
    const endpoint = (consumer: string, requirement: string) => input.endpoints.filter(e => e.consumer === consumer && e.requirement === requirement);
    const materializedTargets = (consumer: string, provider: string, kind: string): string[] => {
        const c = input.consumers.find(x => x.id === consumer);
        const requirements = c?.requirements?.filter(r => r.provider === provider && r.kind === kind) ?? [];
        const targets = requirements.flatMap(r => endpoint(consumer, r.id)).map(e => e.placement === 'local' ? kind : `${e.alias}:${kind}`);
        return [...new Set(targets)].sort(compareCodeUnits);
    };
    for (const s of input.selected)
        if (s.role === 'extension' && !input.consumers.some(c => c.owner === s.key))
            issue('partial', 'EXTENSION_CONSUMER_UNKNOWN', s.key);
    for (const c of input.consumers) {
        if (c.descriptorDigest !== recipePreflightDigest({ id: c.id, owner: c.owner, requirements: c.requirements }))
            issue('refused', 'DESCRIPTOR_DIGEST', c.id);
        if (!input.selected.some(s => s.key === c.owner))
            issue('refused', 'CONSUMER_OWNER', c.id);
        else if (!recipes.has(c.owner))
            issue('partial', 'PROVIDER_ARTIFACT_UNAVAILABLE', c.id);
        if (!Array.isArray(c.requirements)) {
            issue('partial', 'CONSUMER_REQUIREMENTS_UNKNOWN', c.id);
            continue;
        }
        unique(c.requirements, 'id', `requirements:${c.id}`);
        if (c.requirements.length === 0 && input.selected.some(s => s.key === c.owner && s.role === 'extension'))
            issue('partial', 'EXTENSION_REQUIREMENTS_UNKNOWN', c.id);
        for (const r of c.requirements) {
            const at = `${c.id}:${r.id}`;
            for (const key of Object.keys(r))
                if (!['id', 'provider', 'kind', 'required', 'fields', 'links', 'unsupported'].includes(key))
                    issue('partial', 'UNSUPPORTED_OPERATOR', `${at}:${key}`);
            for (const u of r.unsupported ?? [])
                issue('partial', 'UNSUPPORTED_CONSTRAINT', `${at}:${u}`);
            if (!input.selected.some(s => s.key === r.provider)) {
                issue(r.required ? 'refused' : 'partial', 'SELECTED_PROVIDER_MISSING', at);
                continue;
            }
            if (!recipes.has(r.provider)) {
                issue('partial', 'PROVIDER_ARTIFACT_UNAVAILABLE', at);
                continue;
            }
            const es = endpoint(c.id, r.id);
            if (es.length !== 1) {
                issue(es.length > 1 ? 'refused' : 'partial', es.length > 1 ? 'ENDPOINT_AMBIGUOUS' : 'ENDPOINT_UNOBSERVED', at);
                continue;
            }
            const e = es[0]!;
            if (!['local', 'qualified'].includes(e.placement) || (e.placement === 'local' && e.alias !== undefined) || (e.placement === 'qualified' && (!e.alias || e.alias === 'local' || !isBundleAlias(e.alias)))) {
                issue('refused', 'ENDPOINT_BINDING', at);
                continue;
            }
            const os = input.observations.filter(o => o.provider === r.provider && o.scope === scopeOf(e));
            if (os.length !== 1) {
                issue(os.length > 1 ? 'refused' : 'partial', os.length > 1 ? 'OBSERVATION_AMBIGUOUS' : 'OBSERVATION_UNAVAILABLE', at);
                continue;
            }
            const o = os[0]!;
            if (o.availability !== 'available') {
                issue('partial', r.required ? 'REQUIRED_UNAVAILABLE' : 'OPTIONAL_UNAVAILABLE', at);
                continue;
            }
            const kind = inventories.get(o.id)?.registry.kinds.get(r.kind);
            if (!kind) {
                issue(o.complete === true ? 'refused' : 'partial', o.complete === true ? 'REQUIRED_KIND_MISSING' : 'REQUIRED_KIND_UNOBSERVED', at);
                continue;
            }
            for (const field of r.fields ?? [])
                if (![...kind.fields.required, ...kind.fields.optional].includes(field))
                    issue('refused', 'REQUIRED_FIELD_MISSING', `${at}:${field}`);
            if (e.placement === 'qualified' && r.links?.length) {
                // Alias mappings here describe the root scope, not a foreign source's namespace.
                issue('partial', 'SOURCE_QUALIFIED_LINKS_UNSUPPORTED', at);
                continue;
            }
            for (const link of r.links ?? []) {
                const targets = materializedTargets(c.id, link.target.provider, link.target.kind);
                const expected = targets[0];
                if (targets.length > 1)
                    issue('refused', 'LINK_TARGET_AMBIGUOUS', `${at}:${link.label}`);
                else if (!expected)
                    issue('partial', 'LINK_TARGET_UNOBSERVED', `${at}:${link.label}`);
                else if (!kind.links || kind.links[link.label] !== expected)
                    issue('refused', 'LINK_TARGET_MISMATCH', `${at}:${link.label}`);
            }
        }
    }
    for (const e of input.endpoints) {
        const c = input.consumers.find(c => c.id === e.consumer);
        if (!c?.requirements?.some(r => r.id === e.requirement))
            issue('refused', 'ORPHAN_ENDPOINT', e.id);
    }
    const dedup = [...new Map(issues.map(i => [JSON.stringify(i), i])).values()].sort((a, b) => compareCodeUnits(JSON.stringify(a), JSON.stringify(b)));
    const verdict = dedup.some(i => i.level === 'refused') ? 'refused' : dedup.length ? 'partial' : 'valid';
    return { schema: 'recipe-set-preflight-result/v1', verdict, structuralComplete: verdict === 'valid', scope: 'declared-structural-input-only', digestScheme: 'fixture-envelope-v1/utf16-code-unit-sorted-keys-and-file-paths/sha256', inputs: { selected: input.selected.map(({ key, publisher, recipeId, release, artifactDigest }) => ({ key, publisher, recipeId, release, artifactDigest })), consumers: input.consumers.map(({ id, descriptorDigest }) => ({ id, descriptorDigest })), observations: input.observations.map(({ id, observedVersion }) => ({ id, ...(observedVersion ? { observedVersion } : {}) })), placementInventories: (input.placementInventories ?? []).map(({ id, observedVersion }) => ({ id, ...(observedVersion ? { observedVersion } : {}) })) }, externalConsumers: 'unknown-out-of-scope', issues: dedup, parserWarnings: parserWarnings.sort((a, b) => compareCodeUnits(JSON.stringify(a), JSON.stringify(b))) };
}
/** Human guidance is separate from deterministic diagnostics, so adapters need not invent it. */
export function explainRecipePreflightIssue(code: string): {
    message: string;
    action: string;
} {
    const groups: [
        string[],
        string,
        string
    ][] = [
        [['INPUT_SHAPE', 'SCHEMA'], 'The supplied evidence does not match the supported contract.', 'Supply finite JSON using recipe-set-preflight/v1 and the documented fields.'],
        [['ARTIFACT_DIGEST', 'FILE_DIGEST', 'DESCRIPTOR_DIGEST'], 'An exact content pin does not match the supplied content.', 'Reacquire the intended exact bytes and independently verify their declared digest.'],
        [['ARTIFACT_IDENTITY', 'MANIFEST_IDENTITY', 'DUPLICATE_ID', 'CONSUMER_OWNER', 'OBSERVATION_PROVIDER_UNKNOWN'], 'The supplied identities conflict or are ambiguous.', 'Choose unique selected keys, recipe IDs and descriptor identities, and align their references.'],
        [['DEFINITION_ID_COLLISION', 'KIND_DUPLICATE_GOVERNS'], 'More than one owner claims a definition path or active Kind in this placement.', 'Use separately owned noncolliding definitions or explicitly different placements.'],
        [['FOREIGN_OR_DIVERGENT_STAMP', 'STAMP_DEFINITION_DIVERGED', 'LOCAL_ADAPTATION', 'UNOWNED_DEFINITION'], 'Observed content does not conform to the selected recipe release and ownership.', 'Inspect the installed definition and choose the intended exact release or deliberate local adaptation outside this conformance claim.'],
        [['STAMP_UNAVAILABLE', 'STAMP_RULES_UNKNOWN'], 'Installed ownership or integrity cannot be established.', 'Supply readable supported Core stamps; do not adopt or restamp definitions based on this result.'],
        [['BUNDLE_IDENTITY', 'ENDPOINT_BINDING', 'ENDPOINT_AMBIGUOUS', 'LINK_TARGET_AMBIGUOUS', 'ORPHAN_ENDPOINT'], 'Placement evidence conflicts with the declared endpoint mapping.', 'Provide one explicit mapping with matching aliases and expected/observed bundle identities.'],
        [['REQUIRED_KIND_MISSING', 'REQUIRED_FIELD_MISSING', 'LINK_TARGET_MISMATCH'], 'A supplied structural definition contradicts a declared consumer requirement.', 'Align the explicitly selected definitions and consumer contract; optionality does not hide contradictions.'],
        [['INVENTORY_INCONSISTENT', 'PLACEMENT_INVENTORY_AMBIGUOUS'], 'Supplied inventories disagree about the checked snapshot.', 'Collect one consistent placement inventory and matching owned observations.'],
        [['RECIPE_MALFORMED', 'RECIPE_EMPTY', 'RECIPE_UNSAFE_PATH', 'RECIPE_CONNECTOR_INVALID', 'PARSE_FAILURE', 'OBSERVATION_PARSE', 'KIND_CONVENTION_MALFORMED'], 'A supplied recipe or active definition is malformed.', 'Correct the input using the existing Core recipe/Kind parser diagnostics before checking again.'],
        [['UNSUPPORTED_OPERATOR', 'UNSUPPORTED_CONSTRAINT', 'SOURCE_QUALIFIED_LINKS_UNSUPPORTED', 'PARSER_DIAGNOSTIC_UNCLASSIFIED', 'MANIFEST_SEMANTICS_NOT_APPLIED'], 'Requested or declared semantics are not evaluated by this structural checker.', 'Keep this result partial and evaluate those semantics with their owning contract; reserved manifest keys are not enforced.'],
    ];
    for (const [codes, message, action] of groups)
        if (codes.includes(code))
            return { message, action };
    return { message: 'Required evidence or consumer scope is missing, incomplete or unavailable.', action: 'Inspect the diagnostic location, supply the missing exact snapshot or descriptor, then run preflight again. Do not treat unknown evidence as absence or approval.' };
}
