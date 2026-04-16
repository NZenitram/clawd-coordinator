import { platform } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { existsSync } from 'node:fs';

export const isWindows = platform() === 'win32';
export const isMacOS = platform() === 'darwin';
export const isLinux = platform() === 'linux';

// On Windows, spawn/execFile need shell:true to find .cmd/.bat shims
export function shellOpts(opts?: Record<string, unknown>): Record<string, unknown> {
  return isWindows ? { ...opts, shell: true } : { ...opts };
}

/**
 * Resolve a command to its full path on Windows (.cmd/.bat shim lookup).
 * Returns the original command on non-Windows or if not found.
 * This allows spawning without shell:true, avoiding arg quoting issues.
 */
export function resolveCommand(cmd: string): string {
  if (!isWindows) return cmd;
  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    for (const ext of ['.cmd', '.bat', '.exe', '']) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return cmd; // fallback — let the OS try
}

export async function checkCommandExists(cmd: string): Promise<{ exists: boolean; version?: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(cmd, ['--version'], { timeout: 10000, ...(isWindows ? { shell: true } : {}) });
    return { exists: true, version: stdout.trim().slice(0, 200) };
  } catch {
    return { exists: false };
  }
}

export async function detectPackageManager(): Promise<{ name: string; installCmd: (pkg: string) => string } | null> {
  if (isMacOS) {
    const brew = await checkCommandExists('brew');
    if (brew.exists) return { name: 'brew', installCmd: (pkg) => `brew install ${pkg}` };
  }
  if (isLinux) {
    for (const [name, cmd] of [['apt', 'sudo apt install -y'], ['dnf', 'sudo dnf install -y'], ['yum', 'sudo yum install -y']] as const) {
      const check = await checkCommandExists(name);
      if (check.exists) return { name, installCmd: (pkg) => `${cmd} ${pkg}` };
    }
  }
  if (isWindows) {
    const winget = await checkCommandExists('winget');
    if (winget.exists) return { name: 'winget', installCmd: (pkg) => `winget install ${pkg}` };
    const choco = await checkCommandExists('choco');
    if (choco.exists) return { name: 'choco', installCmd: (pkg) => `choco install ${pkg}` };
  }
  return null;
}
