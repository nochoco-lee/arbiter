import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';

// Node.js version check (Requires 18+)
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
    console.error(`[ARBITER] Error: Node.js version ${process.versions.node} is not supported.`);
    console.error(`[ARBITER] Please upgrade to Node.js 18 or higher (Recommended: 20+).`);
    process.exit(1);
}

import { leaseManager } from '../state/lease';
import { queueManager } from '../queue/index';
import { LeaseRequest, YieldRequest } from '../api/types';

// Analytics tracking cost-engine mapping for Agents. (Resource -> Command pattern -> List of durations in ms)
const durationHistory: Record<string, Record<string, number[]>> = {};

// Session-Scoped Device State trackers
const stateSnapshots: Record<string, { 
    installed_packages: Record<string, any>, 
    config_changes: any[], 
    command_history: { timestamp: string, command: string, token: string }[] 
}> = {};

// Resource alias groups: tools that share the same physical device share one lease slot.
// The user-facing resource name is preserved in logs; only the internal scheduling key is normalized.
const RESOURCE_ALIASES: Record<string, string> = {
    'adb':     'android',  // adb and android-cli address the same device
};

function getAverageDuration(resource: string, command: string): number | null {
    if (!durationHistory[resource] || !durationHistory[resource][command]) return null;
    const history = durationHistory[resource][command];
    if (history.length === 0) return null;
    // Rolling average over last N calls
    const recent = history.slice(-8); 
    const avgMs = recent.reduce((a, b) => a + b, 0) / recent.length;
    return Math.round(avgMs / 1000); // return in seconds
}

import { ConfigManager } from '../config/index';
import { ContextManager } from '../context/index';
import { log, warn, logBuffer, sseClients } from './logger';
import * as fs from 'fs';
import * as path from 'path';

const globalConfig = ConfigManager.loadConfig('arbiter.yaml');
const PORT = parseInt(process.env.ARBITER_PORT || (globalConfig.port ? globalConfig.port.toString() : '38401'));

// --- Remote Broker: Resolve real binary path for a given resource type ---
function resolveRemoteBin(resource: string): string {
    const envKey = `ARBITER_REAL_${resource.toUpperCase()}_PATH`;
    const override = process.env[envKey];
    if (override) return override;
    const defaults: Record<string, string> = {
        'adb':    '/usr/bin/adb',
        'sdb':    '/usr/bin/sdb',
        'simctl': '/usr/bin/xcrun',
        'tdb':    `node ${path.resolve(__dirname, '../tests/tdb.js')}`,
    };
    return defaults[resource] || `/usr/bin/${resource}`;
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const LOG_BUFFER_SIZE = 500;

export const startBroker = () => {
  leaseManager.experimentalScheduling = true;
  queueManager.experimentalScheduling = true;

  const stateFile = path.join(process.env.ARBITER_CONTEXT_DIR || process.cwd(), '.arbiter_broker_state.json');
  try {
      if (fs.existsSync(stateFile)) {
          const raw = fs.readFileSync(stateFile, 'utf8');
          const data = JSON.parse(raw);
          leaseManager.importState(data.leaseManager || {});
          queueManager.importState(data.queueManager || {});
          log(`[Broker] Restored previous broker state from ${stateFile}`);
      }
  } catch (e) {
      warn(`[Broker] Failed to restore state: ${e}`);
  }

  setInterval(() => {
      try {
          const state = {
              leaseManager: leaseManager.exportState(),
              queueManager: queueManager.exportState(),
              timestamp: Date.now()
          };
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      } catch (e) {
          warn(`[Broker] State serialization failed: ${e}`);
      }
  }, 5000);

  // Graceful shutdown handling
  const shutdown = () => {
      try {
          const state = { leaseManager: leaseManager.exportState(), queueManager: queueManager.exportState(), timestamp: Date.now() };
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
          log(`[Broker] Final state persisted successfully.`);
      } catch (e) {}
      process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`[Broker] Smart Scheduling Enabled (Default).`);

  // Dependency Injection for circular dependency avoidance
  leaseManager.queueDepthResolver = (res: string) => queueManager.getQueueDepth(res);
  leaseManager.onResourceFree = (res: string) => queueManager.pump(res);

  try {
      leaseManager.ceilingConfig = globalConfig.resources || {};
      log(`[Broker] Loaded Global Ceiling configurations natively.`);
  } catch(e: any) {
      log(`[Broker] Notice: No explicit arbiter.yaml mapped. Skipping Ceiling overrides.`);
  }

  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');

    try {
        const urlObj = new URL(req.url || '/', `http://${req.headers.host}`);
        const path = urlObj.pathname;

        if (req.method === 'GET' && path === '/status') {
            const authHeader = req.headers['authorization'];
            if (authHeader && authHeader.startsWith('Bearer ')) {
                // Shim Validation check
                const token = authHeader.substring(7);
                const reactivate = urlObj.searchParams.get('reactivate') !== 'false';
                const isValid = leaseManager.validateToken(token, reactivate);
                if (isValid) {
                    const resource = leaseManager.getResourceByToken(token);
                    const depth = queueManager.getQueueDepth(resource || '');
                    let expires = Date.now();
                    // extract raw lease object for expiry
                    const privateState = leaseManager.getActiveLeaseInfo(resource || '');
                    if (privateState) expires = privateState.expires_at;

                    const pending = leaseManager.getPendingPermits(token);
                    let installAvg = getAverageDuration(resource || '', 'adb install') || 30; // fallback to 30s
                    let estimates = { 'install': installAvg };

                    const statusResp: any = { valid: true, resource: resource, expires_at: expires, queueDepth: depth, estimates, pending_permits: pending };
                    
                    // Check if it's a permit token specifically
                    const permit = leaseManager.getPermitsForResource(resource || '')?.[token];
                    // Wait, getPermitsForResource returns Record<id, PermitRequestInfo>. 
                    // Let's rely on validateToken logic... Actually, if it's a permit token, it's NOT the active lease token usually.
                    // Let's find the permit.
                    let isPermit = false;
                    let permitCommands = "";
                    const allPermits = leaseManager.getPermitsForResource(resource || '');
                    if (allPermits) {
                        for (const p of Object.values(allPermits)) {
                            if (p.permit_token === token) {
                                isPermit = true;
                                permitCommands = p.commands;
                                break;
                            }
                        }
                    }

                    if (isPermit) {
                        statusResp.is_permit = true;
                        statusResp.permitted_commands = permitCommands;
                    }
                    
                    if (leaseManager.experimentalScheduling && resource) {
                        statusResp.headType = queueManager.getHeadType(resource);
                        statusResp.drainingActivePermitCount = leaseManager.getDrainingPermitCount(resource);
                        if (privateState) {
                            statusResp.holderAgeSeconds = Math.round((Date.now() - (privateState.expires_at - privateState.requested_duration_ms)) / 1000);
                        }
                    }

                    res.writeHead(200);
                    res.end(JSON.stringify(statusResp));
                } else {
                    const status = leaseManager.getTokenStatus(token);
                    res.writeHead(401);
                    res.end(JSON.stringify({ valid: false, message: status.message }));
                }
                return;
            }

            const rawResource = urlObj.searchParams.get('resource');
            if (rawResource) {
                const resource = RESOURCE_ALIASES[rawResource] ?? rawResource;
                const leaseData = leaseManager.getActiveLeaseToken(resource); // we'll use internally known remaining time soon
                
                const response: any = {
                    resource,
                    state: leaseManager.getResourceState(resource),
                    queueDepth: queueManager.getQueueDepth(resource)
                };

                if (leaseManager.experimentalScheduling) {
                    const activeLease = leaseManager.getActiveLeaseInfo(resource);
                    response.headType = queueManager.getHeadType(resource);
                    response.drainingActivePermitCount = leaseManager.getDrainingPermitCount(resource);
                    if (activeLease) {
                        response.holderAgeSeconds = Math.round((Date.now() - (activeLease.expires_at - activeLease.requested_duration_ms)) / 1000);
                    }
                }

                res.writeHead(200);
                res.end(JSON.stringify(response));
                return;
            }

            // Global Status (All resources)
            const resources = leaseManager.getAllResources();
            const response: any = { resources: {} };
            for (const r of resources) {
                response.resources[r] = {
                    state: leaseManager.getResourceState(r),
                    queueDepth: queueManager.getQueueDepth(r),
                    headType: queueManager.getHeadType(r),
                    drainingActivePermitCount: leaseManager.getDrainingPermitCount(r)
                };
            }
            res.writeHead(200);
            res.end(JSON.stringify(response));
            return;
        }

        if (req.method === 'POST' && path === '/api/lease/heartbeat') {
            const body = await readJsonBody<{token: string}>(req);
            if (!body.token) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'missing_token' }));
            }
            const touched = leaseManager.touchHeartbeat(body.token);
            res.writeHead(touched ? 200 : 404);
            res.end(JSON.stringify({ success: touched }));
            return;
        }

        if (req.method === 'POST' && path === '/request') {
            const body = await readJsonBody<{resource: string, duration_seconds?: number, allow_conflict?: boolean, wait_mode?: 'BLOCKING' | 'ASYNC'}>(req);
            if (!body.resource) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'missing_resource' }));
            }

            const originalResource = body.resource;
            body.resource = RESOURCE_ALIASES[body.resource] ?? body.resource;
            if (body.resource !== originalResource) {
                log(`[Broker] Resource alias: '${originalResource}' -> '${body.resource}'`);
            }

            log(`[Broker] Incoming Request: resource=${body.resource}, duration=${body.duration_seconds || 'default'}`);
            
            const ADAPTER_KEYWORDS = ['auto', 'adb', 'android', 'sdb', 'simctl', 'windows', 'macos', 'linux'];
            // If requested resource matches a known generic adapter/auto keyword natively, AND it is not explicitly registered as an exact string literal in ceilingConfig...
            if (ADAPTER_KEYWORDS.includes(body.resource) && !(leaseManager.ceilingConfig || {})[body.resource]) {
                const isGlobalAuto = body.resource === 'auto';
                
                const candidates = Object.keys(leaseManager.ceilingConfig || {}).filter(k => {
                    if (k === 'default') return false; // Default abstracted node
                    if (!isGlobalAuto) {
                        const nodeAdapter = leaseManager.ceilingConfig?.[k]?.adapter || 'adb';
                        if (nodeAdapter !== body.resource) return false;
                    }
                    return true;
                });

                if (candidates.length === 0) {
                    // Fallback intuitively if no filtered candidates match!
                    // If requested 'adb'/'sdb' but nothing is explicitly configured bridging it, fallback string to just restrict to generic global bounds named after adapter organically.
                    body.resource = isGlobalAuto ? 'default' : body.resource; 
                } else {
                    let best = candidates[0];
                    let bestScore = Infinity;
                    for (const c of candidates) {
                        const state = leaseManager.getResourceState(c);
                        const depth = queueManager.getQueueDepth(c);
                        const score = state === 'FREE' ? depth : depth + 1;
                        if (score < bestScore) {
                            bestScore = score;
                            best = c;
                        }
                    }
                    body.resource = best;
                }
            }
            
            // Wait for queue (blocks request until granted)
            const currentState = leaseManager.getResourceState(body.resource);
            if (currentState !== 'FREE' && currentState !== 'AVAILABLE') {
                log(`[Broker] Resource ${body.resource} busy (${currentState}). Enqueuing requester...`);
            }

            // Experimental Scheduling: Upfront auto-shift has been disabled to respect explicit --wait intents.
            // We now rely on the Dynamic Async Shift (3-minute watchdog) to handle actual wait durations.
            const token = await queueManager.enqueue(body as unknown as LeaseRequest);
            const actualResource = leaseManager.getResourceByToken(token) || body.resource;
            const state_snapshot = stateSnapshots[actualResource] || {};

            const isTicket = token.startsWith('q_'); // Ticket IDs always start with q_

            if ((body.wait_mode === 'ASYNC' || isTicket) && !leaseManager.getResourceByToken(token)) {
                // If it's async or dynamically shifted, and not immediately granted
                res.writeHead(202);
                res.end(JSON.stringify({ 
                    token, 
                    resource: actualResource, 
                    status: 'RESERVED',
                    estimated_wait_seconds: queueManager.getEstimatedWait(actualResource)
                }));
                return;
            }

            log(`[Broker] Lease GRANTED: resource=${actualResource}, token=${token.substring(0,8)}...`);
            res.writeHead(200);
            res.end(JSON.stringify({ token, resource: actualResource, state_snapshot }));
            return;
        }

        if (req.method === 'POST' && path === '/api/lease/extend') {
            const body = await readJsonBody<{token: string, reason?: string}>(req);
            if (!body.token) return res.writeHead(400).end();
            const resource = leaseManager.getResourceByToken(body.token);
            if (!resource) return res.writeHead(401).end();

            const waitTime = queueManager.getOldestWaitTime(resource);
            if (waitTime > 300000) {
                warn(`[Broker] Extension Denied for ${resource}: Queue depth too large.`);
                res.writeHead(403);
                return res.end(JSON.stringify({ error: 'denied_queue_too_long' }));
            }
            const success = leaseManager.extendGracePeriod(body.token);
            if (success) log(`[Broker] Lease EXTENDED: resource=${resource}`);
            res.writeHead(success ? 200 : 400);
            return res.end(JSON.stringify({ success }));
        }

        if (req.method === 'POST' && path === '/api/lease/release') {
            const body = await readJsonBody<{token: string, msg?: string}>(req);
            if (!body.token) return res.writeHead(400).end();
            const resource = leaseManager.getResourceByToken(body.token);
            const yielded = await leaseManager.releaseLease(body.token);
            log(`[Broker] Lease RELEASED: resource=${resource || 'unknown'}, yielded=${yielded}`);
            res.writeHead(200);
            return res.end(JSON.stringify({ yielded }));
        }

        if (req.method === 'POST' && path === '/api/permit/request') {
            const body = await readJsonBody<{resource: string, commands: string}>(req);
            const actualResource = RESOURCE_ALIASES[body.resource] ?? body.resource;
            log(`[Broker] Permit Request: resource=${actualResource} (requested: ${body.resource}), commands=${body.commands}`);
            const { permit, error } = leaseManager.requestPermit(actualResource, body.commands);
            if (!permit) {
                warn(`[Broker] Permit Denied: resource=${actualResource} reason=${error}`);
                return res.writeHead(403).end(JSON.stringify({ error: error || 'resource_not_leased' }));
            }
            log(`[Broker] Permit Created: id=${permit.id}, status=${permit.status}`);
            res.writeHead(200);
            return res.end(JSON.stringify(permit));
        }

        if (req.method === 'POST' && path === '/api/permit/resolve') {
            const body = await readJsonBody<{token: string, permit_id: string, grant: boolean}>(req);
            log(`[Broker] Permit Resolve: id=${body.permit_id}, grant=${body.grant}`);
            const token = leaseManager.resolvePermit(body.token, body.permit_id, body.grant);
            if (!token) return res.writeHead(403).end(JSON.stringify({error: 'invalid_permit_id_or_unauthorized'}));
            res.writeHead(200);
            return res.end(JSON.stringify({ success: true, permit_token: token }));
        }

        // --- Permit Execution Tracking (Milestone 1) ---
        if (req.method === 'POST' && path === '/api/permit/execution/start') {
            const body = await readJsonBody<{token: string}>(req);
            const success = leaseManager.startPermitExecution(body.token);
            res.writeHead(success ? 200 : 404);
            return res.end(JSON.stringify({ success }));
        }

        if (req.method === 'POST' && path === '/api/permit/execution/heartbeat') {
            const body = await readJsonBody<{token: string}>(req);
            const success = leaseManager.touchPermitHeartbeat(body.token);
            res.writeHead(success ? 200 : 404);
            return res.end(JSON.stringify({ success }));
        }

        if (req.method === 'POST' && path === '/api/permit/execution/finish') {
            const body = await readJsonBody<{token: string}>(req);
            const success = leaseManager.finishPermitExecution(body.token);
            res.writeHead(success ? 200 : 404);
            return res.end(JSON.stringify({ success }));
        }

        // --- Reservation Tickets (Milestone 3) ---
        if (req.method === 'POST' && path === '/api/reservation/claim') {
            const body = await readJsonBody<{ticketId: string}>(req);
            const { token, error } = await queueManager.claimTicket(body.ticketId);
            if (token) {
                const resource = leaseManager.getResourceByToken(token);
                if (!resource) {
                    // Token doesn't map to an active lease — defence against leaked ticket IDs
                    log(`[Broker] Claim returned token ${token.substring(0, 8)}... but it has no active lease. Rejecting as ticket_still_waiting.`);
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'ticket_still_waiting' }));
                    return;
                }
                res.writeHead(200);
                res.end(JSON.stringify({ token, resource }));
            } else {
                res.writeHead(400);
                res.end(JSON.stringify({ error: error || 'ticket_invalid' }));
            }
            return;
        }

        if (req.method === 'GET' && path === '/api/reservation/status') {
            const ticketId = urlObj.searchParams.get('ticketId');
            if (!ticketId) return res.writeHead(400).end();
            const status = queueManager.getTicketStatus(ticketId);
            if (status) {
                res.writeHead(200);
                res.end(JSON.stringify(status));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'ticket_not_found' }));
            }
            return;
        }

        if (req.method === 'POST' && path === '/api/reservation/cancel') {
            const body = await readJsonBody<{ticketId: string}>(req);
            const success = queueManager.cancelTicket(body.ticketId);
            res.writeHead(success ? 200 : 404);
            res.end(JSON.stringify({ success }));
            return;
        }

        if (req.method === 'GET' && path === '/api/permit/status') {
             const rawRc = urlObj.searchParams.get('resource');
             const pid = urlObj.searchParams.get('id');
             if (!rawRc || !pid) return res.writeHead(400).end();
             const rc = RESOURCE_ALIASES[rawRc] ?? rawRc;
             const permits = leaseManager.getPermitsForResource(rc);
             if (!permits || !permits[pid]) return res.writeHead(404).end();
             res.writeHead(200);
             return res.end(JSON.stringify(permits[pid]));
        }

        // --- Session-Scoped State ---
        if (req.method === 'POST' && path === '/api/session/command') {
            const body = await readJsonBody<{token: string, command: string, args: string[], apk_hash?: string}>(req);
            const resource = leaseManager.getResourceByToken(body.token || '');
            if (resource) {
                log(`[Broker] session command logged for ${resource}: ${body.command}`);
                leaseManager.touchHeartbeat(body.token); // Keep the lease alive when command starts
                if (!stateSnapshots[resource]) {
                    stateSnapshots[resource] = { installed_packages: {}, config_changes: [], command_history: [] };
                }
                const fullCmd = `${body.command} ${body.args.join(' ')}`;
                
                // Roll-out Global Audit Trail (capped at 100)
                stateSnapshots[resource].command_history.push({
                    timestamp: new Date().toISOString(),
                    command: fullCmd,
                    token: body.token || 'unknown'
                });
                if (stateSnapshots[resource].command_history.length > 100) {
                    stateSnapshots[resource].command_history.shift();
                }

                if (fullCmd.includes('install')) {
                    const pkgMatch = body.args.find(a => a.endsWith('.apk') || a.endsWith('.app')); // basic heuristic
                    if (pkgMatch) {
                        stateSnapshots[resource].installed_packages[pkgMatch] = {
                            installed_by_session: body.token,
                            installed_at: new Date().toISOString(),
                            apk_hash: body.apk_hash
                        };
                    }
                } else if (fullCmd.includes('setprop') || fullCmd.includes('settings put')) {
                    stateSnapshots[resource].config_changes.push({
                         changed_by_session: body.token,
                         changed_at: new Date().toISOString(),
                         command: fullCmd
                    });
                }
            }
            // Notify Mode is strictly async, unblocking
            res.writeHead(202).end();
            return;
        }

        if (req.method === 'POST' && path === '/api/state/query') {
            const body = await readJsonBody<{token: string, package_name: string}>(req);
            if (!body.token || !body.package_name) return res.writeHead(400).end();
            const resource = leaseManager.getResourceByToken(body.token);
            if (!resource) return res.writeHead(401).end();
            
            const snap = stateSnapshots[resource];
            const pkg = snap?.installed_packages[body.package_name];
            res.writeHead(200);
            return res.end(JSON.stringify({ apk_hash: pkg?.apk_hash || null, installed_at: pkg?.installed_at }));
        }

        if (req.method === 'POST' && path === '/api/state/history') {
            const body = await readJsonBody<{token: string}>(req);
            if (!body.token) return res.writeHead(400).end(JSON.stringify({ error: 'missing_token' }));
            const resource = leaseManager.getResourceByToken(body.token);
            if (!resource) return res.writeHead(401).end(JSON.stringify({ error: 'invalid_token' }));

            const snap = stateSnapshots[resource];
            res.writeHead(200);
            return res.end(JSON.stringify({ history: snap?.command_history || [] }));
        }

        // --- Analytics Engine Routes ---
        if (req.method === 'POST' && path === '/api/stat/duration') {
            const body = await readJsonBody<{token: string, command: string, duration_ms: number}>(req);
            const resource = leaseManager.getResourceByToken(body.token || '');
            if (resource && body.command && body.duration_ms > 0) {
                const fullCmd = body.command;
                const parts = fullCmd.split(' ');
                const pattern = parts.length > 1 ? `${parts[0]} ${parts[1]}` : parts[0];
                
                if (!durationHistory[resource]) durationHistory[resource] = {};
                
                // Track both exact command AND generic pattern
                if (!durationHistory[resource][fullCmd]) durationHistory[resource][fullCmd] = [];
                durationHistory[resource][fullCmd].push(body.duration_ms);

                if (fullCmd !== pattern) {
                    if (!durationHistory[resource][pattern]) durationHistory[resource][pattern] = [];
                    durationHistory[resource][pattern].push(body.duration_ms);
                }
            }
            res.writeHead(202).end(); // Fire and forget Accepted
            return;
        }

        if (req.method === 'POST' && path === '/api/lease/estimate') {
            const body = await readJsonBody<{token: string, command: string}>(req);
            if (!body.token || !body.command) return res.writeHead(400).end(JSON.stringify({ error: 'missing_parameters' }));
            
            const resource = leaseManager.getResourceByToken(body.token);
            if (!resource) return res.writeHead(401).end(JSON.stringify({ error: 'invalid_token' }));

            const fullCmd = body.command;
            const parts = fullCmd.split(' ');
            const pattern = parts.length > 1 ? `${parts[0]} ${parts[1]}` : parts[0];
            
            // Try exact match first, then fall back to pattern
            let avgSecs = getAverageDuration(resource, fullCmd);
            if (avgSecs === null && fullCmd !== pattern) {
                avgSecs = getAverageDuration(resource, pattern);
            }
            
            res.writeHead(200);
            return res.end(JSON.stringify({
                command: body.command,
                estimated_seconds: avgSecs,
                based_on: `last ${durationHistory[resource]?.[pattern]?.length || 0} executions on this resource`,
                recommendation: avgSecs ? "Historical context available" : "Insufficient execution history"
            }));
        }

        if (req.method === 'POST' && path === '/relay') {
            const body = await readJsonBody<{token: string, args: string[]}>(req);
            if (!body.token || !body.args) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'missing_payload' }));
            }
            
            const resource = leaseManager.getResourceByToken(body.token);
            if (!resource) {
                res.writeHead(401);
                return res.end(JSON.stringify({ error: 'unauthorized_token' }));
            }
            
            leaseManager.touchActivity(body.token);
            const adapter = await leaseManager.getAdapter(resource);
            try {
                // Execute natively on the host's actual binary mapping
                const out = await adapter.execute(body.args);
                res.writeHead(200);
                res.end(JSON.stringify(out));
            } catch (e: any) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (req.method === 'POST' && path === '/yield') {
            const body = await readJsonBody<YieldRequest>(req);
            if (!body.token) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'missing_token' }));
            }
            const success = await leaseManager.yieldLease(body);
            
            // Kick the queue for all empty resources
            queueManager.pump('*'); 

            res.writeHead(success ? 200 : 400);
            res.end(JSON.stringify({ success }));
            return;
        }

        if (req.method === 'GET' && path === '/api/context') {
            const resource = urlObj.searchParams.get('resource');
            if (!resource) {
                res.writeHead(400);
                return res.end(JSON.stringify({ error: 'missing_resource' }));
            }
            const ctx = ContextManager.loadLastContext(resource);
            res.writeHead(ctx ? 200 : 404);
            return res.end(JSON.stringify(ctx || { error: 'no_context_found' }));
        }

        if (req.method === 'GET' && path === '/api/logs') {
            const limitParam = urlObj.searchParams.get('limit');
            const limit = Math.min(parseInt(limitParam || '200', 10), LOG_BUFFER_SIZE);
            res.writeHead(200);
            return res.end(JSON.stringify({ lines: logBuffer.slice(-limit) }));
        }

        if (req.method === 'GET' && path === '/api/logs/stream') {
            // Server-Sent Events for real-time log tailing
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            // Flush recent history first so the client sees context immediately
            const recentLines = logBuffer.slice(-50);
            for (const line of recentLines) {
                res.write(`data: ${JSON.stringify(line)}\n\n`);
            }
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            req.on('error', () => sseClients.delete(res));
            return; // keep connection open
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not_found' }));
    } catch (e: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
    }
  });

  const BIND_HOST = process.env.ARBITER_BIND || '127.0.0.1';

  // --- WebSocket server for Remote Broker exec ---
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
      let child: ReturnType<typeof spawn> | null = null;
      let execToken: string | null = null;

      ws.on('message', (raw) => {
          let msg: any;
          try { msg = JSON.parse(raw.toString()); } catch { return; }

          if (msg.type === 'exec') {
              // Validate token
              if (!leaseManager.validateToken(msg.token)) {
                  ws.send(JSON.stringify({ type: 'error', message: 'invalid_token' }));
                  ws.close(1008, 'invalid_token');
                  return;
              }
              execToken = msg.token as string;
              leaseManager.touchHeartbeat(execToken); // Phase 2: keep lease alive


              const binPath = resolveRemoteBin(msg.resource || '');
              const binParts = binPath.split(' ');
              log(`[Remote] exec ${msg.resource}: ${binParts[0]} ${(msg.args || []).join(' ')}`);

              child = spawn(binParts[0], [...binParts.slice(1), ...(msg.args || [])], {
                  stdio: ['pipe', 'pipe', 'pipe'],
                  env: process.env
              });

              child.stdout!.on('data', (d: Buffer) => {
                  if (ws.readyState === WebSocket.OPEN)
                      ws.send(JSON.stringify({ type: 'stdout', data: d.toString('base64') }));
              });
              child.stderr!.on('data', (d: Buffer) => {
                  if (ws.readyState === WebSocket.OPEN)
                      ws.send(JSON.stringify({ type: 'stderr', data: d.toString('base64') }));
              });
              child.on('exit', (code) => {
                  log(`[Remote] exec exited with code ${code}`);
                  if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'exit', code: code ?? -1 }));
                      ws.close(1000);
                  }
              });
              child.on('error', (e: Error) => {
                  ws.send(JSON.stringify({ type: 'error', message: `spawn failed: ${e.message}` }));
                  ws.close(1011);
              });
          }

          else if (msg.type === 'stdin' && child?.stdin) {
              child.stdin.write(Buffer.from(msg.data, 'base64'));
              if (execToken) leaseManager.touchHeartbeat(execToken); // Phase 2
          }
          else if (msg.type === 'stdin_end' && child?.stdin) {
              child.stdin.end();
          }

          else if (msg.type === 'signal' && child) {
              child.kill(msg.signal || 'SIGINT');
          }
      });

      ws.on('close', () => {
          if (child && !child.killed) child.kill('SIGTERM');
      });
      ws.on('error', () => {
          if (child && !child.killed) child.kill('SIGTERM');
      });
  });

  server.on('upgrade', (req, socket, head) => {
      log(`[Broker] Upgrade request received for ${req.url}`);
      if (req.url === '/api/remote/exec') {
          // Phase 3: validate shared secret on WS upgrade
          const secret = process.env.ARBITER_AUTH_SECRET;
          if (secret) {
              const auth = req.headers['x-arbiter-secret'];
              if (auth !== secret) {
                  log(`[Broker] WS Auth failed`);
                  socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                  socket.destroy();
                  return;
              }
          }
          log(`[Broker] Upgrading to WS...`);
          wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } else {
          socket.destroy();
      }
  });

  server.listen(PORT, BIND_HOST, () => {
    const boundPort = (server.address() as { port: number }).port;
    // Emit a structured ready-line so the test harness can discover the
    // actual port when PORT=0 (OS-assigned). Must go to stdout directly
    // so it is always parseable regardless of log buffering.
    process.stdout.write(`ARBITER_PORT_READY=${boundPort}\n`);
    log(`ARBITER Broker running on http://${BIND_HOST}:${boundPort}`);
    if (BIND_HOST !== '127.0.0.1') {
        log(`[Broker] Remote Broker mode active — listening on ${BIND_HOST}:${boundPort}`);
        if (!process.env.ARBITER_AUTH_SECRET) {
            warn(`[Broker] WARNING: ARBITER_AUTH_SECRET is not set. Remote connections are unauthenticated.`);
        }
    }
  });
};

if (require.main === module) {
  startBroker();
}
