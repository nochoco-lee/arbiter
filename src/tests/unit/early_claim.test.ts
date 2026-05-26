import { test } from 'node:test';
import * as assert from 'node:assert';

process.env.ARBITER_TEST_MODE = 'true';

import { leaseManager } from '../../state/lease';
import { queueManager } from '../../queue/index';

// Helper: ensure a fresh queue state before each test
function resetState(resource: string) {
    queueManager.importState({ queue: [] });
    queueManager.experimentalScheduling = true;
    leaseManager.importState({ activeLeases: [], resourceStates: [], pendingPermits: [] });
    leaseManager.experimentalScheduling = true;
    leaseManager.queueDepthResolver = (res: string) => queueManager.getQueueDepth(res);
    leaseManager.onResourceFree = (res: string) => queueManager.pump(res);
}

// -------------------------------------------------------------------------
// Test 1: Claiming a WAITING ticket blocks until ready
// -------------------------------------------------------------------------
test('Early claim: WAITING ticket blocks and resolves when resource is freed', async () => {
    const resource = 'ec-res-1';
    resetState(resource);

    // Occupy the resource so the enqueued ticket cannot be immediately promoted
    leaseManager.injectTestState(resource, { state: 'GRANTED', expires_at: Date.now() + 60000 });

    // Enqueue an ASYNC ticket — resource is busy, so it stays WAITING
    const ticketIdPromise = queueManager.enqueue({ resource, wait_mode: 'ASYNC', duration_seconds: 10 } as any);
    const ticketId = await ticketIdPromise;
    assert.ok(ticketId.startsWith('q_'), `Expected q_ ticket ID, got: ${ticketId}`);

    const status = queueManager.getTicketStatus(ticketId);
    assert.strictEqual(status?.status, 'WAITING', 'Ticket should still be WAITING while resource is busy');

    // Attempt an early claim — it should block
    let claimResolved = false;
    let claimedToken: string | null = null;
    const claimPromise = queueManager.claimTicket(ticketId).then(res => {
        claimResolved = true;
        claimedToken = res.token;
        return res;
    });

    // Let the event loop tick
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(claimResolved, false, 'claimTicket should block while WAITING');

    // Free the resource manually
    leaseManager.forceReclaim(resource, 'FREE');

    // Wait for the claim to resolve
    const res = await claimPromise;
    assert.strictEqual(claimResolved, true, 'claimTicket should resolve after resource is freed');
    assert.ok(res.token, 'Token should be valid');
    assert.ok(!(res.token as string).startsWith('q_'), 'Token should not be a q_ ticket ID');
});

// -------------------------------------------------------------------------
// Test 2: Dynamic Async Shift watchdog does NOT increase queue depth
// -------------------------------------------------------------------------
test('Watchdog async shift: queue depth stays constant after conversion', async () => {
    const resource = 'ec-res-2';
    resetState(resource);

    // Occupy the resource
    leaseManager.injectTestState(resource, { state: 'GRANTED', expires_at: Date.now() + 60000 });

    // Enqueue a BLOCKING entry that was created long ago (past the threshold)
    const thresholdMs = 180 * 1000;
    queueManager.injectTestState(resource, [{
        id: 'q_ec_early',
        request: { resource, duration_seconds: 10 },
        waiting_since: Date.now() - thresholdMs - 1000, // past threshold
        status: 'WAITING',
        wait_mode: 'BLOCKING',
    }]);

    const depthBefore = queueManager.getQueueDepth(resource);
    assert.strictEqual(depthBefore, 1, 'Queue depth should be 1 before watchdog');

    // Manually trigger the watchdog
    queueManager.runWatchdog();

    const depthAfter = queueManager.getQueueDepth(resource);
    assert.strictEqual(depthAfter, 1, 'Queue depth must not change after async shift — entry stays in queue');
});

// -------------------------------------------------------------------------
// Test 3: claimTicket() NEVER returns a q_ prefixed string as the token
// -------------------------------------------------------------------------
test('Invariant: claimTicket never returns a q_ string as the token', async () => {
    const resource = 'ec-res-3';
    resetState(resource);

    // Enqueue with resource free — ticket gets promoted to READY immediately
    const ticketIdPromise = queueManager.enqueue({ resource, wait_mode: 'ASYNC', duration_seconds: 10 } as any);
    const ticketId = await ticketIdPromise;

    // Force READY state so claim can succeed
    queueManager.forcePromote(resource);

    const { token, error } = await queueManager.claimTicket(ticketId);

    if (token !== null) {
        assert.ok(!token.startsWith('q_'), `Token must never be a q_ ticket ID, got: ${token}`);
        assert.ok(token.length > 8, 'Token should be a real UUID');
    } else {
        // If claim failed for some reason, error is acceptable but token must still be null
        assert.strictEqual(token, null);
        assert.ok(typeof error === 'string', 'Error should be a string when token is null');
    }
});

// -------------------------------------------------------------------------
// Test 4: When resource becomes free, a READY ticket claim returns a real UUID + resource
// -------------------------------------------------------------------------
test('Happy path: READY ticket claim returns real UUID lease token and resource name', async () => {
    const resource = 'ec-res-4';
    resetState(resource);

    // Resource is free — ASYNC ticket enqueued → immediately promoted to READY by pump()
    const ticketIdPromise = queueManager.enqueue({ resource, wait_mode: 'ASYNC', duration_seconds: 10 } as any);
    const ticketId = await ticketIdPromise;
    assert.ok(ticketId.startsWith('q_'));

    // Force promote to READY (simulates the pump running after enqueue)
    queueManager.forcePromote(resource);

    const { token, error } = await queueManager.claimTicket(ticketId);
    assert.ok(token, `Expected a valid lease token, got error: ${error}`);
    assert.ok(!token!.startsWith('q_'), 'Lease token must not be a q_ ticket ID');
    // UUID format: 8-4-4-4-12 hex chars
    assert.match(token!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Queue should now be empty — entry was claimed and removed
    assert.strictEqual(queueManager.getQueueDepth(resource), 0, 'Queue depth must be 0 after successful claim');
});

// -------------------------------------------------------------------------
// Test 5: Repeated early claims resolve to the same token without duplicating entries
// -------------------------------------------------------------------------
test('Repeated early claims: all promises resolve to same token, queue order preserved', async () => {
    const resource = 'ec-res-5';
    resetState(resource);

    // Occupy the resource
    leaseManager.injectTestState(resource, { state: 'GRANTED', expires_at: Date.now() + 60000 });

    // Enqueue two ASYNC tickets — both stay WAITING because resource is busy
    const t1Promise = queueManager.enqueue({ resource, wait_mode: 'ASYNC', duration_seconds: 10 } as any);
    const t2Promise = queueManager.enqueue({ resource, wait_mode: 'ASYNC', duration_seconds: 10 } as any);
    const t1 = await t1Promise;
    const t2 = await t2Promise;

    assert.strictEqual(queueManager.getQueueDepth(resource), 2, 'Queue depth should be 2');

    // Attempt early claim on t1 three times in a row
    const p1 = queueManager.claimTicket(t1);
    const p2 = queueManager.claimTicket(t1);
    const p3 = queueManager.claimTicket(t1);

    // Let the event loop tick
    await new Promise(resolve => setTimeout(resolve, 50));

    // Queue depth must not have increased — no duplicate entries
    assert.strictEqual(queueManager.getQueueDepth(resource), 2, 'Queue depth must stay at 2 after repeated early claims');

    // Queue order must be preserved: t1 is still head, t2 is second
    const statusT1 = queueManager.getTicketStatus(t1);
    const statusT2 = queueManager.getTicketStatus(t2);
    assert.strictEqual(statusT1?.position, 1, 't1 must remain at position 1');
    assert.strictEqual(statusT2?.position, 2, 't2 must remain at position 2');

    // Free the resource so the claims can resolve
    leaseManager.forceReclaim(resource, 'FREE');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.ok(r1.token, 'Should resolve to a valid token');
    assert.strictEqual(r1.token, r2.token, 'Repeated claims should yield the exact same token');
    assert.strictEqual(r1.token, r3.token, 'Repeated claims should yield the exact same token');
});
