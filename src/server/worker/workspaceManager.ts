// ─── Workspace Manager ──────────────────────────────────────
// Cross-platform filesystem service for worker workspaces.
// Each task gets an isolated folder under `workspaces/<taskId>/`.

import fs from 'node:fs';
import path from 'node:path';

export type WorkspaceType = 'research' | 'webapp' | 'creative' | 'data' | 'general';

const WORKSPACES_ROOT = path.join(process.cwd(), 'workspaces');

export function getDefaultWorkspacesRoot(): string {
  return WORKSPACES_ROOT;
}

export interface WorkspaceFile {
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
}

export interface WorkspacePathOptions {
  rootDir?: string | null;
  workspacePath?: string | null;
}

// ─── Scaffold Templates ─────────────────────────────────────

const SCAFFOLD: Record<WorkspaceType, string[]> = {
  research: ['sources', 'notes', 'output', 'logs'],
  webapp: ['output', 'logs'],
  creative: ['assets', 'output', 'logs'],
  data: ['input', 'output', 'logs'],
  general: ['output', 'logs'],
};

// ─── Manager Implementation ─────────────────────────────────

export class WorkspaceManagerImpl {
  private resolveWorkspacePath(taskId: string, options?: WorkspacePathOptions): string {
    const explicitPath = options?.workspacePath?.trim();
    if (explicitPath) {
      return path.resolve(explicitPath);
    }

    const configuredRoot = options?.rootDir?.trim();
    const rootDir = configuredRoot ? path.resolve(configuredRoot) : WORKSPACES_ROOT;
    return path.join(rootDir, taskId);
  }

  /**
   * Creates a new workspace folder with type-specific scaffold.
   * Returns the absolute workspace path.
   */
  createWorkspace(
    taskId: string,
    type: WorkspaceType = 'general',
    options?: WorkspacePathOptions,
  ): string {
    const wsPath = this.getWorkspacePath(taskId, options);
    fs.mkdirSync(wsPath, { recursive: true });

    // Create scaffold directories
    const dirs = SCAFFOLD[type] || SCAFFOLD.general;
    for (const dir of dirs) {
      fs.mkdirSync(path.join(wsPath, dir), { recursive: true });
    }

    // Write workspace metadata
    const metadata = {
      taskId,
      type,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    fs.writeFileSync(
      path.join(wsPath, '.workspace.json'),
      JSON.stringify(metadata, null, 2),
      'utf-8',
    );

    return wsPath;
  }

  /**
   * Returns the absolute path for a workspace. Cross-platform via path.join.
   */
  getWorkspacePath(taskId: string, options?: WorkspacePathOptions): string {
    return this.resolveWorkspacePath(taskId, options);
  }

  /**
   * Checks if a workspace folder exists.
   */
  exists(taskId: string, options?: WorkspacePathOptions): boolean {
    return fs.existsSync(this.getWorkspacePath(taskId, options));
  }

  /**
   * Write a text or binary file into the workspace.
   * Parent directories are created automatically.
   */
  writeFile(
    taskId: string,
    relativePath: string,
    content: string | Buffer,
    options?: WorkspacePathOptions,
  ): void {
    const fullPath = path.join(this.getWorkspacePath(taskId, options), relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fullPath, content);
    } else {
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
  }

  /**
   * Read a file from the workspace. Returns null if not found.
   */
  readFile(taskId: string, relativePath: string, options?: WorkspacePathOptions): Buffer | null {
    const fullPath = path.join(this.getWorkspacePath(taskId, options), relativePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath);
  }

  /**
   * Read a text file as string. Returns null if not found.
   */
  readTextFile(taskId: string, relativePath: string, options?: WorkspacePathOptions): string | null {
    const buf = this.readFile(taskId, relativePath, options);
    return buf ? buf.toString('utf-8') : null;
  }

  /**
   * List all files and directories in a workspace (recursive).
   */
  listFiles(taskId: string, subPath = '', options?: WorkspacePathOptions): WorkspaceFile[] {
    const wsPath = this.getWorkspacePath(taskId, options);
    const targetDir = subPath ? path.join(wsPath, subPath) : wsPath;

    if (!fs.existsSync(targetDir)) return [];

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const result: WorkspaceFile[] = [];

    for (const entry of entries) {
      const relPath = subPath ? path.join(subPath, entry.name) : entry.name;
      const fullPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          relativePath: relPath,
          size: 0,
          modifiedAt: fs.statSync(fullPath).mtime.toISOString(),
          isDirectory: true,
        });
        // Recurse into subdirectories
        result.push(...this.listFiles(taskId, relPath, options));
      } else {
        const stat = fs.statSync(fullPath);
        result.push({
          name: entry.name,
          relativePath: relPath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isDirectory: false,
        });
      }
    }

    return result;
  }

  /**
   * Delete an entire workspace folder.
   */
  deleteWorkspace(taskId: string, options?: WorkspacePathOptions): void {
    const wsPath = this.getWorkspacePath(taskId, options);
    this.deleteWorkspaceAtPath(wsPath);
  }

  deleteWorkspaceAtPath(workspacePath: string): void {
    const wsPath = path.resolve(workspacePath);
    if (fs.existsSync(wsPath)) {
      fs.rmSync(wsPath, { recursive: true, force: true });
    }
  }

  /**
   * Calculate total size of a workspace in bytes.
   */
  getWorkspaceSize(taskId: string, options?: WorkspacePathOptions): number {
    const files = this.listFiles(taskId, '', options);
    return files.reduce((total, f) => total + f.size, 0);
  }
}

// ─── Singleton ───────────────────────────────────────────────

let instance: WorkspaceManagerImpl | null = null;

export function getWorkspaceManager(): WorkspaceManagerImpl {
  if (!instance) {
    instance = new WorkspaceManagerImpl();
  }
  return instance;
}
