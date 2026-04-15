import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

// execFile can be called with or without an options object:
//   execFile(cmd, args, cb)          — 3 args (no options)
//   execFile(cmd, args, opts, cb)    — 4 args (with options)
// The mock handles both signatures so promisify works correctly.

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: any[]) => {
    const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    if (cb) cb(null, { stdout: '', stderr: '' });
  }),
}));

// Import after mock is registered
const { NoneStrategy, WorktreeStrategy, TempDirStrategy, createIsolationStrategy } =
  await import('../../src/agent/isolation.js');
const { execFile } = await import('node:child_process');

// ─────────────────────────────────────────────────────────────────────────────
// NoneStrategy
// ─────────────────────────────────────────────────────────────────────────────

describe('NoneStrategy', () => {
  const strategy = new NoneStrategy();

  it('setup returns baseDir unchanged', async () => {
    const dir = '/some/base/dir';
    const result = await strategy.setup('task-1', dir);
    expect(result).toBe(dir);
  });

  it('cleanup is a no-op and does not throw', async () => {
    await expect(strategy.cleanup('task-1')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WorktreeStrategy
// ─────────────────────────────────────────────────────────────────────────────

describe('WorktreeStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: succeed for any execFile call (handles both 3-arg and 4-arg forms)
    (execFile as any).mockImplementation((...args: any[]) => {
      const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(null, { stdout: '', stderr: '' });
    });
  });

  it('setup calls git worktree add with correct path and returns the worktree path', async () => {
    const strategy = new WorktreeStrategy();
    const baseDir = '/repo';
    const taskId = 'abc-123';

    const result = await strategy.setup(taskId, baseDir);

    expect(result).toBe('/repo/.worktrees/abc-123');
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '/repo/.worktrees/abc-123', '-d'],
      { cwd: baseDir },
      expect.any(Function),
    );
  });

  it('cleanup calls git worktree remove with --force', async () => {
    const strategy = new WorktreeStrategy();
    const baseDir = '/repo';
    const taskId = 'abc-456';

    await strategy.setup(taskId, baseDir);
    vi.clearAllMocks();
    (execFile as any).mockImplementation((...args: any[]) => {
      const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(null, { stdout: '', stderr: '' });
    });

    await strategy.cleanup(taskId);

    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/repo/.worktrees/abc-456'],
      {},
      expect.any(Function),
    );
  });

  it('cleanup is a no-op when taskId was never set up', async () => {
    const strategy = new WorktreeStrategy();
    await strategy.cleanup('never-setup');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('setup rejects when git worktree add fails', async () => {
    (execFile as any).mockImplementationOnce((...args: any[]) => {
      const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error('not a git repository'));
    });

    const strategy = new WorktreeStrategy();
    await expect(strategy.setup('task-x', '/not-a-repo')).rejects.toThrow('not a git repository');
  });

  it('cleanup rejects when git worktree remove fails', async () => {
    const strategy = new WorktreeStrategy();
    await strategy.setup('task-y', '/repo');
    vi.clearAllMocks();

    (execFile as any).mockImplementationOnce((...args: any[]) => {
      const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error('worktree not found'));
    });

    await expect(strategy.cleanup('task-y')).rejects.toThrow('worktree not found');
  });

  it('setup can handle multiple tasks concurrently and tracks each path', async () => {
    const strategy = new WorktreeStrategy();
    const [r1, r2] = await Promise.all([
      strategy.setup('t1', '/repo'),
      strategy.setup('t2', '/repo'),
    ]);
    expect(r1).toBe('/repo/.worktrees/t1');
    expect(r2).toBe('/repo/.worktrees/t2');
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TempDirStrategy
// ─────────────────────────────────────────────────────────────────────────────

describe('TempDirStrategy', () => {
  let baseDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Use a real temp directory as baseDir, create a sample file inside it
    baseDir = await mkdtemp(join(tmpdir(), 'coord-test-base-'));
    await writeFile(join(baseDir, 'sample.txt'), 'hello');

    // For TempDirStrategy, execFile is used for `cp -r`:
    //   execFile('cp', ['-r', src, dest], cb)   — 3-arg form (no opts)
    // Simulate cp by writing a marker file into the destination directory.
    (execFile as any).mockImplementation((...callArgs: any[]) => {
      const cb: Function = typeof callArgs[callArgs.length - 1] === 'function'
        ? callArgs[callArgs.length - 1]
        : null;
      // callArgs[1] is the args array: ['-r', src, dest]
      const fileArgs: string[] = callArgs[1];
      const dest = fileArgs[2];
      writeFile(join(dest, 'sample.txt'), 'hello')
        .then(() => { if (cb) cb(null, { stdout: '', stderr: '' }); })
        .catch((err) => { if (cb) cb(err); });
    });
  });

  it('setup creates a temp directory distinct from baseDir', async () => {
    const strategy = new TempDirStrategy();
    const result = await strategy.setup('task-tmp-1', baseDir);

    expect(result).not.toBe(baseDir);
    expect(result).toMatch(/coord-task-/);
    expect(existsSync(result)).toBe(true);

    // Cleanup after ourselves
    await strategy.cleanup('task-tmp-1');
  });

  it('setup calls cp -r with correct src and dest', async () => {
    const strategy = new TempDirStrategy();
    const result = await strategy.setup('task-tmp-2', baseDir);

    expect(execFile).toHaveBeenCalledWith(
      'cp',
      ['-r', baseDir + '/.', result],
      expect.any(Function),
    );

    await strategy.cleanup('task-tmp-2');
  });

  it('cleanup removes the temp directory', async () => {
    const strategy = new TempDirStrategy();
    const result = await strategy.setup('task-tmp-3', baseDir);
    expect(existsSync(result)).toBe(true);

    await strategy.cleanup('task-tmp-3');
    expect(existsSync(result)).toBe(false);
  });

  it('cleanup is a no-op when taskId was never set up', async () => {
    const strategy = new TempDirStrategy();
    await expect(strategy.cleanup('never-setup')).resolves.toBeUndefined();
  });

  it('setup isolates two concurrent tasks in different directories', async () => {
    const strategy = new TempDirStrategy();
    const [r1, r2] = await Promise.all([
      strategy.setup('task-a', baseDir),
      strategy.setup('task-b', baseDir),
    ]);

    expect(r1).not.toBe(r2);
    await strategy.cleanup('task-a');
    await strategy.cleanup('task-b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WorktreeStrategy.pruneOrphans
// ─────────────────────────────────────────────────────────────────────────────

describe('WorktreeStrategy.pruneOrphans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (execFile as any).mockImplementation((...args: any[]) => {
      const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(null, { stdout: '', stderr: '' });
    });
  });

  it('does nothing when git worktree list returns no .worktrees paths', async () => {
    // porcelain output with no worktrees under baseDir/.worktrees/
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    (execFile as any).mockImplementationOnce((...args: any[]) => {
      const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(null, { stdout: porcelain, stderr: '' });
    });

    await WorktreeStrategy.pruneOrphans('/repo');

    // Only the list call — no remove calls
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: '/repo' },
      expect.any(Function),
    );
  });

  it('removes stale worktrees found under .worktrees/', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/task-orphan-1',
      'HEAD def456',
      'detached',
      '',
      'worktree /repo/.worktrees/task-orphan-2',
      'HEAD ghi789',
      'detached',
      '',
    ].join('\n');

    // First call = git worktree list; subsequent = git worktree remove
    (execFile as any)
      .mockImplementationOnce((...args: any[]) => {
        const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (cb) cb(null, { stdout: porcelain, stderr: '' });
      })
      .mockImplementation((...args: any[]) => {
        const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (cb) cb(null, { stdout: '', stderr: '' });
      });

    await WorktreeStrategy.pruneOrphans('/repo');

    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/repo/.worktrees/task-orphan-1'],
      { cwd: '/repo' },
      expect.any(Function),
    );
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/repo/.worktrees/task-orphan-2'],
      { cwd: '/repo' },
      expect.any(Function),
    );
  });

  it('swallows errors on individual worktree removal failures', async () => {
    const porcelain = [
      'worktree /repo/.worktrees/task-bad',
      'HEAD abc123',
      'detached',
      '',
    ].join('\n');

    (execFile as any)
      .mockImplementationOnce((...args: any[]) => {
        const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (cb) cb(null, { stdout: porcelain, stderr: '' });
      })
      .mockImplementationOnce((...args: any[]) => {
        const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (cb) cb(new Error('worktree locked'));
      });

    // Must resolve without throwing
    await expect(WorktreeStrategy.pruneOrphans('/repo')).resolves.toBeUndefined();
  });

  it('returns early when git worktree list fails (not a git repo)', async () => {
    (execFile as any).mockImplementationOnce((...args: any[]) => {
      const cb: Function = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (cb) cb(new Error('not a git repository'));
    });

    await expect(WorktreeStrategy.pruneOrphans('/not-a-repo')).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createIsolationStrategy factory
// ─────────────────────────────────────────────────────────────────────────────

describe('createIsolationStrategy', () => {
  it('returns NoneStrategy for "none"', () => {
    const s = createIsolationStrategy('none');
    expect(s).toBeInstanceOf(NoneStrategy);
  });

  it('returns WorktreeStrategy for "worktree"', () => {
    const s = createIsolationStrategy('worktree');
    expect(s).toBeInstanceOf(WorktreeStrategy);
  });

  it('returns TempDirStrategy for "tmpdir"', () => {
    const s = createIsolationStrategy('tmpdir');
    expect(s).toBeInstanceOf(TempDirStrategy);
  });
});
