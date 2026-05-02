import * as blessed from 'blessed';
import * as http from 'http';

function fetchStatus(): Promise<any> {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:38401/status', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        }).on('error', reject);
    });
}

export function startTui() {
    const screen = blessed.screen({
        smartCSR: true,
        title: 'ARBITER TUI'
    });

    const box = blessed.box({
        top: 'center',
        left: 'center',
        width: '80%',
        height: '80%',
        content: 'Loading Arbiter State...',
        tags: true,
        border: { type: 'line' },
        style: {
            fg: 'white',
            bg: 'blue',
            border: { fg: '#f0f0f0' }
        }
    });

    screen.append(box);

    screen.key(['escape', 'q', 'C-c'], (ch, key) => process.exit(0));

    setInterval(async () => {
        try {
            const statusData = await fetchStatus();
            if (statusData) {
                let content = `{bold}Active ARBITER Daemon Status{/bold}\n\n`;
                const resources = statusData.resources || {};
                
                if (Object.keys(resources).length === 0) {
                    content += "No resources currently registered / active in broker queue.\n";
                }

                for (const [resName, info] of Object.entries(resources) as [string, any][]) {
                    let stateStr = info.state === 'DRAINING' ? `{yellow-fg}DRAINING{/yellow-fg}` : info.state;
                    if (info.drainingActivePermitCount > 0) stateStr += ` (${info.drainingActivePermitCount} active)`;
                    
                    content += `[Resource] {cyan-fg}${resName}{/cyan-fg}: ${stateStr}\n`;
                    content += `   Queue: ${info.queueDepth} (Next: ${info.headType || 'None'})\n`;
                }

                content += `\n{bold}Queue Engine{/bold}: Online`;
                
                box.setContent(content);
            } else {
                box.setContent(`{red-fg}Daemon parsing failed.{/red-fg}`);
            }
            screen.render();
        } catch (e) {
            box.setContent(`{red-fg}Could not connect to ARBITER daemon on 127.0.0.1:38401{/red-fg}\n\nEnsure the broker is running in the background (e.g., 'node src/broker/server.js').`);
            screen.render();
        }
    }, 1000);
}

if (require.main === module) {
    startTui();
}
