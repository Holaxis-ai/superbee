import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { provider, manifest, applyProposal, mergedPull, filesFromSource, config,
  initialVersion, previousSha, mergedSha, commit, preflight, sourceFiles } from './fixture.mjs';

const originalConnect = net.Socket.prototype.connect;
const originalFetch = globalThis.fetch;
const originalSource = filesFromSource();
before(() => {
  net.Socket.prototype.connect = () => { throw new Error('Network disabled in proof'); };
  globalThis.fetch = () => { throw new Error('Network disabled in proof'); };
});
after(() => { net.Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch; });

async function firstProposal() {
  const fixture = provider();
  const proposals = await (await manifest(fixture)).buildPullRequests();
  assert.equal(proposals.length, 1);
  return { fixture, proposal: proposals[0] };
}

test('pinned upstream and real source baseline', () => {
  assert.equal(JSON.parse(readFileSync(new URL('./node_modules/release-please/package.json', import.meta.url))).version, '17.11.2');
  assert.deepEqual(preflight(filesFromSource()), []);
});

test('shared libraries tag is discovered without a GitHub release, proposal is repeatable', async () => {
  const { fixture, proposal } = await firstProposal();
  assert.equal(proposal.version.toString(), '0.2.0-pre.3');
  assert.match(proposal.body.toString(), /new core correction/);
  assert.doesNotMatch(proposal.body.toString(), /already shipped correction/);
  const again = await (await manifest(fixture)).buildPullRequests();
  assert.deepEqual(applyProposal(fixture.files, proposal), applyProposal(fixture.files, again[0]));
  assert.equal(proposal.body.toString(), again[0].body.toString());
  assert.ok(fixture.calls.some(([operation]) => operation === 'tags'));
  assert.ok(!fixture.calls.some(([operation]) => operation === 'would-create-pr'));
});

test('extra-files update exact pair and root lock, but unchanged renderer peer refuses new prerelease', async () => {
  const { fixture, proposal } = await firstProposal();
  const files = applyProposal(fixture.files, proposal);
  const core = JSON.parse(files['packages/core/package.json']);
  const server = JSON.parse(files['packages/server/package.json']);
  const lock = JSON.parse(files['package-lock.json']);
  assert.equal(core.version, '0.2.0-pre.3');
  assert.equal(server.version, core.version);
  assert.equal(server.dependencies['@superbee/core'], core.version);
  assert.equal(lock.packages['packages/core'].version, core.version);
  assert.equal(lock.packages['packages/server'].version, core.version);
  assert.equal(lock.packages['packages/server'].dependencies['@superbee/core'], core.version);
  for (const file of ['package.json', 'packages/cli/package.json', 'packages/markdown-renderer/package.json']) {
    assert.equal(files[file], fixture.files[file], `${file} untouched`);
  }
  const errors = preflight(files);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /markdown-renderer.*must admit/);
});

test('server-only changes are missed by a shared component rooted at core', async () => {
  const fixture = provider({ commits: [commit('a'.repeat(40), 'fix: server only correction', ['packages/server/src/example.ts']),
    commit(previousSha, 'fix: already shipped correction', ['packages/core/src/example.ts'])] });
  assert.deepEqual(await (await manifest(fixture)).buildPullRequests(), []);
});

for (const tag of ['libraries/vnot-a-version', 'libraries/v0.2.0-pre.1', 'core-v0.2.0-pre.2']) {
  test(`unmatched tag ${tag} falls back instead of rejecting missing release history`, async () => {
    const fixture = provider({ tags: [{ name: tag, sha: previousSha }] });
    const proposals = await (await manifest(fixture)).buildPullRequests();
    assert.equal(proposals.length, 1);
    assert.match(proposals[0].body.toString(), /already shipped correction/);
  });
}

test('second candidate is correct after tag-only completion; no repeated release after merge', async () => {
  const { fixture, proposal } = await firstProposal();
  const files = applyProposal(fixture.files, proposal);
  const merged = mergedPull(proposal);
  const releasedCommit = { ...commit(mergedSha, merged.title, merged.files), pullRequest: merged };
  const tags = [{ name: 'libraries/v0.2.0-pre.3', sha: mergedSha }];
  const noChange = provider({ files, tags, commits: [releasedCommit] });
  assert.deepEqual(await (await manifest(noChange)).buildPullRequests(), []);
  const next = provider({ files, tags, commits: [commit('b'.repeat(40), 'fix: next cycle correction', ['packages/core/src/example.ts']), releasedCommit] });
  const candidates = await (await manifest(next)).buildPullRequests();
  assert.equal(candidates[0].version.toString(), '0.2.0-pre.4');
  assert.match(candidates[0].body.toString(), /next cycle correction/);
  assert.doesNotMatch(candidates[0].body.toString(), /new core correction|already shipped correction/);
});

for (const state of ['merged without tag', 'tagged without stage', 'core staged only', 'both staged',
  'core approved only', 'both published finalizer pending', 'both published finalizer failed', 'finalizer succeeded']) {
  test(`pending label blocks PR creation: ${state}`, async () => {
    // These stages have the same SCM projection. Upstream has no npm/finalizer
    // read API; this is intentionally not a test of a fabricated stage controller.
    const { fixture, proposal } = await firstProposal();
    const merged = mergedPull(proposal);
    const next = provider({ files: applyProposal(fixture.files, proposal), merged: [merged],
      tags: state === 'merged without tag' ? [] : [{ name: 'libraries/v0.2.0-pre.3', sha: mergedSha }],
      commits: [commit('b'.repeat(40), 'fix: next cycle correction', ['packages/core/src/example.ts']),
        { ...commit(mergedSha, merged.title, merged.files), pullRequest: merged }] });
    assert.deepEqual(await (await manifest(next)).createPullRequests(), []);
    assert.ok(!next.calls.some(([operation]) => operation === 'would-create-pr'));
  });
}

test('removing pending label permits a PR even without publication verification', async () => {
  const { fixture, proposal } = await firstProposal();
  const merged = mergedPull(proposal, ['autorelease: tagged']);
  const next = provider({ files: applyProposal(fixture.files, proposal), merged: [merged],
    tags: [{ name: 'libraries/v0.2.0-pre.3', sha: mergedSha }],
    commits: [commit('b'.repeat(40), 'fix: next cycle correction', ['packages/core/src/example.ts']),
      { ...commit(mergedSha, merged.title, merged.files), pullRequest: merged }] });
  await assert.rejects((await manifest(next)).createPullRequests(), /WOULD_CREATE_PR/);
  assert.equal(next.calls.filter(([operation]) => operation === 'would-create-pr').length, 1);
});

for (const [name, mutate] of [
  ['divergent server version', files => { const server = JSON.parse(files['packages/server/package.json']); server.version = '0.2.0-pre.1'; files['packages/server/package.json'] = JSON.stringify(server); }],
  ['missing exact dependency', files => { const server = JSON.parse(files['packages/server/package.json']); delete server.dependencies['@superbee/core']; files['packages/server/package.json'] = JSON.stringify(server); }],
  ['malformed manifest', files => { files['packages/core/package.json'] = '{'; }],
  ['missing workspace lock', files => { const lock = JSON.parse(files['package-lock.json']); delete lock.packages['packages/core']; files['package-lock.json'] = JSON.stringify(lock); }],
]) {
  test(`existing preflight rejects ${name}`, () => { const files = filesFromSource(); mutate(files); assert.ok(preflight(files).length > 0); });
}

test('stable promotion is an explicit configuration, not a publication', async () => {
  const files = filesFromSource();
  const stable = structuredClone(config);
  stable.packages['packages/core'].prerelease = false;
  files['release-please-config.json'] = JSON.stringify(stable);
  const fixture = provider({ files });
  const proposals = await (await manifest(fixture)).buildPullRequests();
  assert.equal(proposals[0].version.toString(), '0.2.0');
  assert.equal(JSON.parse(applyProposal(files, proposals[0])['packages/server/package.json']).version, '0.2.0');
  assert.ok(!fixture.calls.some(([operation]) => operation === 'would-create-pr'));
});

test('source files remain byte-identical after all in-memory proposals', () => {
  for (const file of sourceFiles) assert.equal(originalSource[file], readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
});
