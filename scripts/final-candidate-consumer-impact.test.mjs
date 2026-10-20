import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
function fixture(t, { core = '0.2.0-pre.23', plugin = core, devPin = false } = {}) {
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
  put(pluginRoot, 'scripts/package-contract.test.mjs', `assert.deepEqual(pkg.peerDependencies,{'@superbee/core':'${plugin}'});\n`);
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

for (const [label, file, mutate, expected] of [
  ['widened peer', 'integrations/github/package.json', text => text.replace('"@superbee/core": "0.2.0-pre.23"', '"@superbee/core": "^0.2.0"'), /ranges are not the plugin ABI/],
  ['missing CI expectation', '.github/workflows/ci.yml', () => 'steps: []\n', /plugin CI Core install/],
  ['duplicate CI target', '.github/workflows/ci.yml', text => text + text, /plugin CI Core install/],
  ['missing assertion', 'scripts/package-contract.test.mjs', () => '', /plugin exact peer assertion/],
  ['missing lock projection', 'package-lock.json', text => text.replace('peerDependencies', 'other'), /expected one exact version/],
  ['publication enabled', 'integrations/github/package.json', text => text.replace('"private": true', '"private": false'), /Git checkout distribution/],
  ['installed registry lock needs verified integrity', 'package-lock.json', text => text.replace('"packages": {', '"packages": {"node_modules/@superbee/core":{"version":"0.2.0-pre.23","integrity":"sha512-unverified"},'), /registry-verified lock update/],
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
