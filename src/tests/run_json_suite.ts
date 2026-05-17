import * as fs from 'fs';
import * as path from 'path';
import { allocatePort, startBrokerWithEnv, createUniqueResource } from './helpers/harness';
import { JsonTestRunner, TestSchema } from './helpers/json_runner';

async function runJsonSuite() {
    const scenariosDir = path.join(__dirname, 'scenarios');
    if (!fs.existsSync(scenariosDir)) {
        console.log("No JSON scenarios found.");
        return;
    }

    const files = fs.readdirSync(scenariosDir).filter(f => f.endsWith('.json'));
    console.log(`=== Running ${files.length} JSON Driven Tests ===\n`);

    let failed = 0;
    
    for (const file of files) {
        const fullPath = path.join(scenariosDir, file);
        const schema: TestSchema = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        
        const port = allocatePort();
        const broker = await startBrokerWithEnv(port, schema.config || {});
        const resource = createUniqueResource('json-scenario');
        
        let runnerError = null;
        try {
            const runner = new JsonTestRunner(broker.port, resource);
            await runner.run(schema);
        } catch (e: any) {
            runnerError = e;
            console.error(`\n❌ ${file} FAILED: ${e.message}\n`);
            failed++;
        } finally {
            await broker.stop();
        }
        
        if (!runnerError) {
             console.log(`✅ ${file} Passed`);
        }
    }

    if (failed > 0) {
        console.error(`\nSuite Failed: ${failed} tests failed.`);
        process.exit(1);
    } else {
        console.log(`\n✅ All ${files.length} JSON Tests Passed.\n`);
    }
}

runJsonSuite().catch(e => {
    console.error(e);
    process.exit(1);
});
