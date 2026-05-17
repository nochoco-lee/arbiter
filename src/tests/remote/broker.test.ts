import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import { allocatePort, startBrokerWithEnv, BrokerInstance, delay } from '../helpers/harness';
import { brokerRequest } from '../helpers/broker';
import { spawn } from 'child_process';
import * as path from 'path';

describe('Remote Broker Execution (WebSocket)', () => {
    let port: number;
    let broker: BrokerInstance;
    let token: string;
    const AUTH_SECRET = 'test-secret';

    before(async () => {
        const initialPort = allocatePort();
        broker = await startBrokerWithEnv(initialPort, {
            ARBITER_AUTH_SECRET: AUTH_SECRET,
            ARBITER_BIND: '127.0.0.1'
        });
        port = broker.port;

        const reqRes = await brokerRequest(port, '/request', {
            resource: 'mock',
            duration_seconds: 60,
            wait_mode: 'BLOCKING'
        }, { 'x-arbiter-secret': AUTH_SECRET });
        assert.strictEqual(reqRes.status, 200);
        token = reqRes.data.token;
    });

    after(async () => {
        await broker.stop();
    });

    function runShim(args: string[], inputStr?: string): Promise<{ stdout: string, stderr: string, code: number | null }> {
        return new Promise((resolve) => {
            const shimPath = path.resolve('node_modules', 'ts-node', 'dist', 'bin.js');
            const shimFile = path.resolve('src', 'shim', 'index.ts');
            const child = spawn('node', [shimPath, shimFile, ...args], {
                env: {
                    ...process.env,
                    ARBITER_LEASE_TOKEN: token,
                    ARBITER_BROKER_HOST: '127.0.0.1',
                    ARBITER_PORT: port.toString(),
                    ARBITER_AUTH_SECRET: AUTH_SECRET,
                    ARBITER_TEST_MODE: 'true',
                    ARBITER_FORCE_REMOTE: 'true'
                }
            });

            let stdout = '';
            let stderr = '';
            child.stdout.on('data', d => stdout += d.toString());
            child.stderr.on('data', d => stderr += d.toString());

            if (inputStr) {
                child.stdin.write(inputStr);
                child.stdin.end();
            }

            child.on('close', (code) => {
                resolve({ stdout, stderr, code });
            });
        });
    }

    test('Scenario 1: Happy Path (One-shot command)', async () => {
        const res = await runShim(['mock', '--echo', 'hello_world']);
        assert.strictEqual(res.code, 0);
        assert.match(res.stdout, /hello_world/);
    });

    test('Scenario 2: Remote crash exits correctly', async () => {
        const res = await runShim(['mock', '--crash']);
        assert.strictEqual(res.code, 1);
        assert.match(res.stderr, /Mock stream encountered a fatal error/);
    });

    test('Scenario 3: Authentication Rejection', async () => {
        const child = spawn('node', [
            path.resolve('node_modules', 'ts-node', 'dist', 'bin.js'), 
            path.resolve('src', 'shim', 'index.ts'), 'mock', '--echo', 'hi'
        ], {
            env: {
                ...process.env,
                ARBITER_LEASE_TOKEN: token,
                ARBITER_BROKER_HOST: '127.0.0.1',
                ARBITER_PORT: port.toString(),
                ARBITER_AUTH_SECRET: 'wrong-secret',
                ARBITER_FORCE_REMOTE: 'true'
            }
        });
        
        let stderr = '';
        child.stderr.on('data', d => stderr += d.toString());
        
        const code = await new Promise(r => child.on('close', r));
        assert.strictEqual(code, 1);
        assert.match(stderr, /401/);
    });

    test('Scenario 4: Interactive stdin forwarding', async () => {
        const res = await runShim(['mock', '--interactive'], "test_input\n");
        assert.strictEqual(res.code, 0);
        assert.match(res.stdout, /Interactive mode started/);
        assert.match(res.stdout, /ECHO: test_input/);
        assert.match(res.stdout, /Interactive mode ended/);
    });

    test('Scenario 5: Streaming & Client Disconnect (SIGKILL)', async () => {
        console.log('--- STARTING SCENARIO 5 ---');
        const child = spawn('node', [
            path.resolve('node_modules', 'ts-node', 'dist', 'bin.js'), 
            path.resolve('src', 'shim', 'index.ts'), 'mock', '--logcat'
        ], {
            env: {
                ...process.env,
                ARBITER_LEASE_TOKEN: token,
                ARBITER_BROKER_HOST: '127.0.0.1',
                ARBITER_PORT: port.toString(),
                ARBITER_AUTH_SECRET: AUTH_SECRET,
                ARBITER_FORCE_REMOTE: 'true'
            }
        });

        let stdout = '';
        await new Promise<void>((resolve) => {
            child.stdout.on('data', d => {
                const chunk = d.toString();
                stdout += chunk;
                console.log(`[SCENARIO 5 STDOUT]: ${chunk.trim()}`);
                if (stdout.includes('Log line 2')) {
                    console.log('--- LOG LINE 2 RECEIVED ---');
                    resolve();
                }
            });
            child.stderr.on('data', d => console.error(`[SCENARIO 5 STDERR]: ${d.toString().trim()}`));
        });

        // Hard kill the shim
        console.log('--- KILLING SHIM ---');
        child.kill('SIGKILL');
        await delay(500);
        console.log('--- FINISHED SCENARIO 5 ---');
    });

    test('Scenario 6: Forwarding SIGINT', async (t) => {
        if (process.platform === 'win32') {
            t.skip('SIGINT cannot be caught on Windows using child.kill()');
            return;
        }
        
        const child = spawn('node', [
            path.resolve('node_modules', 'ts-node', 'dist', 'bin.js'), 
            path.resolve('src', 'shim', 'index.ts'), 'mock', '--logcat'
        ], {
            env: {
                ...process.env,
                ARBITER_LEASE_TOKEN: token,
                ARBITER_BROKER_HOST: '127.0.0.1',
                ARBITER_PORT: port.toString(),
                ARBITER_AUTH_SECRET: AUTH_SECRET,
                ARBITER_FORCE_REMOTE: 'true'
            }
        });

        let stdout = '';
        await new Promise<void>((resolve) => {
            child.stdout.on('data', d => {
                stdout += d.toString();
                if (stdout.includes('Log line 1')) resolve();
            });
        });

        // Send SIGINT to the shim
        child.kill('SIGINT');
        
        let allStdout = stdout;
        child.stdout.on('data', d => allStdout += d.toString());

        const code = await new Promise(r => child.on('close', r));
        assert.strictEqual(code, 0); 
        // Mock stream should have printed the cleanup message
        assert.match(allStdout, /Logcat interrupted cleanly/);
    });
});
