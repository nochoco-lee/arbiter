import { 
    allocatePort, startBrokerInstance, createUniqueResource, delay
} from '../helpers/harness';
import { 
    requestLease, yieldLease 
} from '../helpers/broker';

async function testConcurrencyStress() {
    console.log("Running Stress Test: Concurrency (20 Agents)");
    const port = allocatePort();
    const broker = await startBrokerInstance(port);
    const resource = createUniqueResource('stress-concurrency');

    try {
        const count = 20;
        console.log(`- Dispatching ${count} concurrent requests...`);
        
        const start = Date.now();
        const promises = [];
        for (let i = 0; i < count; i++) {
            promises.push((async (id) => {
                const res = await requestLease(port, resource, 300, true);
                if (res.status !== 200) throw new Error(`Agent ${id} failed`);
                // Release immediately to let next one through
                await yieldLease(port, res.data.token);
                return id;
            })(i));
        }

        const completed = await Promise.all(promises);
        const duration = Date.now() - start;
        console.log(`- All ${completed.length} agents finished in ${duration}ms`);

        if (completed.length !== count) throw new Error("Not all agents finished");

        console.log("✅ Concurrency Stress Passed");
    } finally {
        await broker.stop();
    }
}

testConcurrencyStress().catch(e => {
    console.error(e);
    process.exit(1);
});
