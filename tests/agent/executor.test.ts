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
      dangerouslySkipPermissions: true,
      onOutput: () => {},
    });

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--dangerouslySkipPermissions']),
      expect.any(Object)
    );
  });

  it('omits --dangerouslySkipPermissions when not set', async () => {
    const executor = new Executor();
    await executor.run({
      prompt: 'test',
      onOutput: () => {},
    });

    const args = (spawn as any).mock.calls[0][1] as string[];
    expect(args).not.toContain('--dangerouslySkipPermissions');
  });
});
