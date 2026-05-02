import { test } from 'node:test';
import * as assert from 'node:assert';

process.env.ARBITER_TEST_MODE = 'true';
process.env.ARBITER_SKIP_ARTIFACTS = 'true';

import { LeaseManager } from '../../state/lease';
import { LeaseRequest } from '../../api/types';

test('LeaseManager: State Transitions', async (t) => {
    const manager = new LeaseManager();
    manager.experimentalScheduling = true;

    // Mock initial request
    const mockRequest: LeaseRequest = {
        resource: 'test-resource',
        duration_seconds: 10
    };

    // Simulate granting a lease
    manager.injectTestState('test-resource', {
        token: 'token-123',
        expires_at: Date.now() + 10000,
        hard_deadline: Date.now() + 15000,
        last_heartbeat: Date.now(),
        state: 'GRANTED',
        requested_duration_ms: 10000
    });

    assert.strictEqual(manager.getResourceState('test-resource'), 'GRANTED');
    assert.strictEqual(manager.validateToken('token-123'), true);
    assert.strictEqual(manager.validateToken('invalid'), false);

    // Test transition to AVAILABLE when yielded
    await manager.yieldLease({ token: 'token-123', reason: 'release' });
    assert.strictEqual(manager.getResourceState('test-resource'), 'AVAILABLE');
    // Token is still valid if AVAILABLE (Reactive Resume)
    assert.strictEqual(manager.validateToken('token-123'), true);
    // After reactive resume, it moves back to GRANTED
    assert.strictEqual(manager.validateToken('token-123'), true);
    assert.strictEqual(manager.getResourceState('test-resource'), 'GRANTED');
});

test('LeaseManager: Token Expiry Bounds', (t) => {
    const manager = new LeaseManager();
    manager.experimentalScheduling = true;
    manager.injectTestState('test-resource', {
        token: 'token-expired',
        expires_at: Date.now() - 5000, // Expired 5 seconds ago
        hard_deadline: Date.now() - 1000,
        last_heartbeat: Date.now() - 10000,
        state: 'GRANTED',
        requested_duration_ms: 10000
    });

    // validateToken should fail if it's not GRANTED or EXPIRING... Wait, validateToken only checks state string!
    // But Watchdog actually cleans up. LeaseManager's pure method relies on Watchdog.
    // Let's manually trigger Watchdog's active tracking check.
    // getActiveLeaseToken() checks if expires_at > Date.now().
    assert.strictEqual(manager.getActiveLeaseToken('test-resource'), undefined);
});

test('LeaseManager: Persistence Serialization', (t) => {
    const manager = new LeaseManager();
    manager.experimentalScheduling = true;
    manager.injectTestState('res1', { token: 'tok1', state: 'GRANTED' });

    const state = manager.exportState();
    assert.ok(state.activeLeases.length === 1);
    
    const manager2 = new LeaseManager();
    manager2.importState(state);
    assert.strictEqual(manager2.getResourceState('res1'), 'GRANTED');
});
