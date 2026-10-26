import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startOwnedProcess } from '../src/owned-process.js';
test('deadline terminates a resistant process and preserves deadline identity', async () => {
    const result = await startOwnedProcess({ file: process.execPath, args: ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], cwd: process.cwd(), env: process.env, timeoutMs: 150 }).result;
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupConfirmed, true);
    assert.ok(result.elapsedMs < 2000);
});
test('leader exit kills a descendant holding output pipes before returning', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'superbee-owned-'));
    try {
        const marker = path.join(dir, 'late');
        const child = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),450);setInterval(()=>{},1000)`;
        const source = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',1,2]});setTimeout(()=>process.exit(0),100)`;
        const result = await startOwnedProcess({ file: process.execPath, args: ['-e', source], cwd: dir, env: process.env, timeoutMs: 1800 }).result;
        assert.equal(result.status, 0);
        assert.equal(result.timedOut, false);
        assert.equal(result.cleanupConfirmed, true);
        await new Promise(r => setTimeout(r, 500));
        assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('output is capped without blocking drain; expired requests never spawn', async () => {
    const result = await startOwnedProcess({ file: process.execPath, args: ['-e', `process.stdout.write('x'.repeat(100000));process.stderr.write('y'.repeat(100000))`], cwd: process.cwd(), env: process.env, timeoutMs: 2000, maxOutputBytes: 1024 }).result;
    assert.ok(Buffer.byteLength(result.stdout) <= 1024);
    assert.ok(Buffer.byteLength(result.stderr) <= 1024);
    assert.equal(result.cleanupConfirmed, true);
    const expired = await startOwnedProcess({ file: '/does-not-exist', args: [], cwd: process.cwd(), env: process.env, timeoutMs: 0 }).result;
    assert.equal(expired.timedOut, true);
    assert.equal(expired.spawnError, undefined);
});
test('caller cancellation stops its owned group', async () => {
    const controller = new AbortController();
    const run = startOwnedProcess({ file: process.execPath, args: ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], cwd: process.cwd(), env: process.env, timeoutMs: 4000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await run.result;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.cleanupConfirmed, true);
    assert.ok(result.elapsedMs < 1500);
});
test('transient zombie-group EPERM resolves only after definitive absence', async t => {
    const original = process.kill.bind(process);
    let probes = 0;
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid < 0 && signal === 0 && ++probes <= 2)
            throw Object.assign(new Error('zombie group'), { code: 'EPERM' });
        return original(pid, signal);
    });
    const result = await startOwnedProcess({ file: process.execPath, args: ['-e', ''], cwd: process.cwd(), env: process.env, timeoutMs: 1000, cleanupMs: 200 }).result;
    assert.equal(result.cleanupConfirmed, true);
    assert.ok(probes >= 3, 'cleanup needs a later ESRCH observation');
});
test('persistent group permission denial stays unconfirmed within cleanup allowance', async t => {
    const original = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid < 0 && signal === 0)
            throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        return original(pid, signal);
    });
    const result = await startOwnedProcess({ file: process.execPath, args: ['-e', ''], cwd: process.cwd(), env: process.env, timeoutMs: 1000, cleanupMs: 120 }).result;
    assert.equal(result.cleanupConfirmed, false);
    assert.ok(result.elapsedMs >= 100 && result.elapsedMs < 1000);
});
test('redirected descendant must disappear even though leader pipes already closed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'superbee-redirect-'));
    try {
        const pidfile = path.join(dir, 'pid');
        const source = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidfile)},String(c.pid));process.exit(0)`;
        const result = await startOwnedProcess({ file: process.execPath, args: ['-e', source], cwd: dir, env: process.env, timeoutMs: 1500 }).result;
        assert.equal(result.cleanupConfirmed, true);
        const descendant = Number(await readFile(pidfile, 'utf8'));
        assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
    } finally { await rm(dir, { recursive: true, force: true }); }
});
test('terminal SIGTERM reaches the caller only after owned group cleanup', async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const dir = await mkdtemp(path.join(tmpdir(), 'superbee-signal-'));
    try {
        const pidfile = path.join(dir, 'pid');
        const moduleUrl = new URL('../src/owned-process.ts', import.meta.url).href;
        const childCode = `require('fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000)`;
        const code = `import {runOwnedProcess} from ${JSON.stringify(moduleUrl)};await runOwnedProcess({file:process.execPath,args:['-e',${JSON.stringify(childCode)}],cwd:process.cwd(),env:process.env,timeoutMs:2000})`;
        const parent = spawn(process.execPath, ['--import', fileURLToPath(new URL('./ts-loader.mjs', import.meta.url)), '--input-type=module', '-e', code], { stdio: 'ignore' });
        const closed = new Promise<NodeJS.Signals | null>(resolve => parent.on('close', (_code, signal) => resolve(signal)));
        const deadline = Date.now() + 1800;
        let descendant = 0;
        while (!descendant && Date.now() < deadline) {
            descendant = Number(await readFile(pidfile, 'utf8').catch(() => '0'));
            if (!descendant) await new Promise(r => setTimeout(r, 10));
        }
        assert.ok(descendant, 'fixture child started');
        parent.kill('SIGTERM');
        assert.equal(await closed, 'SIGTERM');
        assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
    } finally { await rm(dir, { recursive: true, force: true }); }
});
