import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

export class BrokerInstance {
    constructor(
        public readonly port: number,
        public readonly process: ChildProcess,
        public readonly tdbConfigFile: string
    ) {}

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            this.process.on('exit', () => {
                if (fs.existsSync(this.tdbConfigFile)) {
                    try { fs.unlinkSync(this.tdbConfigFile); } catch (e) {}
                }
                resolve();
            });
            this.process.kill('SIGKILL');
        });
    }
}

// Always use port 0 — the OS assigns a free ephemeral port, eliminating
// any possibility of collision on shared CI runners.
export function allocatePort(): number {
    return 0;
}

export function createUniqueResource(name: string): string {
    const id = randomUUID().substring(0, 8);
    return `test-${name}-${id}`;
}

export function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

// Wait for the broker child process to emit ARBITER_PORT_READY=<port> on
// stdout. This is the only reliable signal that the server is fully bound
// and accepting connections — no TCP polling, no races.
export function waitForBrokerReady(
    proc: ChildProcess,
    timeoutMs: number = 30000
): Promise<number> {
    return new Promise((resolve, reject) => {
        let stdoutBuf = '';
        let stderrBuf = '';
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for broker ARBITER_PORT_READY signal after ${timeoutMs}ms. Stderr: ${stderrBuf}`));
        }, timeoutMs);

        const onStdout = (chunk: Buffer | string) => {
            stdoutBuf += chunk.toString();
            const match = stdoutBuf.match(/ARBITER_PORT_READY=(\d+)/);
            if (match) {
                cleanup();
                resolve(parseInt(match[1], 10));
            }
        };

        const onStderr = (chunk: Buffer | string) => {
            stderrBuf += chunk.toString();
        };

        const onExit = (code: number | null, signal: string | null) => {
            cleanup();
            reject(new Error(`Broker exited prematurely with code ${code} (signal: ${signal}). Stderr: ${stderrBuf}`));
        };

        const onError = (err: Error) => {
            cleanup();
            reject(new Error(`Broker process error: ${err.message}. Stderr: ${stderrBuf}`));
        };

        const cleanup = () => {
            clearTimeout(timer);
            proc.stdout!.off('data', onStdout);
            proc.stderr!.off('data', onStderr);
            proc.off('exit', onExit);
            proc.off('error', onError);
        };

        proc.stdout!.on('data', onStdout);
        proc.stderr!.on('data', onStderr);
        proc.on('exit', onExit);
        proc.on('error', onError);
    });
}

export async function startBrokerInstance(port: number): Promise<BrokerInstance> {
    return startBrokerWithEnv(port, {});
}

export async function startBrokerWithEnv(port: number, env: Record<string, string>, configYaml?: string): Promise<BrokerInstance> {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `arbiter-test-`));
    const tdbConfigFile = path.join(testDir, `tdb_config.json`);
    fs.writeFileSync(tdbConfigFile, JSON.stringify([]));

    if (configYaml) {
        fs.writeFileSync(path.join(testDir, 'arbiter.yaml'), configYaml);
    }

    const tsNodeBin = require.resolve('ts-node/dist/bin.js');
    const brokerArgs = [
        tsNodeBin,
        path.join(__dirname, '..', '..', 'broker', 'server.ts')
    ];

    const brokerProc = spawn('node', brokerArgs, {
        cwd: testDir,
        env: {
            ARBITER_WATCHDOG_INTERVAL: '1000',
            ...process.env,
            ...env,
            ARBITER_PORT: port.toString(), // 0 = OS assigns a free port
            ARBITER_TEST_MODE: 'true',
            ARBITER_SKIP_ARTIFACTS: 'true',
            ARBITER_CONTEXT_DIR: testDir,
            ARBITER_REAL_ADB_PATH: `node ${tsNodeBin} ${path.resolve(__dirname, '..', 'tdb.ts')}`,
            ARBITER_REAL_MOCK_PATH: `node ${path.resolve(__dirname, '..', 'mock_stream.js')}`,
            TDB_CONFIG_PATH: tdbConfigFile
        }
    });

    // Attach stderr immediately to catch early errors in the console
    const earlyStderrLogger = (d: any) => console.error(`[BROKER-BOOT ERR] ` + d.toString().trim());
    brokerProc.stderr!.on('data', earlyStderrLogger);

    // Discover the actual bound port from the broker's stdout ready-signal
    const boundPort = await waitForBrokerReady(brokerProc);

    // Swap boot logger for instance logger
    brokerProc.stderr!.off('data', earlyStderrLogger);
    brokerProc.stdout!.on('data', d => console.log(`[BROKER-${boundPort}] ` + d.toString().trim()));
    brokerProc.stderr!.on('data', d => console.error(`[BROKER-${boundPort} ERR] ` + d.toString().trim()));

    return new BrokerInstance(boundPort, brokerProc, tdbConfigFile);
}
