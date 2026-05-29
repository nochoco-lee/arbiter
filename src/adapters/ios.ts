import { Adapter, AdapterConfig } from './types';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { boundedExec } from './utils';

export class IosAdapter implements Adapter {
    private config!: AdapterConfig;
    private simctlPath = 'xcrun'; // simctl is invoked via xcrun

    async connect(config: AdapterConfig): Promise<void> {
        this.config = config;
        
        // Ensure simulator is booted, simctl boot <udid>
        if (!this.config.udid) {
            throw new Error('iOS configuration missing UDID');
        }

        await boundedExec(this.simctlPath, ['simctl', 'bootstatus', this.config.udid, '-b'], { timeoutMs: 60000 });
        // bootstatus might fail if not booted or already booted, but -b attempts to boot.
    }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        const command = args[0];
        const remainingArgs = args.slice(1);
        const argsWithUdid = ['simctl', command, this.config.udid!, ...remainingArgs];

        return await boundedExec(this.simctlPath, argsWithUdid);
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {
        const command = args[0];
        const remainingArgs = args.slice(1);
        const argsWithUdid = ['simctl', command, this.config.udid!, ...remainingArgs];
        const proc = spawn(this.simctlPath, argsWithUdid);
        
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
        
        await this.execute(['io', 'screenshot', localPath]);
        return localPath;
    }

    async captureLogs(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_${this.config.resourceId}_syslog_${ts}.txt`);
        // In a real adapter we stream \`simctl spawn <udid> log show\` for x seconds. 
        const res = await this.execute(['spawn', 'log', 'show', '--last', '5m']);
        fs.writeFileSync(localPath, res.stdout || "No iOS logs found.");
        return localPath;
    }

    async disconnect(): Promise<void> {
        // We do not eagerly shutdown the simulator here to save time for testing, 
        // depending on lifecycle rules.
    }
}
