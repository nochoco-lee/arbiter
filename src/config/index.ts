import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

export interface ResourceConfig {
    type: string;
    adapter: string;
    serial?: string;
    udid?: string;
    config?: string;
    port?: string;
    baud?: number;
    max_duration_seconds?: number; // Backward-compatible alias for max_lease_seconds
    max_lease_seconds?: number;
    default_lease_seconds?: number;
    heartbeat_timeout_seconds?: number;
    // How long (seconds) before an unresolved pending permit is auto-denied.
    // Default: 30. Set to 0 to disable auto-deny (manual resolve only).
    permit_auto_deny_seconds?: number;
}

export interface ArbiterConfig {
    port?: string | number;
    default_lease_seconds?: number;
    max_lease_seconds?: number;
    global_ceiling_seconds?: number;
    heartbeat_timeout_seconds?: number;
    // Seconds a blocking request must wait before being auto-promoted to an async ticket.
    // Omit or set to 0 (default) to keep blocking-only mode — no async tickets are ever issued.
    // Equivalent to the ARBITER_TICKET_THRESHOLD_WAIT env var, but explicit and version-controlled.
    async_ticket_threshold_seconds?: number;
    resources: Record<string, ResourceConfig>;
}

export class ConfigManager {
    static loadConfig(configPath: string): ArbiterConfig {
        const absolutePath = path.resolve(configPath);
        if (!fs.existsSync(absolutePath)) {
            return { resources: {} };
        }
        
        try {
            const fileContents = fs.readFileSync(absolutePath, 'utf8');
            const data = yaml.load(fileContents) as ArbiterConfig;
            
            if (!data) return { resources: {} };
            if (!data.resources) data.resources = {};

            // Backward compatibility and normalization
            for (const res of Object.keys(data.resources)) {
                const config = data.resources[res];
                // max_duration_seconds is an alias for max_lease_seconds
                if (config.max_duration_seconds && !config.max_lease_seconds) {
                    config.max_lease_seconds = config.max_duration_seconds;
                }
            }
            
            return data;
        } catch (e) {
            console.warn(`[ARBITER] Warning: Failed to parse ${absolutePath}: ${e}. Using safe defaults.`);
            return { resources: {} };
        }
    }
}
