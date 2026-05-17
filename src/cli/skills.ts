import * as fs from 'fs';
import * as path from 'path';

export function handleSkillsCommand(args: string[]) {
    if (args.length === 0) {
         console.error(`[ARBITER] Usage: arbiter skills install <name>`);
         process.exit(1);
    }

    if (args[0] === 'install') {
        const skillName = args[1] || 'arbiter';
        if (skillName === 'arbiter' || skillName === 'adb') {
            installArbiterSkill();
        } else {
            console.error(`[ARBITER] Unknown skill: ${skillName}. Only 'arbiter' is supported currently.`);
            process.exit(1);
        }
    } else {
         console.error(`[ARBITER] Unknown subcommand: ${args[0]}. Usage: arbiter skills install <name>`);
         process.exit(1);
    }
}

function installArbiterSkill() {
    const cwd = process.cwd();
    const skillsDir = path.join(cwd, '.agents', 'skills', 'arbiter');
    fs.mkdirSync(skillsDir, { recursive: true });

    const skillPath = path.join(skillsDir, 'SKILL.md');
    const content = `---
name: arbiter
description: How to safely run device and emulator commands (adb, android, sdb, simctl) in this workspace. This project uses Arbiter to broker exclusive hardware leases — device commands will fail without a valid lease token. Use this skill whenever interacting with physical devices, emulators, or device management CLIs.
---

# Arbiter Device Management Rules

This workspace uses **Arbiter**, a resource broker that manages exclusive leases for shared hardware devices and emulators. Device commands like \`adb\`, \`android\`, \`sdb\`, and \`simctl\` are intercepted by Arbiter shims — without a valid lease token they will fail. The rules below explain how to work with this system.

## 1. Never Bypass the Shim
Arbiter intercepts device commands via \`$PATH\` shims. Using absolute paths to SDK binaries (e.g., \`/usr/bin/adb\`, \`C:\\\\...\\\\adb.exe\`) bypasses Arbiter entirely and will cause conflicts with other agents. Always use the base command name (e.g., \`adb\`, \`android\`) so Arbiter can manage the lease.

## 2. Recognizing Lease Errors
If you run a device command without an active lease, Arbiter will intercept it and output an error like:
> \`[ARBITER SHIM] State: no ARBITER_LEASE_TOKEN is set for this session.\`
> \`[ARBITER SHIM] Next: request a lease before running...\`

## 3. Acquiring a Lease
Request an exclusive lease using the Arbiter CLI. The \`--wait\` flag will block until the resource is free rather than failing immediately:
\`\`\`bash
arbiter request <resource_name> --wait
# Example for Android: arbiter request adb --wait
# Example for Tizen:   arbiter request sdb --wait
\`\`\`

## 4. Providing the Token to Commands
The \`arbiter request\` command outputs your lease token. Because coding agents often spawn a new, isolated shell session for each command, **exporting the token once may not persist** to subsequent commands. The most reliable approach is to provide the token in the same line for *every* device command you run:

**Linux/macOS:**
\`\`\`bash
ARBITER_LEASE_TOKEN=eyJhbGci... adb logcat
# Or chain it:
export ARBITER_LEASE_TOKEN=eyJhbGci... && adb logcat
\`\`\`

**Windows (PowerShell):**
\`\`\`powershell
$env:ARBITER_LEASE_TOKEN="eyJhbGci..."; adb logcat
\`\`\`

**Windows (Command Prompt):**
\`\`\`cmd
set ARBITER_LEASE_TOKEN=eyJhbGci... && adb logcat
\`\`\`

## 5. Releasing the Lease
When you have completely finished all device interactions for the task, release the lease so other agents or developers can use the hardware:
\`\`\`bash
arbiter release
\`\`\`
`;

    fs.writeFileSync(skillPath, content, 'utf8');
    console.log(`[ARBITER] Successfully installed 'arbiter' skill at ${skillPath}`);
}
