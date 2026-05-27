import * as fs from 'fs';
import * as path from 'path';
import { ArbiterContext } from '../api/types';

export class ContextManager {
    static getContextFilePath(resource: string): string {
        // Can be customized via env variable, defaults to current working directory
        const baseDir = process.env.ARBITER_CONTEXT_DIR || process.cwd();
        return path.join(baseDir, `.arbiter_context_${resource}.json`);
    }

    static loadLastContext(resource: string): ArbiterContext | null {
        const p = this.getContextFilePath(resource);
        if (fs.existsSync(p)) {
            try {
                const data = fs.readFileSync(p, 'utf-8');
                return JSON.parse(data) as ArbiterContext;
            } catch (e) {
                console.error(`Failed to parse context file for ${resource}`, e);
            }
        }
        return null;
    }

    static getContextDir(): string {
        return process.env.ARBITER_CONTEXT_DIR || process.cwd();
    }

    static saveContext(context: ArbiterContext): void {
        const baseDir = this.getContextDir();
        const artifactDir = path.join(baseDir, 'artifacts', context.resource);
        if (!fs.existsSync(artifactDir)) {
            fs.mkdirSync(artifactDir, { recursive: true });
        }

        // Move artifacts to persistent storage
        context.artifacts = context.artifacts.map(artPath => {
            if (!artPath || !fs.existsSync(artPath)) return artPath;
            
            const fileName = path.basename(artPath);
            const persistentPath = path.join(artifactDir, fileName);
            
            // Only move if not already in the persistent path
            if (path.resolve(artPath) !== path.resolve(persistentPath)) {
                try {
                    fs.copyFileSync(artPath, persistentPath);
                    fs.unlinkSync(artPath);
                    return persistentPath;
                } catch (e) {
                    console.error(`Failed to persist artifact ${artPath}`, e);
                    return artPath;
                }
            }
            return artPath;
        });

        const p = this.getContextFilePath(context.resource);
        fs.writeFileSync(p, JSON.stringify(context, null, 2), 'utf-8');
    }
}
