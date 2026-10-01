import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);

test('packed agent-surface passes the retained-artifact external consumer proof', async () => {
  const artifacts = await mkdtemp(path.join(tmpdir(), 'superbee-agent-surface-pack-'));
  try {
    // CI builds first; pack once and pass the literal output to the owning verifier.
    const npm = process.env.npm_execpath;
    const { stdout } = await exec(npm ? process.execPath : 'npm',
      [...(npm ? [npm] : []), 'pack', '-w', '@superbee/agent-surface', '--json', '--pack-destination', artifacts],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    const receipts = JSON.parse(stdout);
    assert.equal(receipts.length, 1);
    const [receipt] = receipts;
    const source = JSON.parse(await readFile(path.join(root, 'packages/agent-surface/package.json'), 'utf8'));
    assert.equal(receipt.name, source.name);
    assert.equal(receipt.version, source.version);
    const tarball = path.join(artifacts, receipt.filename);
    const bytes = await readFile(tarball);
    assert.equal(receipt.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    const proof = await exec(process.execPath,
      [path.join(root, 'packages/agent-surface/scripts/verify-packed.mjs'), tarball],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    const result = JSON.parse(proof.stdout);
    assert.equal(result.tarball, tarball);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(tarball), bytes, 'The retained packed bytes must not change');
    const alias = path.join(artifacts, 'artifact-alias.tgz');
    await symlink(tarball, alias);
    await assert.rejects(exec(process.execPath,
      [path.join(root, 'packages/agent-surface/scripts/verify-packed.mjs'), alias],
      { cwd: root, maxBuffer: 10 * 1024 * 1024 }), /retained artifact must be a regular file/);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});
