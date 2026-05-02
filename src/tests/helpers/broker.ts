import * as http from 'http';

export async function brokerRequest(port: number, path: string, payload: any, extraHeaders?: Record<string, string>): Promise<{status: number, data: any}> {
    return new Promise((resolve, reject) => {
        const pStr = JSON.stringify(payload);
        const req = http.request(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pStr), ...extraHeaders }
        }, (res) => {
            let d = ''; res.on('data', c => d+=c);
            res.on('end', () => {
                try {
                    resolve({status: res.statusCode || 500, data: d ? JSON.parse(d) : {}});
                } catch (e) {
                    resolve({status: res.statusCode || 500, data: { raw: d }});
                }
            });
        });
        req.on('error', reject);
        req.write(pStr);
        req.end();
    });
}

export async function requestLease(port: number, resource: string, duration?: number, wait: boolean = false): Promise<any> {
    const payload: any = { resource, duration_seconds: duration, allow_conflict: wait };
    return brokerRequest(port, '/request', payload);
}

export async function yieldLease(port: number, token: string, reason?: string): Promise<any> {
    return brokerRequest(port, '/yield', { token, reason });
}

export async function releaseLease(port: number, token: string): Promise<any> {
    return brokerRequest(port, '/api/lease/release', { token });
}

export async function claimTicket(port: number, ticketId: string): Promise<any> {
    return brokerRequest(port, '/api/reservation/claim', { ticketId });
}

export async function requestPermit(port: number, resource: string, commands: string): Promise<any> {
    return brokerRequest(port, '/api/permit/request', { resource, commands });
}

export async function resolvePermit(port: number, leaseToken: string, permitId: string, grant: boolean): Promise<any> {
    return brokerRequest(port, '/api/permit/resolve', { token: leaseToken, permit_id: permitId, grant });
}
