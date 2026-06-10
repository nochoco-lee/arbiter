import * as fs from 'fs';
import * as path from 'path';

export function handleSkillsCommand(args: string[]) {
    if (args.length === 0) {
         console.error(`[ARBITER] Usage: arbiter skills install <name>`);
         process.exit(1);
    }

    if (args[0] === 'install') {
        const skillName = args[1] || 'arbiter';
        if (skillName === 'arbiter') {
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

## 3. Acquiring a Lease (Blocking — Default)
Request an exclusive lease using the Arbiter CLI. By default, \`arbiter request\` **blocks until the resource is granted** (FIFO queue) — no async handling is needed. The \`--wait\` flag additionally prints queue progress while waiting:
\`\`\`bash
arbiter request <resource_name> --wait
# Example for Android: arbiter request adb --wait
# Example for Tizen:   arbiter request sdb --wait
\`\`\`
The command will print your lease token once it is your turn. If other agents hold the resource, the command will simply wait — this is expected and correct behaviour.

## 4. Providing the Token to Commands
The \`arbiter request\` command outputs your lease token. Because coding agents often spawn a new, isolated shell session for each command, **exporting the token once may not persist** to subsequent commands. The most reliable approach is to provide the token in the same line for *every* device command you run:

**Linux/macOS:**
\`\`\`bash
ARBITER_LEASE_TOKEN=<token> adb logcat
# Or export first:
export ARBITER_LEASE_TOKEN=<token> && adb logcat
\`\`\`

**Windows (PowerShell):**
\`\`\`powershell
$env:ARBITER_LEASE_TOKEN="<token>"; adb logcat
\`\`\`

**Windows (Command Prompt):**
\`\`\`cmd
set ARBITER_LEASE_TOKEN=<token> && adb logcat
\`\`\`

## 5. Releasing the Lease
When you have completely finished all device interactions for the task, release the lease so other agents or developers can use the hardware:
\`\`\`bash
arbiter release
\`\`\`

---

## Advanced: Async Ticket Mode (broker opt-in only)

> **Note:** This section only applies if the broker has been explicitly configured with \`async_ticket_threshold_seconds\` in \`arbiter.yaml\`. In the default (blocking-only) configuration, \`arbiter request\` will never return a ticket — it blocks until the lease is granted.

If \`arbiter request\` returns a **ticket ID** (the response will say "Async Reservation Created" with a \`q_...\` ID), your broker has async mode enabled. This means your place in the queue is reserved, but the resource is not yet free:

1. **Continue non-device work** while the ticket is pending.
2. **Claim the ticket** when the resource is likely ready:
\`\`\`bash
arbiter request --ticket <ticket_id> --wait
\`\`\`
3. Once claimed, export the lease token and proceed with device commands as normal.

If you receive a ticket unexpectedly and are unsure how to proceed, you can always fall back to a straightforward blocking request — it will always work regardless of broker configuration:
\`\`\`bash
arbiter request <resource_name> --wait
\`\`\`

## Advanced: One-time Shared Access (Permits)

> **Warning:** The permit system is **experimental** and not guaranteed to work reliably in all environments. It is intended for advanced multi-agent coordination scenarios.

If you only need to run a single, short-lived device command while another agent holds the lease, you can request a **permit** instead of a full lease. This requires the current lease owner's approval.

**Request a permit:**
\`\`\`bash
arbiter permit request --resource <name> --commands "<exact_command>"
\`\`\`
If granted, the command will execute automatically using a one-time permit token.

**Resolve pending permits (as a lease owner):**
If you are the lease owner and see permit requests from other agents, you can unblock them by resolving the requests:
\`\`\`bash
arbiter permit resolve <id> grant
arbiter permit resolve <id> deny
\`\`\`
If permits are pending, your own subsequent device commands may block until you resolve them.
\`;

    fs.writeFileSync(skillPath, content, 'utf8');
    console.log(`[ARBITER] Successfully installed 'arbiter' skill at ${skillPath}`);
}
