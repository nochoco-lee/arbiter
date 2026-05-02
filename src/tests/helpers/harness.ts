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

let nextPort = 38401 + Math.floor(Math.random() * 1000);

export function allocatePort(): number {
    return nextPort++;
}

export function createUniqueResource(name: string): string {
    const id = randomUUID().substring(0, 8);
    return `test-${name}-${id}`;
}

export function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

export async function waitForPort(port: number, timeoutMs: number = 20000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await new Promise((resolve, reject) => {
                const socket = new (require('net').Socket)();
                socket.setTimeout(500);
                socket.on('connect', () => { socket.destroy(); resolve(true); });
                socket.on('error', (e: any) => { socket.destroy(); reject(e); });
                socket.connect(port, '127.0.0.1');
            });
            return;
        } catch (e) {
            await delay(500);
        }
    }
    throw new Error(`Timeout waiting for port ${port}`);
}

export async function startBrokerInstance(port: number): Promise<BrokerInstance> {
    return startBrokerWithEnv(port, {});
}

export async function startBrokerWithEnv(port: number, env: Record<string, string>): Promise<BrokerInstance> {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), `arbiter-test-${port}-`));
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
            ARBITER_PORT: port.toString(),
            ARBITER_TEST_MODE: 'true',
            ARBITER_SKIP_ARTIFACTS: 'true',
            ARBITER_CONTEXT_DIR: testDir,
            ARBITER_REAL_ADB_PATH: `node ${path.resolve('node_modules', 'ts-node', 'dist', 'bin.js')} ${path.resolve('src', 'tests', 'tdb.ts')}`,
            ARBITER_REAL_MOCK_PATH: `node ${path.resolve('src', 'tests', 'mock_stream.js')}`,
            TDB_CONFIG_PATH: tdbConfigFile
        }
    });

    brokerProc.stdout.on('data', d => console.log(`[BROKER-${port}] ` + d.toString().trim()));
    brokerProc.stderr.on('data', d => console.error(`[BROKER-${port} ERR] ` + d.toString().trim()));

    await waitForPort(port);
    return new BrokerInstance(port, brokerProc, tdbConfigFile);
}
