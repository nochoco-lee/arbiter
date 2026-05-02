import { Adapter, AdapterConfig } from './types';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export class IosAdapter implements Adapter {
    private config!: AdapterConfig;
    private simctlPath = 'xcrun'; // simctl is invoked via xcrun

    async connect(config: AdapterConfig): Promise<void> {
        this.config = config;
        
        // Ensure simulator is booted, simctl boot <udid>
        if (!this.config.udid) {
            throw new Error('iOS configuration missing UDID');
        }

        const res = spawnSync(this.simctlPath, ['simctl', 'bootstatus', this.config.udid, '-b']);
        // bootstatus might fail if not booted or already booted, but -b attempts to boot.
    }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        const fullArgs = ['simctl', ...args.slice(0, 1), this.config.udid!, ...args.slice(1)];
        // Wait, simctl usually expects: simctl <command> <udid> <args>
        // But some commands don't take udid. This is tricky.
        // For transparency, we should probably just prepend 'simctl' and let the user provide the rest.
        // But the previous implementation inserted UDID.
        
        const res = spawnSync(this.simctlPath, ['simctl', ...args], { encoding: 'utf-8' });
        // Actually, if we want transparency, the user should provide the udid if needed, 
        // OR we should have a way to inject it.
        // Let's stick to the previous logic of injecting UDID for specific commands if we can, 
        // but for 'execute' we should probably be more generic.
        
        // Re-evaluating: the previous implementation was:
        // const fullArgs = ['simctl', command, this.config.udid!, ...args];
        
        const command = args[0];
        const remainingArgs = args.slice(1);
        const argsWithUdid = ['simctl', command, this.config.udid!, ...remainingArgs];

        const res2 = spawnSync(this.simctlPath, argsWithUdid, { encoding: 'utf-8' });
        return {
            stdout: res2.stdout || '',
            stderr: res2.stderr || '',
            exitCode: res2.status ?? 1
        };
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
