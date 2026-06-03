import fs from 'fs';
import { resolveSafePath } from '../middleware/sanitize';

/**
 * Service for workspace filesystem operations and path validation.
 * Manages directories under WORKSPACE_BASE_DIR.
 */
import path from 'path';

export class WorkspaceService {
    private readonly baseDir: string;
    private readonly isFile: boolean;
    private codeWorkspaceFolders: Map<string, string> = new Map();

    constructor(baseDir: string) {
        this.baseDir = baseDir;
        this.isFile = fs.existsSync(baseDir) && fs.statSync(baseDir).isFile();
        
        if (this.isFile && this.baseDir.endsWith('.code-workspace')) {
            try {
                const content = fs.readFileSync(this.baseDir, 'utf-8');
                const safeJson = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
                const data = JSON.parse(safeJson);
                if (data.folders && Array.isArray(data.folders)) {
                    const workspaceDir = path.dirname(this.baseDir);
                    for (const f of data.folders) {
                        if (f.path) {
                            const name = path.basename(f.path);
                            const fullPath = path.isAbsolute(f.path) ? f.path : resolveSafePath(f.path, workspaceDir);
                            this.codeWorkspaceFolders.set(name, fullPath);
                        }
                    }
                }
            } catch (e) {
                // Ignore or log parse error
            }
        }
    }

    /**
     * Ensure the base directory exists, creating it if necessary
     */
    public ensureBaseDir(): void {
        if (this.isFile) return;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    /**
     * Return a list of subdirectories in the base directory
     */
    public scanWorkspaces(): string[] {
        if (this.isFile) {
            if (this.codeWorkspaceFolders.size > 0) {
                return Array.from(this.codeWorkspaceFolders.keys()).sort();
            }
            return [path.basename(this.baseDir)];
        }
        
        this.ensureBaseDir();

        const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort();
    }

    /**
     * Validate a relative path and return a safe absolute path
     * @throws On path traversal detection
     */
    public validatePath(relativePath: string): string {
        if (this.isFile && this.codeWorkspaceFolders.has(relativePath)) {
            return this.codeWorkspaceFolders.get(relativePath)!;
        }
        if (this.isFile) return this.baseDir;
        return resolveSafePath(relativePath, this.baseDir);
    }

    /**
     * Get the base directory path
     */
    public getBaseDir(): string {
        return this.isFile ? path.dirname(this.baseDir) : this.baseDir;
    }

    /**
     * Return the absolute path of the specified workspace
     */
    public getWorkspacePath(workspaceName: string): string {
        return this.validatePath(workspaceName);
    }

    /**
     * Check if the specified workspace exists
     */
    public exists(workspaceName: string): boolean {
        if (this.isFile && this.codeWorkspaceFolders.has(workspaceName)) {
            return true;
        }
        if (this.isFile) return true;
        const fullPath = this.validatePath(workspaceName);
        return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
    }
}
