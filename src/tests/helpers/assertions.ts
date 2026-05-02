import * as http from 'http';
import { delay } from './harness';

export async function assertResourceState(port: number, resource: string, expected: string): Promise<void> {
    const status = await getStatus(port, resource);
    if (status.state !== expected) {
        throw new Error(`Assertion Failed: Resource ${resource} state expected ${expected}, got ${status.state}`);
    }
}

export async function assertQueueDepth(port: number, resource: string, expected: number): Promise<void> {
    const status = await getStatus(port, resource);
    if (status.queueDepth !== expected) {
        throw new Error(`Assertion Failed: Resource ${resource} queue depth expected ${expected}, got ${status.queueDepth}`);
    }
}

export async function assertEventually(
    predicate: () => Promise<boolean>,
    timeoutMs: number = 5000,
    intervalMs: number = 500
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) return;
        await delay(intervalMs);
    }
    throw new Error(`Assertion Failed: Predicate did not become true within ${timeoutMs}ms`);
}

export async function getStatus(port: number, resource: string): Promise<any> {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/status?resource=${encodeURIComponent(resource)}`, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}
