import { Adapter, AdapterConfig } from './types';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';

export class WindowsAdapter implements Adapter {
    private config!: AdapterConfig;

    async connect(config: AdapterConfig): Promise<void> { this.config = config; }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        // e.g. run a powershell command
        const res = spawnSync('powershell.exe', [...args], { encoding: 'utf-8' });
        return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? 1 };
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {}

    async screenshot(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_win_${ts}.png`);
        
        // Simple Windows screenshot via powershell snippet
        const psScreenshot = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height; $graphic = [System.Drawing.Graphics]::FromImage($bitmap); $graphic.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); $bitmap.Save('${localPath}', [System.Drawing.Imaging.ImageFormat]::Png);`;
        await this.execute(['-Command', psScreenshot]);
        
        return localPath;
    }

    async captureLogs(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_win_eventlog_${ts}.txt`);
        await this.execute(['-Command', `Get-EventLog -LogName Application -Newest 50 | Out-File -FilePath '${localPath}'`]);
        return localPath;
    }

    async disconnect(): Promise<void> {}
}
