import { Adapter, AdapterConfig } from './types';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { boundedExec } from './utils';

export class LinuxAdapter implements Adapter {
    private config!: AdapterConfig;

    async connect(config: AdapterConfig): Promise<void> { this.config = config; }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        // e.g. xdotool windowactivate
        return await boundedExec('xdotool', args);
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {}

    async screenshot(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_linux_${ts}.png`);
        await boundedExec('scrot', [localPath]);
        return localPath;
    }

    async captureLogs(): Promise<string> {
        // Retrieve dmesg or syslog tail for desktop sessions
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_linux_log_${ts}.txt`);
        const res = await boundedExec('dmesg', ['--level=err,warn', '-T', '|', 'tail', '-n', '100'], { shell: true });
        if (res.stdout) {
            fs.writeFileSync(localPath, res.stdout);
        }
        return localPath;
    }

    async disconnect(): Promise<void> {}
}
