import { test } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

test('Shim Install: Cross-Platform Wrapper Generation', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-shim-test-'));
    const testBinName = 'testadb';

    // Execute the shim installer
    // We assume `npm run build` has produced dist/shim/index.js. For unit tests running via ts-node,
    // we can execute the TS file directly.
    const shimScriptPath = path.resolve(__dirname, '../../shim/index.ts');
    
    // We run it natively via ts-node so we don't depend on dist being up to date
    const tsNodeBin = require.resolve('ts-node/dist/bin.js');
    
    const res = spawnSync('node', [tsNodeBin, shimScriptPath, '--arbiter-install', tmpDir, testBinName], {
        encoding: 'utf8'
    });

    assert.strictEqual(res.status, 0, `Installer failed: ${res.stderr}`);

    if (process.platform === 'win32') {
        const cmdPath = path.join(tmpDir, `${testBinName}.cmd`);
        assert.ok(fs.existsSync(cmdPath), '.cmd wrapper should exist on Windows');
        
        const content = fs.readFileSync(cmdPath, 'utf8');
        assert.ok(content.includes('node'), 'Should invoke node');
        assert.ok(content.includes('index.js') || content.includes('index.ts'), 'Should target index entry point');
        // Validate it passes arguments
        assert.ok(content.includes('%*'), 'Should pass all arguments via %*');
    } else {
        const shPath = path.join(tmpDir, testBinName);
        assert.ok(fs.existsSync(shPath), 'Shell wrapper should exist on Linux/Mac');
        
        const content = fs.readFileSync(shPath, 'utf8');
        assert.ok(content.includes('#!/bin/bash'), 'Should have bash shebang');
        assert.ok(content.includes(process.execPath), 'Should invoke absolute node path');
        assert.ok(content.includes('index.js') || content.includes('index.ts'), 'Should target index entry point');
        // Validate it passes arguments
        assert.ok(content.includes('"$@"'), 'Should pass all arguments via "$@"');
        
        // Assert executable permissions
        const stat = fs.statSync(shPath);
        const isExecutable = !!(stat.mode & fs.constants.S_IXUSR);
        assert.ok(isExecutable, 'Shell script should be executable');
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
