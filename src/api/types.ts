export interface ArbiterContext {
    schema_version: number;
    resource: string;
    session_id: string;
    agent_id?: string;
    duration_seconds: number;
    outcome: string;
    hypothesis?: string;
    findings?: string;
    suggested_next?: string;
    commands_run?: number;
    last_log_tail?: string;
    artifacts: string[];
}

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
  reason?: 'complete' | 'stuck' | 'hypothesis-exhausted' | 'yielding-to-queue' | 'agent_crashed' | 'hard_timeout' | 'release' | 'expired_contention' | 'zombie_timeout' | 'inactivity_timeout';
  context?: ArbiterContext;
}

export type ResourceState = 'FREE' | 'GRANTED' | 'EXPIRING' | 'AVAILABLE' | 'DRAINING';

export interface StatusResponse {
  resource: string;
  state: ResourceState;
  queueDepth: number;
  holderAgeSeconds?: number;
  headType?: 'LEADER' | 'FOLLOWER' | 'WAITING';
  drainingActivePermitCount?: number;
}

export interface PermitRequest {
  resource: string;
  commands: string;
}

export interface PermitResponse {
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
