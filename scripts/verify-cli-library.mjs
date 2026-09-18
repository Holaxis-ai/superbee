import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { versionPattern } from './package-version-policy.mjs';
import { proveCliTarball } from './cli-library-proof.mjs';

// Equality is over committed whole-directory tree objects, not src-only or a build-time boolean.
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
    const tree = ref => {
      const spec = `${ref}:packages/${directory}`;
      assert.equal(git(['cat-file', '-t', spec]), 'tree', `${spec} must exist as a directory`);
      return git(['rev-parse', '--verify', spec]);
    };
    assert.equal(tree(record.source.commit), tree(tagCommit), `packages/${directory} differs from ${row.release_tag}; release the updated libraries first`);
  }
}

export async function verifyCliLibrary() {
  const root = path.resolve(import.meta.dirname, '..');
  const tarball = path.join(root, 'out/superbee-cli.tgz');
  return proveCliTarball(tarball, { checkSource: (record, manifestOf) => verifyReleaseSource(record, { root, githubSha: process.env.GITHUB_SHA, manifestOf }) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.stdout.write(`${JSON.stringify(await verifyCliLibrary(), null, 2)}\n`);
