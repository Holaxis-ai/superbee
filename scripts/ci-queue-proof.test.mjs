import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { manifest, expectedQueueJobs, decide, verifyQueueProof, evaluateQueueResults, eligible, createQueueApi, policyDigest, main } from './ci-queue-proof.mjs';
const p = manifest.queue_reuse;
const context = { repository: p.repository, repositoryId: p.repository_id, event: 'push', ref: 'refs/heads/main', attempt: 1, runId: 99, sha: 'a'.repeat(40) };
function fixture() {
  const run = { id: 10, created_at: '2026-10-19T10:00:00Z', run_attempt: 1, check_suite_id: 20, repository: { id: p.repository_id, full_name: p.repository }, head_repository: { id: p.repository_id, full_name: p.repository },
    head_sha: context.sha, event: 'merge_group', workflow_id: p.workflow_id, path: p.workflow_path, head_branch: 'gh-readonly-queue/main/pr-1-base', referenced_workflows: [], status: 'completed', conclusion: 'success' };
  const jobs = expectedQueueJobs().map((name, i) => ({ id: 100 + i, name, run_id: run.id, run_attempt: 1, head_sha: context.sha, status: 'completed', conclusion: 'success', check_run_url: `https://api.github.com/repos/${p.repository}/check-runs/${100 + i}` }));
  const checks = Object.fromEntries(jobs.map(job => [job.id, { id: job.id, name: job.name, head_sha: context.sha, status: 'completed', conclusion: 'success', check_suite: { id: 20 }, app: { id: p.app_id, slug: 'github-actions' } }]));
  const data = { run, jobs, checks, runs: [run], sourceRuns: [], calls: [] };
  data.api = async route => {
    data.calls.push(route);
    if (route.includes('/runs?') && !route.includes('event=merge_group')) return structuredClone({ total_count: data.sourceRuns.length, workflow_runs: data.sourceRuns });
    if (route.includes('/runs?')) return structuredClone({ total_count: data.runs.length, workflow_runs: data.runs });
    if (route.includes('/jobs?')) return structuredClone({ total_count: data.jobs.length, jobs: data.jobs });
    const source = data.sourceRuns.find(run => route.endsWith(`/runs/${run.id}`));
    if (source) return structuredClone(source);
    if (route.endsWith('/runs/10')) return structuredClone(data.run);
    if (route.includes('/check-runs/')) return structuredClone(data.checks[route.split('/').at(-1)]);
    throw new Error(`unexpected route ${route}`);
  };
  return data;
}
function current(reuse = false, proof) {
  return { 'source-decision': { result: 'success', outputs: { reuse: String(reuse), proof: proof ? JSON.stringify(proof) : '' } },
    ...Object.fromEntries(manifest.required_jobs.map(name => [name, { result: reuse && name !== p.always_full_job ? 'skipped' : 'success' }])) };
}

test('native exact-source complete queue proof admits reuse and all current aggregate paths agree', async () => {
  const f = fixture();
  assert.equal(expectedQueueJobs().length, 19);
  const proof = await verifyQueueProof(f.api, context);
  assert.deepEqual(proof, { run: 10, attempt: 1, suite: 20, sha: context.sha, policy: policyDigest });
  assert.equal(f.calls.filter(route => route.includes('/check-runs/')).length, 19);
  assert.deepEqual(await decide(f.api, context), { reuse: true, proof });
  await evaluateQueueResults(current(true, proof), context, f.api);
  await evaluateQueueResults(current(), context, async () => { throw new Error('full execution needs no provider lookup'); });
});

test('dispatch, rerun, queue, PR, non-main and foreign contexts force full without API', async () => {
  for (const patch of [{ event: 'workflow_dispatch' }, { event: 'merge_group' }, { event: 'pull_request' }, { attempt: 2 }, { ref: 'refs/heads/other' }, { repository: 'fork/repo' }, { repositoryId: 1 }, { sha: 'tree-equality-is-insufficient' }]) {
    const c = { ...context, ...patch };
    assert.equal(eligible(c), false);
    assert.deepEqual(await decide(() => { throw new Error('must not query'); }, c), { reuse: false });
  }
});

test('run identity, trust, conclusion and source mutations all select full', async () => {
  for (const [key, value] of Object.entries({ id: 0, run_attempt: 0, check_suite_id: 0, repository: { id: 1 }, head_repository: { id: 1 }, head_sha: 'b'.repeat(40), event: 'pull_request', workflow_id: 2, path: '.github/workflows/spoof.yml', head_branch: 'main', referenced_workflows: [{}], status: 'in_progress', conclusion: 'failure' })) {
    const f = fixture(); f.run[key] = value;
    assert.deepEqual(await decide(f.api, context), { reuse: false }, key);
  }
  for (const conclusion of ['skipped', 'neutral', 'cancelled', 'timed_out', 'action_required', null]) {
    const f = fixture(); f.run.conclusion = conclusion;
    assert.deepEqual(await decide(f.api, context), { reuse: false }, String(conclusion));
  }
});

test('every lane must have exact native run, attempt, SHA, check URL and successful conclusion', async () => {
  for (const patch of [{ id: 0 }, { run_id: 11 }, { run_attempt: 2 }, { head_sha: 'b'.repeat(40) }, { check_run_url: 'https://evil.example/check' }, { name: 'same-provider-name-squatting' }, { status: 'queued' }, ...['failure', 'skipped', 'neutral', 'cancelled', 'timed_out', 'action_required', null].map(conclusion => ({ conclusion }))]) {
    const f = fixture(); Object.assign(f.jobs[0], patch);
    assert.deepEqual(await decide(f.api, context), { reuse: false }, JSON.stringify(patch));
  }
  for (const mutate of [f => f.jobs.pop(), f => f.jobs.push(f.jobs[0]), f => f.jobs.push({ ...f.jobs[0], id: 999 }), f => { f.jobs[0].id = f.jobs[1].id; }]) {
    const f = fixture(); mutate(f);
    assert.deepEqual(await decide(f.api, context), { reuse: false });
  }
});

test('same-named checks cannot substitute another suite, provider, SHA or check identity', async () => {
  for (const patch of [{ id: 999 }, { name: 'unrelated' }, { head_sha: 'b'.repeat(40) }, { check_suite: { id: 21 } }, { app: { id: 1, slug: 'github-actions' } }, { app: { id: p.app_id, slug: 'other' } }, { status: 'queued' }, { conclusion: 'neutral' }]) {
    const f = fixture(); Object.assign(f.checks[f.jobs[0].id], patch);
    assert.deepEqual(await decide(f.api, context), { reuse: false });
  }
});

test('newest relevant queue run decides, never an older successful run', async () => {
  const f = fixture();
  f.runs.push({ ...f.run, id: 11, created_at: '2026-10-19T11:00:00Z', conclusion: 'failure' });
  assert.deepEqual(await decide(f.api, context), { reuse: false });
  f.runs.pop(); f.runs.push(f.run);
  assert.deepEqual(await decide(f.api, context), { reuse: false });
});

test('attempt changes and a newly listed relevant run invalidate admission', async () => {
  for (const kind of ['attempt', 'status', 'new-run']) {
    const f = fixture(); const api = f.api; let lists = 0, reads = 0;
    f.api = async route => {
      if (route.includes('event=merge_group') && ++lists === 2 && kind === 'new-run') f.runs.push({ ...f.run, id: 11, created_at: '2026-10-19T11:00:00Z' });
      if (route.endsWith('/runs/10') && ++reads === 2) {
        if (kind === 'attempt') f.run.run_attempt++;
        if (kind === 'status') f.run.conclusion = 'failure';
      }
      return api(route);
    };
    assert.deepEqual(await decide(f.api, context), { reuse: false }, kind);
  }
});

test('aggregate reselects newest run and current attempt instead of trusting decision output', async () => {
  for (const mutate of [f => { f.run.run_attempt++; }, f => { f.runs.push({ ...f.run, id: 11, created_at: '2026-10-19T11:00:00Z' }); }, f => { f.run.conclusion = 'failure'; }]) {
    const f = fixture(); const proof = await verifyQueueProof(f.api, context); mutate(f);
    await assert.rejects(evaluateQueueResults(current(true, proof), context, f.api));
  }
});

test('API faults, incomplete/changing pagination and malformed objects all select full', async () => {
  for (const response of [null, {}, { total_count: 1, workflow_runs: [] }, { total_count: 1001, workflow_runs: [] }, { total_count: 0, workflow_runs: [] }, { total_count: '1', workflow_runs: [] }]) {
    assert.deepEqual(await decide(async () => response, context), { reuse: false });
  }
  assert.deepEqual(await decide(async () => { throw new Error('403/429/network/JSON failure'); }, context), { reuse: false });
  const f = fixture(); const api = f.api;
  for (const body of [{ total_count: 20, jobs: f.jobs }, { total_count: 19, jobs: [] }]) {
    assert.deepEqual(await decide(route => route.includes('/jobs?') ? body : api(route), context), { reuse: false });
  }
});

test('aggregate fails every missing/extra/skipped/malformed current proof shape', async () => {
  const f = fixture(); const proof = await verifyQueueProof(f.api, context);
  for (const mutate of [r => { delete r['source-decision']; }, r => { r.unknown = { result: 'success' }; }, r => { r['source-decision'].result = 'failure'; }, r => { r['source-decision'].outputs.reuse = 'false'; }, r => { r['source-decision'].outputs.proof = '{}'; }, r => { r['source-decision'].outputs.proof = JSON.stringify({ ...proof, policy: 'b'.repeat(64) }); }, r => { r['source-decision'].outputs.proof = JSON.stringify({ ...proof, sha: 'b'.repeat(40) }); }, r => { r['source-decision'].outputs.proof = '{'; }, r => { r['smoke-node-22'].result = 'skipped'; }, r => { r.runtime.result = 'success'; }, r => { r.runtime.result = 'failure'; }]) {
    const results = current(true, proof); mutate(results);
    await assert.rejects(evaluateQueueResults(results, context, f.api));
  }
  for (const decision of ['failure', 'skipped', 'cancelled']) {
    const results = current(); results['source-decision'].result = decision;
    await evaluateQueueResults(results, context, () => { throw new Error('API not needed'); });
  }
  await assert.rejects(evaluateQueueResults(current(true, proof), context, async () => { throw new Error('API outage at aggregate'); }));
});

test('HTTP client refuses API failures, redirects, invalid JSON and response overflow', async () => {
  const route = `/repos/${p.repository}/actions/runs/10`;
  for (const response of [new Response('{}', { status: 403 }), new Response('{}', { status: 429 }), new Response('invalid'), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    await assert.rejects(createQueueApi({ fetchImpl: async () => response })(route));
  }
  const calls = [];
  const api = createQueueApi({ token: 'fixture-token', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{}'); } });
  assert.deepEqual(await api(route), {});
  assert.equal(calls[0].url, `https://api.github.com${route}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'GET');
  await assert.rejects(api('https://evil.example/'));
  await assert.rejects(api(`/repos/${p.repository}/../other`));
});

test('literal workflow helper writes safe forced-full output and rejects skipped aggregate via CLI', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-queue-proof-'));
  try {
    const output = path.join(dir, 'output');
    const env = { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: output, REQUIRED_RESULTS_JSON: JSON.stringify(current(true, {})) };
    const decision = spawnSync(process.execPath, ['scripts/ci-queue-proof.mjs', 'decision'], { env, encoding: 'utf8' });
    assert.equal(decision.status, 0, decision.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'reuse=false\nproof=\n');
    const aggregate = spawnSync(process.execPath, ['scripts/ci-queue-proof.mjs', 'aggregate'], { env, encoding: 'utf8' });
    assert.equal(aggregate.status, 1);
    assert.match(aggregate.stderr, /workflow_dispatch.*exact source/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('literal helper main produces admitted outputs and aggregate native evidence links', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-queue-proof-main-'));
  try {
    const f = fixture(); const output = path.join(dir, 'output'); const summary = path.join(dir, 'summary');
    const env = { GITHUB_EVENT_NAME: context.event, GITHUB_REF: context.ref, GITHUB_SHA: context.sha, GITHUB_RUN_ATTEMPT: '1',
      GITHUB_REPOSITORY: p.repository, GITHUB_REPOSITORY_ID: String(p.repository_id), GITHUB_RUN_ID: String(context.runId), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
    await main(env, f.api, 'decision');
    const text = readFileSync(output, 'utf8');
    assert.match(text, /^reuse=true\nproof=/);
    const proof = JSON.parse(text.split('\n')[1].slice('proof='.length));
    env.REQUIRED_RESULTS_JSON = JSON.stringify(current(true, proof));
    await main(env, f.api, 'aggregate');
    assert.match(readFileSync(summary, 'utf8'), /actions\/runs\/10\/attempts\/1/);
    f.runs.push({ ...f.run, id: 11, created_at: '2026-10-19T11:00:00Z' });
    await assert.rejects(main(env, f.api, 'aggregate'), /full CI tests workflow_dispatch/);
    await main(env, f.api, 'decision');
    assert.match(readFileSync(output, 'utf8'), /reuse=false\nproof=\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pagination must be complete, stable and duplicate-free even across multiple pages', async () => {
  const f = fixture(); const baseApi = f.api;
  const runs = Array.from({ length: 101 }, (_, i) => ({ ...f.run, id: 10 + i, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString().replace('.000Z', 'Z') }));
  // Keep the selected newest run at the fixture's native ID; list ordering itself conveys no authority.
  runs.at(-1).id = 10; runs[0].id = 500;
  f.run.created_at = runs.at(-1).created_at;
  let pageTwo = false;
  const api = async route => {
    if (!route.includes('event=merge_group')) return baseApi(route);
    const page = Number(new URL(`https://api.github.com${route}`).searchParams.get('page'));
    if (page === 2) pageTwo = true;
    return { total_count: runs.length, workflow_runs: page === 1 ? runs.slice(0, 100) : runs.slice(100) };
  };
  assert.equal((await decide(api, context)).reuse, true);
  assert.equal(pageTwo, true);
  const changedCount = route => route.includes('event=merge_group') && route.endsWith('page=2') ? { total_count: 102, workflow_runs: runs.slice(100) } : api(route);
  assert.deepEqual(await decide(changedCount, context), { reuse: false });
  const tie = fixture(); tie.runs.push({ ...tie.run, id: 11 });
  assert.deepEqual(await decide(tie.api, context), { reuse: false });
});

test('newer trusted manual or main-push failures and pending runs veto old queue success', async () => {
  for (const event of ['workflow_dispatch', 'push']) {
    for (const patch of [{ status: 'in_progress', conclusion: null }, { conclusion: 'failure' }, { conclusion: 'cancelled' }]) {
      const f = fixture();
      f.sourceRuns.push({ ...f.run, id: 50, event, head_branch: 'main', created_at: '2026-10-19T11:00:00Z', ...patch });
      assert.deepEqual(await decide(f.api, context), { reuse: false }, `${event} ${JSON.stringify(patch)}`);
    }
  }
});

test('current push is excluded, other-event success is no positive authority, and older reruns can veto', async () => {
  const f = fixture();
  f.sourceRuns.push({ ...f.run, id: context.runId, event: 'push', head_branch: 'main', status: 'in_progress', conclusion: null, created_at: '2026-10-19T12:00:00Z' });
  assert.equal((await decide(f.api, context)).reuse, true);
  f.runs = [];
  f.sourceRuns[0].conclusion = 'success'; f.sourceRuns[0].status = 'completed';
  assert.deepEqual(await decide(f.api, context), { reuse: false });
  const rerun = fixture();
  rerun.sourceRuns.push({ ...rerun.run, id: 50, event: 'workflow_dispatch', head_branch: 'main', created_at: '2026-10-19T09:00:00Z', run_attempt: 2, run_started_at: '2026-10-19T11:00:00Z', conclusion: 'failure' });
  assert.deepEqual(await decide(rerun.api, context), { reuse: false });
});

test('aggregate newly appearing contradictory full run fails, and ambiguous candidate provenance refuses', async () => {
  const f = fixture(); const proof = await verifyQueueProof(f.api, context);
  f.sourceRuns.push({ ...f.run, id: 50, event: 'workflow_dispatch', head_branch: 'main', created_at: '2026-10-19T11:00:00Z', conclusion: 'failure' });
  await assert.rejects(evaluateQueueResults(current(true, proof), context, f.api));
  for (const patch of [{ workflow_id: 1 }, { path: '.github/workflows/unrelated.yml' }, { repository: { id: 1 } }, { head_repository: { id: 1 } }]) {
    const other = fixture(); other.sourceRuns.push({ ...other.run, id: 50, event: 'workflow_dispatch', head_branch: 'main', ...patch });
    assert.deepEqual(await decide(other.api, context), { reuse: false });
  }
  const irrelevant = fixture();
  irrelevant.sourceRuns.push({ id: 50, event: 'pull_request', workflow_id: 1, conclusion: 'failure' });
  assert.equal((await decide(irrelevant.api, context)).reuse, true);
});
