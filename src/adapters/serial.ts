import { Adapter, AdapterConfig } from './types';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface SerialAdapterConfig extends AdapterConfig {
    port?: string;
    baud?: number;
}

export class SerialAdapter implements Adapter {
    private config!: SerialAdapterConfig;
    private port!: any;
    private logBuffer: string = "";

    async connect(config: SerialAdapterConfig): Promise<void> {
        this.config = config;
        if (!config.port) throw new Error("Serial config missing 'port'");

        let SerialPortClass;
        try {
            SerialPortClass = require('serialport').SerialPort;
        } catch (e) {
            throw new Error("The 'serialport' package is required to use the SerialAdapter. Run 'npm install serialport' to use this feature.");
        }

        this.port = new SerialPortClass({ path: config.port, baudRate: config.baud || 115200 });

        this.port.on('data', (data: any) => {
            this.logBuffer += data.toString();
        });
    }

    async execute(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number; }> {
        const command = args.join(' ');
        return new Promise((resolve, reject) => {
            if (!this.port) return reject(new Error("SerialPort not connected"));
            this.port.write(command + '\r\n', (err: any) => {
                if (err) return reject(err);
                resolve({ stdout: "Command written to serial port", stderr: "", exitCode: 0 });
            });
        });
    }

    async stream(args: string[], onData: (data: string) => void): Promise<void> {
        const command = args.join(' ');
        if (!this.port) throw new Error("SerialPort not connected");
        this.port.on('data', (d: any) => onData(d.toString()));
        this.port.write(command + '\r\n');
    }

    async screenshot(): Promise<string> {
        return ""; 
    }

    async captureLogs(): Promise<string> {
        const ts = new Date().getTime();
        const localPath = path.join(os.tmpdir(), `arbiter_${this.config.resourceId}_serial_${ts}.txt`);
        fs.writeFileSync(localPath, this.logBuffer);
        return localPath;
    }

    async disconnect(): Promise<void> {
        if (this.port && this.port.isOpen) {
            this.port.close();
        }
    }
}
