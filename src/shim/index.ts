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

async function checkLease(token: string): Promise<{valid: boolean, expires_at?: number, queueDepth?: number, error?: string, status?: number}> {
    return new Promise((resolve) => {
        const req = http.request(`${BROKER_URL}/status`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        }, (res: http.IncomingMessage) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve({valid: res.statusCode === 200, status: res.statusCode});
                }
            });
        });
        
        req.on('error', (e) => resolve({valid: false, error: e.message}));
        req.end();
    });
}

async function checkResourceStatus(resource: string): Promise<any> {
    return new Promise((resolve) => {
        const req = http.request(`${BROKER_URL}/status?resource=${encodeURIComponent(resource)}`, {
            method: 'GET'
        }, (res: http.IncomingMessage) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve({ error: 'invalid_response', status: res.statusCode });
                }
            });
        });
        
        req.on('error', (e) => resolve({ error: e.message }));
        req.end();
    });
}

async function executePermitCommand(commands: string, permitToken: string) {
    // Notify Start
    await new Promise((resolve) => {
        const req = http.request(`${BROKER_URL}/api/permit/execution/start`, { method: 'POST' }, (res) => resolve(res.statusCode));
        req.on('error', () => resolve(500));
        req.write(JSON.stringify({ token: permitToken })); req.end();
    });

    const hb = setInterval(() => {
        const req = http.request(`${BROKER_URL}/api/permit/execution/heartbeat`, { method: 'POST' });
        req.on('error', () => {});
        req.write(JSON.stringify({ token: permitToken })); req.end();
    }, 10000);

    const pArgs = commands.split(' ').slice(1);
    const cmdBase = commands.split(' ')[0];
    const pBinParts = (REAL_BIN_MAP[cmdBase] || `/usr/bin/${cmdBase}`).split(' ');

    const { spawnSync } = require('child_process');
    spawnSync(pBinParts[0], [...pBinParts.slice(1), ...pArgs], { 
        stdio: 'inherit', 
        env: { ...process.env, ARBITER_LEASE_TOKEN: permitToken }
    });

    clearInterval(hb);

    // Notify Finish
    await new Promise((resolve) => {
        const req = http.request(`${BROKER_URL}/api/permit/execution/finish`, { method: 'POST' }, (res) => resolve(res.statusCode));
        req.on('error', () => resolve(500));
        req.write(JSON.stringify({ token: permitToken })); req.end();
    });
}

function displayHelp() {
    console.log(`
ARBITER - Resource Lease and Conflict Management System

USAGE:
  arbiter <command> [options]

COMMANDS:
  start                  Start the Arbiter Broker daemon in the foreground.
  tui                    Launch the Terminal UI monitor.
  doctor                 Run system diagnostics to check Broker health.
  logs                   Print the last 200 broker log lines.
    --follow, -f         Stream live broker logs (Ctrl+C to stop).
    --limit <n>          Print last N lines (default: 200, max: 500).

  request <resource>     Request a lease for a resource (e.g., android, adb).
    --duration <secs>    How long you need the resource (default: 300s).
    --wait               Block and wait until the resource is granted.
    --async              Request an asynchronous reservation ticket instead of blocking.
    --ticket <id>        Claim an existing reservation ticket (blocks if not ready).

  release                Voluntarily release the current lease.
  extend                 Request to extend the current lease duration.

  lease status           View status of the current lease or a specific resource.
    --resource <name>    View status of a specific resource.

  permit request         Request a one-time shared access permit.
    --resource <name>    The resource to access (e.g. android).
    --commands <cmd>     The EXACT command to run (e.g. 'adb logcat -d'). This is shown verbatim to the lease owner.
  
  permit resolve <id>    Resolve a pending permit request (grant/deny).
  
  estimate <command>     Get a wait-time estimate for a specific command based on history.
  state history          View the command audit trail for the current session.

  shim install <dir> [name]      Install the Arbiter shim interceptor into the specified directory.
                                 Example: arbiter shim install ~/.arbiter/bin android
                                 Example: arbiter shim install ~/.arbiter/bin adb
  shim uninstall <dir> [name]    Remove the Arbiter shim interceptor and revert any hijacking.

  skills install <name>          Install an agent skill that guides coding agents on how to use 
                                 Arbiter for coordinated resource access.
                                 (Currently only 'adb' is supported; installs with 'arbiter-' prefix)
                                 Example: arbiter skills install adb

ENVIRONMENT:
  ARBITER_LEASE_TOKEN    Active lease token required for resource access.
  ARBITER_PORT           Communication port between Shim and Broker (Default: 38401).

  [Broker / Server Settings]
  ARBITER_TICKET_THRESHOLD_WAIT   Wait time (secs) before auto-shifting to ASYNC (Default: 180).
  ARBITER_TICKET_THRESHOLD_DEPTH  Queue depth before auto-shifting to ASYNC (Default: 3).
  ARBITER_ZOMBIE_LIMIT            Inactivity limit (ms) before force-releasing (Default: 600000).
  ARBITER_CONTEXT_DIR             Directory where session artifacts are saved (Default: cwd).

  [Shim / Client Settings]
  ARBITER_BROKER_HOST             IP/hostname of the remote Arbiter Broker (default: 127.0.0.1).
  ARBITER_BROKER_HOST_<RESOURCE>  Per-resource remote broker host override.
  ARBITER_AUTH_SECRET             Shared secret required when connecting to a remote broker.
  ARBITER_REAL_<CMD>_PATH         Hard-override path to the real binary (e.g. ARBITER_REAL_ADB_PATH).
`);
}

// --- Remote Broker Execution via WebSocket ---
async function remoteExec(wsUrl: string, token: string, resource: string, args: string[]): Promise<void> {
    const WebSocket = require('ws');
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (process.env.ARBITER_AUTH_SECRET) {
            headers['x-arbiter-secret'] = process.env.ARBITER_AUTH_SECRET;
        }
        const ws = new WebSocket(`${wsUrl}/api/remote/exec`, { headers });

        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'exec', token, resource, args }));
            // Forward local stdin to the remote process
            if (!process.stdin.isTTY) {
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

        ws.on('message', (raw: Buffer) => {
            let msg: any;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === 'stdout') process.stdout.write(Buffer.from(msg.data, 'base64'));
            if (msg.type === 'stderr') process.stderr.write(Buffer.from(msg.data, 'base64'));
            if (msg.type === 'exit')   { process.exitCode = msg.code ?? 0; ws.close(); }
            if (msg.type === 'error')  {
                process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] ${msg.message}\n`);
                process.exitCode = 1;
                ws.close();
            }
        });

        ws.on('close', () => resolve());
        ws.on('error', (e: Error) => {
            process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Connection to ${wsUrl} failed: ${e.message}\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER REMOTE] Ensure the broker is running on the remote host with ARBITER_BIND set.\n`);
            reject(e);
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
        meta = await checkLease(token);
        if (!meta.valid && !isTokenExempt) {
            if (meta.error && meta.error.includes('ECONNREFUSED')) {
                process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
            } else {
                const requestAs = caller === 'arbiter' ? 'adb' : caller;
                const SHIM_ALIASES: Record<string, string> = { 'adb': 'android', 'android': 'adb' };
                const aliasPeer = SHIM_ALIASES[requestAs];
                console.error(`${getTimestamp()} [ARBITER SHIM] State: current lease token is invalid or expired.`);
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
                process.stderr.write(`${getTimestamp()} [ARBITER] Next: resolve each listed permit, then rerun your blocked command.\n`);
                process.stderr.write(`${getTimestamp()} [ARBITER] Avoid: do not continue device-mutating work until the permits are granted or denied.\n`);
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
            require('../broker/server').startBroker();
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
             const req = http.request(`${BROKER_URL}/api/lease/extend`, { method: 'POST' }, (res) => {
                 process.stdout.write(res.statusCode === 200
                    ? "Extension granted. Continue current resource work.\n"
                    : "Extension denied. Another agent may be waiting too long; finish promptly or release.\n");
             });
             req.on('error', () => {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                 process.exit(1);
             });
             req.write(JSON.stringify({ token })); req.end();
             return;
        } else if (cmd === 'release') {
             const req = http.request(`${BROKER_URL}/api/lease/release`, { method: 'POST' }, (res) => {
                 let d = ''; res.on('data', c => d += c);
                 res.on('end', () => {
                     const yielded = JSON.parse(d).yielded;
                     if (yielded) {
                         process.stdout.write("Release processed. The resource has been handed off or is draining for handoff.\n");
                         process.stdout.write("Next: stop issuing resource commands with this lease token.\n");
                     } else {
                         process.stdout.write("Release logged. Queue is empty, so the lease remains warm in AVAILABLE state.\n");
                         process.stdout.write("Next: either continue with more resource work, or remain idle and let the lease expire if all work is done.\n");
                     }
                 });
             });
             req.on('error', () => {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                 process.exit(1);
             });
             req.write(JSON.stringify({ token })); req.end();
             return;
        } else if (cmd === 'lease' && args[1] === 'status') {
             let resourceArg = '';
             for (let i = 2; i < args.length; i++) {
                 if (args[i] === '--resource') resourceArg = args[++i];
             }

             if (resourceArg) {
                 const status = await checkResourceStatus(resourceArg);
                 if (status.error && status.error.includes('ECONNREFUSED')) {
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
             const req = http.request(`${BROKER_URL}/api/lease/estimate`, { method: 'POST' }, (res) => {
                 let d = ''; res.on('data', c => d += c);
                 res.on('end', () => {
                     try {
                        process.stdout.write(JSON.stringify(JSON.parse(d), null, 2) + "\n");
                     } catch(e) {
                        process.stderr.write(`${getTimestamp()} [ARBITER SHIM] Error: Invalid response from broker for estimate: ${d} (Status: ${res.statusCode})\n`);
                     }
                 });
             });
             req.on('error', () => {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                 process.exit(1);
             });
             req.write(JSON.stringify({ token, command: targetCmd })); req.end();
             return;
        } else if (cmd === 'state' && args[1] === 'history') {
             const req = http.request(`${BROKER_URL}/api/state/history`, { method: 'POST' }, (res) => {
                 let d = ''; res.on('data', c => d += c);
                 res.on('end', () => {
                     try {
                        const out = JSON.parse(d);
                        process.stdout.write("=== Command Audit History ===\n");
                        (out.history || []).forEach((h: any) => {
                            process.stdout.write(`[${h.timestamp}] ${h.command} (token: ${h.token.substring(0,8)}...)\n`);
                        });
                     } catch(e) {
                        process.stderr.write(`${getTimestamp()} [ARBITER SHIM] Error: Invalid response from broker for history. (Status: ${res.statusCode})\n`);
                     }
                 });
             });
             req.on('error', () => {
                 process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                 process.exit(1);
             });
             req.write(JSON.stringify({ token })); req.end();
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

             if (ticketId) {
                const treq = http.request(`${BROKER_URL}/api/reservation/claim`, { method: 'POST' }, (res) => {
                    let d = ''; res.on('data', c => d+=c);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            const out = JSON.parse(d);
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
                            const err = JSON.parse(d);
                            if (err.error === 'ticket_still_waiting') {
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
                    });
                });
                treq.on('error', () => {
                    process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                    process.exit(1);
                });
                treq.write(JSON.stringify({ ticketId })); treq.end();
                return;
             }

             if (!resource || resource.startsWith('--')) {
                  process.stderr.write("Usage: arbiter request <resource> [--duration SECS] [--wait] [--async] [--ticket ID]\n");
                  return;
              }
             
             const makeReq = (conflict_accepted = false) => {
                 let progressIv: NodeJS.Timeout | undefined;
                 
                 // Experimental Scheduling: Progress Reporting
                 if (autoWait && !asyncMode) {
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

                 const breq = http.request(`${BROKER_URL}/request`, { method: 'POST' }, (res) => {
                     if (progressIv) clearInterval(progressIv);
                     let d = ''; res.on('data', c => d+=c);
                     res.on('end', () => {
                         if (res.statusCode === 409) {
                             const parseW = JSON.parse(d);
                             if (autoWait || asyncMode) {
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Conflict detected: ${parseW.warning}\n`);
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Next: queue safely and wait for your turn.\n`);
                                 makeReq(true);
                             } else {
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Conflict: ${parseW.warning}\n`);
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Next: use '--wait' if this resource is needed now, or '--async' if you can continue other work first.\n`);
                                 process.exit(1);
                             }
                         } else if (res.statusCode === 200 || res.statusCode === 202) {
                             const out = JSON.parse(d);
                             if (res.statusCode === 202) {
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Async Reservation Created! Ticket ID: ${out.token}\n`);
                                 if (out.estimated_wait_seconds !== undefined) {
                                     const mins = Math.floor(out.estimated_wait_seconds / 60);
                                     const secs = out.estimated_wait_seconds % 60;
                                     process.stderr.write(`${getTimestamp()} [ARBITER] Estimated wait: ${mins}m ${secs}s\n`);
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
                             process.stdout.write(d + "\n");
                         }
                     });
                 });
                 breq.on('error', (e: any) => {
                     if (progressIv) clearInterval(progressIv);
                     if (e.code === 'ECONNREFUSED') {
                         process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                     } else {
                         process.stderr.write(`${getTimestamp()} [ARBITER] Broker request error: ${e.message}\n`);
                     }
                     process.exit(1);
                 });
                 breq.write(JSON.stringify({ 
                    resource, 
                    duration_seconds, 
                    allow_conflict: conflict_accepted,
                    wait_mode: asyncMode ? 'ASYNC' : 'BLOCKING'
                 }));
                 breq.end();
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
                  
                  const req = http.request(`${BROKER_URL}/api/permit/request`, { method: 'POST' }, (res) => {
                     let d = ''; res.on('data', c => d += c);
                     res.on('end', async () => {
                         const permit = JSON.parse(d);
                         if (permit.error) {
                             if (permit.error === 'resource_not_leased') {
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Permit request failed: no compatible active owner lease is available.\n`);
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Next: request a full lease if you need direct resource access now.\n`);
                             } else if (permit.error === 'permit_denied_late_session') {
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Permit request denied: the current lease is too close to expiry.\n`);
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Next: wait for the next lease owner or request a full lease later.\n`);
                             } else {
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Permit request failed: ${permit.error}\n`);
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Next: request a full lease if this task still requires the resource.\n`);
                             }
                             return;
                         }
                         
                         if (permit.status === 'GRANTED') {
                             process.stdout.write(`${getTimestamp()} Auto-Granted Permit: Executing ${commands}\n`);
                             process.stdout.write(`[ARBITER] Permit Token: ${permit.permit_token}\n`);
                             process.stdout.write(`[ARBITER] Next: this one-time command will run now without taking the full lease.\n`);
                             await executePermitCommand(commands, permit.permit_token);
                             return;
                         }
                         
                         process.stdout.write(`${getTimestamp()} Permit ${permit.id} is pending owner decision.\n`);
                         process.stdout.write(`${getTimestamp()} Next: wait for the current lease owner to grant or deny this one-time request.\n`);
                         const poll = setInterval(() => {
                             http.get(`${BROKER_URL}/api/permit/status?resource=${resource}&id=${permit.id}`, (pres) => {
                                 let pd = ''; pres.on('data', c => pd += c);
                                 pres.on('end', async () => {
                                     const pState = JSON.parse(pd);
                                     if (pState.status === 'GRANTED') {
                                         clearInterval(poll);
                                         process.stdout.write(`${getTimestamp()} Owner Granted Permit! Executing ${commands}\n`);
                                         process.stdout.write(`${getTimestamp()} Next: this one-time command will run now; no full lease request is needed.\n`);
                                         await executePermitCommand(commands, pState.permit_token);
                                         process.exit(0);
                                     } else if (pState.status === 'DENIED') {
                                         clearInterval(poll);
                                         process.stderr.write(`${getTimestamp()} Owner denied the one-time permit request.\n`);
                                         process.stderr.write(`${getTimestamp()} Next: request a full lease if the task still needs this resource.\n`);
                                         process.exit(1);
                                     }
                                 });
                             }).on('error', () => {
                                 clearInterval(poll);
                                 process.stderr.write(`${getTimestamp()} [ARBITER] Connection lost to broker during permit polling.\n`);
                                 process.exit(1);
                             });
                         }, 2000);
                         
                         // Enforced 2m global timeout preventing deadlocks completely
                         setTimeout(() => {
                             clearInterval(poll);
                             process.stderr.write(`${getTimestamp()} Permit request timed out while waiting for owner action.\n`);
                             process.stderr.write(`${getTimestamp()} Next: retry the permit request later or request a full lease if the task is blocked.\n`);
                             process.exit(1);
                         }, 120000);
                     });
                  });
                  req.on('error', () => {
                      process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                      process.exit(1);
                  });
                  req.write(JSON.stringify({ resource, commands })); req.end();
                  return;
             } else if (args[1] === 'resolve') {
                  const permitId = args[2];
                  const grantMode = args[3] === 'grant';
                  const req = http.request(`${BROKER_URL}/api/permit/resolve`, { method: 'POST' }, (res) => {
                      let d = ''; res.on('data', c => d += c);
                      res.on('end', () => {
                           if (res.statusCode === 200) {
                               const out = JSON.parse(d);
                               process.stdout.write("Permit resolution recorded successfully.\n");
                               if (out.permit_token) {
                                   process.stdout.write(`[ARBITER] Permit Token: ${out.permit_token}\n`);
                                   process.stdout.write(`[ARBITER] Next: the requesting agent may now execute its one-time command with that token.\n`);
                               }
                           } else {
                               process.stdout.write("Resolution error. The permit may be invalid or you may not be authorized.\n");
                           }
                      });
                  });
                  req.on('error', () => {
                      process.stderr.write(`${getTimestamp()} [ARBITER] Could not connect to broker at ${BROKER_URL}. Is 'arbiter start' running?\n`);
                      process.exit(1);
                  });
                  req.write(JSON.stringify({ token, permit_id: permitId, grant: grantMode })); req.end();
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
        try {
            const lookCmd = process.platform === 'win32' ? 'where' : 'which';
            const lookRes = spawnSync(lookCmd, ['-a', shimName], { encoding: 'utf8' }); // -a to find ALL occurrences
            if (lookRes.status === 0) {
                const paths = lookRes.stdout.split(/\r?\n/).filter(p => p.trim() !== '');
                
                for (const p of paths) {
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
            }
        } catch (e) {}

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
                    if (fs.existsSync(userPath)) {
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
            console.log(`[ARBITER] Notice: Due to Android's local.properties 'sdk.dir' setting,`);
            console.log(`[ARBITER] the shim you just installed might be bypassed by coding agents`);
            console.log(`[ARBITER] when they run Gradle commands or resolve absolute paths.`);
            console.log(`[ARBITER] We strongly recommend hijacking the real adb binary in your SDK.`);
            console.log(`[ARBITER] ---------------------------------------------------\n`);
            
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const answer = await new Promise<string>(resolve => {
                readline.question(`[ARBITER] Would you like to hijack the real Android SDK adb to guarantee interception? (y/N): `, (ans: string) => {
                    resolve(ans.trim().toLowerCase());
                });
            });

            if (answer === 'y' || answer === 'yes') {
                const finalSdkPath = path.dirname(discoveredPath);
                const realBinaryPath = path.join(finalSdkPath, shimName);
                if (!fs.existsSync(realBinaryPath)) {
                    console.error(`[ARBITER] Error: Could not find '${shimName}' at ${realBinaryPath}.`);
                    process.exit(1);
                }

                try {
                    const content = fs.readFileSync(realBinaryPath, 'utf8');
                    if (content.includes('ARBITER_AGENT_SESSION') || content.includes('ARBITER_REAL_')) {
                        console.error(`[ARBITER] Error: It looks like '${realBinaryPath}' is already an Arbiter smart shim!`);
                        process.exit(1);
                    }
                } catch(e) {}

                const renamedBinaryPath = path.join(finalSdkPath, `${shimName}.real`);
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
    const sendHeartbeat = () => {
        if (leaseLost) return;
        const req = http.request(`${BROKER_URL}/api/lease/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            if (res.statusCode === 404) {
                leaseLost = true;
                clearInterval(hb);
                process.stderr.write(`\n${getTimestamp()} [ARBITER] WARNING: Lease has been reclaimed by Broker (Timeout exceeded).\n`);
                process.stderr.write(`${getTimestamp()} [ARBITER] Action: Continuing execution natively, but results may be inconsistent due to lost exclusivity.\n`);
            }
        });
        req.write(JSON.stringify({ token }));
        req.on('error', () => {});
        req.end();
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
    const notifyReq = http.request(`${BROKER_URL}/api/session/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 500 }, () => {});
    notifyReq.on('error', () => {});
    notifyReq.write(JSON.stringify({ token, command: caller, args, apk_hash }));
    notifyReq.end();
    
    // Flush socket natively safely accommodating loaded CI
    await new Promise(r => setTimeout(r, 100));

    const t0 = Date.now();
    const realBinParts = realBin.split(' ');

    // --- Remote Broker Execution ---
    if (isRemote && caller !== 'arbiter') {
        clearInterval(hb); // WS messages touch heartbeat server-side; no local polling needed
        process.stderr.write(`${getTimestamp()} [ARBITER] Routing execution to remote broker at ${callerBrokerHost}\n`);
        try {
            await remoteExec(callerBrokerWsUrl, token!, caller, args);
            process.exit(process.exitCode || 0);
        } catch (e: any) {
            process.exit(1);
        }
        return;
    }

    // --- Local Execution ---
    const { spawn } = require('child_process');
    const child = spawn(realBinParts[0], [...realBinParts.slice(1), ...args], {
        stdio: 'inherit',
        env: process.env
    });

    let killed = false;
    if (timeoutMs) {
        setTimeout(() => {
            if (!killed) {
                child.kill();
                killed = true;
                process.stderr.write(`\n${getTimestamp()} [ARBITER] Command timeout after ${timeoutSecs}s. Lease is still active.\n`);
                process.stderr.write(`${getTimestamp()} [ARBITER] Next: inspect device state, then either retry, extend, or release when safe.\n`);
                process.exit(-1);
            }
        }, timeoutMs);
    }

    child.on('close', async (code: number) => {
        const duration_ms = Date.now() - t0;
        clearInterval(hb);

        if (code === 0) {
            // Fire and forget anonymous duration metric (Analytics Engine)
            const req = http.request(`${BROKER_URL}/api/stat/duration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }});
            req.on('error', () => {});
            req.write(JSON.stringify({ token, command: `${caller} ${args.join(' ')}`, duration_ms }));
            req.end();
            await new Promise(r => setTimeout(r, 100));
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
            process.stderr.write(`${getTimestamp()} [ARBITER] Command: arbiter release\n`);
            process.stderr.write(`${getTimestamp()} [ARBITER] If you only need one-time shared access in another session, use 'arbiter permit request ...' instead of taking a full lease.\n\n`);
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
