#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    const args = process.argv.slice(2);
    let configPath = process.env.TDB_CONFIG_PATH;
    
    // Fallback to standard fixture location if env var is missing
    if (!configPath) {
        const localFixture = path.resolve(__dirname, 'fixtures', 'tdb_scenarios.json');
        const rootFixture = path.resolve(process.cwd(), 'src', 'tests', 'fixtures', 'tdb_scenarios.json');
        
        if (fs.existsSync(localFixture)) {
            configPath = localFixture;
        } else if (fs.existsSync(rootFixture)) {
            configPath = rootFixture;
        }
    }
    
    // Fallback if no specific config is found
    if (!configPath || !fs.existsSync(configPath)) {
        console.log(`[TDB] Default Mock Log. (Args: ${args.join(' ')})`);
        process.exit(0);
    }
    
    const configList = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Support mock pull: write mock file content to the last argument path
    if (args[0] === 'pull' && args.length >= 3) {
        const destPath = args[args.length - 1];
        try {
            fs.writeFileSync(destPath, 'Mock pulled file content');
        } catch (e) {}
    }
    
    // Evaluate args iteratively
    for (const cfg of configList) {
        // Simple subset matching: if every string in argsMatch appears in the executed arguments
        const match = cfg.argsMatch.every((m: string) => args.includes(m));
        if (match) {
            if (cfg.delayMs) {
                await new Promise(r => setTimeout(r, cfg.delayMs));
            }
            if (cfg.stderr) process.stderr.write(`[TDB] ${cfg.stderr}\n`);
            if (cfg.output) process.stdout.write(`[TDB] ${cfg.output}\n`);
            process.exit(cfg.exitCode || 0);
        }
    }
    
    process.stdout.write(`[TDB] Unmatched Command! Args: ${args.join(' ')}\n`);
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
