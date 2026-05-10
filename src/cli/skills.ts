import * as fs from 'fs';
import * as path from 'path';

export function handleSkillsCommand(args: string[]) {
    if (args.length === 0) {
         console.error(`[ARBITER] Usage: arbiter skills install <name>`);
         process.exit(1);
    }

    if (args[0] === 'install') {
        const skillName = args[1];
        if (skillName === 'adb') {
            installAdbSkill();
        } else {
            console.error(`[ARBITER] Unknown skill: ${skillName}. Only 'adb' is supported currently.`);
            process.exit(1);
        }
    } else {
         console.error(`[ARBITER] Unknown subcommand: ${args[0]}. Usage: arbiter skills install <name>`);
         process.exit(1);
    }
}

function installAdbSkill() {
    const cwd = process.cwd();
    const skillsDir = path.join(cwd, '.agents', 'skills', 'arbiter-adb');
    fs.mkdirSync(skillsDir, { recursive: true });

    const skillPath = path.join(skillsDir, 'SKILL.md');
    const content = `---
name: arbiter-adb
description: This skill must be used when doing anything with adb or managing android devices / emulators. If android-cli is present, it should be used instead.
---

# Arbiter ADB Guidelines

This project uses Arbiter to manage shared test bridges and hardware resources safely. 
When interacting with Android devices or emulators, you MUST follow these rules:

1. **Do not use absolute paths to adb**: Avoid using the raw \`adb\` binary from the Android SDK path directly. Always rely on the \`adb\` available in your system \`PATH\`, as it may be shimmed by Arbiter to prevent resource conflicts.
2. **Handle Lease Errors**: If your \`adb\` command fails due to a missing or expired Arbiter lease, you must acquire one first. Use \`arbiter request adb --wait\` to acquire an exclusive lease.
3. **Prefer android-cli**: If \`android-cli\` is present and available in this project's skills, you should prioritize using it over direct \`adb\` commands, as it handles Arbiter leases automatically.
`;

    fs.writeFileSync(skillPath, content, 'utf8');
    console.log(`[ARBITER] Successfully installed 'adb' skill at ${skillPath}`);
}
