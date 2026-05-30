#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--echo')) {
    const textIdx = args.indexOf('--echo') + 1;
    const text = args[textIdx] || '';
    process.stdout.write(text + '\n');
    process.exit(0);
}

if (args.includes('--crash')) {
    process.stderr.write('Mock stream encountered a fatal error.\n');
    process.exit(1);
}

if (args.includes('--logcat')) {
    let count = 0;
    const iv = setInterval(() => {
        count++;
        process.stdout.write(`Log line ${count}\n`);
    }, 500); // Faster interval for tests (every 500ms)

    process.on('SIGINT', () => {
        clearInterval(iv);
        process.stdout.write('Logcat interrupted cleanly.\n');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        clearInterval(iv);
        process.stdout.write('Logcat terminated.\n');
        process.exit(0);
    });
}

if (args.includes('--interactive')) {
    process.stdout.write('Interactive mode started.\n');
    process.stdin.on('data', (d: Buffer) => {
        process.stdout.write(`ECHO: ${d.toString()}`);
    });
    process.stdin.on('end', () => {
        process.stdout.write('Interactive mode ended.\n');
        process.exit(0);
    });
}
