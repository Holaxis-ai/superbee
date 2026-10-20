import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectConsumerImpact } from './final-candidate-consumer-impact.mjs';

const run = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function put(root, file, bytes) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), bytes);
}
function commit(root) { run(root, 'add', '.'); run(root, 'commit', '-qm', 'fixture'); return run(root, 'rev-parse', 'HEAD'); }
function fixture(t, { core = '0.2.0-pre.23', plugin = core, devPin = false, blender = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'consumer-impact-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidateRoot = path.join(directory, 'candidate'), pluginRoot = path.join(directory, 'plugin');
  for (const root of [candidateRoot, pluginRoot]) {
    mkdirSync(root); run(root, 'init', '-q');
    run(root, 'config', 'user.name', 'Fixture'); run(root, 'config', 'user.email', 'fixture@example.invalid');
  }
  const producer = version => {
    put(candidateRoot, 'packages/core/package.json', json({ name: '@superbee/core', version }));
    put(candidateRoot, 'packages/superbee/package.json', json({ name: 'superbee', version: '0.4.3-pre.14' }));
    put(candidateRoot, 'packages/core/src/source-profiles/index.ts', `export const SOURCE_PLUGIN_CORE_VERSION = "${version}";\n`);
    return commit(candidateRoot);
  };
  const pkg = { name: '@superbee/integration-github', version: '0.1.0-pre.1', private: true,
    superbeeIntegration: { contract: 1, id: 'github', core: plugin }, peerDependencies: { '@superbee/core': plugin } };
  const root = { private: true, devDependencies: devPin ? { '@superbee/core': plugin } : {} };
  put(pluginRoot, 'integrations/github/package.json', json(pkg));
  put(pluginRoot, 'package.json', json(root));
  put(pluginRoot, 'package-lock.json', json({ lockfileVersion: 3, packages: { '': root,
    'integrations/github': { peerDependencies: pkg.peerDependencies } } }));
  put(pluginRoot, '.github/workflows/ci.yml', `steps:\n  - run: npm install --no-save --package-lock=false --ignore-scripts @superbee/core@${plugin}\n  - run: npm test\n`);
  put(pluginRoot, 'scripts/package-contract.test.mjs', `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport {readFile} from 'node:fs/promises';\nconst readJson = async file => JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'));\nconst pkg = await readJson('../integrations/github/package.json');\nassert.deepEqual(pkg.peerDependencies,{'@superbee/core':'${plugin}'});\n`);
  if (blender) put(pluginRoot, 'integrations/blender/package.json', json({name:'@superbee/integration-blender',private:true,superbeeLocalOperations:{contract:1,id:'blender',core:plugin,helper:1,entry:'dist/operation.mjs',assets:['assets/capture.py','assets/compare.py']}}));
  const args = { candidateRoot, candidateSha: producer(core), pluginRoot, pluginSha: commit(pluginRoot) };
  function archive({ sha = args.candidateSha, abi = core, version = '0.4.3-pre.14', identity = true, coreOnly = false, name = 'fixture.tgz' } = {}) {
    const contents = path.join(directory, name + '-contents');
    put(contents, 'package/package.json', json({ name: coreOnly ? '@superbee/core' : 'superbee', version: coreOnly ? abi : version }));
    if (!coreOnly) put(contents, 'package/dist/superbee.mjs', `var SOURCE_PLUGIN_CORE_VERSION = "${abi}";\n${identity ? `define_SUPERBEE_BUILD_IDENTITY_default = { schema: "superbee.build-identity.v1", package: { name: "superbee", version: "${version}" }, source: { commit: "${sha}", dirty: false }, artifact: { channel: "npm-package" }, compatibility_contracts: { skill: 1, hook: 1, mcp: 1 } };\n` : ''}`);
    const tarball = path.join(directory, name);
    execFileSync('tar', ['-czf', tarball, '-C', contents, 'package/package.json', ...coreOnly ? [] : ['package/dist/superbee.mjs']]);
    return tarball;
  }
  return { args, producer, archive, directory };
}

test('existing compatible path needs no proposal or archive execution', t => {
  const { args } = fixture(t);
  const report = inspectConsumerImpact(args);
  assert.equal(report.status, 'compatible');
  assert.deepEqual(report.proposal.files, []);
  assert.deepEqual(report.archives, {});
  assert.equal(report.candidate.source_sha, args.candidateSha);
});

test('queue composition changes Core without changing CLI version; exact companion proposal repairs every expectation', t => {
  const { args, producer, archive } = fixture(t, { devPin: true });
  const before = inspectConsumerImpact(args);
  args.candidateSha = producer('0.2.0-pre.24');
  const report = inspectConsumerImpact(args);
  assert.equal(report.candidate.cli, before.candidate.cli);
  assert.equal(report.status, 'companion-update-required');
  assert.equal(report.proposal.changes.length, 7);
  assert.notEqual(report.proposal.key, before.proposal.key);
  assert.deepEqual(report, inspectConsumerImpact(args), 'proposals are deterministic and read-only');
  for (const change of report.proposal.changes) assert.equal(change.expected, '0.2.0-pre.24');
  for (const row of report.proposal.files) {
    assert.match(row.expected_sha256, /^sha256:[a-f0-9]{64}$/);
    put(args.pluginRoot, row.file, row.content);
  }
  args.pluginSha = commit(args.pluginRoot);
  const repaired = inspectConsumerImpact({ ...args, cliTarball: archive({ abi: '0.2.0-pre.24' }), coreTarball: archive({ abi: '0.2.0-pre.24', coreOnly: true, name: 'core.tgz' }) });
  assert.equal(repaired.status, 'compatible');
  assert.deepEqual(repaired.proposal.files, []);
});

test('old source or plugin SHA and tracked dirty checkouts are refused', t => {
  const { args, producer } = fixture(t);
  producer('0.2.0-pre.24');
  assert.throws(() => inspectConsumerImpact(args), /checkout changed/);
  args.candidateSha = run(args.candidateRoot, 'rev-parse', 'HEAD');
  put(args.pluginRoot, 'package.json', json({ private: true }));
  assert.throws(() => inspectConsumerImpact(args), /tracked checkout changes/);
  commit(args.pluginRoot);
  assert.throws(() => inspectConsumerImpact(args), /checkout changed/);
});

test('same-version final candidate change invalidates the prior archive binding', t => {
  const { args, archive, producer } = fixture(t);
  const cliTarball = archive();
  assert.equal(inspectConsumerImpact({ ...args, cliTarball }).status, 'compatible');
  put(args.candidateRoot, 'unrelated.txt', 'queue composition changed');
  args.candidateSha = commit(args.candidateRoot);
  assert.throws(() => inspectConsumerImpact({ ...args, cliTarball }), /packed CLI source changed/);
  args.candidateSha = producer('0.2.0-pre.24');
  const newArchive = archive({ sha: args.candidateSha, abi: '0.2.0-pre.24', name: 'new.tgz' });
  const report = inspectConsumerImpact({ ...args, cliTarball: newArchive });
  assert.equal(report.status, 'companion-update-required');
  assert.equal(report.archives.cli.core, '0.2.0-pre.24');
});

test('archive mode binds literal bytes, source, version and embedded Core ABI', t => {
  const { args, archive } = fixture(t);
  const cliTarball = archive(), coreTarball = archive({ coreOnly: true, name: 'core.tgz' });
  const report = inspectConsumerImpact({ ...args, cliTarball, coreTarball });
  assert.equal(report.status, 'compatible');
  for (const row of Object.values(report.archives)) assert.match(row.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.archives.cli.source_sha, args.candidateSha);
  for (const [options, expected] of [[{ abi: '0.2.0-pre.24' }, /packed CLI Core ABI differs/], [{ identity: false }, /packed CLI build identity/], [{ sha: 'a'.repeat(40) }, /packed CLI source changed/], [{ version: '9.9.9' }, /strictly equal/]]) {
    assert.throws(() => inspectConsumerImpact({ ...args, cliTarball: archive(options) }), expected);
  }
  assert.throws(() => inspectConsumerImpact({ ...args, coreTarball: archive({ coreOnly: true, abi: '9.9.9' }) }), /strictly equal/);
});

test('archive input refuses symlinks and nonregular files before reading bytes', t => {
  const { args, archive, directory } = fixture(t);
  const target = archive();
  const alias = path.join(directory, 'alias.tgz');
  symlinkSync(target, alias);
  assert.throws(() => inspectConsumerImpact({ ...args, cliTarball: alias }), /ELOOP/);
  assert.throws(() => inspectConsumerImpact({ ...args, cliTarball: directory }), /regular file/);
});

for (const [label, file, mutate, expected] of [
  ['widened peer', 'integrations/github/package.json', text => text.replace('"@superbee/core": "0.2.0-pre.23"', '"@superbee/core": "^0.2.0"'), /ranges are not the plugin ABI/],
  ['missing CI expectation', '.github/workflows/ci.yml', () => 'steps: []\n', /plugin CI Core install/],
  ['duplicate CI target', '.github/workflows/ci.yml', text => text + text, /plugin CI Core install/],
  ['missing assertion', 'scripts/package-contract.test.mjs', () => '', /plugin exact peer assertion/],
  ['missing lock projection', 'package-lock.json', text => text.replace('peerDependencies', 'other'), /expected one exact version/],
  ['publication enabled', 'integrations/github/package.json', text => text.replace('"private": true', '"private": false'), /Git checkout distribution/],
  ['installed registry lock needs verified integrity', 'package-lock.json', text => text.replace('"packages": {', '"packages": {"node_modules/@superbee/core":{"version":"0.2.0-pre.23","integrity":"sha512-unverified"},'), /registry-verified lock update/],
  ['orphaned root development pin', 'package-lock.json', text => text.replace('"devDependencies": {}', '"devDependencies": {"@superbee/core":"0.2.0-pre.22"}'), /orphaned Core development pin/],
  ['orphaned plugin development pin', 'package-lock.json', text => text.replace('"integrations/github": {', '"integrations/github": {"devDependencies":{"@superbee/core":"0.2.0-pre.22"},'), /orphaned Core development pin/],
  ['orphaned runtime Core pin', 'package-lock.json', text => text.replace('"integrations/github": {', '"integrations/github": {"dependencies":{"@superbee/core":"0.2.0-pre.22"},'), /runtime Core dependency/],
]) test(`unsupported consumer shape refuses an automatic proposal: ${label}`, t => {
  const { args } = fixture(t);
  put(args.pluginRoot, file, mutate(readFileSync(path.join(args.pluginRoot, file), 'utf8')));
  args.pluginSha = commit(args.pluginRoot);
  assert.throws(() => inspectConsumerImpact(args), expected);
});

test('command reports compatible, impact and invalid evidence with distinct exit codes', t => {
  const { args, producer } = fixture(t);
  const script = path.join(import.meta.dirname, 'final-candidate-consumer-impact.mjs');
  const execute = () => spawnSync(process.execPath, [script, '--candidate', args.candidateRoot, '--candidate-sha', args.candidateSha, '--plugin', args.pluginRoot, '--plugin-sha', args.pluginSha], { encoding: 'utf8' });
  assert.equal(execute().status, 0);
  args.candidateSha = producer('0.2.0-pre.24');
  const impact = execute();
  assert.equal(impact.status, 1); assert.equal(JSON.parse(impact.stdout).status, 'companion-update-required');
  args.candidateSha = 'HEAD';
  assert.equal(execute().status, 2);
});


test('Blender and GitHub share one proposal, exact old-byte preconditions and combined test replacement', t => {
  const { args, producer } = fixture(t, { blender: true });
  args.candidateSha = producer('0.2.0-pre.24');
  const report = inspectConsumerImpact(args);
  assert.equal(report.expectations.find(row => row.field === 'Blender exact Core assertion').actual, null);
  const testRows = report.proposal.files.filter(row => row.file === 'scripts/package-contract.test.mjs');
  assert.equal(testRows.length, 1);
  assert.ok(testRows[0].content.includes("pkg.peerDependencies,{'@superbee/core':'0.2.0-pre.24'}"));
  assert.ok(testRows[0].content.includes("blender.superbeeLocalOperations.core,'0.2.0-pre.24'"));
  for (const row of report.proposal.files) {
    const actual = `sha256:${createHash('sha256').update(readFileSync(path.join(args.pluginRoot,row.file))).digest('hex')}`;
    assert.equal(row.expected_sha256, actual);
    put(args.pluginRoot,row.file,row.content);
  }
  args.pluginSha = commit(args.pluginRoot);
  assert.equal(inspectConsumerImpact(args).status,'compatible');
  const check = spawnSync(process.execPath,['--test',path.join(args.pluginRoot,'scripts/package-contract.test.mjs')],{encoding:'utf8'});
  assert.equal(check.status,0,check.stderr+check.stdout);
  args.candidateSha = producer('0.2.0-pre.25');
  const next = inspectConsumerImpact(args);
  assert.equal(next.proposal.files.filter(row => row.file === 'scripts/package-contract.test.mjs').length,1);
  for (const row of next.proposal.files) put(args.pluginRoot,row.file,row.content);
  args.pluginSha = commit(args.pluginRoot);
  assert.equal(inspectConsumerImpact(args).status,'compatible');
});

test('same-version Blender manifest still requires the missing assertion, without unrelated file edits', t => {
  const {args} = fixture(t,{blender:true});
  const report = inspectConsumerImpact(args);
  assert.deepEqual(report.proposal.files.map(row => row.file),['scripts/package-contract.test.mjs']);
});

for (const [label,mutate,expected] of [
  ['range', p => {p.superbeeLocalOperations.core='^0.2.0';}, /ranges are not the plugin ABI/],
  ['missing exact pin', p => {delete p.superbeeLocalOperations.core;}, /expected one exact version/],
  ['helper drift', p => {p.superbeeLocalOperations.helper=2;}, /strictly equal/],
  ['entry drift', p => {p.superbeeLocalOperations.entry='other.mjs';}, /strictly equal/],
  ['asset closure drift', p => {p.superbeeLocalOperations.assets.push('other.py');}, /deep-equal/],
  ['publication', p => {p.private=false;}, /Git checkout distribution/],
  ['dependency policy', p => {p.peerDependencies={'@superbee/core':'0.2.0-pre.23'};}, /reviewed consumer policy/],
]) test(`present Blender metadata cannot be silently omitted: ${label}`,t => {
  const {args} = fixture(t,{blender:true});
  const file='integrations/blender/package.json';
  const pkg=JSON.parse(readFileSync(path.join(args.pluginRoot,file),'utf8'));
  mutate(pkg); put(args.pluginRoot,file,json(pkg)); args.pluginSha=commit(args.pluginRoot);
  assert.throws(() => inspectConsumerImpact(args),expected);
});

test('unrecognized or duplicate Blender assertion refuses rather than appending an unchecked assertion', t => {
  const {args} = fixture(t,{blender:true});
  const file='scripts/package-contract.test.mjs';
  const original=readFileSync(path.join(args.pluginRoot,file),'utf8');
  put(args.pluginRoot,file,original+"assert.equal(blender.superbeeLocalOperations.core, '0.2.0-pre.23');\n");
  args.pluginSha=commit(args.pluginRoot);
  assert.throws(() => inspectConsumerImpact(args),/unsupported Blender assertion/);
  put(args.pluginRoot,file,original); args.pluginSha=commit(args.pluginRoot);
  const proposed=inspectConsumerImpact(args).proposal.files.find(row => row.file===file).content;
  put(args.pluginRoot,file,proposed+proposed.slice(proposed.indexOf("test('Blender"))); args.pluginSha=commit(args.pluginRoot);
  assert.throws(() => inspectConsumerImpact(args),/Blender exact Core assertion/);
});
