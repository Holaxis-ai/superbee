// Synthetic author fixtures; no private source, acquisition or runtime evidence.
import { parseRecipeFiles } from '../src/recipes.js';
import { parseMarkdown, stringifyDoc } from '../src/frontmatter.js';
import { prepareRecipeInstall } from '../src/recipe-lifecycle/index.js';
import { recipePreflightDigest as digest } from '../src/recipe-set-preflight.js';
const copy = x => structuredClone(x);
const recipe = (key, kind, path, fields = ['title'], links = {}, version = '1.0.0', extra = '') => {
    const files = [{ path: 'recipe.md', bytes: `---\ntype: Recipe\nid: ${key}\ntitle: ${key}\nversion: ${version}\nsummary: Synthetic preflight contract fixture\n${extra}---\nIndependent synthetic publisher.\n` }, { path: `conventions/${path}.md`, bytes: `---\ntype: Convention\ntitle: ${kind}\ngoverns: ${kind}\npath: ${path}/\nfields:\n  required: [${fields.join(', ')}]\n${Object.keys(links).length ? 'links:\n' + Object.entries(links).map(([k, v]) => `  ${k}: ${v}\n`).join('') : ''}---\nSynthetic reusable definition.\n` }].map(f => ({ ...f, digest: digest(f.bytes) }));
    const artifact = { identity: { publisher: `synthetic-publisher-${key}`, recipeId: key, release: version }, files };
    return { key, role: key === 'contribution' ? 'extension' : 'base', ...artifact.identity, artifactDigest: digest(artifact), artifact };
};
const requirements = [{ id: 'work', provider: 'work', kind: 'Work Item', required: true, fields: ['title', 'status'] }, { id: 'goal', provider: 'goal', kind: 'Goal', required: true, fields: ['title', 'score'] }, { id: 'contribution', provider: 'contribution', kind: 'Contribution', required: true, links: [{ label: 'work', target: { provider: 'work', kind: 'Work Item' } }, { label: 'goal', target: { provider: 'goal', kind: 'Goal' } }] }];
function base(qualified = false) {
    const selected = [recipe('work', 'Work Item', 'work-item', ['title', 'status']), recipe('goal', 'Goal', 'goal', ['title', 'score']), recipe('contribution', 'Contribution', 'contribution', ['title'], { work: 'Work Item', goal: qualified ? 'leadership:Goal' : 'Goal' }, qualified ? '1.0.0-qualified' : '1.0.0')];
    const x = { schema: 'recipe-set-preflight/v1', selected, consumers: [{ id: 'contribution-app', owner: 'contribution', requirements: copy(requirements) }], endpoints: requirements.map(r => ({ id: r.id, consumer: 'contribution-app', requirement: r.id, placement: qualified && r.id === 'goal' ? 'qualified' : 'local', ...(qualified && r.id === 'goal' ? { alias: 'leadership' } : {}) })), observations: [] };
    x.observations = selected.map(s => ({ id: s.key, provider: s.key, scope: qualified && s.key === 'goal' ? 'leadership' : 'local', ...(qualified && s.key === 'goal' ? { bundleId: 'bnd_synthetic_leadership', expectedBundleId: 'bnd_synthetic_leadership' } : {}), availability: 'available', complete: true, observedVersion: 'synthetic-v1', definitions: [] }));
    refresh(x);
    pinDescriptors(x);
    return x;
}
function refresh(x, key) { for (const s of x.selected) {
    if (key && s.key !== key)
        continue;
    s.artifact.files.forEach(f => f.digest = digest(f.bytes));
    s.artifactDigest = digest(s.artifact);
    const parsed = parseRecipeFiles(s.artifact.files, `${s.publisher}/${s.recipeId}@${s.release}`, { okfVersion: '0.2' });
    if (!parsed.ok)
        throw Error(JSON.stringify(parsed));
    const prepared = prepareRecipeInstall(parsed.recipe, { okfVersion: '0.2', now: '2026-10-20T00:00:00.000Z' });
    for (const o of x.observations.filter(o => o.provider === s.key)) {
        o.definitions = prepared.docs.map(d => ({ id: d.id, bytes: stringifyDoc(d.frontmatter, d.body) }));
    }
} }
function editStamp(x, fn) { const d = x.observations[0].definitions[0], doc = { id: d.id, ...parseMarkdown(d.bytes, d.id, { okfVersion: '0.2' }) }; fn(doc.frontmatter); d.bytes = stringifyDoc(doc.frontmatter, doc.body); }
function pinDescriptors(x) { for (const c of x.consumers)
    c.descriptorDigest = digest({ id: c.id, owner: c.owner, requirements: c.requirements }); }
const cases = [];
const add = (id, change, verdict, codes = [], qualified = false, noWarnings = true) => { const input = base(qualified); change(input); pinDescriptors(input); cases.push({ id, input, expected: { verdict, codes, noWarnings } }); };
add('local-complete', () => { }, 'valid');
add('qualified-complete', () => { }, 'valid', [], true);
add('required-provider-not-selected', x => { x.selected = x.selected.filter(s => s.key !== 'goal'); x.observations = x.observations.filter(s => s.provider !== 'goal'); }, 'refused', ['SELECTED_PROVIDER_MISSING']);
add('artifact-pin-mismatch', x => x.selected[0].artifactDigest = 'sha256:' + '0'.repeat(64), 'refused', ['ARTIFACT_DIGEST']);
add('publisher-identity-mismatch', x => x.selected[0].publisher = 'other-publisher', 'refused', ['ARTIFACT_IDENTITY']);
add('release-identity-mismatch', x => x.selected[0].release = '2.0.0', 'refused', ['ARTIFACT_IDENTITY', 'MANIFEST_IDENTITY']);
add('file-digest-mismatch', x => x.selected[0].artifact.files[1].digest = 'sha256:' + '0'.repeat(64), 'refused', ['FILE_DIGEST', 'ARTIFACT_DIGEST']);
add('artifact-observation-missing', x => delete x.selected[1].artifact, 'partial', ['ARTIFACT_UNAVAILABLE', 'PROVIDER_ARTIFACT_UNAVAILABLE']);
add('same-id-different-kind-collision', x => { const s = recipe('collision', 'Other Work', 'work-item'); x.selected.push(s); x.observations.push({ id: 'collision', provider: 'collision', scope: 'local', availability: 'available', complete: true, observedVersion: 'synthetic-v1', definitions: [] }); refresh(x, 'collision'); }, 'refused', ['DEFINITION_ID_COLLISION']);
add('distinct-id-same-kind-collision', x => { const s = recipe('collision', 'Work Item', 'shadow'); x.selected.push(s); x.observations.push({ id: 'collision', provider: 'collision', scope: 'local', availability: 'available', complete: true, observedVersion: 'synthetic-v1', definitions: [] }); refresh(x, 'collision'); }, 'refused', ['KIND_DUPLICATE_GOVERNS']);
add('required-kind-missing', x => { x.selected[1].artifact.files[1].bytes = x.selected[1].artifact.files[1].bytes.replace('governs: Goal', 'governs: Objective'); refresh(x, 'goal'); }, 'refused', ['REQUIRED_KIND_MISSING']);
add('required-consumer-field-missing-with-clean-install', x => { x.selected[1].artifact.files[1].bytes = x.selected[1].artifact.files[1].bytes.replace('[title, score]', '[title]'); refresh(x, 'goal'); }, 'refused', ['REQUIRED_FIELD_MISSING']);
add('required-consumer-link-absent-with-clean-install', x => { x.selected[2].artifact.files[1].bytes = x.selected[2].artifact.files[1].bytes.replace('  goal: Goal\n', ''); refresh(x, 'contribution'); }, 'refused', ['LINK_TARGET_MISMATCH']);
add('endpoint-target-mismatch-with-clean-install', x => { x.selected[2].artifact.files[1].bytes = x.selected[2].artifact.files[1].bytes.replace('  goal: Goal', '  goal: Work Item'); refresh(x, 'contribution'); }, 'refused', ['LINK_TARGET_MISMATCH']);
add('local-adaptation', x => x.observations[0].definitions[0].bytes += 'Local additional guidance.\n', 'refused', ['LOCAL_ADAPTATION']);
add('foreign-stamp', x => editStamp(x, f => f.x_recipe.id = 'foreign'), 'refused', ['FOREIGN_OR_DIVERGENT_STAMP']);
add('divergent-stamp', x => editStamp(x, f => f.x_recipe.definition = 'sha256:' + '0'.repeat(64)), 'refused', ['STAMP_DEFINITION_DIVERGED']);
add('required-endpoint-unavailable', x => x.observations[1].availability = 'unavailable', 'partial', ['REQUIRED_UNAVAILABLE']);
add('optional-endpoint-unavailable', x => { x.consumers[0].requirements[1].required = false; x.observations[1].availability = 'unavailable'; }, 'partial', ['OPTIONAL_UNAVAILABLE']);
add('optional-provider-not-selected', x => { x.consumers[0].requirements[1].required = false; x.selected = x.selected.filter(s => s.key !== 'goal'); x.observations = x.observations.filter(s => s.provider !== 'goal'); }, 'partial', ['SELECTED_PROVIDER_MISSING']);
add('optional-known-mismatch-refuses', x => { x.consumers[0].requirements[1].required = false; x.selected[1].artifact.files[1].bytes = x.selected[1].artifact.files[1].bytes.replace('[title, score]', '[title]'); refresh(x, 'goal'); }, 'refused', ['REQUIRED_FIELD_MISSING']);
add('required-endpoint-unobserved', x => x.endpoints = x.endpoints.filter(e => e.requirement !== 'goal'), 'partial', ['ENDPOINT_UNOBSERVED']);
add('qualified-alias-mismatch', x => x.endpoints[1].alias = 'wrong-alias', 'refused', ['LINK_TARGET_MISMATCH', 'OBSERVATION_UNAVAILABLE'], true);
add('qualified-bundle-identity-mismatch', x => x.observations[1].bundleId = 'bnd_other', 'refused', ['BUNDLE_IDENTITY'], true);
add('qualified-definition-still-local', x => { x.selected[2].artifact.files[1].bytes = x.selected[2].artifact.files[1].bytes.replace('leadership:Goal', 'Goal'); refresh(x, 'contribution'); }, 'refused', ['LINK_TARGET_MISMATCH'], true);
add('consumer-contract-unknown', x => x.consumers[0].requirements = null, 'partial', ['CONSUMER_REQUIREMENTS_UNKNOWN'], false);
// Remove endpoints when contract is unknown; orphan supplied endpoints would be contradictory.
cases.at(-1).input.endpoints = [];
add('unsupported-type-constraint-even-when-field-exists', x => x.consumers[0].requirements[1].unsupported = ['score-type:number'], 'partial', ['UNSUPPORTED_CONSTRAINT']);
add('installed-warning-does-not-enforce-dependency', x => { x.selected[2].artifact.files[0].bytes = x.selected[2].artifact.files[0].bytes.replace('---\nIndependent', 'requires: [missing-recipe]\n---\nIndependent'); refresh(x, 'contribution'); x.consumers[0].requirements.push({ id: 'missing', provider: 'missing-recipe', kind: 'Missing', required: true }); }, 'refused', ['SELECTED_PROVIDER_MISSING'], false, false);
add('missing-stamp-evidence', x => editStamp(x, f => delete f.x_recipe), 'partial', ['STAMP_UNAVAILABLE']);
add('missing-definition-evidence', x => x.observations[0].definitions = [], 'refused', ['DEFINITION_UNOBSERVED', 'REQUIRED_KIND_MISSING']);
add('ambiguous-endpoint', x => x.endpoints.push({ ...x.endpoints[1], id: 'goal2' }), 'refused', ['ENDPOINT_AMBIGUOUS']);
add('incomplete-inventory', x => x.observations[0].complete = false, 'partial', ['INVENTORY_INCOMPLETE']);
add('unknown-observed-version', x => delete x.observations[0].observedVersion, 'partial', ['OBSERVED_VERSION_UNKNOWN']);
add('stale-observation-pin', x => editStamp(x, f => f.x_recipe.version = '0.0.1'), 'refused', ['FOREIGN_OR_DIVERGENT_STAMP']);
add('incomplete-missing-kind-remains-unknown', x => { x.observations[0].complete = false; x.observations[0].definitions = []; }, 'partial', ['REQUIRED_KIND_UNOBSERVED']);
add('unsupported-contract-version', x => x.schema = 'recipe-set-preflight/v2', 'refused', ['SCHEMA']);
add('unknown-requirement-operator', x => x.consumers[0].requirements[1].types = { score: 'number' }, 'partial', ['UNSUPPORTED_OPERATOR']);
add('empty-consumer-inventory-remains-unknown', x => { x.consumers = []; x.endpoints = []; }, 'partial', ['CONSUMER_REQUIREMENTS_UNKNOWN']);
add('duplicate-recipe-id-across-publishers', x => { const s = structuredClone(x.selected[0]); s.key = 'other-work'; s.publisher = 'other-publisher'; s.artifact.identity.publisher = 'other-publisher'; s.artifactDigest = digest(s.artifact); x.selected.push(s); }, 'refused', ['DUPLICATE_ID']);
add('harmless-core-excluded-order', x => editStamp(x, f => f.order = 99), 'valid');
add('unknown-stamp-rules', x => editStamp(x, f => f.x_recipe.digest_rules = 999), 'partial', ['STAMP_RULES_UNKNOWN']);
add('local-added-field-divergence', x => editStamp(x, f => f.fields.required.push('local_field')), 'refused', ['LOCAL_ADAPTATION']);
add('descriptor-pin-mismatch', () => { }, 'refused', ['DESCRIPTOR_DIGEST']);
cases.at(-1).input.consumers[0].descriptorDigest = 'sha256:' + '0'.repeat(64);
pinDescriptors(cases.find(c => c.id === 'consumer-contract-unknown').input);
add('empty-selected-set-remains-unknown', x => { x.selected = []; x.consumers = []; x.endpoints = []; x.observations = []; }, 'partial', ['SELECTED_SET_UNKNOWN']);
add('missing-extension-descriptor', x => { x.consumers = []; x.endpoints = []; }, 'partial', ['EXTENSION_CONSUMER_UNKNOWN']);
add('empty-extension-descriptor-remains-unknown', x => { x.consumers[0].requirements = []; x.endpoints = []; }, 'partial', ['EXTENSION_REQUIREMENTS_UNKNOWN']);
add('standalone-base-recipes-without-consumers', x => { x.selected = x.selected.filter(s => s.role === 'base'); x.observations = x.observations.filter(o => o.provider !== 'contribution'); x.consumers = []; x.endpoints = []; }, 'valid');
export { cases, base, recipe, refresh, pinDescriptors, editStamp };
export function addPlacementInventories(input) {
    input.placementInventories = [...new Set(input.observations.map(o => o.scope))].map(scope => {
        const observations = input.observations.filter(o => o.scope === scope);
        const qualified = observations[0];
        return { id: 'placement-' + scope, scope, ...(scope === 'local' ? {} : { bundleId: qualified.bundleId, expectedBundleId: qualified.expectedBundleId }), availability: 'available', complete: observations.every(o => o.complete), observedVersion: 'placement-v1', files: observations.flatMap(o => o.definitions.map(d => ({ path: d.id + '.md', bytes: d.bytes }))) };
    });
    return input;
}
