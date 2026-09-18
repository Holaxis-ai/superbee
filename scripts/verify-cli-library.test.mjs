import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyReleaseSource } from './verify-cli-library.mjs';
import { validateCliTarEntries, withRetainedTarball } from './cli-library-proof.mjs';

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
