import { spawn } from 'child_process';

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface ExecOptions {
    timeoutMs?: number;
    maxBufferBytes?: number;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
}

/**
 * Executes a command with strict bounds on time and memory.
 * Uses SIGTERM followed by SIGKILL for clean escalation.
 */
export async function boundedExec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs || 60000;
    const maxBuffer = options.maxBufferBytes || 10 * 1024 * 1024; // 10MB default
    
    return new Promise((resolve) => {
        const binParts = command.split(' ');
        const proc = spawn(binParts[0], options.shell ? args : [...binParts.slice(1), ...args], {
            env: { ...process.env, ...options.env },
            shell: options.shell
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGTERM');
            const killEscalation = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch (e) {}
            }, 2000);
            if (killEscalation.unref) killEscalation.unref();
        }, timeoutMs);

        proc.stdout?.on('data', (data: Buffer) => {
            if (stdout.length < maxBuffer) {
                stdout += data.toString();
            }
        });

        proc.stderr?.on('data', (data: Buffer) => {
            if (stderr.length < maxBuffer) {
                stderr += data.toString();
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            resolve({
                stdout: stdout,
                stderr: stderr + `\n[ARBITER] Spawn error: ${err.message}`,
                exitCode: -1
            });
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                stdout,
                stderr,
                exitCode: killed ? -1 : (code ?? 0)
            });
        });
    });
}
