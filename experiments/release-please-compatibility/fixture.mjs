import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manifest } from 'release-please';
import { checkPackageVersions } from '../../scripts/package-version-policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const initialVersion = '0.2.0-pre.2';
export const previousSha = '2'.repeat(40);
export const mergedSha = '3'.repeat(40);
export const sourceFiles = ['package.json', 'package-lock.json', 'packages/core/package.json',
  'packages/server/package.json', 'packages/markdown-renderer/package.json', 'packages/cli/package.json'];
export const config = JSON.parse(readFileSync(new URL('./shared-config.json', import.meta.url)));
export const quiet = { debug() {}, info() {}, warn() {}, error() {} };
export const commit = (sha, message, files) => ({ sha, message, files });

export function filesFromSource() {
  const files = Object.fromEntries(sourceFiles.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
  // These cases describe the audited pre.2 baseline; fail rather than silently reinterpret a later release.
  assert.equal(JSON.parse(files['packages/core/package.json']).version, initialVersion);
  files['release-please-config.json'] = JSON.stringify(config);
  files['.release-please-manifest.json'] = JSON.stringify({ 'packages/core': initialVersion });
  return files;
}

export function preflight(files) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'superbee-release-proof-'));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.resolve(scratch, file);
      assert.ok(target.startsWith(scratch + path.sep));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return checkPackageVersions(scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// The transport implements only canned reads. Mutating entry points are sentinels:
// reaching one is evidence of eligibility, never an actual provider write.
export function provider({ files = filesFromSource(), tags = [{ name: `libraries/v${initialVersion}`, sha: previousSha }],
  commits = [commit('a'.repeat(40), 'fix: new core correction', ['packages/core/src/example.ts']),
    commit(previousSha, 'fix: already shipped correction', ['packages/core/src/example.ts'])], merged = [] } = {}) {
  const calls = [];
  const read = file => {
    calls.push(['file', file]);
    assert.ok(Object.hasOwn(files, file), `Unexpected fixture file read: ${file}`);
    return { content: Buffer.from(files[file]).toString('base64'), parsedContent: files[file], sha: 'f'.repeat(40) };
  };
  const methods = {
    repository: { owner: 'fixture-owner', repo: 'fixture-repo', defaultBranch: 'main' },
    async getFileContentsOnBranch(file) { return read(file); },
    async getFileJson(file) { return JSON.parse(read(file).parsedContent); },
    async *releaseIterator() { calls.push(['releases']); },
    async *tagIterator() { calls.push(['tags']); yield* tags; },
    async *mergeCommitIterator() { calls.push(['commits']); yield* commits; },
    async *pullRequestIterator(branch, state) { calls.push(['pulls', state]); if (state === 'MERGED') yield* merged; },
    async createPullRequest() { calls.push(['would-create-pr']); throw new Error('WOULD_CREATE_PR'); },
  };
  const scm = new Proxy(methods, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    throw new Error(`Unexpected SCM access: ${String(key)}`);
  } });
  return { scm, calls, files };
}

export async function manifest(fixture) {
  return Manifest.fromManifest(fixture.scm, 'main', undefined, undefined, { logger: quiet });
}

export function applyProposal(files, proposal) {
  const updated = { ...files };
  for (const update of proposal.updates) {
    if (!Object.hasOwn(updated, update.path) && !update.createIfMissing) continue;
    updated[update.path] = update.updater.updateContent(updated[update.path], quiet);
  }
  return updated;
}

export function mergedPull(proposal, labels = ['autorelease: pending']) {
  return { number: 100, title: proposal.title.toString(), body: proposal.body.toString(),
    labels, headBranchName: proposal.headRefName, baseBranchName: 'main', sha: mergedSha,
    files: proposal.updates.map(update => update.path) };
}
