import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { versionPattern } from './package-version-policy.mjs';
import { isMainModule } from './is-main-module.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const manifestPath = 'integrations/github/package.json';
const coreName = '@superbee/core';

function checkout(root, sha) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'an exact 40-hex checkout SHA is required');
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), sha, 'checkout changed; rerun against the final candidate SHA');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no').trim(), '', 'tracked checkout changes require a new committed candidate');
  return file => {
    assert.equal(git(root, 'ls-tree', sha, '--', file).split(' ')[0], '100644', `${file}: expected committed regular file`);
    return git(root, 'show', `${sha}:${file}`);
  };
}

function exact(value, label) {
  assert.ok(typeof value === 'string' && versionPattern.test(value), `${label}: expected one exact version; ranges are not the plugin ABI`);
  return value;
}

function single(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, `${label}: expected one supported declaration; inspect changed format before proposing updates`);
  return matches[0];
}

// Read fixed members from one private byte snapshot; never extract or execute archive contents.
function archive(file, consume) {
  assert.ok(lstatSync(file).isFile(), 'archive must be a regular file, not a symlink');
  const bytes = readFileSync(file);
  const scratch = mkdtempSync(path.join(tmpdir(), 'superbee-consumer-impact-'));
  try {
    const snapshot = path.join(scratch, 'package.tgz');
    writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o400 });
    const tar = args => execFileSync('tar', [...args, snapshot], { encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 });
    const entries = tar(['-tzf']).trim().split('\n');
    const read = member => {
      assert.equal(entries.filter(entry => entry === member).length, 1, `${member}: missing or duplicate archive member`);
      return execFileSync('tar', ['-xOzf', snapshot, member], { encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 });
    };
    return { sha256: digest(bytes), ...consume(read) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function inspectConsumerImpact({ candidateRoot, candidateSha, pluginRoot, pluginSha, cliTarball, coreTarball }) {
  const source = checkout(candidateRoot, candidateSha);
  const plugin = checkout(pluginRoot, pluginSha);
  const core = JSON.parse(source('packages/core/package.json'));
  const cli = JSON.parse(source('packages/superbee/package.json'));
  assert.equal(core.name, coreName);
  assert.equal(cli.name, 'superbee');
  exact(core.version, 'candidate Core'); exact(cli.version, 'candidate CLI');
  const sourceCore = single(source('packages/core/src/source-profiles/index.ts'), /^export const SOURCE_PLUGIN_CORE_VERSION = "([^"]+)";$/gm, 'source plugin ABI')[1];
  assert.equal(sourceCore, core.version, 'candidate source plugin ABI differs from candidate Core manifest');
  const archives = {};
  if (cliTarball) archives.cli = archive(cliTarball, read => {
    const manifest = JSON.parse(read('package/package.json'));
    assert.equal(manifest.name, cli.name); assert.equal(manifest.version, cli.version);
    const bundle = read('package/dist/superbee.mjs');
    const abi = single(bundle, /^\s*(?:var )?SOURCE_PLUGIN_CORE_VERSION = "([^"]+)";$/gm, 'packed CLI plugin ABI')[1];
    // This intentionally recognizes only the current unminified esbuild literal. Format drift
    // refuses; it must never silently substitute the checkout's identity for the packed bytes.
    const identity = single(bundle, /^\s*(?:var )?define_SUPERBEE_BUILD_IDENTITY_default = \{ schema: "superbee\.build-identity\.v1", package: \{ name: "superbee", version: "([^"]+)" \}, source: \{ commit: "([a-f0-9]{40})", dirty: false \}, artifact: \{ channel: "npm-package" \}, compatibility_contracts: \{ skill: 1, hook: 1, mcp: 1 \} \};$/gm, 'packed CLI build identity');
    assert.equal(identity[1], cli.version, 'packed CLI version differs from candidate');
    assert.equal(identity[2], candidateSha, 'packed CLI source changed; discard prior impact evidence');
    assert.equal(abi, sourceCore, 'packed CLI Core ABI differs from final source');
    return { package: manifest.name, version: manifest.version, source_sha: identity[2], core: abi };
  });
  if (coreTarball) archives.core = archive(coreTarball, read => {
    const manifest = JSON.parse(read('package/package.json'));
    assert.equal(manifest.name, core.name); assert.equal(manifest.version, core.version);
    return { package: manifest.name, version: manifest.version };
  });

  const files = Object.fromEntries([manifestPath, 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/package-contract.test.mjs'].map(file => [file, plugin(file)]));
  const pkg = JSON.parse(files[manifestPath]);
  const root = JSON.parse(files['package.json']);
  const lock = JSON.parse(files['package-lock.json']);
  assert.equal(pkg.name, '@superbee/integration-github');
  assert.equal(pkg.private, true, 'plugin must retain Git checkout distribution');
  assert.equal(pkg.publishConfig, undefined, 'plugin publication is outside this check');
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages?.['node_modules/@superbee/core'], undefined, 'installed Core lock entry requires a registry-verified lock update; no integrity is fabricated');
  assert.equal(pkg.dependencies?.[coreName], undefined, 'required runtime Core dependency needs a reviewed consumer policy');
  assert.equal(root.dependencies?.[coreName], undefined, 'required runtime Core dependency needs a reviewed consumer policy');
  assert.equal(pkg.superbeeIntegration?.contract, 1);
  assert.equal(pkg.superbeeIntegration?.id, 'github');
  const rows = [];
  const add = (file, field, value) => rows.push({ file, field, actual: exact(value, `${file} ${field}`), expected: sourceCore });
  add(manifestPath, 'superbeeIntegration.core', pkg.superbeeIntegration.core);
  add(manifestPath, 'peerDependencies.@superbee/core', pkg.peerDependencies?.[coreName]);
  add('package-lock.json', 'packages.integrations/github.peerDependencies.@superbee/core', lock.packages?.['integrations/github']?.peerDependencies?.[coreName]);
  // Some supported older checkouts carry an exact development pin; never invent one when absent.
  for (const [file, record, field] of [[manifestPath, pkg, 'devDependencies.@superbee/core'], ['package.json', root, 'devDependencies.@superbee/core']]) {
    if (record.devDependencies?.[coreName] !== undefined) {
      add(file, field, record.devDependencies[coreName]);
      const key = file === manifestPath ? 'integrations/github' : '';
      add('package-lock.json', `packages.${key}.devDependencies.@superbee/core`, lock.packages?.[key]?.devDependencies?.[coreName]);
    }
  }
  const ciPattern = /^(\s*- run: npm install --no-save --package-lock=false --ignore-scripts @superbee\/core@)(\S+)([ \t]*)$/gm;
  const ci = single(files['.github/workflows/ci.yml'], ciPattern, 'plugin CI Core install');
  add('.github/workflows/ci.yml', 'Core install target', ci[2]);
  const testPattern = /(assert\.deepEqual\(pkg\.peerDependencies,\{'@superbee\/core':')([^']+)('\}\);)/g;
  const test = single(files['scripts/package-contract.test.mjs'], testPattern, 'plugin exact peer assertion');
  add('scripts/package-contract.test.mjs', 'exact Core peer assertion', test[2]);
  const changes = rows.filter(row => row.actual !== row.expected);
  const replacements = {};
  for (const [file, parsed] of [[manifestPath, pkg], ['package.json', root], ['package-lock.json', lock]]) {
    const selected = changes.filter(row => row.file === file);
    if (!selected.length) continue;
    // Explicit property paths avoid replacing unrelated version strings or old historical rows.
    if (file === manifestPath) {
      parsed.superbeeIntegration.core = sourceCore; parsed.peerDependencies[coreName] = sourceCore;
      if (parsed.devDependencies?.[coreName] !== undefined) parsed.devDependencies[coreName] = sourceCore;
    } else if (file === 'package.json') parsed.devDependencies[coreName] = sourceCore;
    else {
      parsed.packages['integrations/github'].peerDependencies[coreName] = sourceCore;
      for (const key of ['integrations/github', '']) if (parsed.packages[key]?.devDependencies?.[coreName] !== undefined) parsed.packages[key].devDependencies[coreName] = sourceCore;
    }
    replacements[file] = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if (changes.some(row => row.file === '.github/workflows/ci.yml')) replacements['.github/workflows/ci.yml'] = files['.github/workflows/ci.yml'].replace(ciPattern, (_, before, _version, after) => `${before}${sourceCore}${after}`);
  if (changes.some(row => row.file === 'scripts/package-contract.test.mjs')) replacements['scripts/package-contract.test.mjs'] = files['scripts/package-contract.test.mjs'].replace(testPattern, (_, before, _version, after) => `${before}${sourceCore}${after}`);
  checkout(candidateRoot, candidateSha); checkout(pluginRoot, pluginSha);
  return {
    schema: 'superbee.consumer-impact.v1',
    candidate: { source_sha: candidateSha, cli: cli.version, core: core.version },
    plugin: { source_sha: pluginSha, package: pkg.name, version: pkg.version },
    archives,
    status: changes.length ? 'companion-update-required' : 'compatible',
    expectations: rows,
    proposal: { status: 'unverified; normal registry/finalizer evidence, documentation review and installed archive tests still required',
      key: digest(JSON.stringify([candidateSha, pluginSha, core.version, cli.version, archives])),
      changes,
      files: Object.entries(replacements).map(([file, content]) => ({ file, expected_sha256: digest(files[file]), content })),
      manual_followups: changes.length ? ['Review README.md and integrations/github/README.md current compatibility/install guidance; preserve historical checkout pins.', 'Qualify the proposed checkout with the exact final CLI/Core archives before a companion PR or registration.'] : [],
    },
    evidence_scope: 'Exact declared plugin ABI and candidate/archive identity only; no execution, registry, attestation, publication or activation verdict.',
  };
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: Object.fromEntries(['candidate', 'candidate-sha', 'plugin', 'plugin-sha', 'cli-tarball', 'core-tarball'].map(key => [key, { type: 'string' }])) });
  assert.ok(values.candidate && values.plugin, 'usage: --candidate <checkout> --candidate-sha <SHA> --plugin <checkout> --plugin-sha <SHA> [--cli-tarball <retained.tgz>] [--core-tarball <retained.tgz>]');
  const report = inspectConsumerImpact({ candidateRoot: values.candidate, candidateSha: values['candidate-sha'], pluginRoot: values.plugin, pluginSha: values['plugin-sha'], cliTarball: values['cli-tarball'], coreTarball: values['core-tarball'] });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'compatible' ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
