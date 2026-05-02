export interface LeaseRequest {
  resource: string;
  duration_seconds?: number;
  allow_conflict?: boolean;
  wait_mode?: 'BLOCKING' | 'ASYNC';
}

export interface LeaseResponse {
  token: string;
  expires_at: number;
}

export interface YieldRequest {
  token: string;
  reason?: 'complete' | 'stuck' | 'hypothesis-exhausted' | 'yielding-to-queue' | 'agent_crashed' | 'hard_timeout' | 'release' | 'expired_contention' | 'zombie_timeout';
  context?: any;
}

export type ResourceState = 'FREE' | 'REQUESTED' | 'GRANTED' | 'EXPIRING' | 'RELEASED' | 'AVAILABLE' | 'DRAINING';

export interface StatusResponse {
  state: ResourceState;
  holder?: string;
  expires_at?: number;
  queueDepth: number;
  // Scheduling Metadata
  headType?: 'BLOCKING_WAIT' | 'RESERVATION' | 'READY' | null;
  holderAgeSeconds?: number;
  drainingActivePermitCount?: number;
}

export interface PermitRequestInfo {
  id: string;
  resource: string;
  commands: string;
  status: 'PENDING' | 'GRANTED' | 'DENIED' | 'EXPIRED' | 'CONSUMED';
  executionStatus: 'NOT_STARTED' | 'RUNNING' | 'FINISHED' | 'ABANDONED';
  expires_at: number;
  granted_at?: number;
  permit_token?: string;
  started_at?: number;
  last_heartbeat_at?: number;
  finished_at?: number;
}
