import { Adapter, AdapterConfig } from './types';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { boundedExec } from './utils';

export class AdbAdapter implements Adapter {
    private config!: AdapterConfig;
    private adbPath: string;

    constructor() {
        this.adbPath = process.env.ARBITER_REAL_ADB_PATH || 'adb';
    }

    async connect(config: AdapterConfig): Promise<void> {
        this.config = config;
        
        if (process.env.ARBITER_TEST_MODE === 'true') {
            return; // Skip wait-for-device in tests
        }

        // Wait for device
        const args = config.serial ? ['-s', config.serial, 'wait-for-device'] : ['wait-for-device'];
        const res = await boundedExec(this.adbPath, args, { timeoutMs: 30000 });
        if (res.exitCode !== 0) {
            throw new Error(`Failed to connect to ADB device: ${res.stderr}`);
        }
    }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        const fullArgs = this.config.serial ? ['-s', this.config.serial, ...args] : [...args];
        return await boundedExec(this.adbPath, fullArgs);
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {
        const fullArgs = this.config.serial ? ['-s', this.config.serial, ...args] : [...args];
        const binParts = this.adbPath.split(' ');
        const proc = spawn(binParts[0], [...binParts.slice(1), ...fullArgs]);
        
        return new Promise((resolve, reject) => {
            proc.stdout.on('data', (d: Buffer) => onData(d.toString()));
            proc.stderr.on('data', (d: Buffer) => onData(d.toString()));
            proc.on('close', () => resolve());
            proc.on('error', reject);
        });
    }

    async screenshot(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_${this.config.resourceId}_${ts}.png`);
        
        const fullArgs = this.config.serial ? ['-s', this.config.serial, 'exec-out', 'screencap', '-p'] : ['exec-out', 'screencap', '-p'];
        const binParts = this.adbPath.split(' ');
        const proc = spawn(binParts[0], [...binParts.slice(1), ...fullArgs]);
        const writeStream = fs.createWriteStream(localPath);
        
        return new Promise((resolve, reject) => {
            proc.stdout.pipe(writeStream);
            proc.on('close', (code) => {
                if (code === 0) resolve(localPath);
                else reject(new Error(`ADB screenshot failed with code ${code}`));
            });
            proc.on('error', reject);
        });
    }

    async captureLogs(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_${this.config.resourceId}_logcat_${ts}.txt`);
        const res = await this.execute(['logcat', '-d']);
        fs.writeFileSync(localPath, res.stdout);
        return localPath;
    }

    async disconnect(): Promise<void> {
        // ADB has no explicit disconnection per device, usually just kill-server or ignore
    }
}
