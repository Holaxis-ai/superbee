import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrdinarySync, validateExecutionRequest } from '../src/commands/sync/transfer-worker.js';
test('every establishment invocation is outside supervised ordinary sync', () => {
    for (const argv of [['--establish'], ['--establish', '--yes'], ['--dir', '/tmp', '--establish'], ['--show-incoming', 'doc'], ['--resolve', 'keep', '--doc', 'x']])
        assert.equal(isOrdinarySync(argv), false);
    assert.equal(isOrdinarySync(['--dir', '/tmp', '--json']), true);
});
test('IPC execution admission rejects malformed and unbounded requests', () => {
    for (const request of [{}, { kind: 'push', timeoutMs: Infinity }, { kind: 'gate', timeoutMs: 0 }, { kind: 'push', candidate: 'x', branch: 'board' }])
        assert.throws(() => validateExecutionRequest(request));
});
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTwoCloneTopology, writeBoardDoc, originBoardHead, git } from '../../board-git/test/git-harness.js';
import { isolatedUserEnv } from './support/user-env.js';
const entry = fileURLToPath(new URL('./fixtures/git-transfer-entry.ts', import.meta.url));
const loader = fileURLToPath(new URL('./ts-loader.mjs', import.meta.url));
async function cli(args: string[], cwd: string, home: string, packaged: boolean | string = false): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const exe = typeof packaged === 'string' ? packaged : packaged ? fileURLToPath(new URL('../../superbee/dist/superbee.mjs', import.meta.url)) : entry;
        const child = spawn(process.execPath, [...(packaged ? [] : ['--import', loader]), exe, ...args], { cwd, env: isolatedUserEnv(home, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERBEE_NO_UPDATE_CHECK: '1', SUPERBEE_NO_TURN_SYNC: undefined }), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', b => stdout += b);
        child.stderr.on('data', b => stderr += b);
        child.on('error', reject);
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('fixture deadline exceeded')); }, 10000);
        child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
}
test('source first-party worker publishes once and embedded entry needs no worker dispatcher', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-cli-')));
    try {
        await writeBoardDoc(t.a, 'notes/source-worker', { frontmatter: { type: 'Note', title: 'Worker' }, body: 'one' });
        const first = await cli(['sync', '--dir', t.a.board, '--json'], t.a.root, home);
        assert.equal(first.status, 0, first.stdout + first.stderr);
        const before = originBoardHead(t);
        await writeBoardDoc(t.a, 'notes/embedded', { frontmatter: { type: 'Note', title: 'Embedded' }, body: 'two' });
        const second = await cli(['__embedded', 'sync', '--dir', t.a.board, '--json'], t.a.root, home);
        assert.equal(second.status, 0, second.stdout + second.stderr);
        assert.notEqual(originBoardHead(t), before);
    }
    finally {
        await t.cleanup();
        await rm(home, { recursive: true, force: true });
    }
});
test('outer deadline cuts off synchronous preparation and never sends false success', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-limit-')));
    try {
        git(t.a.board, ['config', 'superbee.syncTimeoutSeconds', '3']);
        await writeBoardDoc(t.a, 'notes/deadline', { frontmatter: { type: 'Note', title: 'Deadline' }, body: 'one' });
        const hooks = git(t.a.board, ['rev-parse', '--git-path', 'hooks']).trim();
        await writeFile(path.resolve(t.a.board, hooks, 'pre-commit'), '#!/bin/sh\nsleep 10\n', { mode: 0o700 });
        const before = originBoardHead(t), start = Date.now();
        const result = await cli(['sync', '--dir', t.a.board, '--json'], t.a.root, home);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.ok(Date.now() - start < 5000);
        assert.match(result.stdout, /deadline-exceeded/);
        assert.equal(originBoardHead(t), before);
        assert.doesNotMatch(result.stdout, /"sent":1/);
    }
    finally {
        await t.cleanup();
        await rm(home, { recursive: true, force: true });
    }
});
test('one-file first-party artifact accepts the same worker protocol', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-packed-')));
    try {
        await writeBoardDoc(t.a, 'notes/packed', { frontmatter: { type: 'Note', title: 'Packed' }, body: 'one' });
        const r = await cli(['sync', '--dir', t.a.board, '--json'], t.a.root, home, true);
        assert.equal(r.status, 0, r.stdout + r.stderr);
    }
    finally {
        await t.cleanup();
        await rm(home, { recursive: true, force: true });
    }
});
test('a gate that exits with a late writer cannot mutate after verification and push', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-gate-')));
    try {
        await writeBoardDoc(t.a, 'notes/gated', { frontmatter: { type: 'Note', title: 'Gated' }, body: 'safe' });
        const marker = path.join(t.a.board, 'late.txt');
        git(t.a.board, ['config', 'superbee.syncGate', `(sleep 1; echo bad > '${marker}') & exit 0`]);
        const r = await cli(['sync', '--dir', t.a.board, '--json'], t.a.root, home);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        await new Promise(r => setTimeout(r, 1200));
        const { readFile } = await import('node:fs/promises');
        assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
    }
    finally {
        await t.cleanup();
        await rm(home, { recursive: true, force: true });
    }
});
test('background expiry persists a hold, skips future attempts, and successful foreground clears it', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-handoff-')));
    try {
        await writeBoardDoc(t.a, 'notes/handoff', { frontmatter: { type: 'Note', title: 'Handoff' }, body: 'safe' });
        const hits = path.join(home, 'gate-hits');
        // Leave preparation room under parallel test load; the gate still outlives the budget.
        git(t.a.board, ['config', 'superbee.syncTimeoutSeconds', '6']);
        git(t.a.board, ['config', 'superbee.syncGate', `echo hit >> '${hits}'; sleep 10`]);
        const before = originBoardHead(t);
        const first = await cli(['turn-end', '--dir', t.a.board, '--git-boards'], t.a.root, home);
        assert.equal(first.status, 0, first.stdout + first.stderr);
        assert.match(first.stdout, /foreground sync/);
        assert.equal(originBoardHead(t), before);
        const { readFile } = await import('node:fs/promises');
        const { foregroundRequired } = await import('../src/commands/sync/transfer.js');
        assert.equal((await readFile(hits, 'utf8')).trim(), 'hit', 'the first hook reached gate admission');
        assert.equal(await foregroundRequired(t.a.board, home), true, 'handoff is persisted before the next hook');
        const second = await cli(['turn-end', '--dir', t.a.board, '--git-boards'], t.a.root, home);
        assert.equal(second.status, 0, second.stdout + second.stderr);
        assert.equal((await readFile(hits, 'utf8')).trim(), 'hit', 'the second hook never re-enters the gate');
        git(t.a.board, ['config', 'superbee.syncGate', 'true']);
        git(t.a.board, ['config', 'superbee.syncTimeoutSeconds', '20']);
        const foreground = await cli(['sync', '--dir', t.a.board, '--json'], t.a.root, home);
        assert.equal(foreground.status, 0, foreground.stdout + foreground.stderr);
        assert.notEqual(originBoardHead(t), before);
        assert.equal(await foregroundRequired(t.a.board, home), false);
    }
    finally {
        await t.cleanup();
        await rm(home, { recursive: true, force: true });
    }
});

test('built reusable CLI publishes through run without a private worker dispatcher', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-library-')));
    try {
        const host = path.join(home, 'embedded.mjs');
        const library = new URL('../dist/index.mjs', import.meta.url).href;
        await writeFile(host, `import {createPosixCliRuntime,staticBuildIdentity} from ${JSON.stringify(library)};
const runtime=createPosixCliRuntime({identity:{...staticBuildIdentity(),package:{name:'example-host',version:'0.0.0'}},executablePath:${JSON.stringify(host)},assetRoot:${JSON.stringify(home)},install:{packageName:'example-host',entryRelativePath:'embedded.mjs',bins:['example-host']},predecessorLayouts:[],ownedSkillPackages:[],updatesEnabled:false});
await runtime.run(process.argv.slice(2));`);
        await writeBoardDoc(t.a, 'notes/library', { frontmatter: { type: 'Note', title: 'Library' }, body: 'one' });
        const before = originBoardHead(t);
        const result = await cli(['sync', '--dir', t.a.board, '--json'], t.a.root, home, host);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.notEqual(originBoardHead(t), before);
    } finally { await t.cleanup(); await rm(home, { recursive: true, force: true }); }
});

test('supervised hook reports a recurring gate failure after verified foreground recovery', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-recurrence-')));
    const hook = () => cli(['turn-end', '--git-boards', '--dir', t.a.board], t.a.root, home, true);
    try {
        await writeBoardDoc(t.a, 'notes/first', { frontmatter: { type: 'Note', title: 'First' }, body: 'one' });
        git(t.a.board, ['config', 'superbee.syncGate', 'false']);
        assert.match((await hook()).stdout, /"decision"\s*:\s*"block"/);
        git(t.a.board, ['config', 'superbee.syncGate', 'true']);
        const recovered = await cli(['sync', '--dir', t.a.board, '--json'], t.a.root, home, true);
        assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
        assert.equal((await hook()).stdout, '');
        await writeBoardDoc(t.a, 'notes/second', { frontmatter: { type: 'Note', title: 'Second' }, body: 'two' });
        git(t.a.board, ['config', 'superbee.syncGate', 'false']);
        const recurrence = await hook();
        assert.equal(recurrence.status, 0, recurrence.stderr);
        assert.match(recurrence.stdout, /"decision"\s*:\s*"block"/);
        assert.match(recurrence.stdout, /sync gate exited 1/);
    } finally { await t.cleanup(); await rm(home, { recursive: true, force: true }); }
});

test('supervised hook hands a moved board back once with checkout and retained local work', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-moved-')));
    const hook = () => cli(['turn-end', '--git-boards', '--dir', t.a.board], t.a.root, home, true);
    try {
        const marker = '.superbee-moved-to-hosted.json';
        await writeFile(path.join(t.a.board, marker), JSON.stringify({ superbee_moved_to_hosted: 1, host: 'https://hosted.example', bundle: 'acme/team.board', moved_at: '2026-10-26T00:00:00.000Z' }));
        git(t.a.board, ['add', '--force', marker]);
        git(t.a.board, ['commit', '-m', 'Move fixture board']);
        git(t.a.board, ['push', 'origin', 'board']);
        await writeBoardDoc(t.a, 'notes/retained', { frontmatter: { type: 'Note', title: 'Retained' }, body: 'local work' });
        const before = originBoardHead(t);
        const result = await hook();
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /"decision"\s*:\s*"block"/);
        assert.match(result.stdout, /moved to hosted Superbee/);
        assert.match(result.stdout, /checkout acme\/team.board --host https:\/\/hosted.example/);
        assert.match(result.stdout, /uncommitted file\(s\) stay in/);
        assert.equal(originBoardHead(t), before);
        assert.equal((await hook()).stdout, '', 'the same moved-board condition is reported once');
    } finally { await t.cleanup(); await rm(home, { recursive: true, force: true }); }
});


test('plain packaged turn-end reports a new deadline after recovery under one canonical board key', async () => {
    const t = await makeTwoCloneTopology();
    const home = await realpath(await mkdtemp(path.join(tmpdir(), 'transfer-plain-hook-')));
    const hook = () => cli(['turn-end', '--git-boards'], t.a.root, home, true);
    try {
        await writeBoardDoc(t.a, 'notes/plain-one', { frontmatter: { type: 'Note', title: 'One' }, body: 'one' });
        git(t.a.board, ['config', 'superbee.syncTimeoutSeconds', '6']);
        git(t.a.board, ['config', 'superbee.syncGate', 'sleep 30']);
        const first = await hook();
        assert.match(first.stdout, /"decision"\s*:\s*"block"/);
        git(t.a.board, ['config', 'superbee.syncTimeoutSeconds', '30']);
        git(t.a.board, ['config', 'superbee.syncGate', 'true']);
        const recovered = await cli(['sync', '--json'], t.a.root, home, true);
        assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
        assert.equal((await hook()).stdout, '');
        await writeBoardDoc(t.a, 'notes/plain-two', { frontmatter: { type: 'Note', title: 'Two' }, body: 'two' });
        git(t.a.board, ['config', 'superbee.syncTimeoutSeconds', '6']);
        git(t.a.board, ['config', 'superbee.syncGate', 'sleep 30']);
        const recurrence = await hook();
        assert.equal(recurrence.status, 0, recurrence.stderr);
        assert.match(recurrence.stdout, /"decision"\s*:\s*"block"/, 'installed plain-cwd hook reports recurring deadline');
        assert.ok(recurrence.stdout.includes(t.a.board), 'handoff names the canonical board');
    } finally { await t.cleanup(); await rm(home, { recursive: true, force: true }); }
});
