import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  prompt: string;
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  dangerouslySkipPermissions?: boolean;
  onOutput: (data: string) => void;
  onError?: (data: string) => void;
}

export interface RunResult {
  exitCode: number;
  timedOut: boolean;
}

export class Executor {
  private currentProcess: ChildProcess | null = null;

  async run(options: RunOptions): Promise<RunResult> {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
    ];

    if (options.sessionId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(options.sessionId)) {
        throw new Error(`Invalid sessionId format: ${options.sessionId}`);
      }
      args.unshift('--resume', options.sessionId);
    }
    if (options.model) {
      if (!/^[a-zA-Z0-9._-]+$/.test(options.model)) {
        throw new Error(`Invalid model format: ${options.model}`);
      }
      args.unshift('--model', options.model);
    }
    if (options.maxBudgetUsd !== undefined) {
      args.unshift('--max-budget-usd', String(options.maxBudgetUsd));
    }
    if (options.dangerouslySkipPermissions) {
      args.unshift('--dangerouslySkipPermissions');
    }

    // -- separator prevents prompt from being interpreted as flags
    args.push('--', options.prompt);

    const cwd = options.workingDirectory ?? process.cwd();
    const timeoutMs = options.timeoutMs ?? 1800000; // 30 min default

    return new Promise<RunResult>((resolve) => {
      const proc = spawn('claude', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.currentProcess = proc;
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (this.currentProcess === proc) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      }, timeoutMs);

      proc.stdout!.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          options.onOutput(line);
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (options.onError) {
          options.onError(text);
        }
      });

      proc.on('close', (code, signal) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        this.currentProcess = null;
        resolve({
          exitCode: code ?? (signal ? 128 : 1),
          timedOut,
        });
      });
    });
  }

  kill(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
    }
  }
}
