import { test } from 'node:test';
import * as assert from 'node:assert';
import { startBrokerInstance, startBrokerWithEnv, delay, createUniqueResource } from '../helpers/harness';
import { brokerRequest, requestLease, yieldLease, claimTicket, requestPermit, resolvePermit } from '../helpers/broker';
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
    const yamlConfig = `default_lease_seconds: 30\nasync_ticket_threshold_seconds: 180\n`;

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
        // Usually yield returns 200 or 404, we'll just test relay which must fail.
    } finally {
        await broker.stop();
        console.log(`[RealWorld] Test completed successfully.`);
    }
});

test('Robustness: Intensive multi-agent developer pipeline scenario', { timeout: 120000 }, async (t) => {
    const port = 0;
    const yamlConfig = `default_lease_seconds: 15\nasync_ticket_threshold_seconds: 5\n`;

    // Tight timeouts: 3s initial inactivity, 2s ticket claim window
    const broker = await startBrokerWithEnv(port, {
        ARBITER_INITIAL_INACTIVITY_TIMEOUT: '3000',
        ARBITER_TICKET_CLAIM_WINDOW: '2000'
    }, yamlConfig);
    const actualPort = broker.port;
    const resource = createUniqueResource('dev_pipeline');

    console.log(`[DeveloperPipeline] Started broker on port ${actualPort} for resource ${resource}`);

    try {
        // --- Agent 1: Build & Install Agent ---
        console.log(`[DeveloperPipeline] Agent 1 requesting lease...`);
        const res1 = await requestLease(actualPort, resource);
        assert.strictEqual(res1.status, 200);
        const token1 = res1.data.token;
        console.log(`[DeveloperPipeline] Agent 1 acquired lease: ${token1}`);

        // Run mock install command
        const installRes = await brokerRequest(actualPort, '/relay', {
            token: token1,
            args: ['echo', 'installing_apk_version_1.0.4']
        });
        assert.strictEqual(installRes.status, 200);

        // Yield lease and save context
        console.log(`[DeveloperPipeline] Agent 1 yielding lease with context...`);
        const context1 = {
            schema_version: 1,
            resource,
            session_id: 'session-1',
            duration_seconds: 5,
            outcome: 'install_success',
            findings: 'installed version 1.0.4 successfully',
            artifacts: ['app.apk']
        };
        const yield1WithContext = await brokerRequest(actualPort, '/yield', {
            token: token1,
            reason: 'complete',
            context: context1
        });
        assert.strictEqual(yield1WithContext.status, 200);

        // --- Agent 2: Test Execution Agent ---
        console.log(`[DeveloperPipeline] Agent 2 requesting lease...`);
        const res2 = await requestLease(actualPort, resource, 45);
        assert.strictEqual(res2.status, 200);
        const token2 = res2.data.token;
        console.log(`[DeveloperPipeline] Agent 2 acquired lease: ${token2}`);

        // Agent 2 reads previous context
        console.log(`[DeveloperPipeline] Agent 2 reading last context...`);
        const getContextDirect = await new Promise<any>((resolve, reject) => {
            const http = require('http');
            http.get(`http://127.0.0.1:${actualPort}/api/context?resource=${encodeURIComponent(resource)}`, (res: any) => {
                let d = ''; res.on('data', (c: any) => d += c);
                res.on('end', () => resolve(JSON.parse(d)));
            }).on('error', reject);
        });
        assert.strictEqual(getContextDirect.outcome, 'install_success');
        assert.strictEqual(getContextDirect.findings, 'installed version 1.0.4 successfully');

        // Agent 2 runs tests (takes ~3s total, heartbeating via relay commands)
        for (let i = 0; i < 3; i++) {
            await delay(1000);
            const relayRes = await brokerRequest(actualPort, '/relay', {
                token: token2,
                args: ['echo', `running_test_step_${i}`]
            });
            assert.strictEqual(relayRes.status, 200);

            // During step 1, Agent 3 (helper) requests a permit to run logcat
            if (i === 1) {
                console.log(`[DeveloperPipeline] Agent 3 (helper) requesting permit...`);
                const permitReq = await requestPermit(actualPort, resource, 'echo logcat_data');
                assert.strictEqual(permitReq.status, 200);
                const permitId = permitReq.data.id;

                console.log(`[DeveloperPipeline] Agent 2 granting permit ${permitId}...`);
                const permitResolve = await resolvePermit(actualPort, token2, permitId, true);
                assert.strictEqual(permitResolve.status, 200);
                const permitToken = permitResolve.data.permit_token;
                assert.ok(permitToken);

                console.log(`[DeveloperPipeline] Agent 3 running permit command...`);
                const permitRelay = await brokerRequest(actualPort, '/relay', {
                    token: permitToken,
                    args: ['echo', 'logcat_data']
                });
                assert.strictEqual(permitRelay.status, 200);
            }
        }

        // Agent 2 yields lease with context
        console.log(`[DeveloperPipeline] Agent 2 yielding lease with context...`);
        const context2 = {
            schema_version: 1,
            resource,
            session_id: 'session-2',
            duration_seconds: 10,
            outcome: 'tests_passed',
            findings: 'all 5 tests passed successfully',
            artifacts: ['test_log.txt']
        };
        const yield2WithContext = await brokerRequest(actualPort, '/yield', {
            token: token2,
            reason: 'complete',
            context: context2
        });
        assert.strictEqual(yield2WithContext.status, 200);

        // --- Agent 4: Reporting Agent ---
        console.log(`[DeveloperPipeline] Agent 4 requesting lease...`);
        const res4 = await requestLease(actualPort, resource);
        assert.strictEqual(res4.status, 200);
        const token4 = res4.data.token;

        const getContext2 = await new Promise<any>((resolve, reject) => {
            const http = require('http');
            http.get(`http://127.0.0.1:${actualPort}/api/context?resource=${encodeURIComponent(resource)}`, (res: any) => {
                let d = ''; res.on('data', (c: any) => d += c);
                res.on('end', () => resolve(JSON.parse(d)));
            }).on('error', reject);
        });
        assert.strictEqual(getContext2.outcome, 'tests_passed');
        assert.strictEqual(getContext2.findings, 'all 5 tests passed successfully');

        await yieldLease(actualPort, token4);

        // --- Agent 5: Crash/Timeout Simulation ---
        console.log(`[DeveloperPipeline] Agent 5 requesting lease...`);
        const res5 = await requestLease(actualPort, resource);
        assert.strictEqual(res5.status, 200);
        const token5 = res5.data.token;

        // Agent 6 is enqueued behind Agent 5
        console.log(`[DeveloperPipeline] Agent 6 enqueuing (wait_mode=ASYNC)...`);
        const res6_pending = await brokerRequest(actualPort, '/request', {
            resource,
            duration_seconds: 10,
            wait_mode: 'ASYNC',
            allow_conflict: true
        });
        assert.strictEqual(res6_pending.status, 202);
        const ticket6 = res6_pending.data.token;

        // Agent 5 does nothing and crashes (we wait 4.5s for inactivity timeout to reclaim it)
        console.log(`[DeveloperPipeline] Agent 5 goes idle. Waiting 4.5s for watchdog to reclaim...`);
        await delay(4500);

        // Verify resource is no longer held by Agent 5
        const statusAfterCrash = await getStatus(actualPort, resource);
        assert.ok(
            statusAfterCrash.state === 'FREE' || statusAfterCrash.state === 'GRANTED',
            `Lease should be FREE or GRANTED after Agent 5 inactivity, got ${statusAfterCrash.state}`
        );

        // Agent 6 claims the lease successfully
        console.log(`[DeveloperPipeline] Agent 6 claiming lease after Agent 5 crash...`);
        const claim6 = await claimTicket(actualPort, ticket6);
        assert.strictEqual(claim6.status, 200, 'Agent 6 should claim the lease after Agent 5 crashed');
        await yieldLease(actualPort, claim6.data.token);

        console.log(`[DeveloperPipeline] Pipeline test completed successfully.`);
    } finally {
        await broker.stop();
    }
});

test('Robustness: Multi-project multi-agent workstation scenario', { timeout: 120000 }, async (t) => {
    const port = 0;
    const yamlConfig = `default_lease_seconds: 30\nasync_ticket_threshold_seconds: 180\n`;

    const broker = await startBrokerWithEnv(port, {
        ARBITER_INITIAL_INACTIVITY_TIMEOUT: '5000'
    }, yamlConfig);
    const actualPort = broker.port;

    const resA = createUniqueResource('res_project_a');
    const resB = createUniqueResource('res_project_b');

    console.log(`[Workstation] Started broker on port ${actualPort} with resources ${resA} and ${resB}`);

    try {
        // --- Project A Loop ---
        const projectAWorkflow = async () => {
            // Agent A1: Feature
            console.log(`[Workstation] Agent A1 requesting ${resA}...`);
            const leaseA1 = await requestLease(actualPort, resA);
            assert.strictEqual(leaseA1.status, 200);
            const tokenA1 = leaseA1.data.token;

            const relayA1 = await brokerRequest(actualPort, '/relay', {
                token: tokenA1,
                args: ['echo', 'building_feature_login']
            });
            assert.strictEqual(relayA1.status, 200);

            // Yield with context
            const contextA1 = {
                schema_version: 1,
                resource: resA,
                session_id: 'session-a1',
                duration_seconds: 10,
                outcome: 'build_success',
                findings: 'feature branch feature-login compiled successfully',
                artifacts: ['login_controller.ts']
            };
            const yieldA1 = await brokerRequest(actualPort, '/yield', {
                token: tokenA1,
                reason: 'complete',
                context: contextA1
            });
            assert.strictEqual(yieldA1.status, 200);

            // Agent A2: Bugfix
            console.log(`[Workstation] Agent A2 requesting ${resA}...`);
            const leaseA2 = await requestLease(actualPort, resA);
            assert.strictEqual(leaseA2.status, 200);
            const tokenA2 = leaseA2.data.token;

            // Inherit context
            const contextA2Loaded = await new Promise<any>((resolve, reject) => {
                const http = require('http');
                http.get(`http://127.0.0.1:${actualPort}/api/context?resource=${encodeURIComponent(resA)}`, (res: any) => {
                    let d = ''; res.on('data', (c: any) => d += c);
                    res.on('end', () => resolve(JSON.parse(d)));
                }).on('error', reject);
            });
            assert.strictEqual(contextA2Loaded.outcome, 'build_success');

            const relayA2 = await brokerRequest(actualPort, '/relay', {
                token: tokenA2,
                args: ['echo', 'applying_bugfix_patch']
            });
            assert.strictEqual(relayA2.status, 200);

            // Yield bugfix context
            const contextA2 = {
                schema_version: 1,
                resource: resA,
                session_id: 'session-a2',
                duration_seconds: 10,
                outcome: 'patch_applied',
                findings: 'session timeout bug fixed',
                artifacts: ['session_handler.ts']
            };
            const yieldA2 = await brokerRequest(actualPort, '/yield', {
                token: tokenA2,
                reason: 'complete',
                context: contextA2
            });
            assert.strictEqual(yieldA2.status, 200);
        };

        // --- Project B Loop ---
        const projectBWorkflow = async () => {
            // Agent B1: Stripe Feature
            console.log(`[Workstation] Agent B1 requesting ${resB}...`);
            const leaseB1 = await requestLease(actualPort, resB);
            assert.strictEqual(leaseB1.status, 200);
            const tokenB1 = leaseB1.data.token;

            const relayB1 = await brokerRequest(actualPort, '/relay', {
                token: tokenB1,
                args: ['echo', 'configuring_stripe_webhooks']
            });
            assert.strictEqual(relayB1.status, 200);

            // Yield with context
            const contextB1 = {
                schema_version: 1,
                resource: resB,
                session_id: 'session-b1',
                duration_seconds: 10,
                outcome: 'stripe_success',
                findings: 'stripe webhook config verified',
                artifacts: ['stripe_service.ts']
            };
            const yieldB1 = await brokerRequest(actualPort, '/yield', {
                token: tokenB1,
                reason: 'complete',
                context: contextB1
            });
            assert.strictEqual(yieldB1.status, 200);

            // Agent B2: Cart Bugfix
            console.log(`[Workstation] Agent B2 requesting ${resB}...`);
            const leaseB2 = await requestLease(actualPort, resB);
            assert.strictEqual(leaseB2.status, 200);
            const tokenB2 = leaseB2.data.token;

            // Inherit context
            const contextB2Loaded = await new Promise<any>((resolve, reject) => {
                const http = require('http');
                http.get(`http://127.0.0.1:${actualPort}/api/context?resource=${encodeURIComponent(resB)}`, (res: any) => {
                    let d = ''; res.on('data', (c: any) => d += c);
                    res.on('end', () => resolve(JSON.parse(d)));
                }).on('error', reject);
            });
            assert.strictEqual(contextB2Loaded.outcome, 'stripe_success');

            const relayB2 = await brokerRequest(actualPort, '/relay', {
                token: tokenB2,
                args: ['echo', 'fixing_cart_rounding']
            });
            assert.strictEqual(relayB2.status, 200);

            // Yield checkout context
            const contextB2 = {
                schema_version: 1,
                resource: resB,
                session_id: 'session-b2',
                duration_seconds: 10,
                outcome: 'rounding_fixed',
                findings: 'stripe cart rounding issue resolved',
                artifacts: ['checkout_calculator.ts']
            };
            const yieldB2 = await brokerRequest(actualPort, '/yield', {
                token: tokenB2,
                reason: 'complete',
                context: contextB2
            });
            assert.strictEqual(yieldB2.status, 200);
        };

        // Run both workflows concurrently
        await Promise.all([projectAWorkflow(), projectBWorkflow()]);

        // Verify isolation & final contexts
        const finalCtxA = await new Promise<any>((resolve, reject) => {
            const http = require('http');
            http.get(`http://127.0.0.1:${actualPort}/api/context?resource=${encodeURIComponent(resA)}`, (res: any) => {
                let d = ''; res.on('data', (c: any) => d += c);
                res.on('end', () => resolve(JSON.parse(d)));
            }).on('error', reject);
        });
        assert.strictEqual(finalCtxA.outcome, 'patch_applied');
        assert.strictEqual(finalCtxA.findings, 'session timeout bug fixed');

        const finalCtxB = await new Promise<any>((resolve, reject) => {
            const http = require('http');
            http.get(`http://127.0.0.1:${actualPort}/api/context?resource=${encodeURIComponent(resB)}`, (res: any) => {
                let d = ''; res.on('data', (c: any) => d += c);
                res.on('end', () => resolve(JSON.parse(d)));
            }).on('error', reject);
        });
        assert.strictEqual(finalCtxB.outcome, 'rounding_fixed');
        assert.strictEqual(finalCtxB.findings, 'stripe cart rounding issue resolved');

    } finally {
        await broker.stop();
        console.log(`[Workstation] Test completed.`);
    }
});
