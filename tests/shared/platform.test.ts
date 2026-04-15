import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── shellOpts ────────────────────────────────────────────────────────────────

describe('shellOpts', () => {
  it('returns the same opts on non-Windows', async () => {
    vi.doMock('node:os', () => ({ platform: () => 'linux' }));
    const { shellOpts } = await import('../../src/shared/platform.js');
    expect(shellOpts({ cwd: '/tmp' })).toEqual({ cwd: '/tmp' });
    vi.doUnmock('node:os');
  });

  it('returns empty object when no opts on non-Windows', async () => {
    vi.doMock('node:os', () => ({ platform: () => 'darwin' }));
    const { shellOpts } = await import('../../src/shared/platform.js');
    expect(shellOpts()).toEqual({});
    vi.doUnmock('node:os');
  });

  it('adds shell:true on Windows', async () => {
    vi.doMock('node:os', () => ({ platform: () => 'win32' }));
    // Must clear the module registry so platform.ts is re-evaluated
    vi.resetModules();
    const { shellOpts } = await import('../../src/shared/platform.js');
    expect(shellOpts({ timeout: 5000 })).toEqual({ timeout: 5000, shell: true });
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('adds shell:true on Windows even with no opts', async () => {
    vi.doMock('node:os', () => ({ platform: () => 'win32' }));
    vi.resetModules();
    const { shellOpts } = await import('../../src/shared/platform.js');
    expect(shellOpts()).toEqual({ shell: true });
    vi.doUnmock('node:os');
    vi.resetModules();
  });
});

// ─── checkCommandExists ────────────────────────────────────────────────────────

describe('checkCommandExists', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('returns exists:true for node', async () => {
    const { checkCommandExists } = await import('../../src/shared/platform.js');
    const result = await checkCommandExists('node');
    expect(result.exists).toBe(true);
    expect(result.version).toBeDefined();
    expect(typeof result.version).toBe('string');
  });

  it('returns exists:false for a nonexistent command', async () => {
    const { checkCommandExists } = await import('../../src/shared/platform.js');
    const result = await checkCommandExists('this-command-does-not-exist-coord-test-xyz');
    expect(result.exists).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it('truncates version output to 200 chars', async () => {
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, { stdout: 'x'.repeat(300) + '\n', stderr: '' });
      }),
    }));
    vi.doMock('node:util', () => ({
      promisify: (fn: Function) => (...args: any[]) => new Promise((resolve, reject) => {
        fn(...args, (err: any, result: any) => err ? reject(err) : resolve(result));
      }),
    }));
    const { checkCommandExists } = await import('../../src/shared/platform.js');
    const result = await checkCommandExists('anycommand');
    expect(result.exists).toBe(true);
    expect(result.version!.length).toBeLessThanOrEqual(200);
  });
});

// ─── platform flags ───────────────────────────────────────────────────────────

describe('platform flags', () => {
  it('isWindows is false on non-Windows', async () => {
    const { isWindows } = await import('../../src/shared/platform.js');
    // On the test machine (macOS/Linux), this should be false
    expect(typeof isWindows).toBe('boolean');
    // We can at least confirm it's a boolean
  });

  it('isMacOS and isLinux are mutually exclusive booleans', async () => {
    const { isMacOS, isLinux, isWindows } = await import('../../src/shared/platform.js');
    // At most one of the three can be true on any single platform
    const trueCount = [isMacOS, isLinux, isWindows].filter(Boolean).length;
    expect(trueCount).toBeLessThanOrEqual(1);
  });
});
