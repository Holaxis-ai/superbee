import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createGitHubApi, verifyActionUpstreams } from './verify-action-upstreams.mjs';
const sha = 'a'.repeat(40), tagSha = 'b'.repeat(40), nestedSha = 'c'.repeat(40);
const verification = { verified: true, reason: 'valid' };
const row = (identity = 'owner/repo') => ({ identity, revision: sha, version: 'v1.2.3' });
function fixture(transform = value => value) {
  const calls = [];
  const api = async (route, options) => {
    calls.push(route);
    let value;
    if (route.includes('/git/ref/')) value = { ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha } };
    else if (route.includes('/git/commits/')) value = { sha, verification, tree: { sha } };
    else if (route.includes('/git/trees/')) value = { sha, truncated: false, tree: [
      { path: 'action.yml', type: 'blob', mode: '100644', sha },
      { path: 'action.yaml', type: 'blob', mode: '100644', sha },
      { path: 'restore', type: 'tree', mode: '040000', sha },
      { path: 'save', type: 'tree', mode: '040000', sha },
    ] };
    else if (route.includes('/contents/')) {
      const file = route.split('/contents/')[1].split('?')[0];
      value = { type: 'file', path: file, name: file.split('/').at(-1), sha };
    }
    return transform(value, route, options);
  };
  return { api, calls };
}

test('lightweight tags include commit signatures, deduplicate repo/tag and verify each subpath', async () => {
  const { api, calls } = fixture();
  const result = await verifyActionUpstreams([row('owner/repo/restore'), row('owner/repo/save'), row('owner/repo/save')], { api });
  assert.equal(result.length, 2);
  assert.equal(calls.filter(r => r.includes('/git/ref/')).length, 1);
  assert.equal(calls.filter(r => r.includes('/git/commits/')).length, 1);
  assert.equal(calls.filter(r => r.includes('/contents/')).length, 2);
  assert.deepEqual(result[0].signatures, { commit: verification, tags: [] });
});

test('annotated tag chains resolve only via constructed routes and report every signature', async () => {
  const { api, calls } = fixture((value, route) => {
    if (route.includes('/git/ref/')) value.object = { type: 'tag', sha: tagSha, url: 'https://attacker.example/tag' };
    if (route.endsWith(`/git/tags/${tagSha}`)) return { sha: tagSha, tag: 'v1.2.3', verification, object: { type: 'tag', sha: nestedSha } };
    if (route.endsWith(`/git/tags/${nestedSha}`)) return { sha: nestedSha, tag: 'nested', verification, object: { type: 'commit', sha } };
    return value;
  });
  const result = await verifyActionUpstreams([row()], { api });
  assert.equal(result[0].signatures.tags.length, 2);
  assert.ok(calls.every(route => route.startsWith('/repos/owner/repo/')));
});

test('invalid or unverifiable upstream evidence fails closed', async () => {
  for (const [label, transform] of [
    ['wrong ref', (v, r) => r.includes('/git/ref/') ? { ...v, ref: 'refs/tags/v1.2.30' } : v],
    ['wrong type', (v, r) => r.includes('/git/ref/') ? { ...v, object: { type: 'tree', sha } } : v],
    ['mismatch', (v, r) => r.includes('/git/ref/') ? { ...v, object: { type: 'commit', sha: tagSha } } : v],
    ['bad schema', (v, r) => r.includes('/git/ref/') ? [] : v],
    ['wrong commit', (v, r) => r.includes('/git/commits/') ? { ...v, sha: tagSha } : v],
    ['signature absent', (v, r) => r.includes('/git/commits/') ? { sha } : v],
    ['missing metadata', (v, r) => r.includes('/contents/') ? null : v],
    ['dereferenced metadata symlink', (v, r) => r.includes('/git/trees/') ? { ...v, tree: [{ path: 'action.yml', type: 'blob', mode: '120000', sha }] } : v],
    ['metadata directory', (v, r) => r.includes('/contents/') ? { ...v, type: 'dir' } : v],
    ['metadata symlink', (v, r) => r.includes('/contents/') ? { ...v, target: 'elsewhere' } : v],
    ['metadata wrong path', (v, r) => r.includes('/contents/') ? { ...v, path: 'elsewhere' } : v],
    ['cyclic tag', (v, r) => r.includes('/git/ref/') ? { ...v, object: { type: 'tag', sha: tagSha } } : r.includes('/git/tags/') ? { sha: tagSha, tag: 'v1.2.3', verification, object: { type: 'tag', sha: tagSha } } : v],
  ]) await assert.rejects(verifyActionUpstreams([row()], fixture(transform)), undefined, label);
  const nested = fixture((v, r) => r.includes('/git/ref/') ? { ...v, object: { type: 'tag', sha: tagSha } } : r.includes('/git/tags/') ? { sha: tagSha, tag: 'v1.2.3', verification, object: { type: 'tag', sha: nestedSha } } : v);
  await assert.rejects(verifyActionUpstreams([row()], { api: nested.api, tagDepth: 1 }), /excessive/);
  const fallback = fixture((v, r) => r.includes('/contents/action.yml?') ? null : v);
  assert.equal((await verifyActionUpstreams([row()], fallback))[0].metadata, 'action.yaml');
});

const route = '/repos/owner/repo/git/ref/tags/v1.2.3';
const response = (status, body = '{}', headers = {}) => new Response(body, { status, headers });
test('transport has a fixed origin, token scope, redirect refusal and bounded finite retries', async () => {
  let calls = 0, delays = 0;
  const api = createGitHubApi({ token: 'test-token', delay: async () => { delays++; }, fetchImpl: async (url, options) => {
    assert.equal(url, `https://api.github.com${route}`); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return ++calls < 3 ? response(503) : response(200, '{"ok":true}');
  }});
  assert.deepEqual(await api(route), { ok: true }); assert.equal(calls, 3); assert.equal(delays, 2);
  for (const status of [401, 403, 302, 404, 429, 500]) {
    calls = 0; delays = 0;
    const get = createGitHubApi({ delay: async () => { delays++; }, fetchImpl: async () => { calls++; return response(status); } });
    await assert.rejects(get(route), status === 404 ? /invalid: missing/ : /infrastructure:/);
    assert.equal(calls, [429, 500].includes(status) ? 3 : 1);
    assert.equal(delays, calls - 1);
  }
  assert.equal(await createGitHubApi({ fetchImpl: async () => response(404) })(route, { allow404: true }), null);
  await assert.rejects(api('https://attacker.example'), /match/);
});

test('timeouts, transport, malformed JSON and bounded streaming all fail without leaking errors', async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => { throw new Error('secret-token'); },
    async () => response(200, 'not json'),
    async () => response(200, 'x'.repeat(101)),
    async () => response(200, '{}', { 'content-length': '101' }),
  ]) {
    const api = createGitHubApi({ fetchImpl, delay: async () => {}, limits: { attempts: 2, timeoutMs: 5, responseBytes: 100 } });
    await assert.rejects(api(route), error => !error.message.includes('secret-token'));
  }
});

test('metadata auth errors cannot be mistaken for absence and imports never make requests', async () => {
  const { api, calls } = fixture(async (v, r) => {
    if (r.includes('/contents/')) return createGitHubApi({ fetchImpl: async () => response(403) })(r, { allow404: true });
    return v;
  });
  await assert.rejects(verifyActionUpstreams([row()], { api }), /infrastructure/);
  assert.equal(calls.filter(r => r.includes('/contents/')).length, 1);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "globalThis.fetch = () => { throw Error('unexpected network'); }; await import('./scripts/verify-action-upstreams.mjs');"], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
