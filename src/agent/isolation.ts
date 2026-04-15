import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellOpts } from '../shared/platform.js';

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
    await execFile('git', ['worktree', 'add', worktreePath, '-d'], shellOpts({ cwd: baseDir }));
    this.worktreePaths.set(taskId, worktreePath);
    return worktreePath;
  }

  async cleanup(taskId: string): Promise<void> {
    const worktreePath = this.worktreePaths.get(taskId);
    if (!worktreePath) return;
    await execFile('git', ['worktree', 'remove', '--force', worktreePath], shellOpts());
    this.worktreePaths.delete(taskId);
  }

  /**
   * pruneOrphans — removes stale worktrees under <baseDir>/.worktrees/ that
   * were left behind by SIGKILL or other unclean shutdowns.
   * Errors on individual removals are swallowed so the agent can still start.
   */
  static async pruneOrphans(baseDir: string): Promise<void> {
    const worktreesDir = join(baseDir, '.worktrees');
    let stdout: string;
    try {
      ({ stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], shellOpts({ cwd: baseDir })));
    } catch {
      // Not a git repo or git not available — nothing to prune
      return;
    }

    const stale: string[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.match(/^worktree (.+)$/);
      if (match) {
        const worktreePath = match[1].trim();
        if (worktreePath.startsWith(worktreesDir + '/') || worktreePath.startsWith(worktreesDir + '\\')) {
          stale.push(worktreePath);
        }
      }
    }

    for (const worktreePath of stale) {
      try {
        await execFile('git', ['worktree', 'remove', '--force', worktreePath], shellOpts({ cwd: baseDir }));
        const { logger } = await import('../shared/logger.js');
        logger.info({ worktreePath }, 'Pruned orphan worktree');
      } catch {
        // Swallow individual removal errors
      }
    }
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
    await cp(baseDir, tempDir, { recursive: true });
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
