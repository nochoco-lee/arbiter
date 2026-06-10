#!/usr/bin/env node
import * as http from 'http';

// Node.js version check (Requires 18+)
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
    console.error(`[ARBITER] Error: Node.js version ${process.versions.node} is not supported.`);
    console.error(`[ARBITER] Please upgrade to Node.js 18 or higher (Recommended: 20+).`);
    process.exit(1);
}

import { spawnSync } from 'child_process';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

// Shim configuration — supports both local (127.0.0.1) and remote broker
function getBrokerHost(resource: string): string {
    const perResource = process.env[`ARBITER_BROKER_HOST_${resource.toUpperCase()}`];
    return perResource || process.env.ARBITER_BROKER_HOST || '127.0.0.1';
}
const BROKER_PORT = process.env.ARBITER_PORT || '38401';
// BROKER_URL and BROKER_WS_URL are computed lazily in main() after caller is known.
// For top-level helper functions that need BROKER_URL before main(), default to localhost.
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const isWin = process.platform === 'win32';
const REAL_BIN_MAP: Record<string, string> = {
    'adb': process.env.ARBITER_REAL_ADB_PATH || (isWin ? 'adb' : '/usr/bin/adb'),
    'simctl': process.env.ARBITER_REAL_SIMCTL_PATH || (isWin ? 'xcrun' : '/usr/bin/xcrun'),
    'sdb': process.env.ARBITER_REAL_SDB_PATH || (isWin ? 'sdb' : '/usr/bin/sdb'),
    'android': process.env.ARBITER_REAL_ANDROID_PATH || (isWin ? 'android' : '/usr/bin/android'),
};

function getTimestamp(): string {
    const now = new Date();
    return `[${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
}

// Config mappings for Hard Timeout exceptions
function getHardTimeoutOverrides(caller: string, args: string[]): number {
    try {
        const configPath = path.resolve(process.cwd(), 'arbiter.yaml');
        if (fs.existsSync(configPath)) {
            const doc = yaml.load(fs.readFileSync(configPath, 'utf8'));
            const fullCmd = `${caller} ${args.join(' ')}`;
            // Check exclusions
            const exceptions = doc?.resources?.['default']?.command_timeout_exceptions || [];
            if (exceptions.some((e: string) => fullCmd.includes(e))) {
                return 0; // Infinite timeout
            }
            return doc?.resources?.['default']?.command_timeout_seconds || 60;
        }
    } catch(e) {}
    return 60; // default 60s hard timeout
}

async function shimRequest<T>(url: string, options: http.RequestOptions = {}, body?: any): Promise<{ data: T | null, status: number, error?: string }> {
    return new Promise((resolve) => {
        const req = http.request(url, {
            ...options,
            timeout: options.timeout || 5000,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    resolve({ data: JSON.parse(data || '{}'), status: res.statusCode || 0 });
                } catch (e) {
                    resolve({ data: null, status: res.statusCode || 0, error: 'JSON_PARSE_ERROR' });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ data: null, status: 0, error: 'TIMEOUT' });
        });

        req.on('error', (e) => {
            resolve({ data: null, status: 0, error: e.message });
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function checkLease(token: string, reactivate: boolean = true): Promise<{valid: boolean, expires_at?: number, queueDepth?: number, error?: string, status?: number, message?: string}> {
    const res = await shimRequest<any>(`${BROKER_URL}/status?reactivate=${reactivate}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.error) return { valid: false, error: res.error, status: res.status };
    return { ...res.data, valid: res.status === 200, status: res.status };
}

function handleBrokerError(res: { error?: string, status?: number }, context: string) {
    const ts = getTimestamp();
    if (res.error === 'TIMEOUT') {
        process.stderr.write(`${ts} [ARBITER] ERROR: Broker request timed out during ${context}.\n`);
        process.stderr.write(`${ts} [ARBITER] Target: ${BROKER_URL}\n`);
        process.stderr.write(`${ts} [ARBITER] Next: Check broker load or network connectivity.\n`);
    } else if (res.error && (res.error.includes('ECONNREFUSED') || res.error === 'ECONNREFUSED')) {
        process.stderr.write(`${ts} [ARBITER] CRITICAL: Broker connection refused during ${context}.\n`);
        process.stderr.write(`${ts} [ARBITER] Target: ${BROKER_URL}\n`);
        process.stderr.write(`${ts} [ARBITER] Diagnosis: The broker daemon is not running.\n`);
        process.stderr.write(`${ts} [ARBITER] Troubleshooting: Run 'arbiter start' to begin the session.\n`);
    } else if (res.error === 'JSON_PARSE_ERROR') {
        process.stderr.write(`${ts} [ARBITER] ERROR: Malformed response from broker during ${context}.\n`);
        process.stderr.write(`${ts} [ARBITER] Diagnosis: The broker returned non-JSON data. This might indicate an internal crash or a misconfigured proxy.\n`);
    } else {
        process.stderr.write(`${ts} [ARBITER] ERROR: Broker request failed during ${context}: ${res.error || 'Unknown error'} (Status: ${res.status || 0})\n`);
    }
}

async function checkResourceStatus(resource: string): Promise<any> {
    const res = await shimRequest<any>(`${BROKER_URL}/status?resource=${encodeURIComponent(resource)}`, {
        method: 'GET'
    });
    return res.data || { error: res.error || 'unknown_error' };
}

async function executePermitCommand(commands: string, permitToken: string) {
    // Notify Start
    await shimRequest(`${BROKER_URL}/api/permit/execution/start`, { method: 'POST' }, { token: permitToken });

    const hb = setInterval(async () => {
        await shimRequest(`${BROKER_URL}/api/permit/execution/heartbeat`, { method: 'POST' }, { token: permitToken });
    }, 10000);

    const pArgs = commands.split(' ').slice(1);
    const cmdBase = commands.split(' ')[0];
    const pBinParts = (REAL_BIN_MAP[cmdBase] || `/usr/bin/${cmdBase}`).split(' ');

    const { spawn } = require('child_process');
    const child = spawn(pBinParts[0], [...pBinParts.slice(1), ...pArgs], { 
        stdio: 'inherit', 
        env: { ...process.env, ARBITER_LEASE_TOKEN: permitToken },
        detached: process.platform !== 'win32'
    });

    const timeoutMs = 120000; // 2 minute default for permit commands
    const timer = setTimeout(() => {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', child.pid, '/f', '/t']);
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
        process.stderr.write(`\n${getTimestamp()} [ARBITER] Permit command timed out and was killed.\n`);
    }, timeoutMs);

    return new Promise<void>((resolve) => {
        child.on('close', async () => {
            clearTimeout(timer);
            clearInterval(hb);
            await shimRequest(`${BROKER_URL}/api/permit/execution/finish`, { method: 'POST' }, { token: permitToken });
            resolve();
        });
        child.on('error', async () => {
            clearTimeout(timer);
            clearInterval(hb);
            await shimRequest(`${BROKER_URL}/api/permit/execution/finish`, { method: 'POST' }, { token: permitToken });
            resolve();
        });
    });
}

function displayHelp() {
    console.log(`
ARBITER - Resource Lease and Conflict Management System

USAGE:
  arbiter <command> [options]

COMMANDS:
  start                  Start the Arbiter Broker daemon in the foreground.
    --resume, -r         Restore the previous broker state from .arbiter_broker_state.json.
  tui                    Launch the Terminal UI monitor.
  doctor                 Run system diagnostics to check Broker health.
  logs                   Print the last 200 broker log lines.
    --follow, -f         Stream live broker logs (Ctrl+C to stop).
    --limit <n>          Print last N lines (default: 200, max: 500).

  request <resource>     Request a lease for a resource (e.g., android, adb).
                         Blocks until the resource is granted (FIFO queue).
    --duration <secs>    How long you need the resource (default: 300s).
    --wait               Block and wait until the resource is granted (default behaviour).
    --async              Request an async reservation ticket instead of blocking.
                         Requires async_ticket_threshold_seconds to be set in arbiter.yaml.
    --ticket <id>        Claim an existing reservation ticket (returns error if not ready yet).

  release                Voluntarily release the current lease.
  extend                 Request to extend the current lease duration.

  lease status           View status of the current lease or a specific resource.
    --resource <name>    View status of a specific resource.

  estimate <command>     Get a wait-time estimate for a specific command based on history.
  state history          View the command audit trail for the current session.

  shim install <dir> [name]      Install the Arbiter shim interceptor into the specified directory.
                                 Example: arbiter shim install ~/.arbiter/bin android
                                 Example: arbiter shim install ~/.arbiter/bin adb
  shim uninstall <dir> [name]    Remove the Arbiter shim interceptor and revert any hijacking.

  skills install <name>          Install an agent skill that guides coding agents on how to use 
                                 Arbiter for coordinated resource access.
                                 (Currently only 'arbiter' is supported)
                                 Example: arbiter skills install arbiter

ENVIRONMENT:
  ARBITER_LEASE_TOKEN    Active lease token required for resource access.
  ARBITER_PORT           Communication port between Shim and Broker (Default: 38401).

  [Broker / Server Settings]
  ARBITER_TICKET_THRESHOLD_WAIT   Wait time (secs) before auto-shifting to ASYNC (Default: 0 = disabled).
                                  Overrides async_ticket_threshold_seconds in arbiter.yaml when set.
  ARBITER_TICKET_THRESHOLD_DEPTH  Queue depth before auto-shifting to ASYNC (Default: 3).
  ARBITER_TICKET_CLAIM_WINDOW     Time (secs) an ASYNC ticket stays READY before expiring (Default: 45).
  ARBITER_WATCHDOG_INTERVAL       Watchdog sweep interval in milliseconds (Default: 5000).
  ARBITER_ZOMBIE_LIMIT            Inactivity limit (ms) before force-releasing (Default: 600000).
  ARBITER_CONTEXT_DIR             Directory where session artifacts are saved (Default: cwd).

  [Shim / Client Settings]
  ARBITER_BROKER_HOST             IP/hostname of the remote Arbiter Broker (default: 127.0.0.1).
  ARBITER_BROKER_HOST_<RESOURCE>  Per-resource remote broker host override.
  ARBITER_AUTH_SECRET             Shared secret required when connecting to a remote broker.
  ARBITER_REAL_<CMD>_PATH         Hard-override path to the real binary (e.g. ARBITER_REAL_ADB_PATH).
`);

    if (process.platform === 'win32') {
        console.log(`
HOW TO RUN CODING AGENTS:
  To allow autonomous coding agents to automatically acquire and use resource leases,
  they must be launched in an environment where the Arbiter shim is in the PATH.

  Windows PowerShell:
    $env:Path = "C:\\Arbiter\\bin;" + $env:Path
    $env:ARBITER_AGENT_SESSION = "1"
    claude

  Windows Command Prompt:
    set PATH=C:\\Arbiter\\bin;%PATH%
    set ARBITER_AGENT_SESSION=1
    claude`);
    } else {
        console.log(`
HOW TO RUN CODING AGENTS:
  To allow autonomous coding agents to automatically acquire and use resource leases,
  they must be launched in an environment where the Arbiter shim is in the PATH.

  Linux / macOS:
    export PATH=~/.arbiter/bin:$PATH
    export ARBITER_AGENT_SESSION=1
    claude`);
    }
}

// --- Remote Broker Execution via WebSocket ---
// --- Helper functions for remote file transfers ---
async function uploadFile(brokerUrl: string, localPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(`${brokerUrl}/api/remote/upload`);
        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
            'x-file-name': path.basename(localPath)
        };
        if (process.env.ARBITER_AUTH_SECRET) {
            headers['x-arbiter-secret'] = process.env.ARBITER_AUTH_SECRET;
        }

        const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.remotePath) {
                            resolve(parsed.remotePath);
                        } else {
                            reject(new Error('Invalid upload response'));
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse upload response'));
                    }
                } else {
                    reject(new Error(`Upload failed with status ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (e: Error) => reject(e));

        const readStream = fs.createReadStream(localPath);
        readStream.pipe(req);
    });
}

async function downloadFile(brokerUrl: string, remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(`${brokerUrl}/api/remote/download?path=${encodeURIComponent(remotePath)}`);
        const headers: Record<string, string> = {};
        if (process.env.ARBITER_AUTH_SECRET) {
            headers['x-arbiter-secret'] = process.env.ARBITER_AUTH_SECRET;
        }

        const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers
        }, (res) => {
            if (res.statusCode === 200) {
                const localDir = path.dirname(path.resolve(localPath));
                if (!fs.existsSync(localDir)) {
                    fs.mkdirSync(localDir, { recursive: true });
                }
                const writeStream = fs.createWriteStream(localPath);
                res.pipe(writeStream);
                writeStream.on('finish', () => resolve());
                writeStream.on('error', (e: Error) => reject(e));
            } else {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => reject(new Error(`Download failed with status ${res.statusCode}: ${data}`)));
            }
        });

        req.on('error', (e: Error) => reject(e));
        req.end();
    });
}

// --- Remote Broker Execution via WebSocket ---
async function remoteExec(wsUrl: string, token: string, resource: string, args: string[], pulledFilesLocalTargets: string[] = [], brokerUrl: string = ''): Promise<void> {
    const WebSocket = require('ws');
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (process.env.ARBITER_AUTH_SECRET) {
            headers['x-arbiter-secret'] = process.env.ARBITER_AUTH_SECRET;
        }
        const ws = new WebSocket(`${wsUrl}/api/remote/exec`, { headers });
        let isTtyActive = false;
        let done = false;
        // Tracks the in-progress file download(s) so ws.on('close') can wait for them
        // before resolving the outer promise (avoiding a race with the broker close frame).
        let pendingDownloads: Promise<void> = Promise.resolve();

        const cleanup = () => {
            if (done) return;
            done = true;
            clearInterval(hbInterval);
            if (isTtyActive && process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            resolve();
        };


        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'exec', token, resource, args }));
            // Forward local stdin to the remote process
            if (process.stdin.isTTY) {
                isTtyActive = true;
                process.stdin.setRawMode(true);
                process.stdin.on('data', (d: Buffer) => {
                    if (ws.readyState === WebSocket.OPEN)
                        ws.send(JSON.stringify({ type: 'stdin', data: d.toString('base64') }));
                });
            } else {
                process.stdin.on('data', (d: Buffer) => {
                    if (ws.readyState === WebSocket.OPEN)
                        ws.send(JSON.stringify({ type: 'stdin', data: d.toString('base64') }));
                });
                process.stdin.on('end', () => {
                    if (ws.readyState === WebSocket.OPEN)
                        ws.send(JSON.stringify({ type: 'stdin_end' }));
                });
            }
        });

        const hbInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'heartbeat' }));
            }
        }, 10000);

        ws.on('message', (raw: Buffer) => {
            let msg: any;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === 'stdout') process.stdout.write(Buffer.from(msg.data, 'base64'));
            if (msg.type === 'stderr') process.stderr.write(Buffer.from(msg.data, 'base64'));
            if (msg.type === 'exit') {
                process.exitCode = msg.code ?? 0;

                // Start file downloads — store the promise so ws.on('close') can wait for it.
                // We must NOT await here: the broker's WS close frame may arrive concurrently
                // and trigger ws.on('close') before an inline await would finish.
                if (process.exitCode === 0 && msg.pulledFiles && msg.pulledFiles.length > 0 && brokerUrl) {
                    pendingDownloads = (async () => {
                        for (let i = 0; i < msg.pulledFiles.length; i++) {
                            const remoteFile = msg.pulledFiles[i];
                            const localFile = pulledFilesLocalTargets[i];
                            if (localFile) {
                                try {
                                    await downloadFile(brokerUrl, remoteFile, localFile);
                                } catch (e: any) {
                                    process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Failed to download pulled file: ${e.message}\n`);
                                    process.exitCode = 1;
                                }
                            }
                        }
                    })();
                }
                // Do NOT call ws.close() here — the broker already sent a close frame.
                // ws.on('close') will fire naturally and await pendingDownloads before resolving.
            }
            if (msg.type === 'error') {
                process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] ${msg.message}\n`);
                process.exitCode = 1;
                ws.close();
            }
        });

        // Wait for any in-progress file downloads to complete before resolving.
        // This is essential: the broker closes the WS immediately after sending the
        // 'exit' message, so the close event can fire while downloadFile is still running.
        ws.on('close', () => {
            pendingDownloads.then(() => cleanup());
        });
        ws.on('error', (e: Error) => {
            process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Connection to ${wsUrl} failed: ${e.message}\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Ensure the broker is running on the remote host with ARBITER_BIND set.\n`);
            process.exitCode = 1;
            cleanup();
        });
        // The 'ws' library emits 'unexpected-response' (not 'error') when the HTTP
        // upgrade is rejected with a non-101 status such as 401 Unauthorized.
        ws.on('unexpected-response', (req: any, res: any) => {
            process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Broker rejected WebSocket upgrade: HTTP ${res.statusCode}\n`);
            if (res.statusCode === 401) {
                process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Authentication failed — check ARBITER_AUTH_SECRET.\n`);
            }
            process.exitCode = 1;
            res.resume(); // drain response body so socket can close cleanly
            cleanup();
        });

        // Forward Ctrl+C as a signal to the remote process rather than killing locally
        const sigHandler = () => ws.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }));
        process.on('SIGINT', sigHandler);
        ws.on('close', () => process.removeListener('SIGINT', sigHandler));

    });
}

async function main() {
    // Recursion protection: if we see too many shims calling each other, abort.
    const shimDepth = parseInt(process.env.ARBITER_SHIM_DEPTH || '0');
    if (shimDepth > 3) {
        console.error(`\n${getTimestamp()} [ARBITER SHIM] CRITICAL: Infinite recursion detected.`);
        console.error(`[ARBITER SHIM] The shim is trying to call itself. This usually happens when the real binary is not found`);
        console.error(`[ARBITER SHIM] or ARBITER_REAL_<CMD>_PATH is pointing to the shim directory.`);
        console.error(`[ARBITER SHIM] Please check your PATH or set the correct ARBITER_REAL_..._PATH environment variable.`);
        process.exit(1);
    }
    process.env.ARBITER_SHIM_DEPTH = String(shimDepth + 1);

    const token = process.env.ARBITER_LEASE_TOKEN;
    let caller = path.basename(process.argv[1] || '').toLowerCase();
    let args = process.argv.slice(2);
    
    let isInstall = args.includes('--arbiter-install');
    let isUninstall = args.includes('--arbiter-uninstall');

    // Support native Node invocations overriding symlinks
    if (caller === 'index.ts' || caller === 'index.js' || caller === 'node') {
        const arbiterCommands = ['start', 'tui', 'doctor', 'shim', 'logs', 'request', 'release', 'extend', 'lease', 'permit', 'estimate', 'state', 'skills'];
        if (args.length > 0 && arbiterCommands.includes(args[0])) {
            caller = 'arbiter';
        } else if (args.length > 0 && !args[0].startsWith('--')) {
            caller = args[0];
            args = args.slice(1);
        } else if (args.length === 0 && !isInstall && !isUninstall) {
            caller = 'arbiter';
        } else if (args[0] === '-h' || args[0] === '--help') {
            caller = 'arbiter';
        }
    }

    if (caller === 'arbiter' && args[0] === 'shim') {
        if (args[1] === 'install') {
            isInstall = true;
            // Shift args to mimic the --arbiter-install format for downstream logic
            args = ['--arbiter-install', args[2], args[3]];
        } else if (args[1] === 'uninstall') {
            isUninstall = true;
            args = ['--arbiter-uninstall', args[2], args[3]];
        }
    }
    
    // Exception: agents running `arbiter permit request` or `arbiter request` or installation routines do not have a lease yet!
    const isHelp = (caller === 'arbiter' && (args.length === 0 || args[0] === '-h' || args[0] === '--help'));
    const isTokenExempt = isHelp || isInstall || isUninstall || 
                         (caller === 'arbiter' && (args[0] === 'skills' || args[0] === 'request' || args[0] === 'start' || args[0] === 'tui' || args[0] === 'doctor' || args[0] === 'logs' || (args[0] === 'lease' && args[1] === 'status') || (args[0] === 'permit' && args[1] === 'request'))) || 
                         (caller === 'index.js' && (args[0] === '--arbiter-install' || args[0] === '--arbiter-uninstall'));

    if (isHelp) {
        displayHelp();
        process.exit(0);
    }

    const realBin = REAL_BIN_MAP[caller] || process.env[`ARBITER_REAL_${caller.toUpperCase()}_PATH`] || `/usr/bin/${caller}`;
    // Per-caller remote broker URLs (resolved after caller is known)
    const callerBrokerHost = getBrokerHost(caller);
    const callerBrokerUrl = `http://${callerBrokerHost}:${BROKER_PORT}`;
    const callerBrokerWsUrl = `ws://${callerBrokerHost}:${BROKER_PORT}`;
    const isRemote = (callerBrokerHost !== '127.0.0.1' && callerBrokerHost !== 'localhost') || process.env.ARBITER_FORCE_REMOTE === 'true';

    let meta: any = { valid: true };
    if (token) {
        const shouldReactivate = !isTokenExempt;
        meta = await checkLease(token, shouldReactivate);
        if (!meta.valid && !isTokenExempt) {
            if (meta.error) {
                handleBrokerError(meta, 'lease validation');
            } else {
                const requestAs = caller === 'arbiter' ? 'adb' : caller;
                const SHIM_ALIASES: Record<string, string> = { 'adb': 'android', 'android': 'adb' };
                const aliasPeer = SHIM_ALIASES[requestAs];
                console.error(`${getTimestamp()} [ARBITER SHIM] State: current lease token is invalid or expired.`);
                if (meta.message) {
                    console.error(`${getTimestamp()} [ARBITER SHIM] Reason: ${meta.message}`);
                }
                console.error(`${getTimestamp()} [ARBITER SHIM] Next: acquire a new lease before running '${caller}'.`);
                console.error(`${getTimestamp()} [ARBITER SHIM] Choose '--wait' if this resource is needed now, or '--async' if you can keep working elsewhere first.`);
                if (aliasPeer) {
                    console.error(`${getTimestamp()} [ARBITER SHIM] Note: a token for '${aliasPeer}' also covers '${requestAs}' — they share a device lease.`);
                }
                console.error(`${getTimestamp()} [ARBITER SHIM] Command: arbiter request ${requestAs} --wait`);
            }
            process.exit(1);
        }
    } else if (!token && !isTokenExempt) {
        const requestAs = caller === 'arbiter' ? 'adb' : caller;
        const SHIM_ALIASES: Record<string, string> = { 'adb': 'android', 'android': 'adb' };
        const aliasPeer = SHIM_ALIASES[requestAs];
        console.error(`${getTimestamp()} [ARBITER SHIM] State: no ARBITER_LEASE_TOKEN is set for this session.`);
        console.error(`${getTimestamp()} [ARBITER SHIM] Next: request a lease before running '${caller}'.`);
        console.error(`${getTimestamp()} [ARBITER SHIM] Choose '--wait' if device work is the immediate next step, or '--async' if other work can continue first.`);
        if (aliasPeer) {
            console.error(`${getTimestamp()} [ARBITER SHIM] Note: a token for '${aliasPeer}' also covers '${requestAs}' — they share a device lease.`);
        }
        console.error(`${getTimestamp()} [ARBITER SHIM] Command: arbiter request ${requestAs} --wait`);
        process.exit(1);
    }

    if (meta.is_permit) {
        const attemptedCmd = args.join(' ');
        // If they just ran "adb", caller is adb, args is empty.
        // The permit_commands usually looks like "adb shell ls". 
        // We compare the suffix. Or we just compare caller + args.
        const fullCmd = args.length > 0 ? `${caller} ${args.join(' ')}` : caller;
        if (meta.permitted_commands !== fullCmd) {
            console.error(`\n[ARBITER SHIM SECURITY VIOLATION]`);
            console.error(`This active token is a narrowly scoped PERMIT, not a general lease.`);
            console.error(`Permitted execution: "${meta.permitted_commands}"`);
            console.error(`Attempted execution: "${fullCmd}"`);
            console.error(`Access Denied. Permit revoked.`);
            process.exit(1);
        }
    }
    
    if (meta.expires_at) {
        const remainingMs = meta.expires_at - Date.now();
        const mins = Math.floor(Math.max(0, remainingMs) / 60000);
        const secs = Math.floor((Math.max(0, remainingMs) % 60000) / 1000);
        process.stderr.write(`${getTimestamp()} [ARBITER lease: ${mins}m ${secs}s remaining | queue: ${meta.queueDepth || 0} waiting]\n`);
    }

    if ((meta as any).pending_permits && (meta as any).pending_permits.length > 0) {
        for (const p of (meta as any).pending_permits) {
            process.stderr.write(`${getTimestamp()} [ARBITER] One-time permit request from agent:\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Exact command: ${p.commands}\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Reply: arbiter permit resolve <${p.id}> <grant|deny>\n`);
        }
        
        // Experimental Scheduling: Mandatory resolution
        // We detect experimental mode if richer metadata is present (e.g. holderAgeSeconds)
        if (typeof (meta as any).holderAgeSeconds === 'number') {
            const isExempt = (caller === 'arbiter' && (
                (args[0] === 'permit' && args[1] === 'resolve') ||
                (args[0] === 'lease' && args[1] === 'status')
            ));

            if (!isExempt) {
                process.stderr.write(`${getTimestamp()} [ARBITER] State: your lease has pending permit requests that require owner action.\n`);
                process.exit(1);
            }
        }
    }

    if (caller === 'arbiter') {
        const cmd = args[0];
        if (cmd === 'skills') {
            require('../cli/skills').handleSkillsCommand(args.slice(1));
            return;
        } else if (cmd === 'start') {
            const resume = args.includes('--resume') || args.includes('-r');
            require('../broker/server').startBroker({ resume });
            return;
        } else if (cmd === 'tui') {
            require('../cli/tui').startTui();
            return;
        } else if (cmd === 'doctor') {
            require('../cli/doctor').runDoctor();
            return;
        } else if (cmd === 'logs') {
             const follow = args.includes('--follow') || args.includes('-f');
             const limitArg = args.indexOf('--limit');
             const limit = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : 200;

             if (follow) {
                 // SSE streaming mode
                 process.stdout.write(`Streaming broker logs (Ctrl+C to stop)...\n`);
                 const sseReq = http.get(`${BROKER_URL}/api/logs/stream`, (sseRes) => {
                     if (sseRes.statusCode !== 200) {
                         process.stderr.write(`Error: Broker returned HTTP ${sseRes.statusCode}. Is it running?\n`);
                         process.exit(1);
                     }
                     let buf = '';
                     sseRes.on('data', (chunk: Buffer) => {
                         buf += chunk.toString();
                         const parts = buf.split('\n\n');
                         buf = parts.pop() || '';
                         for (const part of parts) {
                             const dataLine = part.split('\n').find((l: string) => l.startsWith('data:'));
                             if (dataLine) {
                                 try { process.stdout.write(JSON.parse(dataLine.slice(5).trim()) + '\n'); } catch (_) {}
                             }
                         }
                     });
                     sseRes.on('end', () => { process.stdout.write('Connection closed by broker.\n'); process.exit(0); });
                     sseRes.on('error', (e: Error) => { process.stderr.write(`Stream error: ${e.message}\n`); process.exit(1); });
                 });
                 sseReq.on('error', () => {
                     process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                     process.exit(1);
                 });
                 return;
             } else {
                 // One-shot dump
                 http.get(`${BROKER_URL}/api/logs?limit=${limit}`, (res) => {
                     let d = ''; res.on('data', (c: Buffer) => d += c);
                     res.on('end', () => {
                         try {
                             const { lines } = JSON.parse(d);
                             process.stdout.write(lines.join('\n') + '\n');
                         } catch (e) {
                             process.stderr.write(`Error parsing broker log response: ${d}\n`);
                         }
                     });
                 }).on('error', () => {
                     process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                     process.exit(1);
                 });
                 return;
             }
        } else if (cmd === 'extend') {
             const res = await shimRequest<any>(`${BROKER_URL}/api/lease/extend`, { method: 'POST' }, { token });
             if (res.error) {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                 process.exit(1);
             }
             process.stdout.write(res.status === 200
                ? "Extension granted. Continue current resource work.\n"
                : "Extension denied. Another agent may be waiting too long; finish promptly or release.\n");
             return;
        } else if (cmd === 'release') {
             const res = await shimRequest<any>(`${BROKER_URL}/api/lease/release`, { method: 'POST' }, { token });
             if (res.error) {
                 handleBrokerError(res, 'lease release');
                 process.exit(1);
             }
             
             const yielded = res.data?.yielded;
             const state = res.data?.release_state;
             const artifactsPending = res.data?.artifacts_pending;

             if (yielded) {
                 if (state === 'DRAINING') {
                    process.stdout.write("Release accepted: Resource is currently DRAINING (waiting for active permits to finish).\n");
                    process.stdout.write("Exclusivity: Your lease is revoked, but the resource will not be available to others until permits finish.\n");
                 } else {
                    process.stdout.write("Release processed: The resource has been handed off to the next agent.\n");
                 }
                 if (artifactsPending) {
                    process.stdout.write("Artifacts: Background artifact capture (logs/screenshots) is in progress.\n");
                 }
             } else if (state === 'AVAILABLE') {
                 process.stdout.write("Release logged: Queue is empty, so the lease remains warm in AVAILABLE state.\n");
                 process.stdout.write("Next: either continue with more resource work, or remain idle and let the lease expire if all work is done.\n");
             } else if (res.status === 404) {
                 process.stdout.write("Release ignored: Token is already released or unknown to this broker instance.\n");
             } else {
                 process.stdout.write(`Release status: ${state || 'unknown'}. Yielded: ${yielded}\n`);
             }
             return;
        } else if (cmd === 'lease' && args[1] === 'status') {
             let resourceArg = '';
             for (let i = 2; i < args.length; i++) {
                 if (args[i] === '--resource') resourceArg = args[++i];
             }

             if (resourceArg) {
                 const status = await checkResourceStatus(resourceArg);
                 if (status.error && (status.error.includes('ECONNREFUSED') || status.error === 'TIMEOUT')) {
                      process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                      process.exit(1);
                 }
                 process.stdout.write(JSON.stringify(status, null, 2) + "\n");
             } else if (token && meta.valid) {
                 process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
             } else {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Error: 'lease status' requires either a valid ARBITER_LEASE_TOKEN or --resource <name>.\n`);
                 process.exit(1);
             }
             return;
        } else if (cmd === 'estimate') {
             const targetCmd = args.slice(1).join(' ');
             const res = await shimRequest<any>(`${BROKER_URL}/api/lease/estimate`, { method: 'POST' }, { token, command: targetCmd });
             if (res.error) {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                 process.exit(1);
             }
             if (res.data) {
                process.stdout.write(JSON.stringify(res.data, null, 2) + "\n");
             } else {
                process.stderr.write(`${getTimestamp()} [ARBITER SHIM] Error: Invalid response from broker for estimate (Status: ${res.status})\n`);
             }
             return;
        } else if (cmd === 'state' && args[1] === 'history') {
             const res = await shimRequest<any>(`${BROKER_URL}/api/state/history`, { method: 'POST' }, { token });
             if (res.error) {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                 process.exit(1);
             }
             if (res.data) {
                process.stdout.write("=== Command Audit History ===\n");
                (res.data.history || []).forEach((h: any) => {
                    process.stdout.write(`[${h.timestamp}] ${h.command} (token: ${h.token.substring(0,8)}...)\n`);
                });
             } else {
                process.stderr.write(`${getTimestamp()} [ARBITER SHIM] Error: Invalid response from broker for history. (Status: ${res.status})\n`);
             }
             return;
        } else if (cmd === 'request') {
             let resource = args[0] === 'request' ? args[1] : ''; 
             let duration_seconds = 300, autoWait = false, asyncMode = false, ticketId = '';
             for (let i = 1; i < args.length; i++) {
                 if (args[i] === '--estimated-duration' || args[i] === '--duration') duration_seconds = parseInt(args[++i]) || 300;
                 if (args[i] === '--wait') autoWait = true;
                 if (args[i] === '--async') asyncMode = true;
                 if (args[i] === '--ticket') ticketId = args[++i];
             }

             const pollTicket = async (tid: string) => {
                const res = await shimRequest<any>(`${BROKER_URL}/api/reservation/claim`, { method: 'POST' }, { ticketId: tid });
                if (res.error) {
                    process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                    process.exit(1);
                }

                if (res.status === 200) {
                    const out = res.data!;
                    if (!out.token || out.token.startsWith('q_') || !out.resource) {
                        process.stderr.write(`${getTimestamp()} [ARBITER] Internal error: broker returned an invalid lease token. Please retry.\n`);
                        process.exit(1);
                    }
                    process.stderr.write(`${getTimestamp()} [ARBITER] Ticket CLAIMED! Granted Access to: ${out.resource}\n`);
                    process.stderr.write(`${getTimestamp()} [ARBITER] Next: export the lease token below, then run the resource command.\n`);
                    if (process.platform === 'win32') {
                        process.stdout.write(`:: Command Prompt\nSET ARBITER_LEASE_TOKEN=${out.token}\n`);
                        process.stdout.write(`# PowerShell\n$env:ARBITER_LEASE_TOKEN='${out.token}'\n`);
                    } else {
                        process.stdout.write(`export ARBITER_LEASE_TOKEN=${out.token}\n`);
                    }
                    process.exit(0);
                } else {
                    const err = res.data!;
                    if (err.error === 'ticket_still_waiting') {
                        if (autoWait) {
                            process.stderr.write(`${getTimestamp()} [ARBITER] Reservation not ready yet. Retrying in 15s...\n`);
                            setTimeout(() => pollTicket(tid), 15000);
                            return;
                        }
                        process.stderr.write(`${getTimestamp()} [ARBITER] Ticket claim failed: your reservation is not ready yet.\n`);
                        process.stderr.write(`${getTimestamp()} [ARBITER] Next: continue non-device work and retry the claim later.\n`);
                    } else if (err.error === 'ticket_missed_turn') {
                        process.stderr.write(`${getTimestamp()} [ARBITER] Ticket claim failed: your reservation missed its claim window.\n`);
                        process.stderr.write(`${getTimestamp()} [ARBITER] Next: request a new lease or a new async reservation.\n`);
                    } else if (err.error === 'ticket_expired') {
                        process.stderr.write(`${getTimestamp()} [ARBITER] Ticket claim failed: this reservation has expired.\n`);
                        process.stderr.write(`${getTimestamp()} [ARBITER] Next: request a new lease or reservation.\n`);
                    } else {
                        process.stderr.write(`${getTimestamp()} [ARBITER] Ticket claim failed: ${err.error}\n`);
                        process.stderr.write(`${getTimestamp()} [ARBITER] Next: request a new lease if you still need this resource.\n`);
                    }
                    process.exit(1);
                }
             };

             if (ticketId) {
                pollTicket(ticketId);
                return;
             }

             if (!resource || resource.startsWith('--')) {
                  process.stderr.write("Usage: arbiter request <resource> [--duration SECS] [--wait] [--async] [--ticket ID]\n");
                  return;
              }

             if (token && meta.valid && meta.resource) {
                 const SHIM_ALIASES: Record<string, string> = { 'adb': 'android', 'android': 'adb' };
                 if (meta.resource === resource || SHIM_ALIASES[meta.resource] === resource || SHIM_ALIASES[resource] === meta.resource) {
                     process.stderr.write(`${getTimestamp()} [ARBITER] You already hold an active lease for ${resource} (Token: ${token}).\n`);
                     process.stderr.write(`${getTimestamp()} [ARBITER] If you need more time, use 'arbiter extend', or 'arbiter release' first.\n`);
                     return;
                 }
             }
             
             const makeReq = async (conflict_accepted = false) => {
                 let progressIv: NodeJS.Timeout | undefined;
                 
                 // Experimental Scheduling: Progress Reporting
                 if (autoWait && !asyncMode) {
                     const initialStatus = await checkResourceStatus(resource);
                     if (initialStatus && initialStatus.state && initialStatus.state !== 'FREE' && initialStatus.state !== 'AVAILABLE') {
                         let msg = `${getTimestamp()} [ARBITER] waiting: state=${initialStatus.state} queue=${initialStatus.queueDepth}`;
                         if (initialStatus.holderAgeSeconds !== undefined) msg += ` holder_age=${initialStatus.holderAgeSeconds}s`;
                         if (initialStatus.drainingActivePermitCount > 0) msg += ` draining=${initialStatus.drainingActivePermitCount}`;
                         process.stderr.write(msg + "\n");
                     }

                     progressIv = setInterval(async () => {
                         const status = await checkResourceStatus(resource);
                         if (status && status.state) {
                             let msg = `${getTimestamp()} [ARBITER] waiting: state=${status.state} queue=${status.queueDepth}`;
                             if (status.holderAgeSeconds !== undefined) msg += ` holder_age=${status.holderAgeSeconds}s`;
                             if (status.drainingActivePermitCount > 0) msg += ` draining=${status.drainingActivePermitCount}`;
                             process.stderr.write(msg + "\n");
                         }
                     }, 30000);
                 }

                 const res = await shimRequest<any>(`${BROKER_URL}/request`, { method: 'POST', timeout: 300000 }, { 
                    resource, 
                    duration_seconds, 
                    allow_conflict: conflict_accepted,
                    wait_mode: asyncMode ? 'ASYNC' : 'BLOCKING'
                 });

                 if (progressIv) clearInterval(progressIv);

                 if (res.error) {
                     handleBrokerError(res, 'lease request');
                     process.exit(1);
                 }

                 if (res.status === 409) {
                     const parseW = res.data!;
                     if (autoWait || asyncMode) {
                         process.stderr.write(`${getTimestamp()} [ARBITER] Conflict detected: ${parseW.warning}\n`);
                         process.stderr.write(`${getTimestamp()} [ARBITER] Next: queue safely and wait for your turn.\n`);
                         makeReq(true);
                     } else {
                         process.stderr.write(`${getTimestamp()} [ARBITER] Conflict: ${parseW.warning}\n`);
                         process.stderr.write(`${getTimestamp()} [ARBITER] Next: use '--wait' if this resource is needed now, or '--async' if you can continue other work first.\n`);
                         process.exit(1);
                     }
                 } else if (res.status === 200 || res.status === 202) {
                     const out = res.data!;
                     if (res.status === 202) {
                         process.stderr.write(`${getTimestamp()} [ARBITER] Async Reservation Created! Ticket ID: ${out.token}\n`);
                         if (out.estimated_wait_seconds !== undefined) {
                             const mins = Math.floor(out.estimated_wait_seconds / 60);
                             const secs = out.estimated_wait_seconds % 60;
                             process.stderr.write(`${getTimestamp()} [ARBITER] Estimated wait: ${mins}m ${secs}s\n`);
                         }
                         if (out.wait_deadline_ms) {
                             const deadline = new Date(out.wait_deadline_ms).toLocaleTimeString();
                             process.stderr.write(`${getTimestamp()} [ARBITER] Bounded wait deadline: ${deadline}\n`);
                         }
                         if (autoWait) {
                             process.stderr.write(`${getTimestamp()} [ARBITER] Long wait detected. Shifting to ticket polling (ticket: ${out.token})...\n`);
                             pollTicket(out.token);
                             return;
                         }
                         process.stderr.write(`${getTimestamp()} [ARBITER] Next: continue non-device work, then claim when the resource is likely ready.\n`);
                         process.stderr.write(`${getTimestamp()} [ARBITER] Command: arbiter request --ticket ${out.token}\n`);
                         return;
                     }
                     if (out.resource) process.stderr.write(`${getTimestamp()} [ARBITER] Granted Access to: ${out.resource}\n`);
                     process.stderr.write(`${getTimestamp()} [ARBITER] Next: export the lease token below, then run your resource command.\n`);
                     if (process.platform === 'win32') {
                         process.stdout.write(`:: Command Prompt\nSET ARBITER_LEASE_TOKEN=${out.token}\n`);
                         process.stdout.write(`# PowerShell\n$env:ARBITER_LEASE_TOKEN='${out.token}'\n`);
                     } else {
                         process.stdout.write(`export ARBITER_LEASE_TOKEN=${out.token}\n`);
                     }
                 } else {
                     process.stdout.write(JSON.stringify(res.data) + "\n");
                 }
             };
             makeReq();
             return;
        } else if (cmd === 'permit') {
             if (args[1] === 'request') {
                  let commands = '', resource = '';
                  for (let i = 2; i < args.length; i++) {
                      if (args[i] === '--commands') commands = args[++i];
                      if (args[i] === '--resource') resource = args[++i];
                  }
                  
                  const res = await shimRequest<any>(`${BROKER_URL}/api/permit/request`, { method: 'POST' }, { resource, commands });
                  if (res.error) {
                      process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                      process.exit(1);
                  }

                  const permit = res.data!;
                  if (permit.error) {
                      if (permit.error === 'resource_not_leased') {
                          process.stderr.write(`${getTimestamp()} [ARBITER] Permit request failed: no compatible active owner lease is available.\n`);
                      } else if (permit.error === 'permit_denied_late_session') {
                          process.stderr.write(`${getTimestamp()} [ARBITER] Permit request denied: the current lease is too close to expiry.\n`);
                      } else {
                          process.stderr.write(`${getTimestamp()} [ARBITER] Permit request failed: ${permit.error}\n`);
                      }
                      return;
                  }
                  
                  if (permit.status === 'GRANTED') {
                      process.stdout.write(`${getTimestamp()} Auto-Granted Permit: Executing ${commands}\n`);
                      process.stdout.write(`[ARBITER] Permit Token: ${permit.permit_token}\n`);
                      await executePermitCommand(commands, permit.permit_token);
                      return;
                  }
                  
                  process.stdout.write(`${getTimestamp()} Permit ${permit.id} is pending owner decision.\n`);
                  const poll = setInterval(async () => {
                      const pres = await shimRequest<any>(`${BROKER_URL}/api/permit/status?resource=${resource}&id=${permit.id}`, { method: 'GET' });
                      if (pres.error) {
                          clearInterval(poll);
                          process.stderr.write(`${getTimestamp()} [ARBITER] Connection lost to broker during permit polling.\n`);
                          process.exit(1);
                      }
                      const pState = pres.data!;
                      if (pState.status === 'GRANTED') {
                          clearInterval(poll);
                          process.stdout.write(`${getTimestamp()} Owner Granted Permit! Executing ${commands}\n`);
                          await executePermitCommand(commands, pState.permit_token);
                          process.exit(0);
                      } else if (pState.status === 'DENIED') {
                          clearInterval(poll);
                          process.stderr.write(`${getTimestamp()} Owner denied the one-time permit request.\n`);
                          process.exit(1);
                      }
                  }, 2000);
                  
                  // Enforced 2m global timeout preventing deadlocks completely
                  setTimeout(() => {
                      clearInterval(poll);
                      process.stderr.write(`${getTimestamp()} Permit request timed out while waiting for owner action.\n`);
                      process.exit(1);
                  }, 120000);
                  return;
             } else if (args[1] === 'resolve') {
                  const permitId = args[2];
                  const grantMode = args[3] === 'grant';
                  const res = await shimRequest<any>(`${BROKER_URL}/api/permit/resolve`, { method: 'POST' }, { token, permit_id: permitId, grant: grantMode });
                  if (res.error) {
                      process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                      process.exit(1);
                  }
                  if (res.status === 200) {
                      const out = res.data!;
                      process.stdout.write("Permit resolution recorded successfully.\n");
                      if (out.permit_token) {
                          process.stdout.write(`[ARBITER] Permit Token: ${out.permit_token}\n`);
                      }
                  } else {
                      process.stdout.write("Resolution error. The permit may be invalid or you may not be authorized.\n");
                  }
                  return;
             }
        }
    }

    if (args[0] === '--arbiter-uninstall') {
        const targetDir = args[1];
        const shimName = args[2] || 'adb';
        if (!targetDir) {
            console.error('Usage: <shim> --arbiter-uninstall <target_directory_in_path> [shim_name]');
            process.exit(1);
        }

        const shimPath = process.platform === 'win32' ? path.join(targetDir, `${shimName}.cmd`) : path.join(targetDir, shimName);
        if (fs.existsSync(shimPath)) {
            fs.unlinkSync(shimPath);
            console.log(`[ARBITER] Removed shim at ${shimPath}`);
        } else {
            console.log(`[ARBITER] Shim not found at ${shimPath}`);
        }

        if (shimName === 'adb' && process.platform !== 'win32') {
            try {
                const lookRes = spawnSync('which', ['-a', 'adb'], { encoding: 'utf8' });
                if (lookRes.status === 0) {
                    const paths = lookRes.stdout.split(/\r?\n/).filter(p => p.trim() !== '');
                    for (const p of paths) {
                        if (p === shimPath) continue;
                        try {
                            const content = fs.readFileSync(p, { encoding: 'utf8', flag: 'r' });
                            if (content.includes('ARBITER_AGENT_SESSION')) {
                                const realPath = p + '.real';
                                if (fs.existsSync(realPath)) {
                                    fs.unlinkSync(p);
                                    fs.renameSync(realPath, p);
                                    console.log(`[ARBITER] Reverted hijack: Restored ${realPath} to ${p}`);
                                    break;
                                }
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {
                console.error(`[ARBITER] Failed to revert hijack: ${e}`);
            }
        }
        process.exit(0);
    }

    if (args[0] === '--arbiter-install') {
        const targetDir = args[1];
        const shimName = args[2] || 'adb'; // support installing as adb, android, sdb, simctl
        if (!targetDir) {
            console.error('Usage: <shim> --arbiter-install <target_directory_in_path> [shim_name]');
            process.exit(1);
        }
        
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // --- DISCOVERY LOGIC ---
        let discoveredPath = '';
        let candidatePaths: string[] = [];

        if (shimName === 'adb') {
            const home = require('os').homedir();
            if (process.platform === 'win32') {
                candidatePaths.push(path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
            } else if (process.platform === 'darwin') {
                candidatePaths.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
            } else {
                candidatePaths.push(path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'));
            }
        }

        try {
            const lookCmd = process.platform === 'win32' ? 'where' : 'which';
            const lookRes = spawnSync(lookCmd, ['-a', shimName], { encoding: 'utf8' }); // -a to find ALL occurrences
            if (lookRes.status === 0) {
                const paths = lookRes.stdout.split(/\r?\n/).filter(p => p.trim() !== '');
                candidatePaths.push(...paths);
            }
        } catch (e) {}

        for (const p of candidatePaths) {
            if (!fs.existsSync(p)) continue;
            // Skip if it's the directory we are currently installing into
            if (p.includes(targetDir)) continue;

            try {
                const content = fs.readFileSync(p, { encoding: 'utf8', flag: 'r' });
                // Check for Arbiter Fingerprint: "ARBITER SHIM" or "node ... index.js"
                if (content.includes('[ARBITER SHIM]') || content.includes('dist/shim/index.js') || content.includes('ARBITER_REAL_') || content.includes('ARBITER_AGENT_SESSION')) {
                    continue; // This is another shim, skip it
                }
                discoveredPath = p;
                break; // Found a real one!
            } catch (e) {
                // If we can't read it (e.g. it's a binary), it's likely the REAL one!
                discoveredPath = p;
                break;
            }
        }

        if (!discoveredPath) {
            console.warn(`\n[ARBITER] Warning: Could not auto-discover the real '${shimName}' binary in your PATH.`);
            if (process.stdin.isTTY) {
                const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
                
                let promptMsg = `[ARBITER] Please enter the absolute path to the real '${shimName}' binary:\n`;
                if (shimName === 'adb') {
                    let examplePath = '';
                    if (process.platform === 'win32') {
                        examplePath = `C:\\Users\\<user>\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe`;
                    } else if (process.platform === 'darwin') {
                        examplePath = `/Users/<user>/Library/Android/sdk/platform-tools/adb`;
                    } else {
                        examplePath = `/home/<user>/Android/Sdk/platform-tools/adb`;
                    }
                    promptMsg += `(Example: ${examplePath})\n`;
                }
                promptMsg += `> `;

                while (!discoveredPath) {
                    const userPath = await new Promise<string>(resolve => {
                        readline.question(promptMsg, (ans: string) => resolve(ans.trim()));
                    });
                    if (fs.existsSync(userPath) && fs.statSync(userPath).isFile()) {
                        try {
                            const content = fs.readFileSync(userPath, { encoding: 'utf8', flag: 'r' });
                            if (content.includes('[ARBITER SHIM]') || content.includes('dist/shim/index.js') || content.includes('ARBITER_REAL_') || content.includes('ARBITER_AGENT_SESSION')) {
                                console.error(`[ARBITER] Error: The provided file appears to be an Arbiter shim. Please provide the path to the original binary.`);
                                continue;
                            }
                        } catch(e) {}
                        discoveredPath = userPath;
                    } else {
                        console.error(`[ARBITER] Error: File does not exist at '${userPath}'. Please try again.`);
                    }
                }
                readline.close();
            } else {
                console.warn(`[ARBITER] Non-interactive environment detected. Proceeding without hardcoded path.`);
            }
        }
        // -----------------------
        
        let targetRealBinary = discoveredPath;

        if (shimName === 'adb' && process.platform !== 'win32') {
            console.log(`\n[ARBITER] ---------------------------------------------------`);
            console.log(`[ARBITER] Auto-detected real binary at: ${discoveredPath}`);
            console.log(`[ARBITER] Notice: Due to Android's local.properties 'sdk.dir' setting,`);
            console.log(`[ARBITER] the shim you just installed might be bypassed by coding agents`);
            console.log(`[ARBITER] when they run Gradle commands or resolve absolute paths.`);
            console.log(`[ARBITER] We strongly recommend hijacking the real adb binary in your SDK.`);
            console.log(`[ARBITER] (If the detected path above is /usr/bin/adb, it is highly recommended to provide the custom Android SDK path instead)`);
            console.log(`[ARBITER] ---------------------------------------------------\n`);
            
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });

            let hijackTarget = '';
            const answer = await new Promise<string>(resolve => {
                readline.question(`[ARBITER] Would you like to hijack a binary? (y/N/custom): `, (ans: string) => {
                    resolve(ans.trim().toLowerCase());
                });
            });

            if (answer === 'y' || answer === 'yes') {
                 hijackTarget = discoveredPath;
            } else if (answer === 'custom' || answer === 'c') {
                 let promptMsg = `[ARBITER] Please enter the absolute path to the real SDK '${shimName}' binary:\n> `;
                 let customPath = '';
                 while (!customPath) {
                     const userPath = await new Promise<string>(resolve => {
                         readline.question(promptMsg, (ans: string) => resolve(ans.trim()));
                     });
                     if (fs.existsSync(userPath)) {
                         customPath = userPath;
                     } else {
                         console.error(`[ARBITER] Error: File does not exist at '${userPath}'. Please try again.`);
                     }
                 }
                 hijackTarget = customPath;
            }

            if (hijackTarget) {
                const finalSdkPath = path.dirname(hijackTarget);
                const realBinaryPath = hijackTarget;

                let canHijack = true;
                if (!fs.existsSync(realBinaryPath)) {
                    console.error(`[ARBITER] Error: Could not find '${shimName}' at ${realBinaryPath}.`);
                    canHijack = false;
                }

                if (canHijack) {
                    try {
                        const content = fs.readFileSync(realBinaryPath, 'utf8');
                        if (content.includes('ARBITER_AGENT_SESSION') || content.includes('ARBITER_REAL_')) {
                            console.error(`[ARBITER] Error: It looks like '${realBinaryPath}' is already an Arbiter smart shim!`);
                            canHijack = false;
                        }
                    } catch(e) {}
                }

                if (canHijack) {
                    const renamedBinaryPath = path.join(finalSdkPath, `${shimName}.real`);
                    try {
                        fs.renameSync(realBinaryPath, renamedBinaryPath);

                        const wrapperContent = `#!/bin/bash\n` +
`if [ "$ARBITER_AGENT_SESSION" = "1" ]; then\n` +
`    export ARBITER_REAL_${shimName.toUpperCase()}_PATH="${renamedBinaryPath}"\n` +
`    exec "${process.execPath}" "${path.resolve(__filename)}" "${shimName}" "$@"\n` +
`else\n` +
`    exec "${renamedBinaryPath}" "$@"\n` +
`fi\n`;
                        fs.writeFileSync(realBinaryPath, wrapperContent);
                        fs.chmodSync(realBinaryPath, '755');
                        
                        console.log(`[ARBITER] Success! Hijacked ${shimName} at ${finalSdkPath}`);
                        console.log(`[ARBITER] Original binary renamed to ${shimName}.real`);
                        console.log(`[ARBITER] Humans will bypass Arbiter instantly. Agents with ARBITER_AGENT_SESSION=1 will route through Arbiter leases.`);
                        
                        // Point the PATH shim directly to the .real binary so we don't trigger the Node shim twice
                        targetRealBinary = renamedBinaryPath;
                    } catch (e: any) {
                        if (e.code === 'EACCES' || e.code === 'EPERM') {
                            console.error(`[ARBITER] Warning: Permission denied when attempting to hijack ${realBinaryPath}.`);
                            console.error(`[ARBITER] The binary could not be hijacked. You may need to run this command with 'sudo' or configure it manually.`);
                        } else {
                            console.error(`[ARBITER] Failed to hijack binary: ${e.message}`);
                        }
                        
                        // Revert any partial rename if we failed writing the wrapper
                        try {
                            if (fs.existsSync(renamedBinaryPath) && !fs.existsSync(realBinaryPath)) {
                                fs.renameSync(renamedBinaryPath, realBinaryPath);
                            }
                        } catch (revertErr) {}
                    }
                }
            }
            readline.close();
        }

        if (process.platform === 'win32') {
            const shimPath = path.join(targetDir, `${shimName}.cmd`);
            let batContent = `@ECHO OFF\n`;
            batContent += `IF "%ARBITER_AGENT_SESSION%"=="1" (\n`;
            if (targetRealBinary) {
                batContent += `  SET "ARBITER_REAL_${shimName.toUpperCase()}_PATH=${targetRealBinary}"\n`;
            }
            batContent += `  "${process.execPath}" "${__filename}" ${shimName} %*\n`;
            batContent += `) ELSE (\n`;
            batContent += `  "${targetRealBinary}" %*\n`;
            batContent += `)\n`;
            fs.writeFileSync(shimPath, batContent);
            console.log(`[ARBITER] Installed Windows shim into ${shimPath} (Pinned to: ${targetRealBinary || 'auto-detect'})`);
        } else {
            const shimPath = path.join(targetDir, shimName);
            const wrapperContent = `#!/bin/bash\n` +
`if [ "$ARBITER_AGENT_SESSION" = "1" ]; then\n` +
`    export ARBITER_REAL_${shimName.toUpperCase()}_PATH="${targetRealBinary}"\n` +
`    exec "${process.execPath}" "${path.resolve(__filename)}" "${shimName}" "$@"\n` +
`else\n` +
`    exec "${targetRealBinary}" "$@"\n` +
`fi\n`;
            fs.writeFileSync(shimPath, wrapperContent);
            fs.chmodSync(shimPath, '755');
            console.log(`[ARBITER] Installed UNIX shim into ${shimPath} (Pinned to: ${targetRealBinary})`);
        }
        process.exit(0);
    }

    if (process.env.ARBITER_USE_RELAY === 'true') {
        // TCP Forwarding (Relay Mode) for WSL / Docker environments
        const relayReq = http.request(`${BROKER_URL}/relay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res: http.IncomingMessage) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        console.error(`${getTimestamp()} [ARBITER RELAY] Error: ${parsed.error || data}`);
                        process.exit(1);
                    }
                    if (parsed.stdout) process.stdout.write(parsed.stdout);
                    if (parsed.stderr) process.stderr.write(parsed.stderr);
                    process.exit(parsed.exitCode ?? 0);
                } catch (e) {
                    console.error(`${getTimestamp()} [ARBITER RELAY] Invalid response formatting`);
                    process.exit(1);
                }
            });
        });
        
        relayReq.on('error', (e) => {
            console.error(`${getTimestamp()} [ARBITER RELAY] Failed to connect to host broker: ${e.message}`);
            process.exit(1);
        });
        
        relayReq.write(JSON.stringify({ token, args }));
        relayReq.end();
        return; // Event loop holds until responses arrive
    }

    // Direct Execution passthrough
    const timeoutSecs = getHardTimeoutOverrides(caller, args);
    const timeoutMs = timeoutSecs > 0 ? timeoutSecs * 1000 : undefined;
    
    let leaseLost = false;
    
    // Heartbeat Interval to prevent Crash Detection force-yields
    const sendHeartbeat = async () => {
        if (leaseLost) return;
        const res = await shimRequest(`${BROKER_URL}/api/lease/heartbeat`, { method: 'POST' }, { token });
        if (res.status === 404) {
            leaseLost = true;
            clearInterval(hb);
            process.stderr.write(`\n${getTimestamp()} [ARBITER] WARNING: Lease has been reclaimed by Broker (Timeout exceeded).\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Action: Continuing execution natively, but results may be inconsistent due to lost exclusivity.\n`);
        }
    };
    
    sendHeartbeat(); // send initial heartbeat!
    const hb = setInterval(sendHeartbeat, 10000); // 10s heartbeats to stay ahead of the broker watchdog

    let apk_hash: string | undefined = undefined;
    const fullCmdStr = `${caller} ${args.join(' ')}`;

    // Heuristics Proactive Warnings
    if ((meta as any).estimates && meta.expires_at) {
        if (fullCmdStr.includes('install') || fullCmdStr.includes('android run')) { // Simple matched heuristic
            const estKey = fullCmdStr.includes('android run') ? 'android run' : 'install';
            const estSeconds = (meta as any).estimates[estKey] || (meta as any).estimates['install'];
            if (estSeconds) {
                const remainingMs = meta.expires_at - Date.now();
                if (remainingMs > 0 && remainingMs < estSeconds * 1000) {
                    process.stderr.write(`${getTimestamp()} [ARBITER] Warning: there may not be enough lease time remaining for another execution cycle.\n`);
                    process.stderr.write(`${getTimestamp()} [ARBITER] Next: consider 'arbiter extend' before starting, or release and reacquire later.\n`);
                }
            }
        }
    }

    // Hash calculation dynamically
    if (fullCmdStr.includes('install') || fullCmdStr.includes('android run')) {
        const pkgMatch = args.find(a => a.endsWith('.apk') || a.endsWith('.app'));
        if (pkgMatch && fs.existsSync(pkgMatch)) {
            try {
                 apk_hash = crypto.createHash('sha256').update(fs.readFileSync(pkgMatch)).digest('hex');
                 console.log(`${getTimestamp()} [ARBITER] Calculated apk_hash:`, apk_hash);
            } catch(e) {
                 console.log(`${getTimestamp()} [ARBITER] Failed to calculate apk_hash:`, e);
            }
        }
    }

    // Async Notify-Before-Exec wrapper
    await shimRequest(`${BROKER_URL}/api/session/command`, { method: 'POST', timeout: 500 }, { token, command: caller, args, apk_hash });
    
    const t0 = Date.now();
    const realBinParts = realBin.split(' ');

    // --- Remote Broker Execution ---
    if (isRemote && caller !== 'arbiter') {
        clearInterval(hb); // WS messages touch heartbeat server-side; no local polling needed
        process.stderr.write(`${getTimestamp()} [ARBITER] Routing execution to remote broker at ${callerBrokerHost}\n`);
        try {
            const finalArgs = [...args];
            const pulledFilesLocalTargets: string[] = [];

            // Upload local files transparently
            for (let i = 0; i < finalArgs.length; i++) {
                const arg = finalArgs[i];
                try {
                    if (arg && typeof arg === 'string' && fs.existsSync(arg) && fs.statSync(arg).isFile()) {
                        const isPullDest = (caller === 'adb' && args[0] === 'pull' && i === args.length - 1);
                        const isBugreportDest = (caller === 'adb' && args[0] === 'bugreport' && i === args.length - 1);
                        if (!isPullDest && !isBugreportDest) {
                            process.stderr.write(`${getTimestamp()} [ARBITER] Uploading local file '${arg}' to remote broker...\n`);
                            const remotePath = await uploadFile(callerBrokerUrl, arg);
                            finalArgs[i] = remotePath;
                        }
                    }
                } catch (e) {}
            }

            // Handle file downloading (adb pull / adb bugreport)
            if (caller === 'adb' && finalArgs[0] === 'pull') {
                if (finalArgs.length >= 2) {
                    const lastArgIdx = finalArgs.length - 1;
                    const lastArg = finalArgs[lastArgIdx];
                    let localPath = lastArg;
                    if (!lastArg.startsWith('-') && lastArgIdx > 1) {
                        try {
                            if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
                                const remoteFile = finalArgs[lastArgIdx - 1];
                                localPath = path.join(localPath, path.basename(remoteFile));
                            }
                        } catch {}
                        pulledFilesLocalTargets.push(localPath);
                        finalArgs[lastArgIdx] = 'ARBITER_PULL_FILE';
                    } else {
                        const remoteFile = finalArgs[lastArgIdx];
                        const defaultPath = path.join(process.cwd(), path.basename(remoteFile));
                        pulledFilesLocalTargets.push(defaultPath);
                        finalArgs.push('ARBITER_PULL_FILE');
                    }
                }
            } else if (caller === 'adb' && finalArgs[0] === 'bugreport') {
                if (finalArgs.length >= 2) {
                    const lastArgIdx = finalArgs.length - 1;
                    const lastArg = finalArgs[lastArgIdx];
                    if (!lastArg.startsWith('-') && lastArgIdx > 0) {
                        let localPath = lastArg;
                        try {
                            if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
                                localPath = path.join(localPath, 'bugreport.zip');
                            }
                        } catch {}
                        pulledFilesLocalTargets.push(localPath);
                        finalArgs[lastArgIdx] = 'ARBITER_PULL_FILE';
                    } else {
                        const defaultPath = path.join(process.cwd(), 'bugreport.zip');
                        pulledFilesLocalTargets.push(defaultPath);
                        finalArgs.push('ARBITER_PULL_FILE');
                    }
                } else {
                    const defaultPath = path.join(process.cwd(), 'bugreport.zip');
                    pulledFilesLocalTargets.push(defaultPath);
                    finalArgs.push('ARBITER_PULL_FILE');
                }
            }

            await remoteExec(callerBrokerWsUrl, token!, caller, finalArgs, pulledFilesLocalTargets, callerBrokerUrl);
            process.exit(process.exitCode || 0);
        } catch (e: any) {
            process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Execution error: ${e.message}\n`);
            process.exit(1);
        }
        return;
    }

    // --- Local Execution ---
    const { spawn } = require('child_process');
    const child = spawn(realBinParts[0], [...realBinParts.slice(1), ...args], {
        stdio: 'inherit',
        env: process.env,
        detached: process.platform !== 'win32'
    });

    let killed = false;
    if (timeoutMs) {
        setTimeout(async () => {
            if (!killed) {
                if (process.platform === 'win32') {
                    spawnSync('taskkill', ['/pid', child.pid, '/f', '/t']);
                } else {
                    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
                }
                killed = true;
                process.stderr.write(`\n${getTimestamp()} [ARBITER] Command timeout after ${timeoutSecs}s. Releasing lease due to hard timeout.\n`);
                
                await shimRequest(`${BROKER_URL}/api/lease/release`, { method: 'POST' }, { token, reason: 'hard_timeout' });
                process.exit(-1);
            }
        }, timeoutMs);
    }

    child.on('close', async (code: number) => {
        if (killed) return;
        const duration_ms = Date.now() - t0;
        clearInterval(hb);

        if (code === 0) {
            // Fire and forget anonymous duration metric (Analytics Engine)
            await shimRequest(`${BROKER_URL}/api/stat/duration`, { method: 'POST' }, { token, command: `${caller} ${args.join(' ')}`, duration_ms });
        }
        
        if (leaseLost) {
            process.stderr.write(`\n${getTimestamp()} [ARBITER] [WARNING] CRITICAL WARNING: Lease Expired Mid-Execution\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Your command ran longer than your allocated lease duration, and the resource was granted to another agent.\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] The results above might be corrupted or inconsistent.\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Next: Please re-run your exact command with a much longer uninterrupted lease time. Example: arbiter request <resource> --wait --duration 1800\n\n`);
        } else {
            process.stderr.write(`\n${getTimestamp()} [ARBITER] Command execution finished.\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] IMPORTANT: You are currently holding an exclusive lease on this resource.\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Next: if more related resource commands are needed, continue using this same lease.\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Next: if the resource work is finished, release the lease now.\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] Command: arbiter release\n\n`);
        }
        process.exit(code ?? 0);
    });

    child.on('error', (err: Error) => {
        clearInterval(hb);
        console.error(`${getTimestamp()} [ARBITER SHIM] Failed to start process: ${err.message}`);
        process.exit(1);
    });
}


main().catch(e => {
    console.error(e);
    process.exit(1);
});
