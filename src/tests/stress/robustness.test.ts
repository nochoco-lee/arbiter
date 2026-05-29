import { test } from 'node:test';
import * as assert from 'node:assert';
import { startBrokerInstance, delay, createUniqueResource } from '../helpers/harness';
import { brokerRequest, requestLease, yieldLease, claimTicket } from '../helpers/broker';
import { getStatus } from '../helpers/assertions';

test('Robustness: High Concurrency, Restarts, and Hanging Commands', async (t) => {
    const port = 0;
    let broker = await startBrokerInstance(port);
    const actualPort = broker.port;
    const resource = createUniqueResource('stress');

    console.log(`[Stress] Started broker on port ${actualPort} for resource ${resource}`);

    const CONCURRENCY = 120;
    const agents = Array.from({ length: CONCURRENCY }, (_, i) => `agent-${i}`);
    const results: any[] = [];

    // --- Phase 1: Thundering Herd (Blocking and Async) ---
    console.log(`[Stress] Phase 1: Dispatching ${CONCURRENCY} concurrent requests...`);
    const requestPromises = agents.map(async (agentId, i) => {
        const isAsync = i % 2 === 0;
        const res = await brokerRequest(actualPort, '/request', {
            resource,
            duration_seconds: 5,
            wait_mode: isAsync ? 'ASYNC' : 'BLOCKING',
            allow_conflict: true
        });
        return { agentId, isAsync, ...res };
    });

    // We don't await them all immediately because blocking ones will hang.
    // We just want to ensure they all hit the broker.
    await delay(2000);

    // --- Phase 2: Broker Responsiveness check during pressure ---
    const status = await getStatus(actualPort, resource);
    assert.ok(status.queueDepth >= CONCURRENCY - 1, `Queue depth should be high, got ${status.queueDepth}`);
    console.log(`[Stress] Broker responsive. Queue depth: ${status.queueDepth}`);

    // --- Phase 3: Randomized Lifecycle (Claim, Release, Cancel) ---
    console.log(`[Stress] Phase 3: Processing queue with random interactions...`);
    
    // Helper to process a single agent's lifecycle
    async function processAgent(agentData: any) {
        if (agentData.data?.token) {
            const token = agentData.data.token;
            if (token.startsWith('q_')) {
                // It's a ticket, random wait then claim or cancel
                await delay(Math.random() * 1000);
                if (Math.random() > 0.2) {
                    const claim = await claimTicket(actualPort, token);
                    if (claim.status === 200) {
                        await delay(Math.random() * 500);
                        await yieldLease(actualPort, claim.data.token);
                    }
                } else {
                    await brokerRequest(actualPort, '/api/reservation/cancel', { ticketId: token });
                }
            } else {
                // It's a direct lease (blocking result)
                await delay(Math.random() * 500);
                await yieldLease(actualPort, token);
            }
        }
    }

    // Start consuming the queue
    const lifecyclePromises = requestPromises.map(p => p.then(processAgent));

    // --- Phase 4: Simulated Device Hangs & Large Output ---
    console.log(`[Stress] Phase 4: Injecting hanging commands and large output...`);
    const hangingAgent = await requestLease(actualPort, resource, 10, true);
    if (hangingAgent.data?.token) {
        // Large stderr / stdout simulation via relay
        // We use a command that produces lots of data then hangs
        brokerRequest(actualPort, '/relay', {
            token: hangingAgent.data.token,
            args: ['bash', '-c', 'for i in {1..1000}; do echo "OUT $i"; echo "ERR $i" >&2; done; sleep 10']
        }).catch(() => {});
    }

    await delay(1000);
    const midStatus = await getStatus(actualPort, resource);
    assert.ok(midStatus.state !== 'UNKNOWN', 'Broker should still be alive');

    // --- Phase 5: Broker Restart ---
    console.log(`[Stress] Phase 5: Simulating Broker Restart...`);
    const tdbConfig = broker.tdbConfigFile;
    await broker.process.kill('SIGKILL'); // Hard kill
    
    // Restart broker (manually since startBrokerInstance creates new tdb)
    broker = await startBrokerInstance(actualPort); 
    console.log(`[Stress] Broker restarted on port ${broker.port}`);

    // --- Phase 6: Final Verification ---
    console.log(`[Stress] Phase 6: Final integrity check...`);
    await delay(2000); // Give it a moment to stabilize
    
    const finalStatus = await getStatus(broker.port, resource);
    // After restart without persistence (since we used fresh startBrokerInstance), 
    // the resource should be FREE. 
    assert.strictEqual(finalStatus.queueDepth, 0, 'Queue should be empty after fresh restart');
    assert.strictEqual(finalStatus.state, 'FREE', 'Resource should be FREE after fresh restart');

    await broker.stop();
    console.log(`[Stress] Test completed successfully.`);
});
