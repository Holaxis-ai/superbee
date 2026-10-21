import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('./install.mjs', import.meta.url));
const npmToken = 'fixture_npm_reader_123456';
const githubToken = `ghs_123456_${'a'.repeat(700)}.${'b'.repeat(100)}.fixture_signature`;
const options = { skip: process.platform === 'win32', timeout: 60_000 };

async function fixture(t, { failPreflight = false, invalidLock = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'authenticated-npm-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runner-temp'));
  const manifest = { name: 'private-install-fixture', version: '1.0.0', private: true,
    scripts: { 'ci:dependencies': 'node preflight.cjs', postinstall: 'node postinstall.cjs' },
    ...(invalidLock ? { dependencies: { 'missing-local-fixture': 'file:./missing-local-fixture' } } : {}) };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version,
    lockfileVersion: 3, requires: true, packages: { '': { name: manifest.name, version: manifest.version } } }));
  await writeFile(path.join(root, '.npmrc'), '# consumer-owned configuration\n');
  await writeFile(path.join(root, 'preflight.cjs'), `
const fs = require('node:fs');
const config = process.env.npm_config_userconfig;
fs.writeFileSync('preflight.json', JSON.stringify({ config, text: fs.readFileSync(config, 'utf8'),
  npmReader: process.env.CI_NPM_READ_TOKEN === ${JSON.stringify(npmToken)},
  githubReader: process.env.CI_GITHUB_PACKAGES_TOKEN === ${JSON.stringify(githubToken)},
  legacyReader: process.env.NODE_AUTH_TOKEN === ${JSON.stringify(githubToken)} }));
console.log(process.env.CI_NPM_READ_TOKEN);
console.error(process.env.CI_GITHUB_PACKAGES_TOKEN);
process.exitCode = ${failPreflight ? 17 : 0};
`);
  await writeFile(path.join(root, 'postinstall.cjs'), `require('node:fs').writeFileSync('lifecycle-ran', 'yes'); console.log(process.env.CI_NPM_READ_TOKEN);`);
  return { root, env: { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_TEMP: path.join(root, 'runner-temp'),
    npm_config_cache: path.join(root, 'empty-cache'), NPM_CI_TOKEN: npmToken,
    NPM_CI_GITHUB_SCOPE: '@example-org', NPM_CI_GITHUB_TOKEN: githubToken,
    NPM_CI_PREFLIGHT_SCRIPT: 'ci:dependencies', NPM_CI_IGNORE_SCRIPTS: 'true' } };
}

function execute(f, overrides = {}) {
  return spawnSync(process.execPath, [entry], { cwd: f.root, env: { ...f.env, ...overrides }, encoding: 'utf8' });
}

async function assertCleanup(f) {
  assert.deepEqual(await readdir(path.join(f.root, 'runner-temp')), []);
  assert.equal(await readFile(path.join(f.root, '.npmrc'), 'utf8'), '# consumer-owned configuration\n');
}

test('real npm preflight and locked install receive separate readers and clean their configuration', options, async t => {
  const f = await fixture(t);
  const result = execute(f);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(await readFile(path.join(f.root, 'preflight.json'), 'utf8'));
  assert.equal(observed.npmReader, true); assert.equal(observed.githubReader, true); assert.equal(observed.legacyReader, true);
  assert.match(observed.text, /@example-org:registry=https:\/\/npm.pkg.github.com\//);
  assert.match(observed.text, /\$\{CI_NPM_READ_TOKEN\}/);
  for (const token of [npmToken, githubToken]) {
    assert.equal(observed.text.includes(token), false);
    assert.equal((result.stdout + result.stderr).includes(token), false);
  }
  await assert.rejects(readFile(path.join(f.root, 'lifecycle-ran')), { code: 'ENOENT' });
  await assertCleanup(f);
});

test('npmjs-only consumers can explicitly preserve their required install lifecycle', options, async t => {
  const f = await fixture(t);
  const result = execute(f, { NPM_CI_GITHUB_SCOPE: '', NPM_CI_GITHUB_TOKEN: '', NPM_CI_PREFLIGHT_SCRIPT: '', NPM_CI_IGNORE_SCRIPTS: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(f.root, 'lifecycle-ran'), 'utf8'), 'yes');
  assert.equal((result.stdout + result.stderr).includes(npmToken), false);
  await assertCleanup(f);
});

test('failed preflight refuses installation, redacts output and still removes temporary configuration', options, async t => {
  const f = await fixture(t, { failPreflight: true });
  const result = execute(f, { NPM_CI_IGNORE_SCRIPTS: 'false' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Dependency preflight failed \(exit 17\)/);
  for (const token of [npmToken, githubToken]) assert.equal((result.stdout + result.stderr).includes(token), false);
  await assert.rejects(readFile(path.join(f.root, 'lifecycle-ran')), { code: 'ENOENT' });
  await assertCleanup(f);
});

test('failed npm ci removes configuration and preserves the consumer configuration', options, async t => {
  const f = await fixture(t, { invalidLock: true });
  const result = execute(f);
  assert.equal(result.status, 1); assert.match(result.stderr, /Dependency installation failed/);
  await assertCleanup(f);
});

test('missing readers and malformed options fail before npm executes', options, async t => {
  const f = await fixture(t);
  for (const [overrides, message] of [
    [{ NPM_CI_TOKEN: '' }, /npm-token is missing/],
    [{ NPM_CI_TOKEN: 'fixture_reader\nregistry=other' }, /npm-token is missing/],
    [{ NPM_CI_GITHUB_TOKEN: 'fixture reader' }, /requires both/],
    [{ NPM_CI_GITHUB_TOKEN: 'fixture_reader\r\nother=value' }, /requires both/],
    [{ NPM_CI_GITHUB_TOKEN: '' }, /requires both/],
    [{ NPM_CI_IGNORE_SCRIPTS: 'sometimes' }, /must be true or false/],
    [{ NPM_CI_PREFLIGHT_SCRIPT: '--help' }, /must name one npm script/],
  ]) {
    const result = execute(f, overrides);
    assert.equal(result.status, 1); assert.match(result.stderr, message);
    await assertCleanup(f);
  }
  await assert.rejects(readFile(path.join(f.root, 'preflight.json')), { code: 'ENOENT' });
});
