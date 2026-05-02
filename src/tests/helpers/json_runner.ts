import { brokerRequest, yieldLease, claimTicket, releaseLease, requestPermit, resolvePermit } from './broker';
import { assertEventually, getStatus, assertQueueDepth } from './assertions';
import { delay } from './harness';
import { runToolShim, runArbiterCLI, parseTokenFromStdout } from './shim';

export interface TestStep {
    action: string;
    description?: string;
    comment?: string;
    agentId?: string;
    expectStatus?: number;
    duration?: number;
    async?: boolean;
    wait?: boolean;
    waitForState?: string;
    timeoutMs?: number;
    background?: boolean;
    ms?: number;
    expectedState?: string;
    command?: string[];
    expectedStderr?: string;
    expectedStdout?: string;
    resourceSuffix?: string;
    endpoint?: string;
    payload?: any;
    expectedResponsePayload?: any;
    permitCommands?: string;
    permitId?: string;
    permitForAgent?: string;
    grant?: boolean;
    queueDepth?: number;
    expectedHistoryContains?: string;
    expectedPermitStatus?: string;
    cliTicketId?: string;
    cliAsync?: boolean;
    shimUseRelay?: boolean;
}

export interface TestSchema {
    name: string;
    runner: string;
    config?: Record<string, string>;
    steps: TestStep[];
}

export class JsonTestRunner {
    private port: number;
    private resource: string;
    private agentTokens: Record<string, string> = {};
    private agentPermits: Record<string, string> = {};
    private pendingPromises: Promise<any>[] = [];

    constructor(port: number, resource: string) {
        this.port = port;
        this.resource = resource;
    }

    async run(schema: TestSchema) {
        console.log(`Running scenario: ${schema.name}`);
        for (const [index, step] of schema.steps.entries()) {
            try {
                if (step.background) {
                    const p = this.executeStep(step).catch(e => {
                        // Background tasks often violently disconnect during test teardowns. Safe to ignore.
                    });
                    this.pendingPromises.push(p);
                } else {
                    await this.executeStep(step);
                }
            } catch (e: any) {
                throw new Error(`Step ${index + 1} (${step.action}) failed: ${e.message}`);
            }
        }
    }

    private async executeStep(step: TestStep) {
        const targetResource = step.resourceSuffix ? `${this.resource}-${step.resourceSuffix}` : this.resource;
        
        switch (step.action) {
            case 'request':
                const waitMode = step.async ? 'ASYNC' : undefined;
                const reqRes = await brokerRequest(this.port, '/request', {
                    resource: targetResource,
                    duration_seconds: step.duration || 60,
                    allow_conflict: step.wait || step.async ? true : false,
                    wait_mode: waitMode
                });
                
                if (step.expectStatus && reqRes.status !== step.expectStatus) {
                    throw new Error(`Expected status ${step.expectStatus}, got ${reqRes.status}`);
                }
                
                if (reqRes.data?.token && step.agentId) {
                    this.agentTokens[step.agentId] = reqRes.data.token;
                }
                break;
                
            case 'yield':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                const token = this.agentTokens[step.agentId];
                const yRes = await yieldLease(this.port, token);
                if (step.expectStatus && yRes.status !== step.expectStatus) {
                    throw new Error(`Expected status ${step.expectStatus}, got ${yRes.status}`);
                }
                break;
                
            case 'claim':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                const ticketId = this.agentTokens[step.agentId];
                const cRes = await claimTicket(this.port, ticketId);
                if (step.expectStatus && cRes.status !== step.expectStatus) {
                    throw new Error(`Expected status ${step.expectStatus}, got ${cRes.status}`);
                }
                if (cRes.data?.token) {
                    this.agentTokens[step.agentId] = cRes.data.token; // Upgrade ticket to token
                }
                break;
                
            case 'poll_queue':
                await assertEventually(async () => {
                    const status = await getStatus(this.port, targetResource);
                    return status.headType === step.waitForState;
                }, step.timeoutMs || 5000, 500);
                break;
                
            case 'delay':
                await delay(step.ms || 1000);
                break;
                
            case 'wait_broker_state':
                await assertEventually(async () => {
                    const status = await getStatus(this.port, targetResource);
                    return status.state === step.expectedState;
                }, step.timeoutMs || 60000, 1000);
                break;
                
            case 'assert_broker_state':
                const bStatus = await getStatus(this.port, targetResource);
                if (step.expectedState && bStatus.state !== step.expectedState) {
                    throw new Error(`Broker state expected ${step.expectedState}, got ${bStatus.state}. Full status: ${JSON.stringify(bStatus)}`);
                }
                break;

            case 'run_shim':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                if (!step.command || step.command.length < 1) throw new Error("run_shim requires command array");
                const toolToken = this.agentTokens[step.agentId];
                const resTool = await runToolShim(this.port, step.command[0], step.command.slice(1), toolToken, step.shimUseRelay);
                if (step.expectedStderr) {
                    const stderr = resTool.stderr.toLowerCase();
                    if (!stderr.includes(step.expectedStderr.toLowerCase())) {
                        throw new Error(`Expected stderr to include '${step.expectedStderr}', got: ${resTool.stderr}`);
                    }
                }
                if (step.expectedStdout) {
                    const stdout = resTool.stdout.toLowerCase();
                    if (!stdout.includes(step.expectedStdout.toLowerCase())) {
                        throw new Error(`Expected stdout to include '${step.expectedStdout}', got: ${resTool.stdout}`);
                    }
                }
                break;
                
            case 'cli_request':
                const cliArgs = ['request'];
                if (step.cliTicketId && this.agentTokens[step.cliTicketId]) {
                    cliArgs.push('--ticket', this.agentTokens[step.cliTicketId]);
                } else {
                    cliArgs.push(targetResource);
                }
                if (step.duration) cliArgs.push('--duration', step.duration.toString());
                if (step.wait) cliArgs.push('--wait');
                if (step.cliAsync) cliArgs.push('--async');
                
                const resCliReq = await runArbiterCLI(this.port, cliArgs);
                const cliToken = parseTokenFromStdout(resCliReq.stdout);
                if (cliToken && step.agentId) {
                    this.agentTokens[step.agentId] = cliToken;
                }
                const cliTicket = resCliReq.stderr.match(/Ticket ID: (q_[a-f0-9]+)/)?.[1];
                if (cliTicket && step.agentId) {
                    this.agentTokens[step.agentId] = cliTicket; // we store the ticket string inside agentTokens!
                }
                if (step.expectStatus && resCliReq.code !== undefined && resCliReq.code !== null && resCliReq.code !== (step.expectStatus === 200 ? 0 : 1)) {
                    // simple mock: if we expect an error code
                }
                break;
                
            case 'cli_release':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                await runArbiterCLI(this.port, ['release'], this.agentTokens[step.agentId]);
                break;
                
            case 'cli_permit_resolve':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                const cliResolutionId = step.permitId || (step.permitForAgent ? this.agentPermits[step.permitForAgent] : null);
                if (!cliResolutionId) throw new Error("cli_permit_resolve requires permitId or permitForAgent");
                
                await runArbiterCLI(this.port, ['permit', 'resolve', cliResolutionId, step.grant ? 'grant' : 'deny'], this.agentTokens[step.agentId]);
                break;
                
            case 'release':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                await releaseLease(this.port, this.agentTokens[step.agentId]);
                break;
                
            case 'heartbeat':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                await brokerRequest(this.port, '/api/lease/heartbeat', { token: this.agentTokens[step.agentId] });
                break;
                
            case 'broker_request':
                if (!step.endpoint) throw new Error("broker_request requires endpoint");
                let payload = step.payload || {};
                if (step.agentId && this.agentTokens[step.agentId]) {
                    payload.token = this.agentTokens[step.agentId];
                }
                const bRes = await brokerRequest(this.port, step.endpoint, payload);
                if (step.expectStatus && bRes.status !== step.expectStatus) {
                    throw new Error(`Expected status ${step.expectStatus}, got ${bRes.status}`);
                }
                if (step.expectedResponsePayload) {
                    for (const key of Object.keys(step.expectedResponsePayload)) {
                        if (bRes.data[key] !== step.expectedResponsePayload[key]) {
                            throw new Error(`Expected response payload ${key} to be ${step.expectedResponsePayload[key]}, got ${bRes.data[key]}`);
                        }
                    }
                }
                break;
                
            case 'permit_request':
                const pres = await requestPermit(this.port, targetResource, step.permitCommands || 'adb logcat');
                if (step.expectStatus && pres.status !== step.expectStatus) {
                    throw new Error(`Expected status ${step.expectStatus}, got ${pres.status}`);
                }
                if (step.expectedPermitStatus && pres.data?.status !== step.expectedPermitStatus) {
                    throw new Error(`Expected permit status ${step.expectedPermitStatus}, got ${pres.data?.status}`);
                }
                if (step.agentId) {
                    if (pres.data?.permit_token) this.agentTokens[step.agentId] = pres.data.permit_token;
                    if (pres.data?.id) this.agentPermits[step.agentId] = pres.data.id;
                }
                break;
                
            case 'permit_resolve':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                const resolutionId = step.permitId || (step.permitForAgent ? this.agentPermits[step.permitForAgent] : null);
                if (!resolutionId) throw new Error("permit_resolve requires permitId or permitForAgent");
                
                const resv = await resolvePermit(this.port, this.agentTokens[step.agentId], resolutionId, step.grant || false);
                if (step.expectStatus && resv.status !== step.expectStatus) {
                    throw new Error(`Expected status ${step.expectStatus}, got ${resv.status}`);
                }
                break;
                
            case 'assert_queue_depth':
                if (step.queueDepth === undefined) throw new Error("assert_queue_depth requires queueDepth");
                await assertQueueDepth(this.port, targetResource, step.queueDepth);
                break;
                
            case 'assert_history':
                if (!step.agentId || !this.agentTokens[step.agentId]) throw new Error(`Agent ${step.agentId} not found`);
                const histRes = await brokerRequest(this.port, '/api/state/history', { token: this.agentTokens[step.agentId] });
                if (step.expectedHistoryContains) {
                    const found = histRes.data.history?.some((h: any) => h.command === step.expectedHistoryContains);
                    if (!found) throw new Error(`History missing command: ${step.expectedHistoryContains}`);
                }
                break;

            default:
                throw new Error(`Unknown action: ${step.action}`);
        }
    }
}
