export interface AdapterConfig {
    resourceId: string;
    serial?: string;
    udid?: string;
    realBinaryPath?: string;
}

export interface Adapter {
    /** Establish connection to resource, verify ready */
    connect(config: AdapterConfig): Promise<void>;
    
    /** Run a command, return stdout/stderr */
    execute(args: string[]): Promise<{ stdout: string, stderr: string, exitCode: number }>;
    
    /** Run a command with streaming output */
    stream(args: string[], onData: (data: string) => void): Promise<void>;
    
    /** Capture current screen state as artifact, returns filepath */
    screenshot(): Promise<string>;

    /** Capture logs as artifact, returns filepath */
    captureLogs(): Promise<string>;
    
    /** Clean up, release any held resources */
    disconnect(): Promise<void>;
}
