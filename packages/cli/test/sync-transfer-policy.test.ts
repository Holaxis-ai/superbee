import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransferSeconds, DEFAULT_PUSH_MS, DEFAULT_TOTAL_MS, phaseBudget } from '../src/commands/sync/transfer.js';
test('finite defaults cover the declared workload with room for quiet processing', () => {
    assert.equal(DEFAULT_PUSH_MS, 600000);
    assert.equal(DEFAULT_TOTAL_MS, 1500000);
    assert.ok(DEFAULT_PUSH_MS > 160000000 * 8 / 5000000 * 1000 + 120000);
    for (const raw of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '3601', '1e2'])
        assert.throws(() => parseTransferSeconds('push', raw, 600, 3600));
    assert.equal(parseTransferSeconds('push', undefined, 600, 3600), 600000);
    assert.equal(parseTransferSeconds('push', '3600', 600, 3600), 3600000);
});
test('phase budget consumes original deadline and reserves cleanup without reset', () => {
    assert.equal(phaseBudget(10000, 600000, 1000), 7000);
    assert.equal(phaseBudget(10000, 600000, 9000), 0);
});
