import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { inspectConsumerImpact } from './final-candidate-consumer-impact.mjs';
import { withRetainedTarball } from './cli-library-proof.mjs';
import { assertIntegrity } from '../packages/package-verification/src/harness.mjs';
import { isMainModule } from './is-main-module.mjs';

export const PRODUCER = 'Holaxis-ai/superbee';
export const CONSUMER = 'Holaxis-ai/superbee-plugins';
const sha = value => { assert.match(value ?? '', /^[a-f0-9]{40}$/); return value; };
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const pin = value => { assert.match(value ?? '', /^(?:sha256:)?[a-f0-9]{64}$/); return value.replace(/^sha256:/, ''); };
const root = repo => `repos/${repo}`;
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
const allowed = repo => [`https://github.com/${repo}.git`, `https://github.com/${repo}`, `git@github.com:${repo}.git`];
const verified = new WeakMap();
function checkCheckoutPins(options) {
  for (const [directory, commit] of [[options.candidateRoot, options.candidateSha], [options.pluginRoot, options.pluginSha]]) {
    assert.equal(git(directory, 'rev-parse', 'HEAD'), commit, 'checkout changed during handoff; replan');
    assert.equal(git(directory, 'status', '--porcelain', '--untracked-files=no'), '', 'tracked source changed during handoff; replan');
  }
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const member of Object.values(value)) freeze(member); Object.freeze(value); }
  return value;
}
const contents = (io, commit, file) => io.api('GET', `${root(CONSUMER)}/contents/${file}?ref=${sha(commit)}`).then(value => {
  assert.equal(value.type, 'file'); assert.equal(value.encoding, 'base64');
  return Buffer.from(value.content, 'base64').toString('utf8');
});
const assertBase = async (io, expected) => {
  const branch = await io.api('GET', `${root(CONSUMER)}/branches/main`);
  assert.equal(branch.commit.sha, expected, 'plugin base changed; prepare a fresh handoff before any draft mutation');
};

export function githubTransport() {
  assert.ok(!process.env.GH_HOST || process.env.GH_HOST === 'github.com', 'handoff uses github.com only');
  return {
    async api(method, route, input) {
      const args = ['api', '--hostname', 'github.com', '--method', method, route];
      if (input !== undefined) args.push('--input', '-');
      const text = execFileSync('gh', args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      return text ? JSON.parse(text) : undefined;
    },
    async registry(name, version) {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      assert.ok(response.ok, `registry evidence unavailable for ${name}@${version}; retry without mutation`);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= 4 * 1024 * 1024, 'registry metadata exceeds handoff bound'); chunks.push(chunk); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
    async log(job) {
      return execFileSync('gh', ['api', '--hostname', 'github.com', '--allow-escape-sequences', `${root(PRODUCER)}/actions/jobs/${job}/logs`], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    },
    async attest(file, tag, workflow) {
      execFileSync('gh', ['attestation', 'verify', file, '-R', PRODUCER, '--signer-workflow', `${PRODUCER}/.github/workflows/${workflow}`, '--source-ref', `refs/tags/${tag}`, '--format', 'json'], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    },
  };
}

async function tagCommit(io, tag) {
  let object = (await io.api('GET', `${root(PRODUCER)}/git/ref/tags/${tag}`)).object;
  for (let depth = 0; object.type === 'tag' && depth < 4; depth++) object = (await io.api('GET', `${root(PRODUCER)}/git/tags/${sha(object.sha)}`)).object;
  assert.equal(object.type, 'commit', 'native source tag must resolve to a commit');
  return sha(object.sha);
}

async function coreTree(io, commit) {
  const entry = async (tree, name) => {
    const row = (await io.api('GET', `${root(PRODUCER)}/git/trees/${tree}`)).tree.find(row => row.path === name);
    assert.equal(row?.type, 'tree'); return sha(row.sha);
  };
  return entry(await entry(commit, 'packages'), 'core');
}

async function publication(io, options, report, cliSnapshot, coreSnapshot) {
  const version = report.candidate.core;
  assert.ok(Number.isSafeInteger(options.finalizerRun) && options.finalizerRun > 0, 'exact successful Core/Server finalizer run is required');
  const route = `${root(PRODUCER)}/actions/runs/${options.finalizerRun}`;
  const run = await io.api('GET', route);
  assert.equal(run.repository.full_name, PRODUCER); assert.equal(run.path, '.github/workflows/release-libraries-finalize.yml');
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success', 'Core/Server finalizer is not verified');
  const jobs = (await io.api('GET', `${route}/jobs?per_page=100`)).jobs;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].conclusion, 'success');
  assert.equal(jobs[0].name, 'verify both registry artifacts and attestations');
  const log = (await io.log(jobs[0].id)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const versions = [...log.matchAll(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+V: (\S+)\s*$/gm)].map(match => match[1]);
  assert.ok(versions.length > 0 && versions.every(value => value === version), 'native finalizer logs do not bind the exact Core version');
  const [core, server] = await Promise.all([io.registry('@superbee/core', version), io.registry('@superbee/server', version)]);
  assert.equal(core.name, '@superbee/core'); assert.equal(core.version, version);
  assert.equal(server.name, '@superbee/server'); assert.equal(server.version, version);
  assert.equal(server.dependencies?.['@superbee/core'], version, 'published pair is incomplete or divergent');
  assert.match(server.dist?.integrity ?? '', /^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/, 'published Server integrity is missing');
  assertIntegrity(await readFile(coreSnapshot), core.dist?.integrity);
  const coreCommit = await tagCommit(io, `libraries/v${version}`);
  assert.equal(await coreTree(io, coreCommit), git(options.candidateRoot, 'rev-parse', `${options.candidateSha}:packages/core`), 'candidate Core source differs from its published library tag');
  assert.equal(await tagCommit(io, `v${report.candidate.cli}`), options.candidateSha, 'CLI source tag differs from the actual final candidate');
  await io.attest(coreSnapshot, `libraries/v${version}`, 'release-libraries.yml');
  await io.attest(cliSnapshot, `v${report.candidate.cli}`, 'release.yml');
  return { finalizer_run: options.finalizerRun, core_source_sha: coreCommit, registry_integrity: core.dist.integrity, server_registry_integrity: server.dist.integrity,
    core_tag: `libraries/v${version}`, cli_tag: `v${report.candidate.cli}`, attestations: 'exact retained Core and CLI bytes verified against native signer workflows and source tags' };
}

async function openProposals(io) {
  const rows = [];
  for (let page = 1; ; page++) {
    const next = await io.api('GET', `${root(CONSUMER)}/pulls?state=open&base=main&per_page=100&page=${page}`);
    assert.ok(Array.isArray(next)); rows.push(...next);
    if (next.length < 100) return rows;
    assert.ok(page < 20, 'too many open proposals to establish unique ownership');
  }
}

async function existingProposal(io, plan) {
  const matches = [];
  for (const pr of await openProposals(io)) {
    assert.equal(pr.base.repo.full_name, CONSUMER);
    // Foreign forks remain with their owners; reading them must not grant this command writes.
    assert.equal(pr.head.repo?.full_name, CONSUMER, 'an open fork PR needs an owner check before companion creation');
    const pkg = JSON.parse(await contents(io, pr.head.sha, 'integrations/github/package.json'));
    if (pkg.superbeeIntegration?.core !== plan.impact.candidate.core) continue;
    const exact = (await Promise.all(plan.files.map(async row => (await contents(io, pr.head.sha, row.file)) === row.content))).every(Boolean);
    matches.push({ number: pr.number, url: pr.html_url, draft: pr.draft, head_sha: sha(pr.head.sha), base_sha: sha(pr.base.sha), exact_machine_files: exact,
      managed_key_matches: (pr.body ?? '').includes(`<!-- superbee-core-companion:${plan.key} -->`) });
  }
  assert.ok(matches.length <= 1, 'multiple Core companion owners exist; coordinate rather than creating another draft');
  const match = matches[0];
  if (match) {
    assert.equal(match.base_sha, plan.base_sha, 'existing companion base changed; owner must refresh its evidence');
    assert.ok(match.exact_machine_files, 'existing Core companion has different exact files; coordinate with its owner');
  }
  return match;
}

function draftBody(plan) {
  const { candidate, archives } = plan.impact;
  return `<!-- superbee-core-companion:${plan.key} -->\nPrepare the Git checkout GitHub plugin for exact Core ${candidate.core}.\n\n` +
    `Source: ${PRODUCER}@${candidate.source_sha}. CLI: ${candidate.cli}.\nCLI archive: ${archives.cli.sha256}. Core archive: ${archives.core.sha256}.\n` +
    `Verified Core/Server finalizer: https://github.com/${PRODUCER}/actions/runs/${plan.publication.finalizer_run}.\nCore registry integrity: ${plan.publication.registry_integrity}.\n` +
    `Native CLI/Core attestations and Core source-tree equality checked. Base lease: ${CONSUMER}@${plan.base_sha} (main).\n\n` +
    `This is a draft metadata proposal. CLI npm approval/finalization, actual proposed-checkout build and installed archive tests, README/install review, normal review and CI remain required before the owning maintainer merges it. If base, head, source or archive changes, rerun the handoff. No ranges widened, plugin npm publication, automatic registration or downstream merge.\n`;
}

export async function prepareHandoff(options, io = githubTransport()) {
  assert.ok(options.cliTarball && options.coreTarball, 'actual retained CLI and Core archives are required');
  const cliPin = pin(options.cliSha256), corePin = pin(options.coreSha256);
  assert.ok(allowed(PRODUCER).includes(git(options.candidateRoot, 'remote', 'get-url', 'origin')), 'candidate must use the verified producer repository');
  assert.ok(allowed(CONSUMER).includes(git(options.pluginRoot, 'remote', 'get-url', 'origin')), 'plugin must use the verified consumer repository');
  return withRetainedTarball(options.cliTarball, (cliSnapshot, cliHash) => withRetainedTarball(options.coreTarball, async (coreSnapshot, coreHash) => {
    assert.equal(cliHash, cliPin, 'retained CLI hash changed'); assert.equal(coreHash, corePin, 'retained Core hash changed');
    const impact = inspectConsumerImpact({ ...options, cliTarball: cliSnapshot, coreTarball: coreSnapshot });
    const repo = await io.api('GET', root(CONSUMER));
    assert.equal(repo.full_name, CONSUMER); assert.equal(repo.default_branch, 'main');
    await assertBase(io, options.pluginSha);
    const proof = await publication(io, options, impact, cliSnapshot, coreSnapshot);
    const plan = { schema: 'superbee.core-github-handoff.v1', repository: CONSUMER, base_branch: 'main', base_sha: options.pluginSha,
      key: hash(JSON.stringify([CONSUMER, options.pluginSha, impact.proposal.key])), impact, publication: proof, files: impact.proposal.files };
    plan.branch = `codex/core-companion-${plan.key.slice(7, 27)}`;
    plan.title = `Prepare GitHub plugin for exact Core ${impact.candidate.core}`;
    plan.body = draftBody(plan);
    plan.existing = await existingProposal(io, plan);
    plan.status = plan.existing ? 'existing-owner-handoff' : plan.files.length ? 'draft-plan' : 'compatible';
    plan.next_action = plan.existing ? 'Give this exact evidence to the existing owner; this command does not rewrite their PR.' : 'Review the exact proposal and invoke --create-draft explicitly if a new draft is needed.';
    checkCheckoutPins(options);
    await assertBase(io, options.pluginSha);
    verified.set(plan, { ...options });
    return freeze(plan);
  }));
}

export async function createDraft(plan, io) {
  const options = verified.get(plan);
  assert.ok(options, 'draft creation requires a fresh verified handoff in this invocation, never restored JSON');
  checkCheckoutPins(options);
  if (plan.existing || !plan.files.length) return plan;
  await assertBase(io, plan.base_sha);
  assert.ok((await io.api('GET', root(CONSUMER))).permissions?.push, 'existing GitHub session lacks consumer push access; no credentials or permissions are provisioned');
  // Re-discover immediately before mutation; another owner may have opened a proposal since proof.
  const existing = await existingProposal(io, plan);
  if (existing) return { ...plan, status: 'existing-owner-handoff', existing };
  const closed = await io.api('GET', `${root(CONSUMER)}/pulls?state=closed&base=main&head=${encodeURIComponent(`Holaxis-ai:${plan.branch}`)}&per_page=100`);
  if (closed.length) return { ...plan, status: 'closed-proposal-held', next_action: 'An owner closed this exact native branch proposal; coordinate before proposing it again.', closed: closed.map(pr => ({ number: pr.number, url: pr.html_url })) };
  for (const row of plan.files) assert.equal(hash(await contents(io, plan.base_sha, row.file)), row.expected_sha256, 'base file precondition changed');
  const base = await io.api('GET', `${root(CONSUMER)}/git/commits/${plan.base_sha}`);
  const tree = await io.api('POST', `${root(CONSUMER)}/git/trees`, { base_tree: base.tree.sha, tree: plan.files.map(row => ({ path: row.file, mode: '100644', type: 'blob', content: row.content })) });
  const refs = await io.api('GET', `${root(CONSUMER)}/git/matching-refs/heads/${plan.branch}`);
  let commit;
  if (refs.length) {
    assert.equal(refs.length, 1); assert.equal(refs[0].ref, `refs/heads/${plan.branch}`);
    commit = sha(refs[0].object.sha);
    const prior = await io.api('GET', `${root(CONSUMER)}/git/commits/${commit}`);
    assert.deepEqual(prior.parents.map(row => row.sha), [plan.base_sha], 'existing branch base differs; never overwrite it');
    assert.equal(prior.message, `${plan.title}\n\nHandoff ${plan.key}`, 'existing branch is not this exact proposal');
    assert.equal(prior.tree.sha, tree.sha, 'existing branch has other changes; never overwrite it');
    for (const row of plan.files) assert.equal(await contents(io, commit, row.file), row.content, 'existing branch differs; never overwrite it');
  } else {
    commit = sha((await io.api('POST', `${root(CONSUMER)}/git/commits`, { message: `${plan.title}\n\nHandoff ${plan.key}`, tree: tree.sha, parents: [plan.base_sha] })).sha);
    await assertBase(io, plan.base_sha);
    try { await io.api('POST', `${root(CONSUMER)}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: commit }); }
    catch { return { ...plan, status: 'branch-outcome-unknown', created_branch: { branch: plan.branch, sha: commit }, next_action: 'Inspect the native branch before retrying. A later invocation may reuse only the exact expected tree and parent.' }; }
  }
  try { checkCheckoutPins(options); await assertBase(io, plan.base_sha); }
  catch { return { ...plan, status: 'branch-base-changed', created_branch: { branch: plan.branch, sha: commit }, next_action: 'Branch retained; source or base changed. Replan before opening a draft.' }; }
  let pr;
  try { pr = await io.api('POST', `${root(CONSUMER)}/pulls`, { base: 'main', head: plan.branch, title: plan.title, body: plan.body, draft: true }); }
  catch {
    // A lost response may follow a successful create. Re-discover before any retry or new PR.
    try {
      const seen = await existingProposal(io, plan);
      if (seen) return { ...plan, status: 'existing-owner-handoff', existing: seen };
    } catch { /* Preserve the known branch and report the uncertain native outcome below. */ }
    return { ...plan, status: 'draft-outcome-unknown', created_branch: { branch: plan.branch, sha: commit }, next_action: 'Read native PR/branch state before retrying. No branch overwrite or downstream merge is permitted.' };
  }
  const status = pr.draft !== true ? 'draft-state-uncertain' : pr.head.sha !== commit ? 'draft-head-changed' : pr.base.sha === plan.base_sha ? 'draft-created' : 'draft-base-changed';
  return { ...plan, status, created: { number: pr.number, url: pr.html_url, head_sha: pr.head.sha, expected_head_sha: commit, base_sha: pr.base.sha },
    next_action: status === 'draft-created' ? 'Existing owner/review/CI and release approval gates remain; do not merge automatically.' : 'Native proposal state changed during creation. Owner must inspect and replan before review or merge.' };
}

export async function main(argv = process.argv.slice(2)) {
  const names = ['candidate', 'candidate-sha', 'plugin', 'plugin-sha', 'cli-tarball', 'core-tarball', 'cli-sha256', 'core-sha256', 'core-finalizer-run'];
  const { values } = parseArgs({ args: argv, options: { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])), 'create-draft': { type: 'boolean' } } });
  assert.ok(!values['create-draft'] || !process.env.GITHUB_ACTIONS, 'draft creation is an explicit operator route; no automatic Actions authority is configured');
  const options = { candidateRoot: values.candidate, candidateSha: values['candidate-sha'], pluginRoot: values.plugin, pluginSha: values['plugin-sha'], cliTarball: values['cli-tarball'], coreTarball: values['core-tarball'], cliSha256: values['cli-sha256'], coreSha256: values['core-sha256'], finalizerRun: Number(values['core-finalizer-run']) };
  const io = githubTransport();
  let plan = await prepareHandoff(options, io);
  if (values['create-draft']) plan = await createDraft(plan, io);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exitCode = ['draft-base-changed', 'draft-head-changed', 'draft-state-uncertain', 'branch-base-changed', 'branch-outcome-unknown', 'draft-outcome-unknown', 'closed-proposal-held'].includes(plan.status) ? 3 : 0;
}

if (isMainModule(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 2; });
