import { platform } from 'node:os';

export const isWindows = platform() === 'win32';
export const isMacOS = platform() === 'darwin';
export const isLinux = platform() === 'linux';

// On Windows, spawn/execFile need shell:true to find .cmd/.bat shims
export function shellOpts(opts?: Record<string, unknown>): Record<string, unknown> {
  return isWindows ? { ...opts, shell: true } : { ...opts };
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
