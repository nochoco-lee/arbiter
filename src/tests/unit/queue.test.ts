import { test } from 'node:test';
import * as assert from 'node:assert';

process.env.ARBITER_TEST_MODE = 'true';

// Mocking required internal dependencies before importing QueueEngine
import { leaseManager } from '../../state/lease';

// We import the specific class. Since index.ts exports `queueManager` as an instance,
// we just manipulate its underlying methods.
// Actually, queue/index.ts has `class QueueEngine` but doesn't export it! 
// Let's just import the instance and test it directly.
import { queueManager } from '../../queue/index';

test('QueueManager: Enqueue and Claim Ticket Logic', async (t) => {
    // 1. Clear any state
    queueManager.importState({ queue: [] });
    queueManager.experimentalScheduling = true;

    // 2. Enqueue an ASYNC ticket
    const pToken = queueManager.enqueue({
        resource: 'q-res',
        wait_mode: 'ASYNC',
        duration_seconds: 10
    } as any);

    assert.ok(pToken instanceof Promise);
    // Wait, enqueue returns a token string immediately for ASYNC mode!
    // Let's await just in case, though it's synchronous for ASYNC if it doesn't block.
    const token = await pToken;
    assert.ok(token.startsWith('q_'));

    // 3. Queue Depth is 1
    assert.strictEqual(queueManager.getQueueDepth('q-res'), 1);

    // 4. Head Type is READY because it was auto-promoted (resource is free)
    assert.strictEqual(queueManager.getHeadType('q-res'), 'READY');

    // 5. Try to claim (it is likely READY already because resource is free)
    const status = queueManager.getTicketStatus(token);
    assert.ok(status?.status === 'WAITING' || status?.status === 'READY');

    // 6. Promote the ticket manually to bypass interval watchdog for unit tests
    queueManager.forcePromote('q-res');

    const { token: claimedToken, error } = await queueManager.claimTicket(token);
    assert.ok(claimedToken);
    assert.ok(!error);

    // 7. Queue Depth is now 0 because it was claimed
    assert.strictEqual(queueManager.getQueueDepth('q-res'), 0);
});

test('QueueManager: Persistence Serialization', (t) => {
    queueManager.importState({ queue: [] });
    queueManager.experimentalScheduling = true;
    
    // Create an entry manually using testing API
    queueManager.injectTestState('persist-res', [{
        id: 'q_persist',
        request: { resource: 'persist-res', duration_seconds: 10 },
        waiting_since: Date.now(),
        status: 'WAITING',
        wait_mode: 'BLOCKING'
    }]);

    const state = queueManager.exportState();
    
    // The exported state should convert BLOCKING to ASYNC
    const exportedQueueArray = state.queue;
    assert.strictEqual(exportedQueueArray.length, 1);
    const firstResQueue = exportedQueueArray[0][1];
    assert.strictEqual(firstResQueue[0].id, 'q_persist');
    assert.strictEqual(firstResQueue[0].wait_mode, 'ASYNC'); // Restored tickets default to ASYNC

    queueManager.importState(state);
    assert.strictEqual(queueManager.getQueueDepth('persist-res'), 1);
});
