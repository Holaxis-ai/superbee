import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const SEGMENT = '[A-Za-z0-9_][A-Za-z0-9_.-]*';
export const IDENTITY = new RegExp(`^${SEGMENT}/${SEGMENT}(?:/${SEGMENT})*$`);
export const SHA = /^[0-9a-f]{40}$/;
export const VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REMOTE = new RegExp(`^(${SEGMENT}/${SEGMENT}(?:/${SEGMENT})*)@([0-9a-f]{40})$`);
const REMOTE_LINE = /^\s*(?:-\s+)?uses: (\S+)\s+#\s+(v\d+\.\d+\.\d+)\s*$/;
const LOCAL_LINE = /^\s*(?:-\s+)?uses: (\.\/[A-Za-z0-9_./-]+)\s*(?:#.*)?$/;
const mapping = (value, label) => assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a mapping`);

export function validateIdentities(identities) {
  assert.ok(Array.isArray(identities), 'github_actions.identities must be an array');
  const set = new Set();
  for (const identity of identities) {
    assert.equal(typeof identity, 'string');
    assert.match(identity, IDENTITY, `malformed approved identity ${identity}`);
    assert.ok(!set.has(identity), `duplicate approved identity ${identity}`);
    set.add(identity);
  }
  return set;
}

export function actionIdentity(value) {
  assert.equal(typeof value, 'string', 'uses must be a scalar string');
  const match = REMOTE.exec(value);
  assert.ok(match, `uses must have a full lowercase 40-hex revision: ${value}`);
  return match[1];
}

// Canonical source positions are paired with semantic positions, never matched by value alone.
// Restricting executable uses to block mappings makes aliases, flow maps and comment decoys fail closed.
export function parseActionDocument(text, file, { composite = false, identities } = {}) {
  const document = yaml.safeLoad(text);
  mapping(document, file);
  const semantic = [];
  const addSteps = (steps, location) => {
    assert.ok(Array.isArray(steps), `${file} ${location} must be an array`);
    steps.forEach((step, index) => {
      mapping(step, `${file} ${location}[${index}]`);
      if (Object.hasOwn(step, 'uses')) semantic.push({ value: step.uses, location: `${location}[${index}]` });
    });
  };
  if (composite) {
    mapping(document.runs, `${file} runs`);
    assert.equal(document.runs.using, 'composite', `${file} only local composite actions are supported`);
    addSteps(document.runs.steps, 'runs.steps');
  } else {
    mapping(document.jobs, `${file} jobs`);
    for (const [name, job] of Object.entries(document.jobs)) {
      mapping(job, `${file} jobs.${name}`);
      assert.ok(!Object.hasOwn(job, 'uses'), `${file} jobs.${name}: reusable workflows are unsupported`);
      if (job.steps !== undefined) addSteps(job.steps, `jobs.${name}.steps`);
    }
  }
  const source = new Map();
  let section = false, job, steps = false, step = -1;
  const stepIndent = composite ? 4 : 6;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      section = line === (composite ? 'runs:' : 'jobs:');
      steps = false;
      continue;
    }
    if (!section) continue;
    if (!composite && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      job = line.trim().slice(0, -1); steps = false;
      continue;
    }
    const indent = composite ? 2 : 4;
    if (new RegExp(`^ {${indent}}steps:\\s*$`).test(line)) {
      steps = true; step = -1; continue;
    }
    if (new RegExp(`^ {0,${indent}}\\S`).test(line)) { steps = false; continue; }
    if (!steps) continue;
    if (new RegExp(`^ {${stepIndent}}-\\s`).test(line)) step++;
    if (!new RegExp(`^(?: {${stepIndent}}- | {${stepIndent + 2}})uses:`).test(line)) continue;
    const remote = REMOTE_LINE.exec(line);
    const local = LOCAL_LINE.exec(line);
    assert.ok(remote || local, `${file}:${index + 1} uses requires canonical same-line action@sha # vX.Y.Z syntax`);
    const location = composite ? `runs.steps[${step}]` : `jobs.${job}.steps[${step}]`;
    assert.ok(!source.has(location), `${file} duplicate source uses at ${location}`);
    source.set(location, { value: (remote ?? local)[1], version: remote?.[2], line: index + 1 });
  }
  assert.equal(source.size, semantic.length, `${file} semantic/source uses occurrence mismatch`);
  const occurrences = semantic.map(({ value, location }) => {
    const raw = source.get(location);
    assert.equal(typeof value, 'string', `${file} ${location} uses must be a scalar string`);
    assert.equal(raw?.value, value, `${file} ${location} semantic/source uses mismatch`);
    if (value.startsWith('./')) return { file, location, ...raw, local: true };
    const identity = actionIdentity(value);
    assert.match(raw.version, VERSION, `${file} invalid release label`);
    if (identities) assert.ok(identities.has(identity), `${file} unapproved action identity ${identity}`);
    return { file, location, ...raw, identity, revision: value.slice(-40), local: false };
  });
  return { document, occurrences };
}

export function workflowTexts(root) {
  return new Map(readdirSync(path.join(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name)).sort()
    .map(name => [`.github/workflows/${name}`, readFileSync(path.join(root, '.github/workflows', name), 'utf8')]));
}

function readActionDefinition(file) {
  // Validate and read the same opened object. Nonblocking open lets us reject FIFOs too.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.ok(fstatSync(fd).isFile(), 'local action definition must be a regular file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function discoverActions(root, { workflows = workflowTexts(root), identities } = {}) {
  const approved = validateIdentities(identities ?? JSON.parse(readFileSync(path.join(root, 'scripts/ci-lanes.json'), 'utf8')).github_actions.identities);
  const realRoot = realpathSync(root);
  const contained = (file) => {
    const real = realpathSync(file);
    const relative = path.relative(realRoot, real);
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `local action escapes repository: ${file}`);
    return real;
  };
  const occurrences = [], visited = new Set(), active = new Set();
  const visit = (file, text, composite = false) => {
    for (const occurrence of parseActionDocument(text, file, { composite, identities: approved }).occurrences) {
      occurrences.push(occurrence);
      if (!occurrence.local) continue;
      const directory = contained(path.resolve(realRoot, occurrence.value));
      const definitions = readdirSync(directory).filter(name => name === 'action.yml' || name === 'action.yaml')
        .map(name => path.join(directory, name));
      assert.equal(definitions.length, 1, `${file} local action needs exactly one action.yml/action.yaml: ${occurrence.value}`);
      const definition = contained(definitions[0]);
      assert.ok(!active.has(definition), `local composite cycle: ${definition}`);
      if (visited.has(definition)) continue;
      active.add(definition);
      visit(path.relative(realRoot, definition), readActionDefinition(definition), true);
      active.delete(definition); visited.add(definition);
    }
  };
  for (const [file, text] of workflows) visit(file, text);
  return occurrences;
}

export function normalizeWorkflowActions(text, file, identities) {
  const { document, occurrences } = parseActionDocument(text, file, { identities: validateIdentities(identities) });
  for (const occurrence of occurrences) {
    const match = /^jobs\.([^.]+)\.steps\[(\d+)\]$/.exec(occurrence.location);
    if (!occurrence.local) document.jobs[match[1]].steps[Number(match[2])].uses = occurrence.identity;
  }
  return document;
}
