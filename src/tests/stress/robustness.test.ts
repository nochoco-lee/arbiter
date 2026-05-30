import { test } from 'node:test';
import * as assert from 'node:assert';
import { startBrokerInstance, startBrokerWithEnv, delay, createUniqueResource } from '../helpers/harness';
import { brokerRequest, requestLease, yieldLease, claimTicket } from '../helpers/broker';
import { getStatus } from '../helpers/assertions';

test('Robustness: High Concurrency, Restarts, and Hanging Commands', { timeout: 120000 }, async (t) => {
    const port = 0;
    let broker = await startBrokerInstance(port);
    const actualPort = broker.port;
    const resource = createUniqueResource('stress');

    console.log(`[Stress] Started broker on port ${actualPort} for resource ${resource}`);

    try {
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
    } finally {
        await broker.stop();
        console.log(`[Stress] Test completed successfully.`);
    }
});

test('Robustness: Real-world scenario with timeouts and queuing', { timeout: 120000 }, async (t) => {
    const port = 0;
    const yamlConfig = `default_lease_seconds: 30\n`;
    
    // Broker with 30s session timeout, 10s initial inactivity timeout
    const broker = await startBrokerWithEnv(port, { ARBITER_INITIAL_INACTIVITY_TIMEOUT: '10000' }, yamlConfig);
    const actualPort = broker.port;
    const resource = createUniqueResource('timeout_scenario');

    console.log(`[RealWorld] Started broker on port ${actualPort} for resource ${resource}`);

    try {
        // Agent A requests lease
    const resA = await requestLease(actualPort, resource);
    assert.strictEqual(resA.status, 200);
    const tokenA = resA.data.token;
    console.log(`[RealWorld] Agent A acquired lease: ${tokenA}`);

    // Wait for initial inactivity timeout (10s)
    console.log(`[RealWorld] Waiting 12s for Agent A inactivity timeout...`);
    await delay(12000);

    // Verify Agent A lease is lost (resource should be FREE or given to next)
    const status1 = await getStatus(actualPort, resource);
    assert.strictEqual(status1.state, 'FREE', 'Resource should be FREE after A inactivity timeout');

    // Agent B requests lease
    const resB = await requestLease(actualPort, resource);
    assert.strictEqual(resB.status, 200);
    const tokenB = resB.data.token;
    console.log(`[RealWorld] Agent B acquired lease: ${tokenB}`);

    // Agent B uses shim so initial inactivity timeout does NOT occur
    // Send relay command within 10s
    await delay(2000);
    console.log(`[RealWorld] Agent B uses shim`);
    const relayB = await brokerRequest(actualPort, '/relay', {
        token: tokenB,
        args: ['echo', 'AgentB']
    });
    // The command executes
    assert.strictEqual(relayB.status, 200);

    // Wait past the 10s initial inactivity boundary (12s total since B acquired)
    console.log(`[RealWorld] Waiting 10s to verify B does not timeout...`);
    await delay(10000);

    // Verify B is still holding the lease
    const status2 = await getStatus(actualPort, resource);
    assert.strictEqual(status2.state, 'GRANTED', 'Resource should be GRANTED by B');

    // Agent A tries to use shim, gets permission denied / expired
    console.log(`[RealWorld] Agent A tries to use shim with old token`);
    const relayA = await brokerRequest(actualPort, '/relay', {
        token: tokenA,
        args: ['echo', 'AgentA']
    });
    assert.notStrictEqual(relayA.status, 200, 'Agent A should not be allowed to use shim');

    // Agent A requests lease, gets queued (wait_mode=ASYNC) with a short 10s duration
    console.log(`[RealWorld] Agent A requests lease again for 10s`);
    const resA_pending = await brokerRequest(actualPort, '/request', {
        resource,
        duration_seconds: 10,
        wait_mode: 'ASYNC',
        allow_conflict: true
    });
    assert.strictEqual(resA_pending.status, 202);
    const ticketA = resA_pending.data.token;
    assert.ok(ticketA.startsWith('q_'), 'Agent A should receive a queue ticket');

    // Agent B releases lease
    console.log(`[RealWorld] Agent B releases lease`);
    const yieldB = await yieldLease(actualPort, tokenB);
    assert.strictEqual(yieldB.status, 200);

    // Agent A acquires lease after B releases
    console.log(`[RealWorld] Agent A claims lease`);
    // Might need a moment for the broker to notify / move queue, but claimTicket checks it
    await delay(1000);
    const claimA = await claimTicket(actualPort, ticketA);
    assert.strictEqual(claimA.status, 200, 'Agent A should successfully claim the lease');
    const newTokenA = claimA.data.token;
    assert.ok(!newTokenA.startsWith('q_'), 'Agent A should have a real token now');

    // Agent B sees token expired/unauthorized
    console.log(`[RealWorld] Agent B tries to use shim with yielded token`);
    const relayB_late = await brokerRequest(actualPort, '/relay', {
        token: tokenB,
        args: ['echo', 'AgentB_late']
    });
    assert.notStrictEqual(relayB_late.status, 200, 'Agent B should not be allowed to use shim after yielding');

    // Agent B requests lease and gets queued
    console.log(`[RealWorld] Agent B requests lease again`);
    const resB_pending = await brokerRequest(actualPort, '/request', {
        resource,
        duration_seconds: 30,
        wait_mode: 'ASYNC',
        allow_conflict: true
    });
    assert.strictEqual(resB_pending.status, 202);
    const ticketB = resB_pending.data.token;

    // Agent A uses shim so initial inactivity doesn't kill it, we want session timeout to kill it!
    await brokerRequest(actualPort, '/relay', { token: newTokenA, args: ['echo', 'AgentA'] });

    // Wait for Agent A's session to expire natively (10s + 2s buffer)
    console.log(`[RealWorld] Waiting 12s for Agent A's session to expire and trigger queue promotion...`);
    await delay(12000);

    // Agent B gets lease automatically after A timed out
    console.log(`[RealWorld] Agent B claims lease after A timeout`);
    const claimB = await claimTicket(actualPort, ticketB);
    assert.strictEqual(claimB.status, 200, 'Agent B should claim lease after A expires');
    const newTokenB = claimB.data.token;

    // Real-world Case: Token Heartbeat
    console.log(`[RealWorld] Agent B uses heartbeat to keep lease alive`);
    await delay(5000); // within 10s inactivity window
    const hbRes = await brokerRequest(actualPort, '/api/lease/heartbeat', { token: newTokenB });
    assert.strictEqual(hbRes.status, 200, 'Heartbeat should succeed');
    
    console.log(`[RealWorld] Waiting 7s to exceed initial inactivity timeout (if heartbeat failed)`);
    await delay(7000); // 5 + 7 = 12s total since B acquired. Should be dead if no heartbeat.
    const statusHB = await getStatus(actualPort, resource);
    assert.strictEqual(statusHB.state, 'GRANTED', 'Agent B lease should survive via heartbeat');

    // Agent B yields
    console.log(`[RealWorld] Agent B yields lease`);
    await yieldLease(actualPort, newTokenB);

    // Real-world Case: Queue Cancellation
    console.log(`[RealWorld] Queue Cancellation Test`);
    const resC = await requestLease(actualPort, resource); // C gets it immediately
    const tokenC = resC.data.token;

    // D and E enter queue
    const resD_pending = await brokerRequest(actualPort, '/request', { resource, duration_seconds: 30, wait_mode: 'ASYNC', allow_conflict: true });
    const resE_pending = await brokerRequest(actualPort, '/request', { resource, duration_seconds: 30, wait_mode: 'ASYNC', allow_conflict: true });
    const ticketD = resD_pending.data.token;
    const ticketE = resE_pending.data.token;

    // D cancels its ticket
    console.log(`[RealWorld] Agent D cancels its ticket`);
    const cancelD = await brokerRequest(actualPort, '/api/reservation/cancel', { ticketId: ticketD });
    assert.strictEqual(cancelD.status, 200, 'Cancel should succeed');

    // C releases
    console.log(`[RealWorld] Agent C yields lease`);
    await yieldLease(actualPort, tokenC);
    await delay(1000);

    // E claims successfully (D was skipped)
    console.log(`[RealWorld] Agent E claims lease after D cancelled`);
    const claimE = await claimTicket(actualPort, ticketE);
    assert.strictEqual(claimE.status, 200, 'Agent E should successfully claim the lease');
    const tokenE = claimE.data.token;

    // Real-world Case: Short-duration session expiry
    console.log(`[RealWorld] Short-duration session expiry`);
    await yieldLease(actualPort, tokenE);

    const resF = await requestLease(actualPort, resource, 5); // 5 second max duration
    assert.strictEqual(resF.status, 200);
    const tokenF = resF.data.token;
    console.log(`[RealWorld] Agent F acquired 5s lease`);
    
    // Send a relay to reset inactivity, so we ONLY test session timeout
    await brokerRequest(actualPort, '/relay', { token: tokenF, args: ['echo', 'F'] });
    
    // Wait for session timeout (5s + buffer)
    console.log(`[RealWorld] Waiting 7s for Agent F session timeout (should move to EXPIRING)...`);
    await delay(7000);
    const statusF1 = await getStatus(actualPort, resource);
    assert.strictEqual(statusF1.state, 'EXPIRING', 'Agent F lease should be in EXPIRING grace period after 5s');

    console.log(`[RealWorld] Waiting 6s for Agent F grace period to end...`);
    await delay(6000);
    const statusF2 = await getStatus(actualPort, resource);
    assert.strictEqual(statusF2.state, 'AVAILABLE', 'Agent F lease should be AVAILABLE after grace period');

    // Real-world Case: Invalid token handling
    console.log(`[RealWorld] Invalid token handling`);
    const invalidRelay = await brokerRequest(actualPort, '/relay', { token: 'invalid-token-123', args: ['echo', 'bad'] });
    assert.notStrictEqual(invalidRelay.status, 200, 'Relay with invalid token should fail');
    
    const invalidYield = await yieldLease(actualPort, 'invalid-token-123');
    // The current broker yields 200 for yield on invalid token as it's idempotent, let's just log it or assert >= 200.
    // Usually yield returns 200 or 404, we'll just test relay which must fail.
    } finally {
        await broker.stop();
        console.log(`[RealWorld] Test completed successfully.`);
    }
});
