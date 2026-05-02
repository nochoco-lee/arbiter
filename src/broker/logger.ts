import * as http from 'http';

const LOG_BUFFER_SIZE = 500;
export const logBuffer: string[] = [];
export const sseClients: Set<http.ServerResponse> = new Set();

export function getTimestamp(): string {
    const now = new Date();
    return `[${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
}

function pushLog(line: string) {
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    // Push to all active SSE clients
    for (const client of sseClients) {
        try { 
            client.write(`data: ${JSON.stringify(line)}\n\n`); 
        } catch (_) {
            // Client likely disconnected
        }
    }
}

export function log(msg: string) {
    const line = `${getTimestamp()} ${msg}`;
    process.stdout.write(line + '\n');
    pushLog(line);
}

export function warn(msg: string) {
    const line = `${getTimestamp()} ${msg}`;
    process.stderr.write(line + '\n');
    pushLog(line);
}
