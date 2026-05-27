import { randomUUID } from 'crypto';
import { ResourceState, YieldRequest, ArbiterContext } from '../api/types';
import { ContextManager } from '../context';
import { getAdapterInstance } from '../adapters/index';
import { log, warn } from '../broker/logger';

export interface LeaseInfo {
  token: string;
  resource: string;
  created_at: number;
  expires_at: number;
  hard_deadline: number;
  last_heartbeat: number;
  last_activity_at: number;
  has_started: boolean;
  state: 'GRANTED' | 'EXPIRING' | 'EXPIRED' | 'AVAILABLE' | 'DRAINING';
  extended?: boolean;
  requested_duration_ms: number;
}

export interface DeadLeaseInfo {
    token: string;
    resource: string;
    created_at: number;
    expired_at: number;
    last_activity_at: number;
    has_started: boolean;
    reason: string;
}

export class LeaseManager {
  private activeLeases: Map<string, LeaseInfo> = new Map();
  private deadLeaseHistory: Map<string, DeadLeaseInfo> = new Map();
  private resourceStates: Map<string, ResourceState> = new Map();
  private activeAdapters: Map<string, any> = new Map();
  private pendingPermits: Map<string, Record<string, any>> = new Map(); // Resource -> Record<id, PermitRequestInfo>
  // We inject a late-bound queue depth resolver to avoid cyclic dependency imports in state module
  public queueDepthResolver?: (res: string) => number;
  public onResourceFree?: (res: string) => void;
  public ceilingConfig?: Record<string, any>;
  public experimentalScheduling: boolean = false;

  // --- Testing & State Manipulation APIs ---
  public injectTestState(resource: string, leaseInfo: Partial<LeaseInfo>): void {
      const now = Date.now();
      if (!this.activeLeases.has(resource)) {
          this.activeLeases.set(resource, {
              token: leaseInfo.token || randomUUID(),
              resource,
              created_at: leaseInfo.created_at || now - 5000,
              expires_at: leaseInfo.expires_at || now + 10000,
              hard_deadline: leaseInfo.hard_deadline || now + 15000,
              last_heartbeat: leaseInfo.last_heartbeat || now,
              last_activity_at: leaseInfo.last_activity_at || now,
              has_started: leaseInfo.has_started || false,
              state: leaseInfo.state || 'GRANTED',
              requested_duration_ms: leaseInfo.requested_duration_ms || 10000
          });
      } else {
          Object.assign(this.activeLeases.get(resource)!, leaseInfo);
      }
      if (leaseInfo.state) {
          this.resourceStates.set(resource, leaseInfo.state === 'EXPIRED' ? 'FREE' : leaseInfo.state as any);
      }
  }

  public forceReclaim(resource: string, newState: 'FREE' | 'AVAILABLE'): void {
      if (newState === 'FREE') {
          this.activeLeases.delete(resource);
          this.resourceStates.set(resource, 'FREE');
          if (this.onResourceFree) this.onResourceFree(resource);
      } else {
          const lease = this.activeLeases.get(resource);
          if (lease) {
              lease.state = 'AVAILABLE';
              this.resourceStates.set(resource, 'AVAILABLE');
          }
      }
  }

  public getResourceState(resource: string): ResourceState {
    const activeLease = this.activeLeases.get(resource);
    if (activeLease) {
      if (activeLease.state === 'GRANTED' || activeLease.state === 'EXPIRING' || activeLease.state === 'DRAINING') {
        if (activeLease.state === 'DRAINING') return 'DRAINING';
        return activeLease.state === 'EXPIRING' ? 'EXPIRING' as any : 'GRANTED';
      }
      if (activeLease.state === 'AVAILABLE') {
        return 'AVAILABLE';
      }
    }
    return this.resourceStates.get(resource) || 'FREE';
  }

  public getAllResources(): string[] {
      const set = new Set<string>();
      for (const r of this.activeLeases.keys()) set.add(r);
      for (const r of this.resourceStates.keys()) set.add(r);
      if (this.ceilingConfig) {
          for (const r of Object.keys(this.ceilingConfig)) {
              if (r !== 'default') set.add(r);
          }
      }
      return Array.from(set);
  }

  public exportState(): any {
    return {
      activeLeases: Array.from(this.activeLeases.entries()),
      resourceStates: Array.from(this.resourceStates.entries()),
      pendingPermits: Array.from(this.pendingPermits.entries())
    };
  }

  public importState(data: any): void {
    if (data.activeLeases) this.activeLeases = new Map(data.activeLeases);
    if (data.resourceStates) this.resourceStates = new Map(data.resourceStates);
    if (data.pendingPermits) this.pendingPermits = new Map(data.pendingPermits);
  }

  public getActiveLeaseToken(resource: string): string | undefined {
    const lease = this.activeLeases.get(resource);
    if (lease && (lease.expires_at > Date.now() || lease.state === 'AVAILABLE')) {
      return lease.token;
    }
    return undefined;
  }

  private resurrectIfPossible(lease: LeaseInfo): boolean {
    const queueDepth = this.queueDepthResolver ? this.queueDepthResolver(lease.resource) : 0;
    if (queueDepth === 0) {
      const now = Date.now();
      lease.state = 'GRANTED';
      this.resourceStates.set(lease.resource, 'GRANTED');
      lease.expires_at = now + lease.requested_duration_ms;
      lease.hard_deadline = lease.expires_at + 60000;
      lease.last_heartbeat = now;
      log(`[Arbiter] Lease ${lease.token} resurrected/extended for ${lease.requested_duration_ms/1000}s (Resource uncontended)`);
      return true;
    }
    return false;
  }

  public validateToken(token: string, reactivate: boolean = true): boolean {
    for (const [_, lease] of this.activeLeases.entries()) {
      // Allow execution to bridge if its still GRANTED. 
      if (lease.token === token) {
        if (lease.state === 'GRANTED') return true;
        
        // If AVAILABLE, move back to GRANTED (Reactive Resume)
        if (lease.state === 'AVAILABLE') {
            if (reactivate) {
                lease.state = 'GRANTED';
                this.resourceStates.set(lease.resource, 'GRANTED');
                lease.last_heartbeat = Date.now();
                log(`[Arbiter] Lease ${lease.token} reactivated from AVAILABLE state.`);
            }
            return true;
        }

        // If EXPIRING, attempt resurrection if no one is waiting
        if (lease.state === 'EXPIRING') {
          return this.resurrectIfPossible(lease);
        }
      }
    }
      
    // Allow execution if it's an active granted Permit token exclusively mapped
    for (const [_, permits] of this.pendingPermits.entries()) {
        for (const p of Object.values(permits)) {
            if (p.status === 'GRANTED' && p.permit_token === token && p.expires_at > Date.now()) {
                return true;
            }
        }
    }
    return false;
  }

  public getResourceByToken(token: string): string | undefined {
    for (const [resource, lease] of this.activeLeases.entries()) {
      if (lease.token === token) {
          if (lease.expires_at > Date.now()) return resource;
          // Even if expired, if we are about to resurrect it via validateToken, we should return resource
          const queueDepth = this.queueDepthResolver ? this.queueDepthResolver(resource) : 0;
          if (queueDepth === 0) return resource;
      }
    }
      
    for (const [resource, permits] of this.pendingPermits.entries()) {
        for (const p of Object.values(permits)) {
            if (p.status === 'GRANTED' && p.permit_token === token && p.expires_at > Date.now()) {
                return resource;
            }
        }
    }
    return undefined;
  }

  public async getAdapter(resource: string): Promise<any> {
    if (this.activeAdapters.has(resource)) return this.activeAdapters.get(resource);
    
    let adapterType = 'adb';
    if (this.ceilingConfig && this.ceilingConfig[resource] && this.ceilingConfig[resource].adapter) {
        adapterType = this.ceilingConfig[resource].adapter;
    }
    
    const adapter = getAdapterInstance(adapterType);
    await adapter.connect({ resourceId: resource });
    this.activeAdapters.set(resource, adapter);
    return adapter;
  }



  public getActiveLeaseInfo(resource: string): LeaseInfo | undefined {
    return this.activeLeases.get(resource);
  }

  public getDrainingPermitCount(resource: string): number {
      const permits = this.pendingPermits.get(resource) || {};
      return Object.values(permits).filter((p: any) => p.executionStatus === 'RUNNING').length;
  }

  public grantLease(resource: string, durationSeconds: number = 300): string {
      const state = this.getResourceState(resource);
      if (state === 'GRANTED' || state === 'EXPIRING' || state === 'DRAINING') {
         throw new Error(`Resource ${resource} is already leased`);
      }
      
      // Cooperative Permit System natively mapping ceiling logic limits
      if (this.ceilingConfig && this.ceilingConfig[resource] && this.ceilingConfig[resource].max_duration_seconds) {
          const hardCap = this.ceilingConfig[resource].max_duration_seconds;
          const original = durationSeconds;
          durationSeconds = Math.min(durationSeconds, hardCap);
          if (original > hardCap) {
              log(`[Arbiter] Clamped requested duration ${original}s to Configuration Hard-Cap ${hardCap}s for ${resource}`);
          }
      }

      log(`[Arbiter] Granting Lease: resource=${resource}, duration=${durationSeconds}s`);
      const token = randomUUID();
      const now = Date.now();
      this.activeLeases.set(resource, {
          token,
          resource,
          created_at: now,
          expires_at: now + (durationSeconds * 1000),
          hard_deadline: now + (durationSeconds * 1000) + 60000,
          last_heartbeat: now,
          last_activity_at: now,
          has_started: false,
          state: 'GRANTED',
          requested_duration_ms: durationSeconds * 1000
      });
      this.resourceStates.set(resource, 'GRANTED');

      return token;
  }

  public async yieldLease(req: YieldRequest, force: boolean = false): Promise<boolean> {
      for (const [resource, lease] of this.activeLeases.entries()) {
          if (lease.token === req.token) {
              const artifacts: string[] = [];
              try {
                  const adapter = await this.getAdapter(resource);
                  if (process.env.ARBITER_SKIP_ARTIFACTS !== 'true') {
                      artifacts.push(await adapter.captureLogs());
                      artifacts.push(await adapter.screenshot());
                  }
              } catch (e) {
                  warn(`Failed to capture artifacts via adapter: ${e}`);
              }

              const ctx: ArbiterContext = {
                  schema_version: 1,
                  resource: resource,
                  session_id: lease.token,
                  duration_seconds: Math.round((Date.now() - lease.created_at) / 1000), 
                  outcome: req.reason || 'yielded',
                  artifacts: artifacts
              };
              
              if (req.context) Object.assign(ctx, req.context);

              ContextManager.saveContext(ctx);

              // Track in dead lease history
              this.deadLeaseHistory.set(lease.token, {
                  token: lease.token,
                  resource: lease.resource,
                  created_at: lease.created_at,
                  expired_at: Date.now(),
                  last_activity_at: lease.last_activity_at,
                  has_started: lease.has_started,
                  reason: req.reason || 'yielded'
              });
              // Cap history size
              if (this.deadLeaseHistory.size > 100) {
                  const firstKey = this.deadLeaseHistory.keys().next().value;
                  if (firstKey !== undefined) this.deadLeaseHistory.delete(firstKey);
              }

              // Check if we should drain instead of immediate free
              const permits = this.pendingPermits.get(resource) || {};
              const runningCount = Object.values(permits).filter((p: any) => p.executionStatus === 'RUNNING').length;
              const queueDepth = this.queueDepthResolver ? this.queueDepthResolver(resource) : 0;

              if (!force && this.experimentalScheduling && runningCount > 0) {
                  lease.state = 'DRAINING';
                  this.resourceStates.set(resource, 'DRAINING');
                  log(`[Watchdog] Lease ${req.token} yielded but resource ${resource} is DRAINING ${runningCount} permits.`);
              } else if (!force && this.experimentalScheduling && queueDepth === 0 && req.reason === 'release') {
                  // If it's a voluntary release and no one is waiting, move to AVAILABLE
                  lease.state = 'AVAILABLE';
                  this.resourceStates.set(resource, 'AVAILABLE');
                  log(`[Arbiter] Lease ${req.token} transitioned to AVAILABLE (Queue empty).`);
              } else {
                  if (force && runningCount > 0) {
                      log(`[Watchdog] Force-releasing ${resource} despite ${runningCount} running permits.`);
                  }
                  this.activeLeases.delete(resource);
                  this.resourceStates.set(resource, 'FREE');
                  if (this.onResourceFree) this.onResourceFree(resource);
              }
              
              return true;
          }
      }
      return false;
  }

  public touchHeartbeat(token: string): boolean {
      for (const [_, lease] of this.activeLeases.entries()) {
          if (lease.token === token) {
              lease.last_heartbeat = Date.now();
              lease.last_activity_at = Date.now();
              lease.has_started = true;
              // If it was expiring, resurrect it since we just got a heartbeat and queue is empty
              if (lease.state === 'EXPIRING') {
                  this.resurrectIfPossible(lease);
              }
              return true;
          }
      }
      return false;
  }

  public touchActivity(token: string): boolean {
      for (const [_, lease] of this.activeLeases.entries()) {
          if (lease.token === token) {
              lease.last_activity_at = Date.now();
              lease.has_started = true;
              return true;
          }
      }
      return false;
  }

  public getTokenStatus(token: string): { valid: boolean, message?: string } {
      const active = Array.from(this.activeLeases.values()).find(l => l.token === token);
      if (active) {
          if (active.expires_at > Date.now() || active.state === 'AVAILABLE') return { valid: true };
          return { valid: false, message: `Token expired at ${new Date(active.expires_at).toLocaleTimeString()} after ${Math.round((Date.now() - active.created_at) / 60000)} minutes of activity.` };
      }

      const dead = this.deadLeaseHistory.get(token);
      if (dead) {
          const totalDurationMin = Math.round((dead.expired_at - dead.created_at) / 60000);
          
          if (dead.reason === 'inactivity_timeout') {
              const inactivitySec = Math.round((dead.expired_at - dead.last_activity_at) / 1000);
              const message = !dead.has_started 
                ? `Token expired at ${new Date(dead.expired_at).toLocaleTimeString()} due to ${inactivitySec} seconds of initial inactivity right after lock acquisition.`
                : `Token expired at ${new Date(dead.expired_at).toLocaleTimeString()} due to ${inactivitySec} seconds of inactivity after some session activity.`;
              
              return { valid: false, message };
          }

          if (dead.reason === 'zombie_timeout' || dead.reason === 'expired_contention') {
              return { 
                  valid: false, 
                  message: `Token expired at ${new Date(dead.expired_at).toLocaleTimeString()} after ${totalDurationMin} minutes of activity (Reason: ${dead.reason}).` 
              };
          }

          return { valid: false, message: `Token expired at ${new Date(dead.expired_at).toLocaleTimeString()} (Reason: ${dead.reason}).` };
      }

      return { valid: false, message: "Token is invalid or has been purged from history." };
  }

  public extendGracePeriod(token: string, extraMs: number = 300000): boolean {
      for (const [_, lease] of this.activeLeases.entries()) {
          if (lease.token === token && lease.state === 'GRANTED' && !lease.extended) {
              lease.expires_at = Math.max(lease.expires_at, Date.now() + extraMs);
              lease.hard_deadline += extraMs;
              lease.extended = true;
              return true;
          }
      }
      return false;
  }

  public async releaseLease(token: string): Promise<boolean> {
      for (const [resource, lease] of this.activeLeases.entries()) {
          if (lease.token === token) {
              await this.yieldLease({ token, reason: 'release' });
              return true;
          }
      }
      return false;
  }

  // Requesting Cooperative Permits
  public requestPermit(resource: string, commands: string): { permit: any, error?: string } {
       const lease = this.activeLeases.get(resource);
       if (!lease) return { permit: null, error: 'resource_not_leased' };
       if (lease.state !== 'GRANTED' && lease.state !== 'EXPIRING' && lease.state !== 'AVAILABLE') return { permit: null, error: 'resource_not_active' };

       // Experimental Scheduling: Late permit denial (30s safety window)
       if (this.experimentalScheduling) {
           const now = Date.now();
           const remainingMs = lease.expires_at - now;
           if (lease.state === 'EXPIRING' || (lease.state === 'GRANTED' && remainingMs < 30000)) {
               log(`[Arbiter] Permit Denied for ${resource}: Too close to expiry (${Math.round(remainingMs/1000)}s remaining)`);
               return { permit: null, error: 'permit_denied_late_session' };
           }
       }

       let isAutoGrant = commands.includes('logcat') || commands.includes('dumpsys');

       const permitId = 'permit_' + randomUUID().substring(0, 8);
       
       const permit = {
           id: permitId,
           resource,
           commands,
           status: isAutoGrant ? 'GRANTED' : 'PENDING',
           executionStatus: 'NOT_STARTED' as any,
           expires_at: Date.now() + 600000, // 10 minutes valid
           granted_at: isAutoGrant ? Date.now() : undefined,
           permit_token: isAutoGrant ? 'tok_' + permitId : undefined
       };
       
       // Experimental Scheduling: Auto-Padding
       if (isAutoGrant && this.experimentalScheduling) {
           const paddingMs = 45000; // 45s safety buffer
           const now = Date.now();
           if (lease.expires_at - now < paddingMs) {
               lease.expires_at = now + paddingMs;
               lease.hard_deadline = lease.expires_at + 60000;
               log(`[Arbiter] Auto-Padded lease ${lease.token} by ${paddingMs/1000}s to accommodate new permit.`);
           }
       }

       const permits = this.pendingPermits.get(resource) || {};
       permits[permitId] = permit;
       this.pendingPermits.set(resource, permits);
       return { permit };
  }

  public resolvePermit(leaseToken: string, permitId: string, grant: boolean): string | null {
       for (const [resource, lease] of this.activeLeases.entries()) {
           if (lease.token === leaseToken) {
               const permits = this.pendingPermits.get(resource);
               if (permits && permits[permitId]) {
                   const p = permits[permitId];
                   p.status = grant ? 'GRANTED' : 'DENIED';
                   if (grant) {
                       p.granted_at = Date.now();
                       p.executionStatus = 'NOT_STARTED';
                       p.permit_token = 'tok_' + p.id;

                       // Experimental Scheduling: Auto-Padding
                       if (this.experimentalScheduling) {
                           const paddingMs = 45000;
                           const now = Date.now();
                           if (lease.expires_at - now < paddingMs) {
                               lease.expires_at = now + paddingMs;
                               lease.hard_deadline = lease.expires_at + 60000;
                               log(`[Arbiter] Auto-Padded lease ${lease.token} by ${paddingMs/1000}s to accommodate newly resolved permit.`);
                           }
                       }

                       return p.permit_token;
                   }
                   return "DENIED";
               }
           }
       }
       return null;
  }

  public getPendingPermits(leaseToken: string): any[] {
       for (const [resource, lease] of this.activeLeases.entries()) {
           if (lease.token === leaseToken) {
               const permits = this.pendingPermits.get(resource) || {};
               return Object.values(permits).filter((p: any) => p.status === 'PENDING');
           }
       }
       return [];
  }

  public getPermitsForResource(resource: string): Record<string, any> | undefined {
      return this.pendingPermits.get(resource);
  }

  public startPermitExecution(permitToken: string): boolean {
      for (const [resource, permits] of this.pendingPermits.entries()) {
          for (const p of Object.values(permits)) {
              if (p.permit_token === permitToken && p.status === 'GRANTED' && p.executionStatus === 'NOT_STARTED') {
                  p.executionStatus = 'RUNNING';
                  p.status = 'CONSUMED'; // Mark as consumed immediately to prevent new parallel starts
                  p.started_at = Date.now();
                  p.last_heartbeat_at = Date.now();
                  log(`[Permit] Execution Started & Token Consumed: id=${p.id}, resource=${resource}`);
                  return true;
              }
          }
      }
      return false;
  }

  public touchPermitHeartbeat(permitToken: string): boolean {
      for (const [_, permits] of this.pendingPermits.entries()) {
          for (const p of Object.values(permits)) {
              if (p.permit_token === permitToken && p.executionStatus === 'RUNNING') {
                  p.last_heartbeat_at = Date.now();
                  return true;
              }
          }
      }
      return false;
  }

  public finishPermitExecution(permitToken: string): boolean {
      for (const [resource, permits] of this.pendingPermits.entries()) {
          for (const p of Object.values(permits)) {
              if (p.permit_token === permitToken) {
                  const lease = this.activeLeases.get(resource);
                  p.executionStatus = 'FINISHED';
                  p.status = 'CONSUMED';
                  p.finished_at = Date.now();
                  log(`[Permit] Execution Finished & Consumed: id=${p.id}, resource=${resource}`);
                  
                  // If we were draining, check if we can finish draining
                  if (lease && lease.state === 'DRAINING') {
                      this.checkDrainCompletion(resource);
                  }
                  return true;
              }
          }
      }
      return false;
  }

  private checkDrainCompletion(resource: string) {
      const lease = this.activeLeases.get(resource);
      if (!lease || lease.state !== 'DRAINING') return;

      const permits = this.pendingPermits.get(resource) || {};
      const runningCount = Object.values(permits).filter((p: any) => p.executionStatus === 'RUNNING').length;
      if (runningCount === 0) {
          log(`[Watchdog] Resource ${resource} finished draining. Releasing now.`);
          this.activeLeases.delete(resource);
          this.resourceStates.set(resource, 'FREE');
          if (this.onResourceFree) this.onResourceFree(resource);
      }
  }

  // Validates if the target token matches an active lease OR an active Permit uniquely natively targeting resources safely
  public validatePermitToken(resource: string, tokenString: string): boolean {
       const permits = this.pendingPermits.get(resource) || {};
       for (const p of Object.values(permits)) {
           const isGranted = (p as any).status === 'GRANTED';
           const isRunning = (p as any).status === 'CONSUMED' && (p as any).executionStatus === 'RUNNING';
           
           if ((isGranted || isRunning) && (p as any).permit_token === tokenString && (p as any).expires_at > Date.now()) {
               return true;
           }
       }
       return false;
  }

  public async runWatchdog() {
      const now = Date.now();
      const leases = Array.from(this.activeLeases.entries());
      
      for (const [resource, lease] of leases) {
          const queueDepth = this.queueDepthResolver ? this.queueDepthResolver(resource) : 0;

          // 0. Initial Inactivity Timeout (New Feature)
          // Default to 60s, configurable via ARBITER_INITIAL_INACTIVITY_TIMEOUT
          // This ONLY applies if the lease has not started any activity yet.
          if (!lease.has_started) {
              const initialInactivityTimeout = parseInt(process.env.ARBITER_INITIAL_INACTIVITY_TIMEOUT || '60000');
              if (now - lease.last_activity_at > initialInactivityTimeout) {
                  log(`[Watchdog] Lease ${lease.token} on ${resource} reclaimed due to INITIAL inactivity (${Math.round((now - lease.last_activity_at)/1000)}s).`);
                  await this.yieldLease({ token: lease.token, reason: 'inactivity_timeout' }, false);
                  continue;
              }
          }

          // 1. Soft Timeout detection: if we passed expires_at, block new commands!
          if (now > lease.expires_at && lease.state === 'GRANTED') {
              lease.state = 'EXPIRING';
              log(`[Watchdog] Lease ${lease.token} moved to EXPIRING (Soft Cutoff Active)`);
          }

          // 2. Immediate Reclamation on Contention for Expired Leases
          // If expired AND someone is waiting AND no command is actively heartbeating...
          if (lease.state === 'EXPIRING' && queueDepth > 0) {
              const isActivelyWorking = (now - lease.last_heartbeat < 15000); // Heartbeat every 10s
              if (!isActivelyWorking) {
                  log(`[Watchdog] Lease ${lease.token} expired and resource is contended. Reclaiming immediately.`);
                  // Universal DRAINING: Use force=false to allow draining if permits are running
                  await this.yieldLease({ token: lease.token, reason: 'expired_contention' }, false);
                  continue;
              }
          }

          // 3. Zombie Protection (Safety Net): Force release only after 10 minutes of total silence!
          const zombieLimit = parseInt(process.env.ARBITER_ZOMBIE_LIMIT || (process.env.ARBITER_TEST_MODE === 'true' ? '60000' : '600000'));
          if (now - lease.last_heartbeat > zombieLimit) {
              log(`[Watchdog] Lease ${lease.token} on ${resource} force-released! (Zombie/Crash Safety Net)`);
              await this.yieldLease({ token: lease.token, reason: 'zombie_timeout' }, true);
              continue;
          }
          
          // 4. Hard Deadline (if command refuses to yield forever, preventing Expiry)
          if (lease.state === 'EXPIRING' && now > lease.hard_deadline) {
             log(`[Watchdog] Lease ${lease.token} exceeded Hard Deadline on ${resource}! Force-releasing.`);
             await this.yieldLease({ token: lease.token, reason: 'hard_timeout' }, true);
             continue;
          }

          // Experimental Scheduling: Permit Execution Watchdog
          if (this.experimentalScheduling) {
              const permits = this.pendingPermits.get(resource) || {};
              for (const p of Object.values(permits)) {
                  // permit_start_deadline: must begin within 30 seconds of grant
                  if (p.status === 'GRANTED' && p.executionStatus === 'NOT_STARTED' && p.granted_at && now - p.granted_at > 30000) {
                      log(`[Watchdog] Permit ${p.id} expired: Never started execution.`);
                      p.status = 'EXPIRED';
                      p.executionStatus = 'ABANDONED';
                      if (lease.state === 'DRAINING') this.checkDrainCompletion(resource);
                  }
                  // permit_heartbeat_timeout: default 15 seconds after last heartbeat
                  if (p.executionStatus === 'RUNNING' && p.last_heartbeat_at && now - p.last_heartbeat_at > 15000) {
                      log(`[Watchdog] Permit ${p.id} abandoned: Heartbeat timeout.`);
                      p.executionStatus = 'ABANDONED';
                      if (lease.state === 'DRAINING') this.checkDrainCompletion(resource);
                  }
              }
          }
      }
  }
}

export const leaseManager = new LeaseManager();
const leaseWatchdogInterval = parseInt(process.env.ARBITER_WATCHDOG_INTERVAL || '5000');
const leaseWatchdog = setInterval(() => leaseManager.runWatchdog().catch(e => warn(`Watchdog error: ${e}`)), leaseWatchdogInterval);
if (leaseWatchdog.unref) leaseWatchdog.unref();
