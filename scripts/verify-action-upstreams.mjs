import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { discoverActions, IDENTITY, SHA, VERSION } from './workflow-actions.mjs';

export class UpstreamError extends Error {
  constructor(kind, message) { super(`${kind}: ${message}`); this.kind = kind; }
}
const invalid = message => { throw new UpstreamError('invalid', message); };
const requireEvidence = (condition, message) => { if (!condition) invalid(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const LIMITS = Object.freeze({ attempts: 3, timeoutMs: 15000, retryMs: 1000, responseBytes: 1024 * 1024, tagDepth: 8 });

// Only caller-constructed API routes are accepted; response URLs never become request authority.
export function createGitHubApi({ token, fetchImpl = globalThis.fetch, delay = sleep, limits = LIMITS } = {}) {
  const bounds = { ...LIMITS, ...limits };
  for (const key of Object.keys(LIMITS)) assert.ok(Number.isInteger(bounds[key]) && bounds[key] > 0 && bounds[key] <= LIMITS[key], `invalid ${key} bound`);
  return async function get(route, { allow404 = false } = {}) {
    assert.match(route, /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:git\/(?:ref\/tags\/v\d+\.\d+\.\d+|tags\/[0-9a-f]{40}|commits\/[0-9a-f]{40}|trees\/[0-9a-f]{40})|contents\/[A-Za-z0-9_./-]+\?ref=[0-9a-f]{40})$/);
    assert.ok(!route.split(/[/?]/).includes('..'), 'route traversal is forbidden');
    for (let attempt = 0; attempt < bounds.attempts; attempt++) {
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new UpstreamError('infrastructure', `request timeout for ${route}`)); }, bounds.timeoutMs);
        });
        const request = async () => {
          const response = await fetchImpl(`https://api.github.com${route}`, {
            method: 'GET', redirect: 'manual', signal: controller.signal,
            headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
              ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          });
          if (response.status >= 300 && response.status < 400) throw new UpstreamError('infrastructure', `redirect refused for ${route}`);
          if (response.status === 404) {
            await response.body?.cancel();
            if (allow404) return null;
            invalid(`missing upstream object at ${route}`);
          }
          if (!response.ok) {
            await response.body?.cancel();
            const error = new UpstreamError('infrastructure', `GitHub HTTP ${response.status} for ${route}`);
            error.retryable = response.status === 429 || response.status >= 500;
            throw error;
          }
          const length = response.headers.get('content-length');
          if (length && (!/^\d+$/.test(length) || Number(length) > bounds.responseBytes)) {
            await response.body?.cancel(); invalid(`oversize response for ${route}`);
          }
          requireEvidence(response.body, `missing response body for ${route}`);
          const reader = response.body.getReader();
          let bytes = 0; const chunks = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > bounds.responseBytes) { await reader.cancel(); invalid(`oversize response for ${route}`); }
              chunks.push(Buffer.from(value));
            }
          } finally { reader.releaseLock(); }
          try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { invalid(`malformed JSON for ${route}`); }
        };
        return await Promise.race([request(), timeout]);
      } catch (error) {
        const retryable = !(error instanceof UpstreamError) || error.retryable || error.message.includes('request timeout');
        if (!retryable || attempt + 1 === bounds.attempts) {
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('infrastructure', `transport failed for ${route}`);
        }
      } finally { clearTimeout(timer); controller.abort(); }
      await delay(bounds.retryMs);
    }
  };
}

function objectPointer(value, subject) {
  requireEvidence(record(value) && SHA.test(value.sha) && ['commit', 'tag'].includes(value.type), `${subject}: expected commit/tag object with immutable SHA`);
  return value;
}
function signature(value, subject) {
  requireEvidence(record(value) && typeof value.verified === 'boolean' && typeof value.reason === 'string', `${subject}: malformed signature evidence`);
  return { verified: value.verified, reason: value.reason };
}

export async function verifyActionUpstreams(occurrences, { api = createGitHubApi(), tagDepth = LIMITS.tagDepth } = {}) {
  assert.ok(Number.isInteger(tagDepth) && tagDepth > 0 && tagDepth <= LIMITS.tagDepth);
  const tags = new Map(), commits = new Map(), metadata = new Map(), trees = new Map(), results = [];
  const once = async (cache, key, work) => { if (!cache.has(key)) cache.set(key, await work()); return cache.get(key); };
  const unique = new Map(occurrences.filter(row => !row.local).map(row => [`${row.identity}@${row.revision}#${row.version}`, row]));
  for (const row of unique.values()) {
    requireEvidence(IDENTITY.test(row.identity) && SHA.test(row.revision) && VERSION.test(row.version), 'invalid inventory components');
    const parts = row.identity.split('/'), repo = parts.slice(0, 2).join('/'), subpath = parts.slice(2).join('/');
    const base = `/repos/${repo}`;
    const resolved = await once(tags, `${repo}#${row.version}`, async () => {
      const ref = await api(`${base}/git/ref/tags/${row.version}`);
      requireEvidence(record(ref) && ref.ref === `refs/tags/${row.version}`, `${repo}: wrong exact tag ref`);
      let object = objectPointer(ref.object, repo);
      const seen = new Set(), signatures = [];
      while (object.type === 'tag') {
        requireEvidence(seen.size < tagDepth && !seen.has(object.sha), `${repo}: excessive or cyclic annotated tag chain`);
        seen.add(object.sha);
        const tag = await api(`${base}/git/tags/${object.sha}`);
        requireEvidence(record(tag) && tag.sha === object.sha && typeof tag.tag === 'string', `${repo}: malformed annotated tag identity`);
        requireEvidence(signatures.length > 0 || tag.tag === row.version, `${repo}: wrong annotated release tag`);
        signatures.push({ sha: tag.sha, ...signature(tag.verification, repo) });
        object = objectPointer(tag.object, repo);
      }
      return { revision: object.sha, tags: signatures };
    });
    requireEvidence(resolved.revision === row.revision, `${row.identity} ${row.version}: tag/SHA mismatch (expected ${row.revision}, upstream ${resolved.revision})`);
    const commit = await once(commits, `${repo}@${row.revision}`, async () => {
      const value = await api(`${base}/git/commits/${row.revision}`);
      requireEvidence(record(value) && value.sha === row.revision, `${repo}: wrong commit identity`);
      requireEvidence(record(value.tree) && SHA.test(value.tree.sha), `${repo}: missing commit tree identity`);
      return { verification: signature(value.verification, repo), tree: value.tree.sha };
    });
    const metadataPath = await once(metadata, `${row.identity}@${row.revision}`, async () => {
      for (const filename of ['action.yml', 'action.yaml']) {
        const file = subpath ? `${subpath}/${filename}` : filename;
        const value = await api(`${base}/contents/${file}?ref=${row.revision}`, { allow404: true });
        if (value === null) continue;
        requireEvidence(record(value) && value.type === 'file' && value.path === file && value.name === filename && SHA.test(value.sha)
          && !Object.hasOwn(value, 'submodule_git_url') && !Object.hasOwn(value, 'target'), `${row.identity}: metadata must be a regular file at ${file}`);
        // Contents dereferences some symlinks. Git tree modes prove the metadata itself is regular.
        let treeSha = commit.tree;
        const segments = file.split('/');
        for (let index = 0; index < segments.length; index++) {
          const tree = await once(trees, `${repo}@${treeSha}`, async () => {
            const data = await api(`${base}/git/trees/${treeSha}`);
            requireEvidence(record(data) && SHA.test(data.sha) && data.truncated === false && Array.isArray(data.tree), `${repo}: malformed or truncated git tree`);
            requireEvidence(data.sha === treeSha, `${repo}: wrong git tree identity`);
            return data.tree;
          });
          const matches = tree.filter(entry => record(entry) && entry.path === segments[index]);
          requireEvidence(matches.length === 1 && SHA.test(matches[0].sha), `${row.identity}: missing or ambiguous metadata tree entry`);
          const entry = matches[0];
          const terminal = index === segments.length - 1;
          requireEvidence(terminal ? entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) && entry.sha === value.sha
            : entry.type === 'tree' && entry.mode === '040000', `${row.identity}: metadata path must contain only trees and a regular file`);
          treeSha = entry.sha;
        }
        return file;
      }
      invalid(`${row.identity}: missing action metadata at ${row.revision}`);
    });
    results.push({ identity: row.identity, version: row.version, revision: row.revision, metadata: metadataPath,
      signatures: { commit: commit.verification, tags: resolved.tags } });
  }
  return results;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const results = await verifyActionUpstreams(discoverActions(root), { api: createGitHubApi({ token: process.env.GITHUB_TOKEN }) });
  for (const row of results) console.log(JSON.stringify(row));
  console.log(`Verified ${results.length} distinct action pins; signatures are diagnostic, not code-safety approval.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
