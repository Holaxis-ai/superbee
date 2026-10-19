import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyReleaseSource } from './verify-cli-library.mjs';
import { validateCliTarEntries, withRetainedTarball, assertClosedCliImports } from './cli-library-proof.mjs';
import ts from 'typescript';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-release-source-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.test');
  const manifests = new Map();
  for (const name of ['core', 'server']) {
    mkdirSync(path.join(root, 'packages', name, 'src'), { recursive: true });
    const manifest = { name: `@superbee/${name}`, version: '1.2.3' }; manifests.set(name, manifest);
    writeFileSync(path.join(root, 'packages', name, 'package.json'), JSON.stringify(manifest));
    writeFileSync(path.join(root, 'packages', name, 'README.md'), 'documentation');
    writeFileSync(path.join(root, 'packages', name, 'src', 'index.ts'), 'export {};');
  }
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const sha = commit(); git('tag', 'libraries/v1.2.3');
  const record = { source: { commit: sha, dirty: false }, packages: [...manifests.values()].map(row => ({ ...row, release_tag: 'libraries/v1.2.3' })) };
  const verify = candidate => verifyReleaseSource(candidate ?? record, { root, githubSha: git('rev-parse', 'HEAD'), manifestOf: name => manifests.get(name) });
  return { root, git, commit, record, verify, manifestOf: name => manifests.get(name), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('closed artifact permits guarded author and registered profile loading', async () => {
  const bundle = readFileSync(new URL('../packages/cli/dist/index.mjs', import.meta.url), 'utf8');
  await assertClosedCliImports(bundle);
  const ast = ts.createSourceFile('cli.mjs', bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const registeredLoader = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadRegisteredSourceProfile');
  const registeredSelector = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'selectSourceProfile');
  const loader = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'explicitProfile');
  assert.ok(loader);
  const imports = ast.statements.filter(ts.isImportDeclaration).map(node => node.getText(ast)).join('\n');
  let predicate, selection;
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && /^record\d*$/.test(node.left.text) && node.right.getText(ast).includes('value !== null')) {
      // Choose the predicate actually referenced by this loader, not an unrelated same-shape helper.
      if (loader.getText(ast).includes(`${node.left.text}(module)`)) predicate = `const ${node.left.text} = ${node.right.getText(ast)};`;
    }
    if (ts.isConditionalExpression(node) && node.getText(ast).startsWith('options.profile ? await explicitProfile(')) selection = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(predicate && selection);
  const subject = `${imports}\n${predicate}\n${loader.getText(ast)}\nasync function testSourceForAuthor(recipe, fixture, options = {}) { return ${selection}; }`;
  await assertClosedCliImports(subject);
  if (registeredLoader) {
    assert.ok(registeredSelector);
    const registered = `${imports}\n${registeredLoader.getText(ast)}\n${registeredSelector.getText(ast)}`;
    await assertClosedCliImports(registered);
    for (const [label,candidate] of [
      ['no generation verification',registered.replace(/await verified\d*\(a, input\);/,'')],
      ['different registered entry',registered.replace('dist/profile.mjs','other.mjs')],
      ['unfrozen helpers',registered.replace('Object.freeze({','Object.assign({')],
      ['factory metadata unchecked',registered.replace(/\bp\d*\.kind !== "extension"/,'p.kind !== "generic"')],
      ['external registered loader reference',registered+'\nconst escape = loadRegisteredSourceProfile;'],
      ['registered loader outside selector',registered.replace('function selectSourceProfile(', 'function otherSelector(')],
    ]) await assert.rejects(assertClosedCliImports(candidate),undefined,label);
  }
  await assertClosedCliImports('import fs from "node:fs"; export { fs };');
  const rows = [
    ['same expression outside boundary', subject + '\nawait import(pathToFileURL(resolved).href);'],
    ['sole dynamic import moved outside boundary', subject.replace('await import(pathToFileURL(resolved).href)', 'await Promise.resolve({})') + '\nawait import(pathToFileURL(resolved).href);'],
    ['extra unknown import', subject + '\nawait import(extensionPath);'],
    ['external static dependency', subject + '\nimport external from "external-package";'],
    ['missing boundary', 'await import(pathToFileURL(resolved).href);'],
    ['renamed boundary alone', subject.replaceAll('explicitProfile', 'otherLoader')],
    ['missing private-state guard', subject.replace(/assertPathOutsidePrivateState\([^;]+;/, '')],
    ['different local-file loader', subject.replace(/pathToFileURL\d*\(resolved\)\.href/, 'resolved')],
    ['changed fs member', subject.replace(/\.realpath\(/, '.readFile(')],
    ['extra loader call', subject.replace('try {', 'try { extraCall();')],
    ['implicit profile selection', subject.replace('options.profile ? await explicitProfile(options.profile)', 'recipe.profile ? await explicitProfile(recipe.profile)')],
    ['extra loader reference', subject + '\nconst escape = explicitProfile;'],
  ];
  for (const [label, candidate] of rows) await assert.rejects(assertClosedCliImports(candidate), undefined, label);
});

test('release source requires known clean exact HEAD and GitHub SHA', () => {
  const f = fixture();
  try {
    f.verify();
    for (const source of [{commit:null,dirty:false},{commit:f.record.source.commit,dirty:null},{commit:f.record.source.commit,dirty:true},{commit:'0'.repeat(40),dirty:false}])
      assert.throws(() => f.verify({...f.record,source}));
    writeFileSync(path.join(f.root,'untracked'), 'dirty'); assert.throws(() => f.verify(), /clean/);
  } finally { f.close(); }
});

test('whole committed library directories, including non-source files, must equal named tags', () => {
  for (const file of ['src/index.ts','README.md','package.json']) {
    const f = fixture();
    try {
      writeFileSync(path.join(f.root,'packages/core',file), 'changed');
      f.record.source.commit = f.commit(); assert.throws(() => f.verify(), /differs/);
    } finally { f.close(); }
  }
});

test('missing tags, missing directories, malformed versions and wrong record tags refuse', () => {
  for (const attack of ['tag','directory','row','version']) {
    const f = fixture();
    try {
      if (attack === 'tag') f.git('tag','-d','libraries/v1.2.3');
      if (attack === 'directory') { rmSync(path.join(f.root,'packages/core'),{recursive:true}); f.record.source.commit=f.commit(); }
      if (attack === 'row') f.record.packages[0].release_tag='libraries/v9.9.9';
      if (attack === 'version') f.record.packages[0].version='HEAD';
      assert.throws(() => f.verify());
    } finally { f.close(); }
  }
});


test('packed source independently binds GITHUB_SHA with valid manifests and HEAD', () => {
  const f = fixture();
  try {
    assert.throws(() => verifyReleaseSource(f.record, {
      root: f.root, githubSha: '0'.repeat(40), manifestOf: f.manifestOf,
    }), /packed source must equal GITHUB_SHA/);
  } finally { f.close(); }
});

test('packed source independently binds moved HEAD while GITHUB_SHA still matches', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.root, 'unrelated.txt'), 'advance checkout without changing libraries');
    f.commit();
    assert.throws(() => verifyReleaseSource(f.record, {
      root: f.root, githubSha: f.record.source.commit, manifestOf: f.manifestOf,
    }), /packed source must equal checked-out HEAD/);
  } finally { f.close(); }
});

test('tar allowlist rejects noncanonical segments and names the entry', () => {
  validateCliTarEntries(['package/package.json', 'package/README.md', 'package/dist/index.mjs', 'package/dist/deep/file.d.ts']);
  for (const entry of ['package/dist/../evil.mjs', 'package/dist/..', 'package/dist/a/../x',
    'package/dist/./x', 'package/dist//x', 'package/dist/', '/package/dist/x',
    'package/dist', 'package/other', 'package/package.json/extra', '']) {
    assert.throws(() => validateCliTarEntries([entry]), error => {
      assert.ok(error.message.includes(JSON.stringify(entry)), error.message);
      return true;
    });
  }
});

test('every retained-artifact consumer sees a private exact-byte snapshot', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'retained-proof-'));
  const original = path.join(dir, 'original.tgz');
  const bytes = Buffer.from('retained exact bytes');
  let snapshotPath;
  try {
    writeFileSync(original, bytes);
    const result = await withRetainedTarball(original, async (snapshot, digest) => {
      snapshotPath = snapshot;
      assert.notEqual(snapshot, original);
      assert.deepEqual(readFileSync(snapshot), bytes);
      assert.match(digest, /^[a-f0-9]{64}$/);
      return 'proved';
    });
    assert.equal(result, 'proved');
    assert.throws(() => readFileSync(snapshotPath), /ENOENT/);
    for (const attack of ['overwrite', 'replace', 'symlink', 'directory']) {
      writeFileSync(original, bytes);
      await assert.rejects(withRetainedTarball(original, async snapshot => {
        if (attack === 'overwrite') writeFileSync(original, 'different');
        else {
          renameSync(original, path.join(dir, 'old.tgz'));
          if (attack === 'replace') writeFileSync(original, 'different');
          if (attack === 'symlink') symlinkSync(path.join(dir, 'old.tgz'), original);
          if (attack === 'directory') mkdirSync(original);
        }
        assert.deepEqual(readFileSync(snapshot), bytes);
      }), /retained tarball changed|regular file/);
      rmSync(original, { recursive: true, force: true });
      rmSync(path.join(dir, 'old.tgz'), { force: true });
    }
    mkdirSync(original);
    await assert.rejects(withRetainedTarball(original, () => assert.fail('consumed directory')), /regular file/);
    rmSync(original, { recursive: true });
    symlinkSync(path.join(dir, 'absent'), original);
    await assert.rejects(withRetainedTarball(original, () => assert.fail('consumed symlink')), /regular file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('registered profile import is limited to its verified deferred generation loader', async () => {
  const registered = `import path from "node:path"; import {pathToFileURL} from "node:url";
async function loadRegisteredSourceProfile(selected, a, input) {
  try {
    await verified(a, input);
    const m = await import(pathToFileURL(path.join(selected.root, "dist/profile.mjs")).href);
    if (typeof m.createSourceProfile !== "function") throw pluginRefusal("plugin_export_invalid");
    const p = m.createSourceProfile(Object.freeze({ restJsonProfile, nextLinkTarget, unsupportedContent }));
    if (!record(p) || p.id !== a.profile.id || p.version !== a.profile.version || p.kind !== "extension" || typeof p.validateSpec !== "function" || typeof p.hostsFor !== "function" || typeof p.observe !== "function") throw pluginRefusal("plugin_export_invalid");
    return p;
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw pluginRefusal("plugin_execution_failed");
  }
}
async function selectSourceProfile(selected,a,input) {return {load:()=>loadRegisteredSourceProfile(selected,a,input)};}`;
  await assertClosedCliImports(registered);
  for (const candidate of [
    registered.replace('await verified(a, input);',''),
    registered.replace('dist/profile.mjs','different.mjs'),
    registered.replace('Object.freeze({','Object.assign({'),
    registered.replace(/\bp\d*\.kind !== "extension"/,'p.kind !== "generic"'),
    registered.replace('load:()=>','load:await '),
    registered+'\nconst escaped = loadRegisteredSourceProfile;',
    registered+'\nawait import(other);',
  ]) await assert.rejects(assertClosedCliImports(candidate));
});
