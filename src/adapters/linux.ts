import { Adapter, AdapterConfig } from './types';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';

export class LinuxAdapter implements Adapter {
    private config!: AdapterConfig;

    async connect(config: AdapterConfig): Promise<void> { this.config = config; }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        // e.g. xdotool windowactivate
        const res = spawnSync('xdotool', [...args], { encoding: 'utf-8' });
        return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? 1 };
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {}

    async screenshot(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_linux_${ts}.png`);
        spawnSync('scrot', [localPath]);
        return localPath;
    }

    async captureLogs(): Promise<string> {
        // Retrieve dmesg or syslog tail for desktop sessions
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_linux_log_${ts}.txt`);
        const res = spawnSync('dmesg', ['--level=err,warn', '-T', '|', 'tail', '-n', '100'], { encoding: 'utf-8', shell: true });
        if (res.stdout) {
            const fs = require('fs');
            fs.writeFileSync(localPath, res.stdout);
        }
        return localPath;
    }

    async disconnect(): Promise<void> {}
}
