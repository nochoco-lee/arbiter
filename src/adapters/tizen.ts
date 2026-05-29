import { Adapter, AdapterConfig } from './types';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { boundedExec } from './utils';

export class TizenAdapter implements Adapter {
    private config!: AdapterConfig;
    private sdbPath = 'sdb';

    async connect(config: AdapterConfig): Promise<void> {
        this.config = config;
        
        if (this.config.serial) {
            await boundedExec(this.sdbPath, ['connect', this.config.serial], { timeoutMs: 15000 });
        }
    }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        const fullArgs = this.config.serial ? ['-s', this.config.serial, ...args] : [...args];
        return await boundedExec(this.sdbPath, fullArgs);
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {
        const fullArgs = this.config.serial ? ['-s', this.config.serial, ...args] : [...args];
        const proc = spawn(this.sdbPath, fullArgs);
        
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
        await this.execute(['shell', 'sdbcap', '/tmp/screencap.png']);
        await this.execute(['pull', '/tmp/screencap.png', localPath]);
        return localPath; 
    }

    async captureLogs(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_${this.config.resourceId}_dlog_${ts}.txt`);
        const res = await this.execute(['dlog', '-d']);
        fs.writeFileSync(localPath, res.stdout);
        return localPath;
    }

    async disconnect(): Promise<void> {
        if (this.config.serial) {
            await boundedExec(this.sdbPath, ['disconnect', this.config.serial], { timeoutMs: 10000 });
        }
    }
}
