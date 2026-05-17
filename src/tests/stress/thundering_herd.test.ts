import { test } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import { allocatePort, startBrokerInstance } from '../helpers/harness';
import { randomUUID } from 'crypto';

process.env.ARBITER_TEST_MODE = 'true';
process.env.ARBITER_SKIP_ARTIFACTS = 'true';

const CONCURRENCY = 50;

test('Thundering Herd Concurrency', async (t) => {
    const port = allocatePort();
    const broker = await startBrokerInstance(port);
    const resource = `test-herd-${randomUUID().substring(0, 8)}`;

    try {
        const promises: Promise<any>[] = [];
        
        // Detonate 50 simultaneous parallel requests
        for (let i = 0; i < CONCURRENCY; i++) {
            promises.push(new Promise((resolve) => {
                const req = http.request(`http://127.0.0.1:${broker.port}/request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }, (res) => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d) }));
                });
                req.on('error', (e) => resolve({ status: 500, error: e }));
                req.write(JSON.stringify({
                    resource,
                    duration_seconds: 60,
                    wait_mode: 'ASYNC',
                    allow_conflict: true
                }));
                req.end();
            }));
        }

        const results = await Promise.all(promises);

        // Analyze results
        let grantedCount = 0;
        let queuedCount = 0;
        let errors = 0;

        for (const res of results) {
            if (res.status === 200 && res.data?.token && !res.data.token.startsWith('q_')) {
                grantedCount++;
            } else if (res.status === 202 && res.data?.token?.startsWith('q_')) {
                queuedCount++;
            } else {
                errors++;
            }
        }

        assert.strictEqual(errors, 0, 'No HTTP requests should fail or return unexpected status');
        assert.strictEqual(grantedCount, 0, 'In ASYNC mode, no leases are granted directly; they all get tickets');
        assert.strictEqual(queuedCount, CONCURRENCY, 'All 50 requests should be safely queued as tickets');

        // Verify queue depth on the broker matches
        const statusReq = await new Promise<any>((resolve) => {
            http.get(`http://127.0.0.1:${broker.port}/status?resource=${resource}`, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => resolve(JSON.parse(d)));
            });
        });

        assert.strictEqual(statusReq.queueDepth, CONCURRENCY, 'Broker internal queue depth must perfectly match the async tickets generated');
        assert.strictEqual(statusReq.headType, 'READY', 'The first ticket should be automatically promoted to READY state');

    } finally {
        await broker.stop();
    }
});
