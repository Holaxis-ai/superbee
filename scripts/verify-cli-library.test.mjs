import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyReleaseSource } from './verify-cli-library.mjs';

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
  return { root, git, commit, record, verify, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('release source requires known clean exact HEAD and GitHub SHA', () => {
  const f = fixture();
  try {
    f.verify();
    for (const source of [{commit:null,dirty:false},{commit:f.record.source.commit,dirty:null},{commit:f.record.source.commit,dirty:true},{commit:'0'.repeat(40),dirty:false}])
      assert.throws(() => f.verify({...f.record,source}));
    assert.throws(() => verifyReleaseSource(f.record, {root:f.root,githubSha:'0'.repeat(40),manifestOf:()=>undefined}));
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
