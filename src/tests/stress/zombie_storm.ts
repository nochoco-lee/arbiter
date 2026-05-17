import { 
    allocatePort, startBrokerInstance, createUniqueResource, delay
} from '../helpers/harness';
import { 
    requestLease, brokerRequest 
} from '../helpers/broker';
import * as http from 'http';

async function testZombieStorm() {
    console.log("Running Stress Test: Zombie Storm (10 resources)");
    const port = allocatePort();
    const broker = await startBrokerInstance(port);

    try {
        const count = 10;
        console.log(`- Creating ${count} resources and abandoning leases...`);
        
        for (let i = 0; i < count; i++) {
            const resName = createUniqueResource(`zombie-${i}`);
            // Small duration but long enough to acquire
            await requestLease(broker.port, resName, 5);
        }

        console.log("- Awaiting watchdog cleanup (35s)...");
        await delay(35000);

        console.log("- Verifying all resources are FREE...");
        const resStatus = await new Promise<any>((resolve) => {
            http.get(`http://127.0.0.1:${broker.port}/status`, (res) => {
                let d = ''; res.on('data', c => d+=c); res.on('end', () => resolve(JSON.parse(d)));
            });
        });

        const zombiesLeft = Object.entries(resStatus.resources).filter(([k, v]: [string, any]) => k.includes('zombie') && v.state !== 'FREE');
        if (zombiesLeft.length > 0) {
            console.error("Zombies remaining:", zombiesLeft);
            throw new Error(`${zombiesLeft.length} zombies were not reclaimed`);
        }

        console.log("✅ Zombie Storm Passed");
    } finally {
        await broker.stop();
    }
}

testZombieStorm().catch(e => {
    console.error(e);
    process.exit(1);
});
