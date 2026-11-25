import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { versionPattern } from './package-version-policy.mjs';
import { proveCliTarball } from './cli-library-proof.mjs';

// Check committed package inputs, including manifests, build configuration and packed documentation.
// Tests under the package-root test/ directory are outside the released engine.
export function verifyReleaseSource(record, { root, githubSha, manifestOf }) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.match(record.source?.commit ?? '', /^[a-f0-9]{40}$/);
  assert.equal(record.source.dirty, false, 'release source must be known clean');
  assert.equal(record.source.commit, githubSha, 'packed source must equal GITHUB_SHA');
  assert.equal(record.source.commit, git(['rev-parse', 'HEAD']), 'packed source must equal checked-out HEAD');
  assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '', 'release checkout must be clean');
  for (const directory of ['core', 'server']) {
    const manifest = manifestOf(directory);
    assert.equal(manifest?.name, `@superbee/${directory}`);
    assert.match(manifest.version, versionPattern);
    const rows = record.packages.filter(row => row.name === manifest.name);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.version, manifest.version);
    assert.equal(row.release_tag, `libraries/v${manifest.version}`);
    const tagCommit = git(['rev-parse', '--verify', `refs/tags/${row.release_tag}^{commit}`]);
    const packagePath = `packages/${directory}`;
    for (const ref of [record.source.commit, tagCommit]) {
      const spec = `${ref}:${packagePath}`;
      assert.equal(git(['cat-file', '-t', spec]), 'tree', `${spec} must exist as a directory`);
    }
    const changedInputs = git([
      'diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
      tagCommit, record.source.commit, '--', packagePath, `:(top,glob,exclude)${packagePath}/test/**`,
    ]);
    assert.equal(changedInputs, '', `${packagePath} differs from ${row.release_tag} outside test/; release the updated libraries first`);
  }
}

export async function verifyCliLibrary() {
  const root = path.resolve(import.meta.dirname, '..');
  const tarball = path.join(root, 'out/superbee-cli.tgz');
  return proveCliTarball(tarball, { checkSource: (record, manifestOf) => verifyReleaseSource(record, { root, githubSha: process.env.GITHUB_SHA, manifestOf }) });
}
