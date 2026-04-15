import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process.spawn before importing Executor
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        kill: vi.fn(),
      });

      // Simulate streaming output then exit
      setTimeout(() => {
        proc.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n');
        proc.stdout.push(null);
        proc.emit('close', 0);
      }, 10);

      return proc;
    }),
  };
});

// Import after mock is set up
const { Executor } = await import('../../src/agent/executor.js');
const { spawn } = await import('node:child_process');

describe('Executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes a prompt and collects output', async () => {
    const output: string[] = [];
    const executor = new Executor();

    const result = await executor.run({
      prompt: 'say hello',
      taskId: 'test-1',
      onOutput: (data) => output.push(data),
    });

    expect(result.exitCode).toBe(0);
    expect(output.length).toBeGreaterThan(0);
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      ['-p', '--verbose', '--output-format', 'stream-json', '--', 'say hello'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('reports error when process exits non-zero', async () => {
    (spawn as any).mockImplementationOnce(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        kill: vi.fn(),
      });

      setTimeout(() => {
        proc.stderr.push('Error: something went wrong\n');
        proc.stderr.push(null);
        proc.stdout.push(null);
        proc.emit('close', 1);
      }, 10);

      return proc;
    });

    const errors: string[] = [];
    const executor = new Executor();

    const result = await executor.run({
      prompt: 'fail',
      taskId: 'test-err',
      onOutput: () => {},
      onError: (data) => errors.push(data),
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('times out and kills the process', async () => {
    (spawn as any).mockImplementationOnce(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        kill: vi.fn(() => {
          // Simulate process exiting after SIGTERM
          setTimeout(() => {
            proc.stdout.push(null);
            proc.emit('close', null, 'SIGTERM');
          }, 5);
        }),
      });
      return proc;
    });

    const executor = new Executor();
    const result = await executor.run({
      prompt: 'hang forever',
      taskId: 'test-timeout',
      timeoutMs: 50,
      onOutput: () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(128);
  });

  it('passes sessionId as --resume flag', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'continue work',
      taskId: 'test-session',
      sessionId: 'session-123',
      onOutput: () => {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      ['--resume', 'session-123', '-p', '--verbose', '--output-format', 'stream-json', '--', 'continue work'],
      expect.any(Object)
    );
  });

  it('includes --dangerouslySkipPermissions when enabled', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      taskId: 'test-perms',
      dangerouslySkipPermissions: true,
      onOutput: () => {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--dangerouslySkipPermissions']),
      expect.any(Object)
    );
  });

  it('passes --max-budget-usd flag when budget is set', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      taskId: 'test-budget',
      maxBudgetUsd: 5.0,
      onOutput: () => {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--max-budget-usd', '5']),
      expect.any(Object)
    );
  });

  it('omits --dangerouslySkipPermissions when not set', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      taskId: 'tid-1',
      onOutput: () => {},
    });

    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain('--dangerouslySkipPermissions');
  });

  it('passes --allowedTools when set', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      taskId: 'test-allowed-tools',
      allowedTools: ['Read', 'Write'],
      onOutput: () => {},
    });

    const args = (spawn as any).mock.calls[0][1] as string[];
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Read,Write');
  });

  it('passes --add-dir for each directory', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      taskId: 'test-add-dirs',
      addDirs: ['/tmp/a', '/tmp/b'],
      onOutput: () => {},
    });

    const args = (spawn as any).mock.calls[0][1] as string[];
    // Each dir gets its own --add-dir flag
    const addDirIndices = args.reduce<number[]>((acc, val, i) => {
      if (val === '--add-dir') acc.push(i);
      return acc;
    }, []);
    expect(addDirIndices).toHaveLength(2);
    const dirs = addDirIndices.map(i => args[i + 1]);
    expect(dirs).toContain('/tmp/a');
    expect(dirs).toContain('/tmp/b');
  });

  it('passes --permission-mode when set', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      taskId: 'test-permission-mode',
      permissionMode: 'auto',
      onOutput: () => {},
    });

    const args = (spawn as any).mock.calls[0][1] as string[];
    const idx = args.indexOf('--permission-mode');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('auto');
  });

  it('skips permission flags when dangerouslySkipPermissions is set', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      taskId: 'test-skip-perms',
      dangerouslySkipPermissions: true,
      allowedTools: ['Read', 'Write'],
      permissionMode: 'auto',
      addDirs: ['/tmp/a'],
      disallowedTools: ['Bash'],
      onOutput: () => {},
    });

    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).toContain('--dangerouslySkipPermissions');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--disallowedTools');
  });

  it('tracks multiple concurrent processes by taskId', async () => {
    const output1: string[] = [];
    const output2: string[] = [];

    const executor = new Executor();
    const p1 = executor.run({ prompt: 'task1', taskId: 'id-1', onOutput: (d) => output1.push(d) });
    const p2 = executor.run({ prompt: 'task2', taskId: 'id-2', onOutput: (d) => output2.push(d) });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
  });

  it('kills a specific task by taskId', async () => {
    // Create a process that hangs until killed
    (spawn as any).mockImplementationOnce(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        kill: vi.fn(() => {
          setTimeout(() => {
            proc.stdout.push(null);
            proc.emit('close', null, 'SIGTERM');
          }, 5);
        }),
      });
      return proc;
    });

    const executor = new Executor();
    const p = executor.run({ prompt: 'hang', taskId: 'kill-me', timeoutMs: 60000, onOutput: () => {} });
    await new Promise(r => setTimeout(r, 5));

    executor.killTask('kill-me');
    const result = await p;
    expect(result.exitCode).toBe(128); // SIGTERM
  });

  it('kill() kills all running processes', async () => {
    // Both processes hang until killed
    const mockProcs: any[] = [];
    (spawn as any).mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        kill: vi.fn(() => {
          setTimeout(() => {
            proc.stdout.push(null);
            proc.emit('close', null, 'SIGTERM');
          }, 5);
        }),
      });
      mockProcs.push(proc);
      return proc;
    });

    const executor = new Executor();
    const p1 = executor.run({ prompt: 'a', taskId: 'a1', timeoutMs: 60000, onOutput: () => {} });
    const p2 = executor.run({ prompt: 'b', taskId: 'b1', timeoutMs: 60000, onOutput: () => {} });
    await new Promise(r => setTimeout(r, 5));

    executor.kill();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.exitCode).toBe(128);
    expect(r2.exitCode).toBe(128);
    expect(mockProcs).toHaveLength(2);
    for (const proc of mockProcs) {
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });
});
