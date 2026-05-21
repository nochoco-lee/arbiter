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
        let buf = '';
        const timer = setTimeout(() => {
            reject(new Error(`Timeout waiting for broker ARBITER_PORT_READY signal`));
        }, timeoutMs);

        const onData = (chunk: Buffer | string) => {
            buf += chunk.toString();
            const match = buf.match(/ARBITER_PORT_READY=(\d+)/);
            if (match) {
                clearTimeout(timer);
                proc.stdout!.off('data', onData);
                resolve(parseInt(match[1], 10));
            }
        };
        proc.stdout!.on('data', onData);
    });
}

export async function startBrokerInstance(port: number): Promise<BrokerInstance> {
    return startBrokerWithEnv(port, {});
}

export async function startBrokerWithEnv(port: number, env: Record<string, string>): Promise<BrokerInstance> {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `arbiter-test-`));
    const tdbConfigFile = path.join(testDir, `tdb_config.json`);
    fs.writeFileSync(tdbConfigFile, JSON.stringify([]));

    const brokerArgs = [
        path.join('node_modules', 'ts-node', 'dist', 'bin.js'),
        path.join('src', 'broker', 'server.ts')
    ];

    const brokerProc = spawn('node', brokerArgs, {
        env: {
            ...process.env,
            ...env,
            ARBITER_PORT: port.toString(), // 0 = OS assigns a free port
            ARBITER_TEST_MODE: 'true',
            ARBITER_SKIP_ARTIFACTS: 'true',
            ARBITER_CONTEXT_DIR: testDir,
            ARBITER_REAL_ADB_PATH: `node ${path.resolve('node_modules', 'ts-node', 'dist', 'bin.js')} ${path.resolve('src', 'tests', 'tdb.ts')}`,
            ARBITER_REAL_MOCK_PATH: `node ${path.resolve('src', 'tests', 'mock_stream.js')}`,
            TDB_CONFIG_PATH: tdbConfigFile
        }
    });

    // Discover the actual bound port from the broker's stdout ready-signal
    // before attaching the logging forwarder (which would consume the data).
    const boundPort = await waitForBrokerReady(brokerProc);

    brokerProc.stdout!.on('data', d => console.log(`[BROKER-${boundPort}] ` + d.toString().trim()));
    brokerProc.stderr!.on('data', d => console.error(`[BROKER-${boundPort} ERR] ` + d.toString().trim()));

    return new BrokerInstance(boundPort, brokerProc, tdbConfigFile);
}
