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
    max_duration_seconds?: number;
}

export interface ArbiterConfig {
    port?: string | number;
    resources: Record<string, ResourceConfig>;
}

export class ConfigManager {
    static loadConfig(configPath: string): ArbiterConfig {
        const absolutePath = path.resolve(configPath);
        if (!fs.existsSync(absolutePath)) {
            console.warn(`[ARBITER] Warning: Configuration file not found at ${absolutePath}. Using safe defaults.`);
            return { resources: {} };
        }
        
        try {
            const fileContents = fs.readFileSync(absolutePath, 'utf8');
            const data = yaml.load(fileContents) as Partial<ArbiterConfig>;
            
            if (!data || !data.resources) {
                console.warn(`[ARBITER] Warning: Invalid Configuration at ${absolutePath}. Missing 'resources' object. Using safe defaults.`);
                return { resources: {} };
            }
            
            return data as ArbiterConfig;
        } catch (e) {
            console.warn(`[ARBITER] Warning: Failed to parse ${absolutePath}: ${e}. Using safe defaults.`);
            return { resources: {} };
        }
    }
}
