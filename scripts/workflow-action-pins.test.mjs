import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';
import { discoverActions, parseActionDocument, validateIdentities } from './workflow-actions.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependabot = readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8');
const sha = 'a'.repeat(40), next = 'b'.repeat(40);
const identities = ['actions/checkout', 'actions/cache/restore', 'actions/cache/save'];
const line = (identity = identities[0], revision = sha, version = 'v1.2.3') => `      - uses: ${identity}@${revision} # ${version}`;
const fixtureWorkflow = (body = line()) => `name: fixture\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n${body}\n`;
const parse = text => parseActionDocument(text, 'fixture.yml', { identities: validateIdentities(identities) }).occurrences;
const yamlMapping = text => yaml.safeLoad(text);
const DEPENDABOT_GITHUB_ACTIONS = 'version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n';
function validateDependabot(text) {
  const document = yamlMapping(text, "Dependabot configuration");
  assert.equal(document.version, 2, "Dependabot configuration must use version 2");
  assert.ok(Array.isArray(document.updates), "Dependabot updates must be an array");
  const actionUpdaters = document.updates.filter((entry) => entry?.["package-ecosystem"] === "github-actions");
  assert.equal(actionUpdaters.length, 1, "Dependabot must declare exactly one github-actions updater");
  const updater = actionUpdaters[0];
  assert.deepEqual(
    Object.keys(updater).sort(),
    ["directory", "package-ecosystem", "schedule"],
    "github-actions Dependabot updater must use only approved keys",
  );
  assert.equal(updater.directory, "/", "github-actions Dependabot updater must cover the repository root");
  assert.ok(updater.schedule && typeof updater.schedule === "object" && !Array.isArray(updater.schedule), "github-actions Dependabot schedule must be a mapping");
  assert.deepEqual(Object.keys(updater.schedule), ["interval"], "github-actions Dependabot schedule must use only approved keys");
  assert.equal(updater.schedule.interval, "weekly", "github-actions Dependabot updater must run weekly");
  return actionUpdaters.length;
}

test('repository inventory is derived and every remote identity is approved', t => {
  const occurrences = discoverActions(root);
  const remote = occurrences.filter(row => !row.local);
  assert.ok(remote.length > 0);
  t.diagnostic(JSON.stringify({ occurrences: remote.length, identities: new Set(remote.map(r => r.identity)).size, pins: new Set(remote.map(r => r.value)).size }));
  validateDependabot(dependabot);
});

test('workflow-only renewals, simultaneous majors and last-old-version removal need no registry edits', () => {
  for (const version of ['v1.2.4', 'v1.3.0', 'v2.0.0']) {
    assert.equal(parse(fixtureWorkflow(line(identities[0], next, version)))[0].version, version);
  }
  const both = fixtureWorkflow(`${line()}\n${line(identities[0], next, 'v2.0.0')}`);
  assert.equal(parse(both).length, 2);
  assert.equal(parse(both.replace(`${line()}\n`, '')).length, 1);
  assert.equal(parse(fixtureWorkflow(`${line(identities[1])}\n${line(identities[2])}`)).length, 2);
  validateIdentities([...identities, 'approved/unused']);
});

test('invalid references and ambiguous source forms fail closed at each occurrence', () => {
  for (const changed of [
    line('unknown/checkout'), line('actions/cache/unknown'), line(identities[0], 'main'),
    line(identities[0], 'a'.repeat(39)), line(identities[0], 'A'.repeat(40)),
    line().replace(/ #.*/, ''), line().replace('v1.2.3', 'v1'), line().replace('v1.2.3', 'v01.2.3'),
    line().replace('uses: ', 'uses: "').replace(' #', '" #'),
    line().replace('uses:', '"uses":'), `      - { uses: ${identities[0]}@${sha} }`,
    '      - uses: docker://alpine:3', '      - uses: ${{ inputs.action }}',
    `      - uses: >-\n          ${identities[0]}@${sha}`, '      - uses: *action',
    '      - <<: *step', '      - { <<: *step }', '      - *step',
  ]) {
    const aliases = `x-action: &action ${identities[0]}@${sha}\nx-step: &step\n  uses: ${identities[0]}@${sha} # v1.2.3\n`;
    assert.throws(() => parse(aliases + fixtureWorkflow(changed)), undefined, changed);
  }
  // A canonical decoy in a different occurrence cannot cover an aliased occurrence.
  assert.throws(() => parse(`x-step: &step\n  uses: ${identities[0]}@${sha}\n${fixtureWorkflow(`${line()}\n      - <<: *step`)}`));
  assert.throws(() => parse(`x-job: &job\n  steps:\n    - uses: ${identities[0]}@${sha}\njobs:\n  check: *job\n`));
  for (const use of ['./.github/workflows/reuse.yml', `owner/repo/.github/workflows/reuse.yml@${sha}`]) {
    assert.throws(() => parse(`jobs:\n  call:\n    uses: ${use} # v1.2.3\n`), /reusable workflows are unsupported/);
  }
  assert.equal(parse(fixtureWorkflow(`      - run: |\n          uses: bad@main\n${line()}`)).length, 1);
  for (const list of [[...identities, identities[0]], ['owner/../repo'], ['owner/repo/..'], ['https://github.com/owner/repo']]) assert.throws(() => validateIdentities(list));
});

test('local composite closure is recursive, contained, cycle-safe and complete', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'action-closure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (file, text) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); };
  const composite = body => `name: fixture\nruns:\n  using: composite\n  steps:\n${body}\n`;
  put('a/action.yml', composite('    - uses: ./b'));
  put('b/action.yaml', composite(line().slice(2)));
  const check = body => discoverActions(dir, { workflows: new Map([['fixture.yml', fixtureWorkflow(body)]]), identities });
  assert.equal(check('      - uses: ./a\n      - uses: ./a').filter(r => !r.local).length, 1);
  put('b/action.yaml', composite(line(identities[0], 'main').slice(2)));
  assert.throws(() => check('      - uses: ./a'));
  put('b/action.yaml', composite('    - uses: ./a'));
  assert.throws(() => check('      - uses: ./a'), /cycle/);
  put('b/action.yaml', 'runs:\n  using: node24\n  main: main.js\n');
  assert.throws(() => check('      - uses: ./b'), /only local composite/);
  assert.throws(() => check('      - uses: ./missing'));
  assert.throws(() => check('      - uses: ./..'), /escapes/);
  symlinkSync(tmpdir(), path.join(dir, 'outside'));
  assert.throws(() => check('      - uses: ./outside'), /escapes/);
  put('b/action.yml', composite('    - run: true'));
  assert.throws(() => check('      - uses: ./b'), /exactly one/);
});
test('local definitions are read from the checked descriptor and close it on success or rejection', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'action-descriptor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const actionDirectory = path.join(dir, 'a');
  mkdirSync(actionDirectory);
  const action = path.join(actionDirectory, 'action.yml');
  const text = `runs:\n  using: composite\n  steps:\n${line().slice(2)}\n`;
  const stat = fs.fstatSync;
  const check = () => discoverActions(dir, {
    workflows: new Map([['fixture.yml', fixtureWorkflow('      - uses: ./a')]]), identities,
  });
  for (const regular of [true, false]) {
    if (regular) writeFileSync(action, text);
    else mkdirSync(action);
    let descriptor;
    const probe = t.mock.method(fs, 'fstatSync', fd => {
      descriptor = fd;
      const result = stat(fd);
      if (regular) {
        fs.renameSync(action, path.join(dir, 'retained.yml'));
        writeFileSync(action, 'invalid replacement');
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      if (regular) assert.equal(check().filter(row => !row.local)[0].revision, sha);
      else assert.throws(check, /must be a regular file/);
      assert.equal(typeof descriptor, 'number');
      assert.throws(() => stat(descriptor), { code: 'EBADF' });
    } finally {
      probe.mock.restore();
      syncBuiltinESMExports();
      rmSync(action, { recursive: true, force: true });
    }
  }
});

test("Dependabot has one effective root weekly updater and permits distinct ecosystems", () => {
  for (const [label, text, expected] of [
    ["missing", "version: 2\nupdates: []\n", /exactly one/],
    ["duplicate", `${DEPENDABOT_GITHUB_ACTIONS}  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n`, /exactly one/],
    ["wrong directory", DEPENDABOT_GITHUB_ACTIONS.replace("directory: /", "directory: /.github/workflows"), /repository root/],
    ["wrong interval", DEPENDABOT_GITHUB_ACTIONS.replace("interval: weekly", "interval: monthly"), /run weekly/],
    ["ignored action", `${DEPENDABOT_GITHUB_ACTIONS}    ignore:\n      - dependency-name: actions/checkout\n`, /only approved keys/],
    ["allow list", `${DEPENDABOT_GITHUB_ACTIONS}    allow:\n      - dependency-name: actions/checkout\n`, /only approved keys/],
    ["excluded paths", `${DEPENDABOT_GITHUB_ACTIONS}    exclude-paths:\n      - .github\/workflows\/**\n`, /only approved keys/],
    ["redirected branch", `${DEPENDABOT_GITHUB_ACTIONS}    target-branch: maintenance\n`, /only approved keys/],
    ["pull request limit", `${DEPENDABOT_GITHUB_ACTIONS}    open-pull-requests-limit: 1\n`, /only approved keys/],
    ["scheduled day", DEPENDABOT_GITHUB_ACTIONS.replace("      interval: weekly", "      interval: weekly\n      day: monday"), /schedule must use only approved keys/],
  ]) assert.throws(() => validateDependabot(text), expected, label);

  const withNpm = `${DEPENDABOT_GITHUB_ACTIONS}  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n`;
  assert.equal(validateDependabot(withNpm), 1);
});
