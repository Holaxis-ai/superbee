import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { preflightRecipeSet, recipePreflightDigest } from '../src/recipe-set-preflight.js';
import { cases, base, refresh, pinDescriptors, addPlacementInventories } from './recipe-set-preflight-fixtures.mjs';
const copy = <T>(value: T): T => structuredClone(value);
const freeze = (value: any): any => { if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
} return value; };
for (const row of cases)
    test(`preflight matrix: ${row.id}`, async () => {
        const input = addPlacementInventories(copy(row.input));
        const before = JSON.stringify(input);
        const result = await preflightRecipeSet(freeze(input));
        assert.equal(result.verdict, row.expected.verdict, JSON.stringify(result.issues));
        for (const code of row.expected.codes)
            assert.ok(result.issues.some(i => i.code === code), code);
        assert.equal(result.structuralComplete, result.verdict === 'valid');
        assert.equal(result.externalConsumers, 'unknown-out-of-scope');
        assert.equal(JSON.stringify(input), before);
        assert.deepEqual(await preflightRecipeSet(input), result);
    });
const probe = async (change: (x: any) => void, verdict: string, code?: string) => {
    const input = addPlacementInventories(base());
    change(input);
    const result = await preflightRecipeSet(input);
    assert.equal(result.verdict, verdict, JSON.stringify(result.issues));
    if (code)
        assert.ok(result.issues.some(i => i.code === code), code);
    return result;
};
test('full placement evidence required separately from provider completeness', async () => {
    await probe(x => delete x.placementInventories, 'partial', 'PLACEMENT_INVENTORY_UNKNOWN');
    await probe(x => x.placementInventories[0].complete = false, 'partial', 'PLACEMENT_INVENTORY_INCOMPLETE');
    await probe(x => x.placementInventories[0].availability = 'unavailable', 'partial', 'PLACEMENT_INVENTORY_UNKNOWN');
    await probe(x => x.placementInventories[0].files.pop(), 'refused', 'PLACEMENT_DEFINITION_UNOBSERVED');
    await probe(x => x.placementInventories[0].files[0].bytes += 'changed', 'refused', 'INVENTORY_INCONSISTENT');
});
test('nonrecipe Kinds participate in collisions without acquiring recipe ownership', async () => {
    const local = { path: 'conventions/local.md', bytes: '---\ntype: Convention\ngoverns: Local Note\npath: local/\n---\n' };
    await probe(x => x.placementInventories[0].files.push(local), 'valid');
    await probe(x => x.placementInventories[0].files.push({ ...local, bytes: local.bytes.replace('Local Note', 'Work Item') }), 'refused', 'KIND_DUPLICATE_GOVERNS');
    await probe(x => x.placementInventories[0].files.push({ ...local, path: 'other/local.md', bytes: local.bytes.replace('Local Note', 'Work Item') }), 'valid');
    await probe(x => x.placementInventories[0].files.push({ ...local, bytes: '---\ntype: Convention\n---\n' }), 'refused', 'KIND_CONVENTION_MALFORMED');
});
test('shape validation refuses malformed data and preserves unsupported operator unknowns', async () => {
    for (const value of [null, [], {}, 42, { schema: 'recipe-set-preflight/v1', selected: null, consumers: [], endpoints: [], observations: [] }])
        assert.equal((await preflightRecipeSet(value)).verdict, 'refused');
    for (const change of [x => x.selected[0].artifact.files[0].path = '../escape', x => x.selected[0].role = 'mystery', x => x.consumers[0].requirements[0].required = 'yes', x => x.consumers[0].requirements[0].links = [{ label: 'x', target: null }], x => x.observations[0].definitions = [{ id: 'x', bytes: 42 }], x => x.placementInventories = [null], x => x.selected[0].artifact.identity = null, x => x.selected[0].artifact.files = null])
        await probe(change, 'refused', 'INPUT_SHAPE');
    for (const operator of ['type', 'vocabulary', 'cardinality', 'migration'])
        await probe(x => { x.consumers[0].requirements[0][operator] = { arbitrary: 'constraint' }; pinDescriptors(x); }, 'partial', 'UNSUPPORTED_OPERATOR');
    const cyclic: any = {};
    cyclic.self = cyclic;
    assert.equal((await preflightRecipeSet(cyclic)).verdict, 'refused');
});
test('exact digests use independent raw SHA256 pins and code-unit order', async () => {
    assert.equal(recipePreflightDigest('ä😀'), 'sha256:' + createHash('sha256').update('ä😀', 'utf8').digest('hex'));
    const input = { z: 1, 'ä': 2, files: [{ path: 'ä.md', bytes: 'ä' }, { path: 'z.md', bytes: 'z' }] };
    const canonical = '{"files":[{"bytes":"z","path":"z.md"},{"bytes":"ä","path":"ä.md"}],"z":1,"ä":2}';
    assert.equal(recipePreflightDigest(input), 'sha256:' + createHash('sha256').update(canonical).digest('hex'));
    assert.equal(recipePreflightDigest({ ...input, files: input.files.toReversed() }), recipePreflightDigest(input));
    for (const locale of ['en_US.UTF-8', 'sv_SE.UTF-8']) {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {recipePreflightDigest} from './packages/core/dist/recipe-set-preflight.js'; console.log(recipePreflightDigest(${JSON.stringify(input)}));`], { cwd: new URL('../../..', import.meta.url), env: { ...process.env, LANG: locale, LC_ALL: locale }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), recipePreflightDigest(input));
    }
});
test('diagnostics fail closed for unapplied manifest semantics', async () => {
    await probe(x => { x.selected[0].artifact.files[0].bytes = x.selected[0].artifact.files[0].bytes.replace('---\nIndependent', 'requires: [unknown]\n---\nIndependent'); refresh(x, 'work'); addPlacementInventories(x); }, 'partial', 'MANIFEST_SEMANTICS_NOT_APPLIED');
});
test('complete placement contradiction cannot hide behind missing provider evidence', async () => {
    await probe(x => { x.observations[0].complete = false; x.observations[0].definitions = []; x.placementInventories[0].files[0].bytes = x.placementInventories[0].files[0].bytes.replace('id: work', 'id: foreign'); }, 'refused', 'FOREIGN_OR_DIVERGENT_STAMP');
    await probe(x => { x.endpoints[0].alias = 'unused'; }, 'refused', 'ENDPOINT_BINDING');
});
test('all selected asset classes retain their collision paths', async () => {
    const { parseRecipeFiles } = await import('../src/recipes.js');
    const { prepareRecipeInstall } = await import('../src/recipe-lifecycle/index.js');
    const { stringifyDoc } = await import('../src/frontmatter.js');
    const { CONNECTOR_MD } = await import('./fixtures/connectors/example-calendar.js');
    for (const asset of ['reference', 'registry', 'entry', 'connector']) {
        const selected: any[] = [], observations: any[] = [], files: any[] = [];
        for (const key of ['a', 'b']) {
            const kind = key === 'a' ? 'Event' : 'EventB';
            const manifest = `---\ntype: Recipe\nid: ${key}\ntitle: ${key}\nversion: '1'\nsummary: Synthetic assets\ncontent_policy: definitions-only\n${asset === 'reference' ? 'references: [references/shared.md]\n' : asset === 'connector' ? 'connectors: [connectors/shared.md]\n' : `pages:\n  - registry: views-registry/${asset === 'registry' ? 'shared' : key}.md\n    entry: views/${asset === 'entry' ? 'shared' : key}.html\n`}---\n`;
            const assetFiles = asset === 'reference' ? [{ path: 'references/shared.md', bytes: '---\ntype: Reference\ntitle: Shared\n---\n' }] : asset === 'connector' ? [{ path: 'connectors/shared.md', bytes: CONNECTOR_MD.replaceAll('Event', kind) }] : [{ path: `views-registry/${asset === 'registry' ? 'shared' : key}.md`, bytes: `---\ntype: View\ntitle: Shared\nentry: views/${asset === 'entry' ? 'shared' : key}.html\naccess: bundle-read\n---\n` }, { path: `views/${asset === 'entry' ? 'shared' : key}.html`, bytes: '<!doctype html><title>Synthetic</title>' }];
            const source = [{ path: 'recipe.md', bytes: manifest }, { path: `conventions/${key}.md`, bytes: `---\ntype: Convention\ngoverns: ${kind}\npath: ${key}/\nfields:\n  required: [title, start, event_status]\n  optional: [end, event_url, note, revision]\n---\n` }, ...assetFiles].map(f => ({ ...f, digest: recipePreflightDigest(f.bytes) }));
            const artifact = { identity: { publisher: 'synthetic-' + key, recipeId: key, release: '1' }, files: source };
            selected.push({ key, role: 'base', ...artifact.identity, artifact, artifactDigest: recipePreflightDigest(artifact) });
            const parsed = parseRecipeFiles(source, `${artifact.identity.publisher}/${key}@1`, { okfVersion: '0.2' });
            assert.ok(parsed.ok, JSON.stringify(parsed));
            if (!parsed.ok)
                continue;
            const prepared = prepareRecipeInstall(parsed.recipe, { okfVersion: '0.2', now: '1970-01-01T00:00:00.000Z' });
            const definitions = [...prepared.docs, ...prepared.references.map(r => r.doc), ...prepared.connectors.map(c => c.doc)].map(d => ({ id: d.id, bytes: stringifyDoc(d.frontmatter, d.body) }));
            observations.push({ id: key, provider: key, scope: 'local', availability: 'available', complete: true, observedVersion: 'v1', definitions });
            const ownFiles = [...definitions.map(d => ({ path: d.id + '.md', bytes: d.bytes })), ...prepared.pages.flatMap(p => [{ path: p.registry.id + '.md', bytes: stringifyDoc(p.registry.frontmatter, p.registry.body) }, { path: p.entry, bytes: p.html }])];
            const positive = await preflightRecipeSet({ schema: 'recipe-set-preflight/v1', selected: [selected.at(-1)], observations: [observations.at(-1)], consumers: [], endpoints: [], placementInventories: [{ id: 'local', scope: 'local', availability: 'available', complete: true, observedVersion: 'v1', files: ownFiles }] });
            assert.equal(positive.verdict, 'valid', asset + JSON.stringify(positive.issues));
            files.push(...ownFiles);
        }
        const result = await preflightRecipeSet({ schema: 'recipe-set-preflight/v1', selected, observations, consumers: [], endpoints: [], placementInventories: [{ id: 'local', scope: 'local', availability: 'available', complete: true, observedVersion: 'v1', files }] });
        assert.equal(result.verdict, 'refused', asset + JSON.stringify(result));
        assert.ok(result.issues.some(i => i.code === 'DEFINITION_ID_COLLISION'), asset + JSON.stringify(result.issues));
    }
});
test('endpoint check sensitivity: removing the owning refusal makes a known mismatch valid', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    const path = await import('node:path');
    const sourceUrl = new URL('../dist/recipe-set-preflight.js', import.meta.url);
    const source = readFileSync(sourceUrl, 'utf8');
    const mutant = source.replace(/issue\(['"]refused['"],\s*['"]LINK_TARGET_MISMATCH['"],/g, 'void(').replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_all, quote, specifier) => `from ${quote}${new URL(specifier, sourceUrl).href}${quote}`);
    assert.notEqual(mutant, source, 'control must change the owning check');
    const directory = await mkdtemp(path.join(tmpdir(), 'recipe-preflight-red-'));
    try {
        const file = path.join(directory, 'mutant.mjs');
        await writeFile(file, mutant);
        const changed = await import(pathToFileURL(file).href);
        const row = cases.find(c => c.id === 'endpoint-target-mismatch-with-clean-install');
        const input = addPlacementInventories(copy(row.input));
        assert.equal((await preflightRecipeSet(input)).verdict, 'refused');
        assert.equal((await changed.preflightRecipeSet(input)).verdict, 'valid');
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('repeated logical target with conflicting placements refuses rather than choosing first', async () => {
    await probe(x => { x.consumers[0].requirements.push({ ...x.consumers[0].requirements[1], id: 'goal-remote' }); x.endpoints.push({ id: 'goal-remote', consumer: 'contribution-app', requirement: 'goal-remote', placement: 'qualified', alias: 'leadership' }); pinDescriptors(x); }, 'refused', 'LINK_TARGET_AMBIGUOUS');
});

test('release identity requires an exact release rather than a range or moving tag', async()=>{
 for(const release of ['latest','next','^1.0.0','1.x','*','>=1.0.0','1 || 2'])await probe(x=>x.selected[0].release=release,'refused','INPUT_SHAPE');
});

test('hostile reflection fails closed without invoking getters',async()=>{
 let calls=0; const getter={get schema(){calls++;return 'recipe-set-preflight/v1';}};
 assert.equal((await preflightRecipeSet(getter)).verdict,'refused');assert.equal(calls,0);
 const throwing=new Proxy({}, {ownKeys(){throw Error('unavailable');}});
 assert.equal((await preflightRecipeSet(throwing)).verdict,'refused');
});

test('unsupported active model semantics remain partial while malformed declarations refuse',async()=>{
 await probe(x=>{x.placementInventories[0].files.push({path:'conventions/local.md',bytes:'---\ntype: Convention\ngoverns: Local\nfields:\n  optional: [score]\n  types: {score: future-type}\n---\n'});},'partial','KIND_CONVENTION_UNKNOWN_FIELD_TYPE');
});

test('ordinary readable records under the convention namespace are not active model declarations',async()=>{
 await probe(x=>x.placementInventories[0].files.push({path:'conventions/readme.md',bytes:'---\ntype: Reference\ntitle: Ordinary reference\n---\nReadable record.\n'}),'valid');
 await probe(x=>x.placementInventories[0].files.push({path:'conventions/bad.md',bytes:'---\ntype: Convention\nfields: [not-a-map]\n---\n'}),'refused','KIND_CONVENTION_MALFORMED');
 await probe(x=>x.placementInventories[0].files.push({path:'conventions/corrupt.md',bytes:'---\ntype: Convention\nbroken: [\n---\n'}),'refused','OBSERVATION_PARSE');
});
test('qualified source links remain unsupported while local sources can target qualified models',async()=>{
 assert.equal((await preflightRecipeSet(addPlacementInventories(base(true)))).verdict,'valid');
 const input=base();
 for(const observation of input.observations.filter(o=>o.provider!=='goal')){
  observation.scope='team';observation.bundleId='bnd_synthetic_team';observation.expectedBundleId='bnd_synthetic_team';
 }
 for(const endpoint of input.endpoints.filter(e=>e.requirement!=='goal')){endpoint.placement='qualified';endpoint.alias='team';}
 input.selected[2].artifact.files[1].bytes=input.selected[2].artifact.files[1].bytes.replace('work: Work Item','work: team:Work Item');
 refresh(input,'contribution');addPlacementInventories(input);
 const result=await preflightRecipeSet(input);
 assert.equal(result.verdict,'partial',JSON.stringify(result.issues));
 assert.ok(result.issues.some(i=>i.code==='SOURCE_QUALIFIED_LINKS_UNSUPPORTED'));
 assert.ok(!result.issues.some(i=>i.code==='LINK_TARGET_MISMATCH'));
 // A different spelling is also unknown in this unmodeled reference frame, never a claimed mismatch.
 input.selected[2].artifact.files[1].bytes=input.selected[2].artifact.files[1].bytes.replace('goal: Goal','goal: root:Goal');
 refresh(input,'contribution');addPlacementInventories(input);
 const changed=await preflightRecipeSet(input);
 assert.equal(changed.verdict,'partial',JSON.stringify(changed.issues));
 assert.ok(changed.issues.some(i=>i.code==='SOURCE_QUALIFIED_LINKS_UNSUPPORTED'));
 assert.ok(!changed.issues.some(i=>i.code==='LINK_TARGET_MISMATCH'));
});
