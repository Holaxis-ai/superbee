import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isMainModule } from './is-main-module.mjs';
import { evaluateResults } from '../.github/actions/ci-gate/evaluate.mjs';

const manifestBytes = readFileSync(new URL('./ci-lanes.json', import.meta.url));
export const manifest = JSON.parse(manifestBytes);
export const policyDigest = createHash('sha256').update(manifestBytes).digest('hex');
const policy = manifest.queue_reuse;
const positive = n => Number.isSafeInteger(n) && n > 0;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const requireProof = (condition, message) => assert.ok(condition, message);
export function expectedQueueJobs() {
  const names = [policy.decision_name, ...Object.values(policy.aggregates)];
  for (const lane of Object.values(manifest.lanes)) {
    for (const node of lane.nodes) {
      for (let shard = 1; shard <= (lane.shards ?? 1); shard++) {
        const name = lane.display_name.replace('${{ matrix.node-version }}', String(node)).replace('${{ matrix.shard }}', String(shard));
        if (!names.includes(name)) names.push(name);
      }
    }
  }
  return names.sort();
}

// Routes are constructed locally. Provider URLs and redirect destinations are never request authority.
export function createQueueApi({ token, fetchImpl = fetch } = {}) {
  return async route => {
    const prefix = `/repos/${policy.repository}/`;
    requireProof(route.startsWith(prefix) && /^[/A-Za-z0-9_.?=&%-]+$/.test(route) && !route.includes('..'), 'invalid API route');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(`https://api.github.com${route}`, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      requireProof(response.ok, 'GitHub API unavailable');
      requireProof(response.body, 'missing API body');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        requireProof(bytes <= 2 * 1024 * 1024, 'API response too large');
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

async function collection(api, route, key) {
  const rows = []; let count;
  for (let page = 1; page <= 10; page++) {
    const body = await api(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    requireProof(record(body) && Number.isSafeInteger(body.total_count) && body.total_count >= 0 && body.total_count <= 1000 && Array.isArray(body[key]), 'incomplete API collection');
    count ??= body.total_count;
    requireProof(count === body.total_count && body[key].length <= 100, 'changing API pagination');
    rows.push(...body[key]);
    if (rows.length === count) return rows;
    requireProof(rows.length < count && body[key].length === 100, 'incomplete API pagination');
  }
  throw new Error('API pagination exhausted');
}

export function eligible(context) {
  return context.event === 'push' && context.ref === 'refs/heads/main' && context.attempt === 1 &&
    context.repository === policy.repository && context.repositoryId === policy.repository_id && /^[a-f0-9]{40}$/.test(context.sha);
}
function validRun(run, sha) {
  requireProof(record(run) && positive(run.id) && positive(run.run_attempt) && positive(run.check_suite_id), 'invalid run identity');
  requireProof(run.repository?.id === policy.repository_id && run.head_repository?.id === policy.repository_id &&
    run.repository.full_name === policy.repository && run.head_repository.full_name === policy.repository, 'untrusted repository');
  requireProof(run.head_sha === sha && run.event === 'merge_group' && run.workflow_id === policy.workflow_id && run.path === policy.workflow_path &&
    /^gh-readonly-queue\/main\/.+/.test(run.head_branch), 'wrong workflow source');
  requireProof(Array.isArray(run.referenced_workflows) && run.referenced_workflows.length === 0, 'unexpected reusable workflow');
  requireProof(run.status === 'completed' && run.conclusion === 'success', 'queue proof is not successful');
}
async function newestRun(api, sha) {
  const rows = await collection(api, `/repos/${policy.repository}/actions/workflows/${policy.workflow_id}/runs?head_sha=${sha}&event=merge_group`, 'workflow_runs');
  requireProof(rows.length > 0 && rows.every(run => positive(run.id) && run.event === 'merge_group' && run.head_sha === sha && run.workflow_id === policy.workflow_id), 'missing or ambiguous queue runs');
  requireProof(new Set(rows.map(run => run.id)).size === rows.length, 'duplicate queue runs');
  requireProof(rows.every(run => typeof run.created_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(run.created_at) && Number.isFinite(Date.parse(run.created_at))), 'invalid run creation time');
  rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  requireProof(rows.length === 1 || rows[0].created_at !== rows[1].created_at, 'ambiguous newest run');
  return rows[0];
}
const identity = run => ({ run: run.id, attempt: run.run_attempt, suite: run.check_suite_id });
export async function verifyQueueProof(api, context) {
  requireProof(eligible(context), 'event requires full CI');
  const listed = await newestRun(api, context.sha);
  const base = `/repos/${policy.repository}`;
  const run = await api(`${base}/actions/runs/${listed.id}`);
  validRun(run, context.sha);
  requireProof(JSON.stringify(identity(run)) === JSON.stringify(identity(listed)), 'run changed after listing');
  const jobs = await collection(api, `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  requireProof(JSON.stringify(jobs.map(job => job.name).sort()) === JSON.stringify(expectedQueueJobs()), 'incomplete queue job topology');
  requireProof(new Set(jobs.map(job => job.id)).size === jobs.length, 'duplicate job IDs');
  for (const job of jobs) {
    requireProof(positive(job.id) && job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === context.sha &&
      job.status === 'completed' && job.conclusion === 'success', 'unsuccessful or unrelated queue job');
    requireProof(job.check_run_url === `https://api.github.com${base}/check-runs/${job.id}`, 'untrusted check URL');
    const check = await api(`${base}/check-runs/${job.id}`);
    requireProof(check.id === job.id && check.name === job.name && check.head_sha === context.sha && check.check_suite?.id === run.check_suite_id &&
      check.app?.id === policy.app_id && check.app?.slug === 'github-actions' && check.status === 'completed' && check.conclusion === 'success', 'untrusted native check');
  }
  const final = await api(`${base}/actions/runs/${run.id}`);
  validRun(final, context.sha);
  const newest = await newestRun(api, context.sha);
  validRun(newest, context.sha);
  requireProof(JSON.stringify(identity(final)) === JSON.stringify(identity(run)) && JSON.stringify(identity(newest)) === JSON.stringify(identity(run)), 'queue evidence superseded');
  return { ...identity(run), sha: context.sha, policy: policyDigest };
}
export async function decide(api, context) {
  if (!eligible(context)) return { reuse: false };
  try { return { reuse: true, proof: await verifyQueueProof(api, context) }; }
  catch { return { reuse: false }; }
}
export async function evaluateQueueResults(results, context, api) {
  requireProof(record(results), 'missing current results');
  requireProof(JSON.stringify(Object.keys(results).sort()) === JSON.stringify([...manifest.required_jobs, policy.decision_job].sort()), 'current job topology mismatch');
  const lanes = Object.fromEntries(manifest.required_jobs.map(name => [name, results[name]]));
  const full = evaluateResults(lanes, manifest.required_jobs.map(job => ({ job, required: true })));
  if (full.ok) return;
  requireProof(eligible(context) && results[policy.decision_job]?.result === 'success', 'missing successful reuse decision');
  const output = results[policy.decision_job].outputs;
  requireProof(record(output) && output.reuse === 'true' && typeof output.proof === 'string', 'missing reuse proof');
  const prior = JSON.parse(output.proof);
  const current = await verifyQueueProof(api, context);
  requireProof(JSON.stringify(prior) === JSON.stringify(current), 'reuse proof is stale');
  const admitted = evaluateResults(lanes, manifest.required_jobs.map(job => ({ job, required: job === policy.always_full_job })));
  requireProof(admitted.ok, 'current required results do not match reuse policy');
  for (const job of manifest.required_jobs) requireProof(lanes[job]?.result === (job === policy.always_full_job ? 'success' : 'skipped'), 'unexpected reuse lane result');
}
export function contextFromEnv(env) {
  return { event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha: env.GITHUB_SHA, attempt: Number(env.GITHUB_RUN_ATTEMPT),
    repository: env.GITHUB_REPOSITORY, repositoryId: Number(env.GITHUB_REPOSITORY_ID) };
}
export async function main(env = process.env, api = createQueueApi({ token: env.GITHUB_TOKEN }), mode = process.argv[2]) {
  const context = contextFromEnv(env);
  if (mode === 'decision') {
    const result = await decide(api, context);
    appendFileSync(env.GITHUB_OUTPUT, `reuse=${result.reuse}\nproof=${result.proof ? JSON.stringify(result.proof) : ''}\n`);
    return;
  }
  requireProof(mode === 'aggregate', 'unknown queue proof mode');
  try {
    await evaluateQueueResults(JSON.parse(env.REQUIRED_RESULTS_JSON), context, api);
    if (env.GITHUB_STEP_SUMMARY) {
      const results = JSON.parse(env.REQUIRED_RESULTS_JSON);
      const reused = results[policy.decision_job]?.outputs?.reuse === 'true' && results.runtime?.result === 'skipped';
      const proof = reused ? JSON.parse(results[policy.decision_job].outputs.proof) : undefined;
      appendFileSync(env.GITHUB_STEP_SUMMARY, reused
        ? `Verified exact-source queue [run ${proof.run}, attempt ${proof.attempt}](https://github.com/${policy.repository}/actions/runs/${proof.run}/attempts/${proof.attempt}), native check suite ${proof.suite}, source ${proof.sha}, policy ${proof.policy}; current engines-floor smoke succeeded.\n`
        : 'All current required CI lanes succeeded.\n');
    }
  } catch {
    throw new Error('Required CI proof rejected. Run a full CI tests workflow_dispatch on this exact source to recover.');
  }
}
if (isMainModule(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
