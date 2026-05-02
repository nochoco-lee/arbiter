import { Adapter, AdapterConfig } from './types';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export class MacosAdapter implements Adapter {
    private config!: AdapterConfig;

    async connect(config: AdapterConfig): Promise<void> { this.config = config; }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        // AppleScript execution handler
        const res = spawnSync('osascript', [...args], { encoding: 'utf-8' });
        return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? 1 };
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {}

    async screenshot(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_mac_${ts}.png`);
        spawnSync('screencapture', ['-x', localPath]); // -x silences sound
        return localPath;
    }

    async captureLogs(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_mac_log_${ts}.txt`);
        // grab tail of system log (stub pattern)
        const res = spawnSync('log', ['show', '--predicate', 'processImagePath CONTAINS "WindowServer"', '--last', '5m'], { encoding: 'utf-8' });
        if (res.stdout) fs.writeFileSync(localPath, res.stdout);
        return localPath;
    }

    async disconnect(): Promise<void> {}
}
