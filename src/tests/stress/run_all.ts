import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

async function runAll() {
    const dir = __dirname;
    const files = fs.readdirSync(dir).filter(f => f !== 'run_all.ts' && f.endsWith('.ts'));
    
    console.log(`=== Running ${files.length} Stress Tests ===\n`);
    
    let failed = 0;
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const res = spawnSync('node', [path.join('node_modules', 'ts-node', 'dist', 'bin.js'), fullPath], { 
            stdio: 'inherit',
            env: { ...process.env, ARBITER_ZOMBIE_LIMIT: '10000' } // 10s for stress
        });
        if (res.status !== 0) {
            console.error(`\n❌ ${file} FAILED\n`);
            failed++;
        }
    }
    
    if (failed > 0) {
        console.error(`\nSuite Failed: ${failed} tests failed.`);
        process.exit(1);
    } else {
        console.log(`\n✅ All ${files.length} Stress Tests Passed.\n`);
    }
}

runAll();
