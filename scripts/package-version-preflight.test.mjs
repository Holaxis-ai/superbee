import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPackageVersions, peerAdmits } from './package-version-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['packages/core/package.json', 'packages/server/package.json', 'packages/markdown-renderer/package.json', 'package-lock.json'];
function fixture(t, mutate = () => {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'superbee-version-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const docs = Object.fromEntries(files.map(file => [file, JSON.parse(readFileSync(path.join(root, file), 'utf8'))]));
  mutate(docs);
  for (const [file, value] of Object.entries(docs)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), JSON.stringify(value));
  }
  return directory;
}

test('source preflight succeeds without dependencies, build outputs or network', t => {
  assert.deepEqual(checkPackageVersions(fixture(t)), []);
});

test('a coherent future pair and independent renderer version need no validator edits', t => {
  const directory = fixture(t, d => {
    for (const name of ['core', 'server', 'markdown-renderer']) {
      d[`packages/${name}/package.json`].version = name === 'markdown-renderer' ? '3.1.0' : '9.0.0-pre.3';
      d['package-lock.json'].packages[`packages/${name}`].version = d[`packages/${name}/package.json`].version;
    }
    d['packages/server/package.json'].dependencies['@superbee/core'] = d['packages/core/package.json'].version;
    d['package-lock.json'].packages['packages/server'].dependencies = d['packages/server/package.json'].dependencies;
    d['packages/markdown-renderer/package.json'].peerDependencies['@superbee/core'] = d['packages/core/package.json'].version;
    d['package-lock.json'].packages['packages/markdown-renderer'].peerDependencies = d['packages/markdown-renderer/package.json'].peerDependencies;
  });
  assert.deepEqual(checkPackageVersions(directory), []);
});

for (const [label, mutate, expected] of [
  ['private package', d => { d['packages/core/package.json'].private = true; }, /core\/package.json private: expected publishable/],
  ['publish access drift', d => { d['packages/markdown-renderer/package.json'].publishConfig.access = 'public'; }, /publishConfig.access:.*expected "restricted"/],
  ['missing registry', d => { delete d['packages/core/package.json'].publishConfig.registry; }, /publishConfig.registry: found missing/],
  ['stale optional peer metadata', d => { d['packages/markdown-renderer/package.json'].peerDependenciesMeta = { '@superbee/core': { optional: true } }; }, /markdown-renderer.peerDependenciesMeta: found missing/],
  ['divergent pair', d => { d['packages/server/package.json'].version = '9.0.0'; }, /packages\/server\/package.json version:.*from packages\/core\/package.json/],
  ['stale exact dependency', d => { d['packages/server/package.json'].dependencies['@superbee/core'] = '*'; }, /dependencies.@superbee\/core:.*exact synchronized dependency/],
  ['missing dependency', d => { delete d['packages/server/package.json'].dependencies; }, /dependencies.@superbee\/core: found missing/],
  ['missing peer', d => { delete d['packages/markdown-renderer/package.json'].peerDependencies['@superbee/core']; }, /peerDependencies.@superbee\/core: missing must admit/],
  ['stale peer', d => { d['packages/markdown-renderer/package.json'].peerDependencies['@superbee/core'] = '^0.0.1'; }, /must admit.*from packages\/core\/package.json/],
  ['malformed version', d => { d['packages/core/package.json'].version = '01.2.3'; }, /core\/package.json version: expected/],
  ['missing version', d => { delete d['packages/core/package.json'].version; }, /core\/package.json version: expected/],
  ['missing workspace', d => { delete d['package-lock.json'].packages['packages/server']; }, /missing workspace record/],
  ['stale lock version', d => { d['package-lock.json'].packages['packages/core'].version = '9.0.0'; }, /packages\/core.version:.*from packages\/core\/package.json/],
  ['stale lock peer', d => { d['package-lock.json'].packages['packages/markdown-renderer'].peerDependencies['@superbee/core'] = '*'; }, /packages\/markdown-renderer.peerDependencies:.*from packages\/markdown-renderer\/package.json/],
  ['stale lock dependency', d => { d['package-lock.json'].packages['packages/server'].dependencies['@superbee/core'] = '*'; }, /packages\/server.dependencies:.*from packages\/server\/package.json/],
  ['missing link', d => { delete d['package-lock.json'].packages['node_modules/@superbee/core']; }, /node_modules\/@superbee\/core.link: found missing/],
  ['stale link', d => { d['package-lock.json'].packages['node_modules/@superbee/core'].resolved = 'packages/server'; }, /core.resolved:.*from packages\/core\/package.json/],
  ['non-link', d => { d['package-lock.json'].packages['node_modules/@superbee/core'].link = false; }, /core.link: found false/],
]) test(label, t => assert.match(checkPackageVersions(fixture(t, mutate)).join('\n'), expected));

test('direct runner refuses unexpected arguments', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/package-version-preflight.mjs'), '--fix'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no arguments/);
});

test('missing and malformed JSON fail with a source file', t => {
  const directory = fixture(t);
  rmSync(path.join(directory, 'packages/core/package.json'));
  writeFileSync(path.join(directory, 'package-lock.json'), '{');
  const errors = checkPackageVersions(directory).join('\n');
  assert.match(errors, /packages\/core\/package.json: expected readable JSON/);
  assert.match(errors, /package-lock.json: expected readable JSON/);
});

test('peer policy bounds stable caret versions and requires exact prerelease opt-in', () => {
  for (const [version, range, expected] of [
    ['0.2.0-pre.3', '^0.2.0 || 0.2.0-pre.2', false],
    ['0.2.0-pre.3', '^0.1.3 || 0.2.0-pre.3', true],
    ['0.1.4', '^0.1.3', true], ['0.2.0', '^0.1.3', false],
    ['1.9.0', '^1.2.3', true], ['1.2.2', '^1.2.3', false], ['2.0.0', '^1.2.3', false],
    ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
    ['0.0.0', '^0.0.0', true], ['0.0.1', '^0.0.0', false],
    ['01.2.3', '1.2.3', false], ['1.2.3-pre.01', '1.2.3', false],
    ['1.2.3\n', '1.2.3', false],
  ]) assert.equal(peerAdmits(version, range), expected, `${version} / ${range}`);
  for (const range of ['*', '>=0.1.0', '^0.2.0-pre.1', '^01.2.3', '1.2.3-pre.01', '1.2.3 || ', '1.2.3+build'])
    assert.throws(() => peerAdmits('1.2.3', range), /supported peer policy/);
});
