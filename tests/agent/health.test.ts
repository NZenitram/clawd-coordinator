import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout: 'claude 1.0.0\n', stderr: '' });
  }),
}));

const { checkClaudeHealth } = await import('../../src/agent/health.js');
const { execFile } = await import('node:child_process');

describe('checkClaudeHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns available when claude --version succeeds', async () => {
    const result = await checkClaudeHealth();
    expect(result.available).toBe(true);
    expect(result.version).toBe('claude 1.0.0');
    expect(execFile).toHaveBeenCalled();
  });

  it('returns unavailable when claude --version fails', async () => {
    (execFile as any).mockImplementationOnce((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(new Error('command not found: claude'));
    });
    const result = await checkClaudeHealth();
    expect(result.available).toBe(false);
    expect(result.error).toContain('command not found');
  });

  it('sanitizes version string by stripping control chars and truncating', async () => {
    (execFile as any).mockImplementationOnce((_cmd: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, { stdout: 'claude 1.0.0\x00\x1b[31m with junk\n', stderr: '' });
    });
    const result = await checkClaudeHealth();
    expect(result.version).toBe('claude 1.0.0[31m with junk');
    expect(result.version).not.toMatch(/[\x00-\x1f]/);
  });
});
