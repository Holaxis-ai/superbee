import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { withTransfer, admitTransfer, completeTransfer, foregroundRequired } from '../src/commands/sync/transfer.js';
test('background handoff survives failure and old success cannot clear a newer operation', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'transfer-marker-'));
    const root = path.join(home, 'board');
    try {
        await withTransfer(async () => { await admitTransfer(root, home); }, { background: true });
        assert.equal(await foregroundRequired(root, home), true);
        await assert.rejects(withTransfer(() => admitTransfer(root, home), { background: true }), /foreground/);
        await withTransfer(async () => { await admitTransfer(root, home); assert.equal(await foregroundRequired(root, home), true); await completeTransfer(home); });
        assert.equal(await foregroundRequired(root, home), false);
    }
    finally {
        await rm(home, { recursive: true, force: true });
    }
});
test('an older foreground success cannot clear newer suppression', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'transfer-race-'));
    const root = path.join(home, 'board');
    let admitted!: () => void, release!: () => void;
    const ready = new Promise<void>(r => admitted = r), later = new Promise<void>(r => release = r);
    try {
        const old = withTransfer(async () => { await admitTransfer(root, home); admitted(); await later; await completeTransfer(home); });
        await ready;
        await withTransfer(() => admitTransfer(root, home));
        release();
        await old;
        assert.equal(await foregroundRequired(root, home), true);
    }
    finally {
        release?.();
        await rm(home, { recursive: true, force: true });
    }
});
