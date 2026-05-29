import { Adapter, AdapterConfig } from './types';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { boundedExec } from './utils';

export class MacosAdapter implements Adapter {
    private config!: AdapterConfig;

    async connect(config: AdapterConfig): Promise<void> { this.config = config; }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        // AppleScript execution handler
        return await boundedExec('osascript', args);
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {}

    async screenshot(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_mac_${ts}.png`);
        await boundedExec('screencapture', ['-x', localPath]); // -x silences sound
        return localPath;
    }

    async captureLogs(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_mac_log_${ts}.txt`);
        // grab tail of system log (stub pattern)
        const res = await boundedExec('log', ['show', '--predicate', 'processImagePath CONTAINS "WindowServer"', '--last', '5m']);
        if (res.stdout) fs.writeFileSync(localPath, res.stdout);
        return localPath;
    }

    async disconnect(): Promise<void> {}
}
