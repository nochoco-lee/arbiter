import { LeaseRequest } from '../api/types';
import { leaseManager } from '../state/lease';
import { randomUUID } from 'crypto';
import { log, debug } from '../broker/logger';

interface QueueEntry {
  id: string;
  request: LeaseRequest;
  resolve: (token: string) => void;
  reject: (err: Error) => void;
  waiting_since: number;
  status: 'WAITING' | 'READY' | 'CLAIMED' | 'MISSED' | 'EXPIRED';
  wait_mode: 'BLOCKING' | 'ASYNC';
  ready_at?: number;
  claim_deadline?: number;
  claim_pending?: boolean;   // true while a blocking --ticket claim is waiting on this entry
  async_notified?: boolean;  // true once the watchdog has fired the async shift for this entry
}

class QueueEngine {
  private queue: Map<string, QueueEntry[]> = new Map();
  private pumping: Set<string> = new Set();
  public experimentalScheduling: boolean = true;

  // Set by broker/server.ts from config.
  // 0 (default) = blocking-only mode, no async tickets ever issued.
  // Positive value = seconds a blocking request must wait before being auto-promoted.
  // This replaces the old ARBITER_TICKET_THRESHOLD_WAIT env-var default of 180 s.
  // Defaults to 180s in test mode to support unit tests of the queue engine.
  public asyncTicketThresholdMs: number = process.env.ARBITER_TEST_MODE === 'true' ? 180000 : 0;

  // Diagnostics
  public lastWatchdogRun: number = 0;
  private watchdogInFlight: boolean = false;

  public getDiagnostics() {
      let totalDepth = 0;
      let oldestAge = 0;
      for (const [res, q] of this.queue.entries()) {
          totalDepth += q.length;
          if (q.length > 0) {
              const age = Date.now() - q[0].waiting_since;
              if (age > oldestAge) oldestAge = age;
          }
      }
      return {
          lastWatchdogRun: this.lastWatchdogRun,
          totalQueueDepth: totalDepth,
          oldestQueueAgeMs: oldestAge,
          activePumping: this.pumping.size
      };
  }

  public getQueueDepth(resource: string): number {
      return this.queue.get(resource)?.length || 0;
  }

  // --- Testing APIs ---
  public injectTestState(resource: string, entries: Partial<QueueEntry>[]): void {
      const q = this.queue.get(resource) || [];
      const newEntries = entries.map(e => ({
          id: e.id || randomUUID(),
          request: e.request || { resource, duration_seconds: 60 },
          resolve: e.resolve || (() => {}),
          reject: e.reject || (() => {}),
          waiting_since: e.waiting_since || Date.now(),
          status: e.status || 'WAITING',
          wait_mode: e.wait_mode || 'BLOCKING',
          ...e
      })) as QueueEntry[];
      
      this.queue.set(resource, [...q, ...newEntries]);
  }

  public forcePromote(resource: string): void {
      const q = this.queue.get(resource);
      if (q && q.length > 0) {
          q[0].status = 'READY';
      }
  }

  public exportState(): any {
      // We cannot easily serialize functions like resolve/reject.
      // But we can serialize the requests and statuses, and re-inject them as ASYNC tickets.
      const serializedQueue: [string, any[]][] = [];
      for (const [res, entries] of this.queue.entries()) {
          serializedQueue.push([res, entries.map(e => ({
              id: e.id,
              request: e.request,
              waiting_since: e.waiting_since,
              status: e.status,
              wait_mode: 'ASYNC', // Any restored ticket becomes ASYNC because HTTP sockets are lost.
              ready_at: e.ready_at,
              claim_deadline: e.claim_deadline
          }))]);
      }
      return { queue: serializedQueue };
  }

  public importState(data: any): void {
      if (data.queue) {
          this.queue = new Map();
          for (const [res, entries] of data.queue) {
              const restoredEntries = entries.map((e: any) => ({
                  ...e,
                  resolve: () => {}, // Dummy resolve for restored async tickets
                  reject: () => {}
              }));
              this.queue.set(res, restoredEntries);
          }
      }
  }

  public getHeadType(resource: string): 'BLOCKING_WAIT' | 'RESERVATION' | 'READY' | null {
      const q = this.queue.get(resource);
      if (!q || q.length === 0) return null;
      const head = q[0];
      if (head.status === 'READY') return 'READY';
      return head.wait_mode === 'BLOCKING' ? 'BLOCKING_WAIT' : 'RESERVATION';
  }

  public getOldestWaitTime(resource: string): number {
      const q = this.queue.get(resource);
      if (!q || q.length === 0) return 0;
      return Date.now() - q[0].waiting_since;
  }

  public getEstimatedWait(resource: string): number {
      const q = this.queue.get(resource) || [];
      
      const activeLease = leaseManager.getActiveLeaseInfo(resource);
      let remainingMs = 0;
      if (activeLease && activeLease.state !== 'AVAILABLE') {
          remainingMs = Math.max(0, activeLease.expires_at - Date.now());
      }
      
      if (q.length === 0 && remainingMs === 0) return 0;

      return Math.round((remainingMs + (q.length * 30000)) / 1000);
  }

  public getTicketStatus(ticketId: string): any {
      for (const [resource, resourceQueue] of this.queue.entries()) {
          const idx = resourceQueue.findIndex(e => e.id === ticketId);
          if (idx !== -1) {
              const entry = resourceQueue[idx];
              return {
                  id: ticketId,
                  resource,
                  status: entry.status,
                  position: idx + 1,
                  estimated_wait_seconds: this.getEstimatedWait(resource),
                  claim_deadline: entry.claim_deadline
              };
          }
      }
      return null;
  }

  public cancelTicket(ticketId: string): boolean {
      for (const [resource, resourceQueue] of this.queue.entries()) {
          const idx = resourceQueue.findIndex(e => e.id === ticketId);
          if (idx !== -1) {
              const entry = resourceQueue[idx];
              log(`[Queue] Ticket CANCELLED: id=${ticketId}, resource=${resource}`);
              resourceQueue.splice(idx, 1);
              this.pump(resource);
              return true;
          }
      }
      return false;
  }

  public enqueue(request: LeaseRequest): Promise<string> {
      return new Promise((resolve, reject) => {
          const resourceQueue = this.queue.get(request.resource) || [];
          // When async mode is disabled, ignore any ASYNC wait_mode from the caller
          // and always use BLOCKING so the request simply waits in the queue.
          const effectiveWaitMode =
              (this.asyncTicketThresholdMs > 0 && request.wait_mode === 'ASYNC')
                  ? 'ASYNC'
                  : 'BLOCKING';
          const entry: QueueEntry = { 
              id: 'q_' + randomUUID().substring(0, 8), 
              request, 
              resolve, 
              reject, 
              waiting_since: Date.now(),
              status: 'WAITING',
              wait_mode: effectiveWaitMode
          };
          
          resourceQueue.push(entry);
          this.queue.set(request.resource, resourceQueue);
          
          if (this.experimentalScheduling) {
              log(`[Queue] Entry Created: id=${entry.id}, resource=${request.resource}, mode=${entry.wait_mode}`);
          }
          debug(`[Queue] Enqueued ${entry.id} for ${request.resource}. Total depth: ${resourceQueue.length}`);
          
          if (this.experimentalScheduling && entry.wait_mode === 'ASYNC') {
              // For async, we return the ticket ID immediately instead of waiting for promotion
              resolve(entry.id);
          }

          this.pump(request.resource);
      });
  }

  public pump(resource: string) {
      if (resource === '*') {
          for (const key of this.queue.keys()) {
              this.pump(key);
          }
          return;
      }
      
      if (this.pumping.has(resource)) {
          debug(`[Queue] Already pumping ${resource}, skipping.`);
          return;
      }
      this.pumping.add(resource);
      debug(`[Queue] Pumping ${resource}...`);

      try {
          while (true) {
              const resourceQueue = this.queue.get(resource) || [];
              if (resourceQueue.length === 0) {
                  debug(`[Queue] ${resource} queue empty.`);
                  break;
              }

              const state = leaseManager.getResourceState(resource);
              debug(`[Queue] ${resource} state: ${state}`);
              
              // Experimental Scheduling: Block if DRAINING
              if (this.experimentalScheduling && state === 'DRAINING') {
                  debug(`[Queue] ${resource} is DRAINING, blocking promotion.`);
                  break;
              }

              if (state === 'FREE' || state === 'AVAILABLE') {
                  const head = resourceQueue[0];
                  if (!head) break;
                  debug(`[Queue] Processing head ${head.id} (mode=${head.wait_mode}, status=${head.status})`);

                  // Milestone 3: Handle READY state for Reservations
                  if (this.experimentalScheduling && head.wait_mode === 'ASYNC') {
                      if (head.status === 'WAITING') {
                          head.status = 'READY';
                          head.ready_at = Date.now();
                          const claimWindowMs = parseInt(process.env.ARBITER_TICKET_CLAIM_WINDOW || '45') * 1000;
                          head.claim_deadline = Date.now() + claimWindowMs;
                          log(`[Queue] Entry READY for claim: id=${head.id}, resource=${resource}, deadline=${new Date(head.claim_deadline).toISOString()}`);
                          break; // Stop here, wait for claim or timeout
                      }
                      if (head.status === 'READY') {
                          // Check for timeout
                          if (Date.now() > (head.claim_deadline || 0)) {
                              log(`[Queue] Entry MISSED turn: id=${head.id}, resource=${resource}`);
                              head.status = 'MISSED';
                              resourceQueue.shift();
                              continue; // Loop again to pump next entry
                          }
                          break; // Still waiting for claim
                      }
                  }

                  const next = resourceQueue.shift();
                  if (next) {
                      try {
                        // If it was AVAILABLE, we must yield the old lease first to ensure clean state!
                        if (state === 'AVAILABLE') {
                            const activeToken = leaseManager.getActiveLeaseToken(resource);
                            if (activeToken) {
                                log(`[Queue] Preempting AVAILABLE lease ${activeToken} for new request ${next.id}.`);
                                // Explicitly delete from internal map to free up for grantLease
                                // NOTE: forceReclaim(..., 'FREE') calls this.onResourceFree which calls pump recursively.
                                // Our pumping guard handles this!
                                leaseManager.forceReclaim(resource, 'FREE');
                            }
                        }

                        if (this.experimentalScheduling) {
                            log(`[Queue] Entry Promoted: id=${next.id}, resource=${resource}`);
                            next.status = 'CLAIMED';
                        }

                        const token = leaseManager.grantLease(resource, next.request.duration_seconds);
                        next.resolve(token);
                      } catch (e: any) {
                        next.reject(e);
                      }
                  }
                  // grantLease moves it to GRANTED, so state will no longer be FREE/AVAILABLE in next iteration.
                  continue; 
              } else {
                  break;
              }
          }
      } finally {
          this.pumping.delete(resource);
      }
  }

  public claimTicket(ticketId: string): Promise<{ token: string | null, error?: string }> {
      return new Promise((resolve) => {
          for (const [resource, resourceQueue] of this.queue.entries()) {
              const idx = resourceQueue.findIndex(e => e.id === ticketId);
              if (idx !== -1) {
                  const entry = resourceQueue[idx];
                  if (entry.status === 'READY') {
                      // Strict deadline enforcement
                      if (entry.claim_deadline && Date.now() > entry.claim_deadline) {
                          log(`[Queue] Ticket claim REJECTED (Missed deadline): id=${ticketId}, resource=${resource}`);
                          entry.status = 'MISSED';
                          resourceQueue.splice(idx, 1);
                          this.pump(resource);
                          return resolve({ token: null, error: 'ticket_missed_turn' });
                      }

                      // Promotion logic
                      resourceQueue.splice(idx, 1);
                      entry.status = 'CLAIMED';
                      
                      const token = leaseManager.grantLease(resource, entry.request.duration_seconds);
                      entry.resolve(token); // To keep internal state synced
                      
                      log(`[Queue] Ticket CLAIMED immediately: id=${ticketId}, resource=${resource}`);
                      this.pump(resource);
                      return resolve({ token });
                  } else if (entry.status === 'WAITING') {
                      entry.wait_mode = 'BLOCKING';
                      entry.claim_pending = true;
                      const oldResolve = entry.resolve;
                      const oldReject = entry.reject;
                      
                      entry.resolve = (token: string) => {
                          entry.claim_pending = false;
                          oldResolve(token);
                          resolve({ token });
                      };
                      entry.reject = (err: Error) => {
                          entry.claim_pending = false;
                          oldReject(err);
                          resolve({ token: null, error: err.message });
                      };
                      
                      log(`[Queue] Ticket Claim BLOCKED: id=${ticketId}, resource=${resource}. Waiting for promotion...`);
                      return;
                  } else if (entry.status === 'MISSED') {
                      return resolve({ token: null, error: 'ticket_missed_turn' });
                  } else if (entry.status === 'EXPIRED') {
                      return resolve({ token: null, error: 'ticket_expired' });
                  }
              }
          }
          return resolve({ token: null, error: 'ticket_invalid' });
      });
  }

  public runWatchdog() {
      if (!this.experimentalScheduling) return;
      if (this.watchdogInFlight) {
          log(`[Queue] Watchdog overlap detected. Skipping.`);
          return;
      }
      this.watchdogInFlight = true;
      try {
          this.lastWatchdogRun = Date.now();
          const asyncThresholdMs = this.asyncTicketThresholdMs;

          // When async mode is disabled, just pump all queues and return.
          // Never convert a blocking request to an async ticket.
          if (asyncThresholdMs <= 0) {
              for (const resource of this.queue.keys()) this.pump(resource);
              return;
          }

          // Async mode is enabled: run the Dynamic Async Shift.
          const thresholdWaitMs = asyncThresholdMs; // driven by config, not env default
          
          for (const resource of this.queue.keys()) {
              this.pump(resource);
              
              // Dynamic Async Shift: Retroactively convert long-waiting BLOCKING entries into ASYNC tickets
              const resourceQueue = this.queue.get(resource) || [];
              for (const entry of resourceQueue) {
                  if (entry.wait_mode === 'BLOCKING' && entry.status === 'WAITING' && (Date.now() - entry.waiting_since) > thresholdWaitMs) {
                      if (entry.claim_pending) {
                          log(`[Queue] Dynamic Async Shift skipped: Entry ${entry.id} has a blocking claim in flight.`);
                          continue;
                      }
                      if (entry.async_notified) {
                          continue; // Already shifted once, don't resolve again
                      }
                      log(`[Queue] Dynamic Async Shift: Entry ${entry.id} waited > ${thresholdWaitMs/1000}s. Converting to ASYNC Ticket.`);
                      entry.wait_mode = 'ASYNC';
                      entry.async_notified = true;
                      entry.resolve(entry.id); // This resolves the hanging enqueue() promise, returning the ticket ID
                  }
              }
          }
      } finally {
          this.watchdogInFlight = false;
      }
  }
}

export const queueManager = new QueueEngine();
const queueWatchdogInterval = parseInt(process.env.ARBITER_WATCHDOG_INTERVAL || '5000');
const queueWatchdog = setInterval(() => queueManager.runWatchdog(), queueWatchdogInterval);
if (queueWatchdog.unref) queueWatchdog.unref();
