import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HealthStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export async function checkClaudeHealth(): Promise<HealthStatus> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10000 });
    const version = stdout.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
    return { available: true, version };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
