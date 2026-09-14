import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export function exactKeys(value, keys) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
export function normalizeDocument(bytes) {
  const split = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(bytes);
  assert.ok(split, 'document must have a frontmatter boundary');
  // Only the fixture-owned generated.at field; never body text or timestamp-like unknown fields.
  const header = split[1].replace(/(^generated:\n  by: ['"]?process:parity['"]?\n  at: )(['"]?)(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\2(?=\n|$)/m,
    (_, prefix, quote, value) => { assert.equal(new Date(value).toISOString(), value); return `${prefix}${quote}<generated-at>${quote}`; });
  return `---\n${header}\n---\n${split[2]}`;
}
export function canonicalCommand(command, root, versions) {
  const { label, result } = command;
  assert.equal(result.failure, null, `${label}: ${result.failure}`); assert.equal(result.signal, null, label);
  const replaceRoots = (text) => text.replaceAll(root, '<fixture>');
  function channel(text) {
    let value;
    try { value = JSON.parse(text); } catch {
      // Refusal text keeps every byte except exact verified version tokens and fixture roots.
      if (label === 'stale-cas') for (const [token, alias] of Object.entries(versions)) text = text.replaceAll(token, alias);
      return replaceRoots(text);
    }
    if (Array.isArray(value)) return value;
    for (const key of ['root', 'path']) if (typeof value[key] === 'string') value[key] = replaceRoots(value[key]);
    if (Array.isArray(value.help)) value.help = value.help.map(replaceRoots);
    if (['write-a','write-b','update-a','read-a','read-updated','read-linked','link'].includes(label)) {
      for (const key of ['version','head_version']) if (Object.hasOwn(value, key)) {
        assert.ok(versions[value[key]], `${label}: unverified token`); value[key] = versions[value[key]];
      }
      if (value.generated?.at !== undefined) {
        assert.equal(value.generated.by, 'process:parity'); assert.equal(new Date(value.generated.at).toISOString(), value.generated.at);
        value.generated.at = '<generated-at>';
      }
    }
    if (label === 'list') for (const row of value.docs) {
      if (row.id === 'notes/a') { assert.equal(new Date(row.timestamp).toISOString(), row.timestamp); row.timestamp = '<generated-at>'; }
    }
    return value;
  }
  return { label, code: result.code, signal: result.signal, failure: result.failure, stdout: channel(result.stdout), stderr: channel(result.stderr) };
}
export function compare(baseline, candidate) {
  const differences = [];
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(candidate)])) {
    if (!isDeepStrictEqual(baseline[key], candidate[key])) differences.push({ scenario: key, baseline: baseline[key], candidate: candidate[key] });
  }
  return { pass: differences.length === 0, differences };
}
export function assertNoWindowsInputs(manifest) {
  exactKeys(manifest, ['schema', 'source', 'artifact_sha256', 'inputs']);
  assert.equal(manifest.schema, 'superbee.windows-extraction.inputs.v1');
  assert.match(manifest.source, /^[a-f0-9]{40}$/); assert.match(manifest.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.inputs) && manifest.inputs.length > 0);
  for (const input of manifest.inputs) {
    assert.equal(typeof input, 'string'); assert.ok(input.length > 0);
    assert.doesNotMatch(input, /(?:^|[/\\@._-])(?:windows|win32)(?:$|[/\\@._-])/i, `Windows input: ${input}`);
  }
}
