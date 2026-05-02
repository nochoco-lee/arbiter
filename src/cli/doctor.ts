import { spawnSync } from 'child_process';

const BINARIES_TO_CHECK = [
    { name: 'adb', required_for: 'Android' },
    { name: 'sdb', required_for: 'Tizen' },
    { name: 'xcrun', required_for: 'iOS' },
    { name: 'osascript', required_for: 'macOS Desktop' },
    { name: 'powershell.exe', required_for: 'Windows Desktop' },
    { name: 'xdotool', required_for: 'Linux GUI Testing' }
];

export function runDoctor() {
    console.log("=========================================");
    console.log(" ARBITER DOCTOR ");
    console.log("=========================================\n");

    let allGood = true;

    for (const bin of BINARIES_TO_CHECK) {
        // Simple executable presence check
        // Note: For Windows 'where', for Unix 'which'
        const isWindows = process.platform === 'win32';
        const cmd = isWindows ? 'where' : 'which';
        
        const res = spawnSync(cmd, [bin.name], { encoding: 'utf-8' });
        if (res.status === 0) {
            console.log(`[PASS] ${bin.name} natively available. (${bin.required_for} tests will work).`);
        } else {
            console.log(`[WARN] ${bin.name} NOT found in PATH. (${bin.required_for} adapters will throw errors when hooked).`);
            allGood = false;
        }
    }

    console.log("\n=========================================");
    if (allGood) {
        console.log(" All standard adapter endpoints found. Arbiter is fully operational!");
    } else {
        console.log(" Some native binaries remain unmapped. Install them locally to utilize those features.");
    }
}

if (require.main === module) {
    runDoctor();
}
