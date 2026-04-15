import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateClaudeMd } from '../../src/cli/commands/claude-md.js';

describe('coord claude-md — generateClaudeMd()', () => {
  it('output contains "coord describe"', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord describe');
  });

  it('output mentions --json flag for coord describe', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord describe --json');
  });

  it('output mentions key commands: run', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord run');
  });

  it('output mentions key commands: agents', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord agents');
  });

  it('output mentions key commands: tasks', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord tasks');
  });

  it('output mentions key commands: push', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord push');
  });

  it('output mentions key commands: pull', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord pull');
  });

  it('output mentions connecting as an agent', () => {
    const content = generateClaudeMd();
    expect(content).toContain('coord agent');
  });

  it('output mentions --help', () => {
    const content = generateClaudeMd();
    expect(content).toContain('--help');
  });

  it('output is under 100 lines', () => {
    const content = generateClaudeMd();
    const lineCount = content.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(100);
  });
});

describe('coord claude-md --install flag', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'coord-claude-md-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--install writes CLAUDE.md to current directory', async () => {
    // Import the command and exercise the install branch directly
    const { claudeMdCommand } = await import('../../src/cli/commands/claude-md.js');

    const consoleSpy = vitest.spyOn(console, 'log').mockImplementation(() => {});

    await claudeMdCommand.parseAsync(['--install'], { from: 'user' });

    const filePath = join(tmpDir, 'CLAUDE.md');
    expect(existsSync(filePath)).toBe(true);

    const written = readFileSync(filePath, 'utf8');
    expect(written).toContain('coord describe');
    expect(written).toContain('coord run');

    consoleSpy.mockRestore();
  });

  it('--install prints confirmation message', async () => {
    const { claudeMdCommand } = await import('../../src/cli/commands/claude-md.js');

    const consoleSpy = vitest.spyOn(console, 'log').mockImplementation(() => {});

    await claudeMdCommand.parseAsync(['--install'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('CLAUDE.md'));

    consoleSpy.mockRestore();
  });

  it('without --install prints to stdout (does not write file)', async () => {
    const { claudeMdCommand } = await import('../../src/cli/commands/claude-md.js');

    const consoleSpy = vitest.spyOn(console, 'log').mockImplementation(() => {});

    await claudeMdCommand.parseAsync([], { from: 'user' });

    const filePath = join(tmpDir, 'CLAUDE.md');
    expect(existsSync(filePath)).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

import { vitest } from 'vitest';
