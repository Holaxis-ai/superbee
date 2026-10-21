import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { notesStartTag } from './release-notes-start-tag.mjs';

const tags = [
  'v0.1.4', 'v0.4.1-pre.1', 'v0.4.1', 'v0.4.2-pre.4', 'v0.4.2', 'v0.4.3-pre.9', 'v0.4.3-pre.10',
  'v0.4.3-pre.23', 'v0.4.3', 'libraries/v0.2.0-pre.34', 'cli/v0.1.0', 'v9.9.9-junk!', 'release-x',
];

test('a stable release starts its notes at the previous stable tag', () => {
  assert.equal(notesStartTag('0.4.3', tags), 'v0.4.2');
  assert.equal(notesStartTag('0.4.2', tags), 'v0.4.1');
  assert.equal(notesStartTag('0.4.4', tags), 'v0.4.3', 'prerelease tags of the same base do not count');
});

test('a prerelease starts at the previous tag of any kind, ordered by semver', () => {
  assert.equal(notesStartTag('0.4.3-pre.23', tags), 'v0.4.3-pre.10', 'numeric prerelease order, not text order');
  assert.equal(notesStartTag('0.4.3-pre.10', tags), 'v0.4.3-pre.9');
  assert.equal(notesStartTag('0.4.4-pre.1', tags), 'v0.4.3', 'a stable release outranks its own prereleases');
});

test('only v-prefixed strict semver tags below the version qualify', () => {
  assert.equal(notesStartTag('0.1.4', tags), null);
  assert.equal(notesStartTag('0.2.0', ['libraries/v0.1.9', 'cli/v0.1.0']), null);
  assert.throws(() => notesStartTag('v0.4.3', tags), /invalid release version/);
});

test('the command prints the start tag, or nothing when there is none', () => {
  const run = (version, input) => execFileSync(process.execPath, ['scripts/release-notes-start-tag.mjs', version], { input, encoding: 'utf8' });
  assert.equal(run('0.4.3', tags.join('\n')), 'v0.4.2\n');
  assert.equal(run('0.1.4', tags.join('\n')), '');
});
