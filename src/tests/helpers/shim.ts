import { spawn } from 'child_process';
import * as path from 'path';

export interface ShimResult {
    stdout: string;
    stderr: string;
    code: number | null;
}

export function runArbiterCLI(port: number, args: string[], token?: string): Promise<ShimResult> {
    return new Promise((resolve) => {
        const fullArgs = [
            path.join('node_modules', 'ts-node', 'dist', 'bin.js'),
            path.join('src', 'shim', 'index.ts'),
            'arbiter', ...args
        ];

        const env: any = { 
            ...process.env, 
            ARBITER_PORT: port.toString(),
            ARBITER_REAL_ADB_PATH: `node ${path.resolve('node_modules', 'ts-node', 'dist', 'bin.js')} ${path.resolve('src', 'tests', 'tdb.ts')}`
        };
        if (token) env.ARBITER_LEASE_TOKEN = token;

        const proc = spawn('node', fullArgs, { env });
        let stdout = ''; let stderr = '';

        proc.stdout.on('data', chunk => stdout += chunk.toString());
        proc.stderr.on('data', chunk => stderr += chunk.toString());

        proc.on('close', code => resolve({ stdout, stderr, code }));
    });
}

export function runToolShim(port: number, tool: string, args: string[], token?: string, useRelay?: boolean): Promise<ShimResult> {
    return new Promise((resolve) => {
        const fullArgs = [
            path.join('node_modules', 'ts-node', 'dist', 'bin.js'),
            path.join('src', 'shim', 'index.ts'),
            tool, ...args
        ];

        const env: any = { 
            ...process.env, 
            ARBITER_PORT: port.toString(),
            ARBITER_REAL_ADB_PATH: `node ${path.resolve('node_modules', 'ts-node', 'dist', 'bin.js')} ${path.resolve('src', 'tests', 'tdb.ts')}`,
            ARBITER_REAL_NODE_PATH: 'node'
        };
        if (token) env.ARBITER_LEASE_TOKEN = token;
        if (useRelay) env.ARBITER_USE_RELAY = 'true';

        const proc = spawn('node', fullArgs, { env });
        let stdout = ''; let stderr = '';

        proc.stdout.on('data', chunk => stdout += chunk.toString());
        proc.stderr.on('data', chunk => stderr += chunk.toString());

        proc.on('close', code => resolve({ stdout, stderr, code }));
    });
}

export function parseTokenFromStdout(stdout: string): string | null {
    const match = stdout.match(/ARBITER_LEASE_TOKEN=([a-f0-9-]+)/);
    return match ? match[1] : null;
}

export function parseTicketIdFromStderr(stderr: string): string | null {
    const match = stderr.match(/Ticket ID: (q_[a-f0-9]+)/);
    return match ? match[1] : null;
}

export function parsePermitIdFromStderr(stderr: string): string | null {
    const match = stderr.match(/permit_[a-f0-9]+/);
    return match ? match[0] : null;
}
