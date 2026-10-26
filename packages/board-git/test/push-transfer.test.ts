import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pushAsync } from '../src/porcelain.js';
import { makeTwoCloneTopology, git, commitBoard, originBoardHead } from './git-harness.js';
test('single large object and healthy quiet receive phase complete without idle heuristics', async () => {
    const t = await makeTwoCloneTopology();
    try {
        await writeFile(path.join(t.a.board, 'payload.bin'), randomBytes(1024 * 1024));
        const head = commitBoard(t.a, 'payload');
        await writeFile(path.join(t.origin, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 0.3\n', { mode: 0o700 });
        await pushAsync(t.a.board, head, 'board', { timeoutMs: 2500 });
        assert.equal(originBoardHead(t), head);
    }
    finally {
        await t.cleanup();
    }
});
test('lost acknowledgement is unconfirmed even when remote accepted the exact candidate', async () => {
    const t = await makeTwoCloneTopology();
    try {
        await writeFile(path.join(t.a.board, 'payload.bin'), randomBytes(128 * 1024));
        const head = commitBoard(t.a, 'payload');
        await writeFile(path.join(t.origin, 'hooks', 'post-receive'), '#!/bin/sh\nsleep 2\n', { mode: 0o700 });
        await assert.rejects(pushAsync(t.a.board, head, 'board', { timeoutMs: 600 }), error => {
            const e = error as {
                details?: Record<string, unknown>;
            };
            assert.equal(e.details?.reason, 'deadline-exceeded');
            assert.equal(e.details?.publication, 'unconfirmed');
            assert.equal(e.details?.candidate_sha, head);
            assert.equal(e.details?.retryable, false);
            return true;
        });
        assert.equal(originBoardHead(t), head);
    }
    finally {
        await t.cleanup();
    }
});
test('scaled slow upload completes with generous policy after a short policy interrupts it', async () => {
    const t = await makeTwoCloneTopology();
    try {
        await writeFile(path.join(t.a.board, 'slow.bin'), randomBytes(1024 * 1024));
        const head = commitBoard(t.a, 'slow payload');
        const wrapper = path.join(t.dir, 'slow-receive.cjs');
        await writeFile(wrapper, `#!${process.execPath}\nconst {spawn}=require('node:child_process');
const child=spawn('git',['receive-pack',process.argv[2]],{stdio:['pipe','pipe','inherit']});
child.stdout.pipe(process.stdout);let pending=Buffer.alloc(0),ended=false;
process.stdin.on('data',b=>{pending=Buffer.concat([pending,b]);});process.stdin.on('end',()=>ended=true);
const timer=setInterval(()=>{if(pending.length){const n=Math.min(pending.length,50000);child.stdin.write(pending.subarray(0,n));pending=pending.subarray(n);}else if(ended){clearInterval(timer);child.stdin.end();}},25);
child.on('exit',code=>{clearInterval(timer);process.exit(code??1);});\n`, { mode: 0o700 });
        git(t.a.board, ['config', 'remote.origin.receivepack', wrapper]);
        await assert.rejects(pushAsync(t.a.board, head, 'board', { timeoutMs: 250 }), e => (e as {
            details?: Record<string, unknown>;
        }).details?.reason === 'deadline-exceeded');
        assert.notEqual(originBoardHead(t), head);
        await pushAsync(t.a.board, head, 'board', { timeoutMs: 2500 });
        assert.equal(originBoardHead(t), head);
    }
    finally {
        await t.cleanup();
    }
});
