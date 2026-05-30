import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

process.env.ARBITER_TEST_MODE = 'true';
process.env.ARBITER_WATCHDOG_INTERVAL = '500';

import { leaseManager } from '../../state/lease';
import { queueManager } from '../../queue/index';
import { startBroker } from '../../broker/server';

function resetState() {
    queueManager.importState({ queue: [] });
    leaseManager.importState({ activeLeases: [], resourceStates: [], pendingPermits: [] });
    leaseManager.queueDepthResolver = (res: string) => queueManager.getQueueDepth(res);
    leaseManager.onResourceFree = (res: string) => queueManager.pump(res);
}

test('Expired persisted lease: startup does not restore as blocker', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-persistence-test-'));
    process.env.ARBITER_CONTEXT_DIR = tmpDir;
    const stateFile = path.join(tmpDir, '.arbiter_broker_state.json');

    try {
        const expiredLease = {
            token: 'expired-token',
            resource: 'persistent-res',
            expires_at: Date.now() - 10000, // 10s ago
            requested_duration_ms: 60000,
            state: 'GRANTED'
        };

        const state = {
            leaseManager: {
                activeLeases: [['persistent-res', expiredLease]],
                resourceStates: [['persistent-res', 'GRANTED']],
                pendingPermits: []
            },
            queueManager: { queue: [] },
            timestamp: Date.now()
        };

        fs.writeFileSync(stateFile, JSON.stringify(state));

        // Note: startBroker handles resume logic internally
        // We simulate a fresh start with resume enabled
        resetState();
        
        // This is a bit tricky because startBroker starts a real HTTP server.
        // We'll just verify the leaseManager's state after importState (which startBroker uses).
        const raw = fs.readFileSync(stateFile, 'utf8');
        const data = JSON.parse(raw);
        leaseManager.importState(data.leaseManager);

        // The lease manager correctly marks it AVAILABLE, which means it doesn't block new waiters,
        // but it STILL allows the original holder to reactivate it (Reactive Resume) if uncontended!
        assert.strictEqual(leaseManager.getResourceState('persistent-res'), 'AVAILABLE', 'Expired lease should be AVAILABLE on resume');
        assert.strictEqual(leaseManager.getResourceByToken('expired-token'), 'persistent-res', 'Expired token should still be valid for Reactive Resume if uncontended');

    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.ARBITER_CONTEXT_DIR;
    }
});

test('Early ticket claim: CLI polling still succeeds', async () => {
    // This test ensures that when a ticket is claimed early (WAITING), 
    // the server doesn't just hang the socket indefinitely in a way that breaks polling.
    // In our implementation, claimTicket is an async function that resolves when promoted.
    // The HTTP handler awaits this. 
    
    const resource = 'early-claim-poll';
    resetState();

    // Occupy resource
    leaseManager.injectTestState(resource, { state: 'GRANTED', expires_at: Date.now() + 60000 });

    const ticketId = await queueManager.enqueue({ resource, wait_mode: 'ASYNC' } as any);
    
    let claimFinished = false;
    const claimPromise = queueManager.claimTicket(ticketId).then(() => { claimFinished = true; });

    // While claim is pending, we should still be able to check status
    const status = queueManager.getTicketStatus(ticketId);
    assert.ok(status, 'Ticket status should be available while claim is pending');
    assert.strictEqual(status.status, 'WAITING');
    assert.strictEqual(claimFinished, false, 'Claim should still be pending');

    // Promotion
    leaseManager.forceReclaim(resource, 'FREE');
    await claimPromise;
    assert.strictEqual(claimFinished, true, 'Claim should finish after promotion');
});

test('Command timeout: lease marked terminal or released', async () => {
    // This tests the logic where if a command times out (e.g. in remote broker), 
    // the lease is properly handled.
    // Since Remote Broker is integrated in server.ts, we'll verify the leaseManager's 
    // ability to handle forced reclaims or timeouts.
    
    const resource = 'timeout-res';
    resetState();

    leaseManager.injectTestState(resource, { state: 'GRANTED', expires_at: Date.now() + 1000 }); // Short lease

    await new Promise(resolve => setTimeout(resolve, 1500));
    
    let state = leaseManager.getResourceState(resource);
    assert.ok(state === 'EXPIRING' || state === 'AVAILABLE' || state === 'FREE', `Expected lease to expire, got ${state}`);

    if (state === 'EXPIRING') {
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            state = leaseManager.getResourceState(resource);
            if (state === 'AVAILABLE' || state === 'FREE') break;
        }
    }

    assert.ok(state === 'AVAILABLE' || state === 'FREE', `Expected lease to eventually become AVAILABLE/FREE, got ${state}`);
});
