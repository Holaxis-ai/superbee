import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareHandoff, createDraft, PRODUCER, CONSUMER } from './core-github-release-handoff.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const put = (root, file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'core-github-handoff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { candidateRoot: path.join(directory, 'producer'), pluginRoot: path.join(directory, 'plugin'), finalizerRun: 123 };
  for (const [name, repo] of [['candidateRoot', PRODUCER], ['pluginRoot', CONSUMER]]) {
    mkdirSync(options[name]); git(options[name], 'init', '-q'); git(options[name], 'config', 'user.name', 'Fixture');
    git(options[name], 'config', 'user.email', 'fixture@example.invalid'); git(options[name], 'remote', 'add', 'origin', `https://github.com/${repo}.git`);
  }
  const version = '0.2.0-pre.24';
  put(options.candidateRoot, 'packages/core/package.json', json({ name: '@superbee/core', version }));
  put(options.candidateRoot, 'packages/core/src/source-profiles/index.ts', `export const SOURCE_PLUGIN_CORE_VERSION = "${version}";\n`);
  put(options.candidateRoot, 'packages/superbee/package.json', json({ name: 'superbee', version: '0.4.3-pre.14' }));
  git(options.candidateRoot, 'add', '.'); git(options.candidateRoot, 'commit', '-qm', 'fixture'); options.candidateSha = git(options.candidateRoot, 'rev-parse', 'HEAD');
  const pkg = { name: '@superbee/integration-github', version: '0.1.0-pre.1', private: true, superbeeIntegration: { contract: 1, id: 'github', core: '0.2.0-pre.23' }, peerDependencies: { '@superbee/core': '0.2.0-pre.23' } };
  const files = { 'integrations/github/package.json': json(pkg), 'package.json': json({ private: true }),
    'package-lock.json': json({ lockfileVersion: 3, packages: { '': {}, 'integrations/github': { peerDependencies: pkg.peerDependencies } } }),
    '.github/workflows/ci.yml': '  - run: npm install --no-save --package-lock=false --ignore-scripts @superbee/core@0.2.0-pre.23\n',
    'scripts/package-contract.test.mjs': "assert.deepEqual(pkg.peerDependencies,{'@superbee/core':'0.2.0-pre.23'});\n" };
  for (const [file, text] of Object.entries(files)) put(options.pluginRoot, file, text);
  git(options.pluginRoot, 'add', '.'); git(options.pluginRoot, 'commit', '-qm', 'fixture'); options.pluginSha = git(options.pluginRoot, 'rev-parse', 'HEAD');
  for (const kind of ['cli', 'core']) {
    const source = path.join(directory, kind);
    put(source, 'package/package.json', json({ name: kind === 'cli' ? 'superbee' : '@superbee/core', version: kind === 'cli' ? '0.4.3-pre.14' : version }));
    if (kind === 'cli') put(source, 'package/dist/superbee.mjs', `var SOURCE_PLUGIN_CORE_VERSION = "${version}";\ndefine_SUPERBEE_BUILD_IDENTITY_default = { schema: "superbee.build-identity.v1", package: { name: "superbee", version: "0.4.3-pre.14" }, source: { commit: "${options.candidateSha}", dirty: false }, artifact: { channel: "npm-package" }, compatibility_contracts: { skill: 1, hook: 1, mcp: 1 } };\n`);
    options[`${kind}Tarball`] = path.join(directory, `${kind}.tgz`);
    execFileSync('tar', ['-czf', options[`${kind}Tarball`], '-C', source, 'package/package.json', ...(kind === 'cli' ? ['package/dist/superbee.mjs'] : [])]);
    options[`${kind}Sha256`] = digest(readFileSync(options[`${kind}Tarball`]));
  }
  const state = { base: options.pluginSha, prs: [], snapshots: new Map([[options.pluginSha, files]]), refs: [], calls: [], commits: new Map(), tree: 'd'.repeat(40), commit: 'e'.repeat(40), baseReads: 0, onBase: () => {}, before: () => {} };
  const api = async (method, route, input) => {
    state.calls.push({ method, route, input }); state.before(method, route, input);
    if (route === `repos/${CONSUMER}`) return { full_name: CONSUMER, default_branch: 'main', permissions: { push: true } };
    if (route.endsWith('/branches/main')) { state.onBase(++state.baseReads); return { commit: { sha: state.base } }; }
    if (route.endsWith('/actions/runs/123')) return { repository: { full_name: PRODUCER }, path: '.github/workflows/release-libraries-finalize.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
    if (route.endsWith('/runs/123/jobs?per_page=100')) return { jobs: [{ id: 12, conclusion: 'success', name: 'verify both registry artifacts and attestations' }] };
    if (route.includes('/git/ref/tags/')) return { object: { type: 'commit', sha: options.candidateSha } };
    if (route === `repos/${PRODUCER}/git/trees/${options.candidateSha}`) return { tree: [{ path: 'packages', type: 'tree', sha: 'a'.repeat(40) }] };
    if (route === `repos/${PRODUCER}/git/trees/${'a'.repeat(40)}`) return { tree: [{ path: 'core', type: 'tree', sha: git(options.candidateRoot, 'rev-parse', `${options.candidateSha}:packages/core`) }] };
    if (route.includes('/pulls?')) return route.includes('state=closed') ? state.closed ?? [] : state.prs;
    if (route.includes('/contents/')) {
      const [, file, ref] = /\/contents\/(.+)\?ref=([a-f0-9]{40})$/.exec(route);
      const content = state.snapshots.get(ref)?.[file]; assert.equal(typeof content, 'string', route);
      return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') };
    }
    if (route.includes('/git/matching-refs/')) return state.refs;
    if (method === 'GET' && route.endsWith(`/git/commits/${options.pluginSha}`)) return { tree: { sha: 'b'.repeat(40) } };
    if (method === 'GET' && route.includes('/git/commits/')) return state.commits.get(route.split('/').at(-1));
    if (method === 'POST' && route.endsWith('/git/trees')) { state.proposed = { ...files, ...Object.fromEntries(input.tree.map(row => [row.path, row.content])) }; return { sha: state.tree }; }
    if (method === 'POST' && route.endsWith('/git/commits')) { state.commits.set(state.commit, { message: input.message, parents: input.parents.map(sha => ({ sha })), tree: { sha: input.tree } }); state.snapshots.set(state.commit, state.proposed); return { sha: state.commit }; }
    if (method === 'POST' && route.endsWith('/git/refs')) { state.refs = [{ ref: input.ref, object: { sha: input.sha } }]; return state.refs[0]; }
    if (method === 'POST' && route.endsWith('/pulls')) {
      const pr = { number: 7, html_url: `https://github.com/${CONSUMER}/pull/7`, draft: input.draft, body: input.body, base: { sha: state.base, repo: { full_name: CONSUMER } }, head: { sha: state.commit, repo: { full_name: CONSUMER } } };
      state.prs.push(pr); return pr;
    }
    throw new Error(`Unexpected request: ${method} ${route}`);
  };
  const io = { api, log: async () => '2026-10-20T01:16:16.0094733Z   V: 0.2.0-pre.24\n',
    registry: async (name, version) => ({ name, version, dependencies: { '@superbee/core': version }, dist: { integrity: `sha512-${createHash('sha512').update(readFileSync(options.coreTarball)).digest('base64')}` } }),
    attest: async (file, tag) => { assert.match(tag, /v0\./); assert.ok([options.cliSha256, options.coreSha256].includes(digest(readFileSync(file)))); } };
  const mutations = () => state.calls.filter(call => call.method !== 'GET');
  return { options, io, state, mutations };
}

test('handoff mandates exact inspection and native publication; default proposal is deterministic and read-only', async t => {
  const f = fixture(t);
  const first = await prepareHandoff(f.options, f.io), second = await prepareHandoff(f.options, f.io);
  assert.deepEqual(first, second); assert.equal(first.status, 'draft-plan'); assert.equal(first.files.length, 4);
  assert.equal(first.impact.archives.cli.sha256, `sha256:${f.options.cliSha256}`);
  assert.match(first.body, /draft metadata proposal/); assert.match(first.body, /finalizer.*123/);
  assert.deepEqual(f.mutations(), []);
  await assert.rejects(createDraft(JSON.parse(JSON.stringify(first)), f.io), /fresh verified handoff/);
});

test('explicit draft creates only exact base-derived files and a draft; repeat reuses without a write', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io);
  const result = await createDraft(plan, f.io);
  assert.equal(result.status, 'draft-created'); assert.equal(result.created.number, 7);
  assert.deepEqual(f.mutations().map(row => row.route.split('/').at(-1)), ['trees', 'commits', 'refs', 'pulls']);
  const count = f.mutations().length;
  const again = await createDraft(await prepareHandoff(f.options, f.io), f.io);
  assert.equal(again.status, 'existing-owner-handoff'); assert.equal(f.mutations().length, count);
  assert.equal(f.state.prs.length, 1); assert.equal(f.state.prs[0].draft, true);
});

test('already-owned matching draft is reused without editing its body or duplicating it', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io), head = 'f'.repeat(40);
  f.state.snapshots.set(head, { ...f.state.snapshots.get(f.options.pluginSha), ...Object.fromEntries(plan.files.map(row => [row.file, row.content])) });
  f.state.prs = [{ number: 4, html_url: `https://github.com/${CONSUMER}/pull/4`, draft: true, body: 'Human-owned proposal', base: { sha: f.options.pluginSha, repo: { full_name: CONSUMER } }, head: { sha: head, repo: { full_name: CONSUMER } } }];
  const result = await createDraft(await prepareHandoff(f.options, f.io), f.io);
  assert.equal(result.status, 'existing-owner-handoff'); assert.equal(result.existing.number, 4);
  assert.equal(f.state.prs[0].body, 'Human-owned proposal'); assert.deepEqual(f.mutations(), []);
});

test('changed live base refuses before draft mutation', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io);
  f.state.base = '9'.repeat(40);
  await assert.rejects(createDraft(plan, f.io), /base changed/); assert.deepEqual(f.mutations(), []);
});

test('base changes after branch creation hold the native branch without opening a stale PR', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io);
  f.state.before = (method, route) => { if (method === 'POST' && route.endsWith('/git/refs')) f.state.base = '9'.repeat(40); };
  const result = await createDraft(plan, f.io);
  assert.equal(result.status, 'branch-base-changed'); assert.equal(result.created_branch.sha, f.state.commit);
  assert.equal(f.state.prs.length, 0);
});

test('base moves during native PR creation: draft retained and explicitly stale', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io);
  f.state.before = (method, route) => { if (method === 'POST' && route.endsWith('/pulls')) f.state.base = '9'.repeat(40); };
  const result = await createDraft(plan, f.io);
  assert.equal(result.status, 'draft-base-changed'); assert.equal(f.state.prs[0].draft, true);
  assert.match(result.next_action, /inspect and replan/);
});

test('changed native draft head is held with observed and expected commits distinguished', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io), api = f.io.api;
  f.io.api = async (...args) => {
    const result = await api(...args);
    if (args[0] === 'POST' && args[1].endsWith('/pulls')) result.head.sha = 'f'.repeat(40);
    return result;
  };
  const result = await createDraft(plan, f.io);
  assert.equal(result.status, 'draft-head-changed');
  assert.equal(result.created.head_sha, 'f'.repeat(40));
  assert.equal(result.created.expected_head_sha, f.state.commit);
  assert.equal(f.state.prs.length, 1);
});

test('native attestation adapter uses the gh repository slug contract', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'core-github-native-gh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'gh'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] !== 'attestation' || args[1] !== 'verify' || !/^[^/:]+\\/[^/:]+$/.test(args[args.indexOf('-R') + 1])) process.exit(2);\nprocess.stdout.write('[]');\n`, { mode: 0o755 });
  const source = `import { githubTransport } from ${JSON.stringify(new URL('./core-github-release-handoff.mjs', import.meta.url).href)}; await githubTransport().attest('archive.tgz', 'libraries/v0.2.0-pre.24', 'release-libraries.yml');`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', source], { env: { ...process.env, GH_HOST: 'github.com', PATH: `${directory}${path.delimiter}${process.env.PATH}` }, stdio: 'pipe' });
});

test('partial branch creation recovers only its exact parent, message and whole tree', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io);
  f.state.before = (method, route) => { if (method === 'POST' && route.endsWith('/git/refs')) f.state.base = '9'.repeat(40); };
  assert.equal((await createDraft(plan, f.io)).status, 'branch-base-changed');
  f.state.base = f.options.pluginSha; f.state.before = () => {};
  f.state.commits.get(f.state.commit).tree.sha = '8'.repeat(40);
  await assert.rejects(createDraft(plan, f.io), /other changes/);
  f.state.commits.get(f.state.commit).tree.sha = f.state.tree;
  assert.equal((await createDraft(plan, f.io)).status, 'draft-created');
  assert.equal(f.state.prs.length, 1);
});

test('lost PR response is discovered by native state before retry', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io), api = f.io.api;
  f.io.api = async (...args) => { const result = await api(...args); if (args[0] === 'POST' && args[1].endsWith('/pulls')) throw new Error('lost response'); return result; };
  const result = await createDraft(plan, f.io);
  assert.equal(result.status, 'existing-owner-handoff'); assert.equal(result.existing.number, 7);
  assert.equal(f.state.prs.length, 1);
});

test('uncertain branch create reports exact native target and recovers without overwrite', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io), api = f.io.api;
  f.io.api = async (...args) => { const result = await api(...args); if (args[0] === 'POST' && args[1].endsWith('/git/refs')) throw new Error('lost branch response'); return result; };
  const held = await createDraft(plan, f.io);
  assert.equal(held.status, 'branch-outcome-unknown'); assert.equal(held.created_branch.branch, plan.branch);
  assert.equal(f.state.prs.length, 0);
  f.io.api = api;
  assert.equal((await createDraft(await prepareHandoff(f.options, f.io), f.io)).status, 'draft-created');
  assert.equal(f.mutations().filter(row => row.route.endsWith('/git/refs')).length, 1);
});

test('uncertain PR create with no readable native result reports a hold, never retries', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io), api = f.io.api;
  f.io.api = async (...args) => { if (args[0] === 'POST' && args[1].endsWith('/pulls')) throw new Error('lost before response'); return api(...args); };
  assert.equal((await createDraft(plan, f.io)).status, 'draft-outcome-unknown');
  assert.equal(f.state.prs.length, 0);
});

test('same-Core mismatched proposal and competing owners stop duplication', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io), head = 'f'.repeat(40);
  f.state.snapshots.set(head, { ...f.state.snapshots.get(f.options.pluginSha), ...Object.fromEntries(plan.files.map(row => [row.file, row.content])) });
  const pr = { number: 4, draft: true, base: { sha: f.options.pluginSha, repo: { full_name: CONSUMER } }, head: { sha: head, repo: { full_name: CONSUMER } } };
  f.state.prs = [pr, { ...pr, number: 5 }];
  await assert.rejects(prepareHandoff(f.options, f.io), /multiple Core companion owners/);
  f.state.prs = [pr]; f.state.snapshots.get(head)['scripts/package-contract.test.mjs'] += '// changed\n';
  await assert.rejects(prepareHandoff(f.options, f.io), /different exact files/);
  assert.deepEqual(f.mutations(), []);
});

test('closed native proposal is held rather than silently recreated', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io);
  f.state.closed = [{ number: 3, html_url: `https://github.com/${CONSUMER}/pull/3` }];
  const result = await createDraft(plan, f.io);
  assert.equal(result.status, 'closed-proposal-held'); assert.deepEqual(f.mutations(), []);
});

for (const [name, alter, pattern] of [
  ['wrong archive digest', f => { f.options.cliSha256 = '0'.repeat(64); }, /CLI hash changed/],
  ['missing archive', f => { delete f.options.coreTarball; }, /actual retained/],
  ['wrong finalizer version', f => { f.io.log = async () => '2026-10-20T00:00:00Z   V: 0.2.0-pre.23\n'; }, /exact Core version/],
  ['registry unavailable', f => { f.io.registry = async () => { throw new Error('registry unavailable'); }; }, /registry unavailable/],
  ['half published pair', f => { const registry = f.io.registry; f.io.registry = async (name, version) => name === '@superbee/server' ? { name, version: '0.2.0-pre.23' } : registry(name, version); }, /strictly equal/],
  ['wrong registry bytes', f => { const registry = f.io.registry; f.io.registry = async (...args) => ({ ...await registry(...args), dist: { integrity: 'sha512-AAAAAAAA' } }); }, /integrity/],
  ['native attestation refusal', f => { f.io.attest = async () => { throw new Error('attestation refused'); }; }, /attestation refused/],
  ['failed finalizer', f => { const api = f.io.api; f.io.api = async (...args) => args[1].endsWith('/actions/runs/123') ? { ...await api(...args), conclusion: 'failure' } : api(...args); }, /finalizer is not verified/],
  ['changed native CLI tag', f => { const api = f.io.api; f.io.api = async (...args) => args[1].endsWith('/git/ref/tags/v0.4.3-pre.14') ? { object: { type: 'commit', sha: '7'.repeat(40) } } : api(...args); }, /CLI source tag differs/],
  ['changed published Core tree', f => { const api = f.io.api; f.io.api = async (...args) => args[1].endsWith(`/git/trees/${'a'.repeat(40)}`) ? { tree: [{ path: 'core', type: 'tree', sha: '6'.repeat(40) }] } : api(...args); }, /Core source differs/],
  ['wrong repository', f => { git(f.options.pluginRoot, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git'); }, /verified consumer/],
]) test(`unverified evidence never reaches a draft mutation: ${name}`, async t => {
  const f = fixture(t); alter(f);
  await assert.rejects(prepareHandoff(f.options, f.io), pattern); assert.deepEqual(f.mutations(), []);
});

test('changed checkout after proof refuses mutation', async t => {
  const f = fixture(t), plan = await prepareHandoff(f.options, f.io);
  put(f.options.candidateRoot, 'packages/core/package.json', json({ name: '@superbee/core', version: '9.9.9' }));
  await assert.rejects(createDraft(plan, f.io), /tracked source changed/); assert.deepEqual(f.mutations(), []);
});
