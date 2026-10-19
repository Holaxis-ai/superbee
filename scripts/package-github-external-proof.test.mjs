import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {build} from 'esbuild';
import {init, parse} from 'es-module-lexer';
import ts from 'typescript';
const root = fileURLToPath(new URL('../',import.meta.url));
const exec = promisify(execFile);

export function assertStandaloneModule(source) {
  const [imports] = parse(source);
  assert.deepEqual(imports, [], 'standalone artifact must have no static/dynamic imports, import.meta or import-bearing re-exports');
}

test('standalone proof rejects static, dynamic and re-export imports', async () => {
  await init;
  for (const source of ['import "x";', 'export {x} from "x";', 'export * from "x";', 'const x = import("x");']) assert.throws(() => assertStandaloneModule(source));
  assertStandaloneModule('export const createSourceProfile = helpers => helpers.restJsonProfile;');
});

// A regression fence for reviewed adapter code; not a sandbox or malicious-code detector.
function sourceBoundary(source) {
  const file = ts.createSourceFile('profile.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const problems = [];
  const ambient = new Set(['fetch','process','globalThis','require','eval','Function','WebSocket','XMLHttpRequest','Deno','Bun','window','self','navigator']);
  function visit(node) {
    if (ts.isImportDeclaration(node) && (!node.importClause?.isTypeOnly || !node.moduleSpecifier.text.startsWith('@superbee/core/'))) problems.push('type-only public Core imports required');
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) problems.push('runtime re-export');
    if (ts.isIdentifier(node) && ambient.has(node.text)) problems.push('ambient '+node.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push('dynamic import');
    ts.forEachChild(node,visit);
  }
  visit(file); return problems;
}
test('GitHub source uses only public Core type imports and injected runtime helpers', async () => {
  assert.deepEqual(sourceBoundary(await readFile(path.join(root,'packages/integration-github/src/profile.ts'),'utf8')),[]);
  for (const source of ['import {restJsonProfile} from "@superbee/core/source-profiles";', 'const x = import("x");', 'fetch("x");', 'process.env.TOKEN;', 'const x = eval("1");']) assert.notDeepEqual(sourceBoundary(source),[]);
});

test('packed GitHub factory, recipes, browser and public harness work outside checkout', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(),'superbee-github-consumer-'));
  const run = (command,args,cwd=scratch) => exec(command,args,{cwd,maxBuffer:10*1024*1024,env:{...process.env,NODE_PATH:''}});
  const npm = (args,cwd=scratch) => {
    assert.ok(process.env.npm_execpath,'run with npm exec or npm run test:scripts');
    return run(process.execPath,[process.env.npm_execpath,...args],cwd);
  };
  try {
    const artifacts = path.join(scratch,'artifacts'); await mkdir(artifacts);
    const packed = {};
    for (const name of ['core','integration-github']) {
      const {stdout} = await npm(['pack','-w',`@superbee/${name}`,'--json','--pack-destination',artifacts],root);
      const [receipt] = JSON.parse(stdout); packed[name] = {receipt,tarball:path.join(artifacts,receipt.filename)};
    }
    const receipt = packed['integration-github'].receipt;
    for (const file of receipt.files) assert.ok(file.path === 'package.json' || file.path === 'README.md' || file.path === 'PROFILE.md' || /^(dist|recipes|fixtures)\//.test(file.path), `unexpected packed file ${file.path}`);
    const executable = receipt.files.map(row=>row.path).filter(file=>/\.(mjs|cjs|js)$/.test(file));
    assert.deepEqual(executable.sort(),['dist/profile.mjs','dist/recipes.mjs']);
    await writeFile(path.join(scratch,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@superbee/core':`file:${packed.core.tarball}`,'@superbee/integration-github':`file:${packed['integration-github'].tarball}`}}));
    await npm(['install','--ignore-scripts','--no-audit','--no-fund','--prefer-offline']);
    const lock = JSON.parse(await readFile(path.join(scratch,'package-lock.json'),'utf8'));
    for (const [name,row] of Object.entries(lock.packages)) {
      assert.ok(!row.link,`workspace link ${name}`);
      if (name.startsWith('node_modules/@superbee/')) assert.ok(['node_modules/@superbee/core','node_modules/@superbee/integration-github'].includes(name));
    }
    const installed = path.join(scratch,'node_modules/@superbee/integration-github');
    assert.equal(await realpath(installed),path.join(await realpath(scratch),'node_modules/@superbee/integration-github'));
    const manifest = JSON.parse(await readFile(path.join(installed,'package.json'),'utf8'));
    const sourceManifest = JSON.parse(await readFile(path.join(root,'packages/integration-github/package.json'),'utf8'));
    assert.deepEqual(manifest,sourceManifest);
    assert.deepEqual(manifest.superbeeIntegration,{contract:1,id:'github',core:JSON.parse(await readFile(path.join(root,'packages/core/package.json'),'utf8')).version,profiles:[{id:'github-issues',version:1,entry:'dist/profile.mjs'}],recipes:{'source-feeds':'recipes/source-feeds','work-items':'recipes/work-items'}});
    assert.equal(manifest.dependencies,undefined);
    assert.deepEqual(manifest.peerDependenciesMeta,{'@superbee/core':{optional:true}});
    assert.match(manifest.scripts.prepublishOnly,/process\.exit\(1\)/);
    await init;
    assertStandaloneModule(await readFile(path.join(installed,'dist/profile.mjs'),'utf8'));
    // Compare actual packed inert files to the canonical source inputs, not a second authored copy.
    async function agreement(name,relative='') {
      const source = path.join(root,'examples/recipes',name,relative);
      for (const entry of await readdir(source,{withFileTypes:true})) {
        const file = path.join(relative,entry.name);
        if (entry.isDirectory()) await agreement(name,file);
        else assert.deepEqual(await readFile(path.join(installed,'recipes',name,file)),await readFile(path.join(source,entry.name)));
      }
    }
    for (const id of ['source-feeds','work-items']) await agreement(id);
    await writeFile(path.join(scratch,'consumer.mjs'),consumer);
    await run(process.execPath,['consumer.mjs']);
    await writeFile(path.join(scratch,'consumer.ts'),`import {createSourceProfile} from '@superbee/integration-github';\nimport {recipeFiles} from '@superbee/integration-github/recipes';\nimport {restJsonProfile,nextLinkTarget,type SourcePluginHelpers} from '@superbee/core/source-profiles';\nimport {unsupportedContent,type SourceProfile} from '@superbee/core/source-engine';\nconst helpers: SourcePluginHelpers = {restJsonProfile,nextLinkTarget,unsupportedContent};\nexport const profile: SourceProfile<any,any> = createSourceProfile(helpers);\nexport const files = recipeFiles('work-items');\n`);
    await writeFile(path.join(scratch,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:true,noEmit:true,types:[]},include:['consumer.ts']}));
    await run(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json']);
    const browser = await build({absWorkingDir:scratch,stdin:{contents:`export * from '@superbee/integration-github'; export * from '@superbee/integration-github/profile'; export * from '@superbee/integration-github/recipes';`,resolveDir:scratch},bundle:true,platform:'browser',write:false,logLevel:'silent',metafile:true});
    assert.equal(browser.errors.length,0);
    assert.ok(browser.outputFiles[0].text.includes('createSourceProfile'));
    assert.ok(Object.keys(browser.metafile.inputs).every(file=>file === '<stdin>' || file.startsWith('node_modules/@superbee/integration-github/')),'browser plugin graph has no runtime Core or Node dependency');
  } finally { await rm(scratch,{recursive:true,force:true}); }
});

const consumer = String.raw`
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MemoryBackend,loadKinds} from '@superbee/core';
import {parseConnectorDoc} from '@superbee/core/connectors';
import {parseRecipeFiles} from '@superbee/core/recipes';
import {installRecipe} from '@superbee/core/recipe-lifecycle';
import {restJsonProfile,nextLinkTarget,getSourceProfile,SOURCE_PLUGIN_CORE_VERSION} from '@superbee/core/source-profiles';
import {unsupportedContent} from '@superbee/core/source-engine';
import {runSourceScenario,checkScenario} from '@superbee/core/source-harness';
import {createSourceProfile,normalizeGithubIssue,uncoveredGithubFields} from '@superbee/integration-github';
import {createSourceProfile as sameFactory} from '@superbee/integration-github/profile';
import {recipeFiles} from '@superbee/integration-github/recipes';
assert.equal(createSourceProfile,sameFactory);
assert.equal(getSourceProfile('github-issues'),undefined);
const helpers = Object.freeze({restJsonProfile,nextLinkTarget,unsupportedContent});
const profile = createSourceProfile(helpers);
assert.equal(profile.id,'github-issues'); assert.equal(profile.version,1); assert.equal(profile.kind,'extension');
const fixture = JSON.parse(await readFile(new URL('./node_modules/@superbee/integration-github/fixtures/repository-issues.json',import.meta.url),'utf8'));
const [issue,second] = fixture.issues;
assert.deepEqual(uncoveredGithubFields(issue),[]);
const normalized = normalizeGithubIssue(issue,{owner:'example-org',repo:'widgets'},helpers);
assert.deepEqual(normalized.labels,['bug','help wanted']);
assert.deepEqual(normalized.assignees,['github:octocat','github:zebra']);
assert.equal(normalized.body,undefined);
const backend = new MemoryBackend();
await backend.writeReserved('','index.md',"---\nokf_version: '0.2'\n---\n");
const bundle = {root:'memory://packed-consumer',backend};
for (const id of ['source-feeds','work-items']) {
  const files = recipeFiles(id), pristine = recipeFiles(id);
  files[0].bytes = 'mutated'; assert.deepEqual(recipeFiles(id),pristine);
  const parsed = parseRecipeFiles(pristine,'packed:'+id,{okfVersion:'0.2'}); assert.ok(parsed.ok);
  await installRecipe(bundle,parsed.recipe,{now:'2026-10-19T00:00:00Z'});
}
const registry = await loadKinds(bundle);
const parsed = parseConnectorDoc((await backend.read('connectors/github')).doc,{kinds:registry}); assert.ok(parsed.ok);
const connector = parsed.connector;
const resource = 'https://github.com/example-org/widgets';
const feed = 'source-feeds/widgets';
await backend.write(feed,{id:feed,body:'',frontmatter:{type:'Source Feed',title:'Packed issues',feed_kind:'connector',connector:connector.id,source:'issues',url:resource,owned_fields:Object.keys(connector.sources[0].fields),target_kind:'Work Item',missing_threshold:2}});
const url = 'https://api.github.com/repos/example-org/widgets/issues?state=all&sort=updated&direction=asc&per_page=100';
async function execute(rows,headers={}) {
  const documents = await Promise.all((await backend.list()).map(async id=>(await backend.read(id)).doc));
  return runSourceScenario({connector,profile,spec:connector.sources[0],feed,documents},{name:'packed.observation',runs:[{mode:'complete',exchanges:rows.map((body,index)=>({request:{url:index?url+'&page=2':url},response:{status:200,body:JSON.stringify(body),headers:index?{}:headers}}))}]});
}
let result = await execute([[issue,{...issue,pull_request:{}}],[second]],{link:'<'+url+'&page=2>; rel="next"'});
assert.deepEqual(checkScenario(result),[]);
let run = result.runs[0];
assert.equal(run.receipt.outcome,'observed'); assert.equal(run.receipt.pages,2); assert.equal(run.receipt.changes.new,2);
assert.ok(run.receipt.profile_diagnostics.some(row=>row.code==='PULL_REQUEST_SKIPPED'));
assert.equal(Object.values(run.documents).filter(row=>row.type==='Signal').length,2);
assert.equal(Object.values(run.documents).filter(row=>row.type==='Work Item').length,0);
const adopted = 'work-items/issue-42';
await backend.write(adopted,{id:adopted,body:'Human notes',frontmatter:{type:'Work Item',title:'Human diagnosis',labels:['human-label'],sources:[{resource,id:issue.node_id}]}});
result = await execute([[issue]]); run = result.runs[0];
assert.equal(run.documents[adopted].title,'Human diagnosis'); assert.deepEqual(run.documents[adopted].labels,['human-label']);
assert.equal(run.documents[adopted].key,'example-org/widgets#42');
result = await execute([[{...issue,repository_url:'https://api.github.com/repos/other/widgets'}]]);
assert.equal(result.runs[0].receipt.outcome,'unsupported_content');
result = await execute([[issue]],{link:'<https://api.github.com/repos/other/widgets/issues?page=2>; rel="next"'});
assert.equal(result.runs[0].receipt.outcome,'refused'); assert.equal(result.runs[0].received.length,1);
assert.equal(SOURCE_PLUGIN_CORE_VERSION,JSON.parse(await readFile('./node_modules/@superbee/core/package.json','utf8')).version);
`;
