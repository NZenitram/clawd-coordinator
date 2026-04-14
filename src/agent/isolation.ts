import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFile = promisify(execFileCb);

export interface IsolationStrategy {
  setup(taskId: string, baseDir: string): Promise<string>;
  cleanup(taskId: string): Promise<void>;
}

/**
 * NoneStrategy — passes the baseDir through unchanged.
 * Suitable for sequential workloads where tasks don't clobber each other.
 */
export class NoneStrategy implements IsolationStrategy {
  async setup(_taskId: string, baseDir: string): Promise<string> {
    return baseDir;
  }

  async cleanup(_taskId: string): Promise<void> {
    // no-op
  }
}

/**
 * WorktreeStrategy — creates an isolated git worktree per task.
 * Requires the baseDir to be inside a git repository.
 * Uses a detached HEAD so no branch name collision occurs.
 */
export class WorktreeStrategy implements IsolationStrategy {
  private worktreePaths = new Map<string, string>();

  async setup(taskId: string, baseDir: string): Promise<string> {
    const worktreePath = join(baseDir, '.worktrees', taskId);
    await execFile('git', ['worktree', 'add', worktreePath, '-d'], { cwd: baseDir });
    this.worktreePaths.set(taskId, worktreePath);
    return worktreePath;
  }

  async cleanup(taskId: string): Promise<void> {
    const worktreePath = this.worktreePaths.get(taskId);
    if (!worktreePath) return;
    await execFile('git', ['worktree', 'remove', '--force', worktreePath], {});
    this.worktreePaths.delete(taskId);
  }
}

/**
 * TempDirStrategy — copies baseDir into a fresh temp directory per task.
 * Self-contained; works in any directory regardless of VCS status.
 */
export class TempDirStrategy implements IsolationStrategy {
  private tempPaths = new Map<string, string>();

  async setup(taskId: string, baseDir: string): Promise<string> {
    const prefix = join(tmpdir(), `coord-task-`);
    const tempDir = await mkdtemp(prefix);
    await execFile('cp', ['-r', baseDir + '/.', tempDir]);
    this.tempPaths.set(taskId, tempDir);
    return tempDir;
  }

  async cleanup(taskId: string): Promise<void> {
    const tempDir = this.tempPaths.get(taskId);
    if (!tempDir) return;
    await rm(tempDir, { recursive: true, force: true });
    this.tempPaths.delete(taskId);
  }
}

export type IsolationMode = 'none' | 'worktree' | 'tmpdir';

export function createIsolationStrategy(mode: IsolationMode): IsolationStrategy {
  switch (mode) {
    case 'none':
      return new NoneStrategy();
    case 'worktree':
      return new WorktreeStrategy();
    case 'tmpdir':
      return new TempDirStrategy();
  }
}
