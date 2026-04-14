import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  prompt: string;
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
  maxBudgetUsd?: number;
  onOutput: (data: string) => void;
  onError?: (data: string) => void;
}

export interface RunResult {
  exitCode: number;
}

export class Executor {
  private currentProcess: ChildProcess | null = null;

  async run(options: RunOptions): Promise<RunResult> {
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      options.prompt,
    ];

    if (options.sessionId) {
      args.unshift('--resume', options.sessionId);
    }
    if (options.model) {
      args.unshift('--model', options.model);
    }
    if (options.maxBudgetUsd !== undefined) {
      args.unshift('--max-budget-usd', String(options.maxBudgetUsd));
    }

    const cwd = options.workingDirectory ?? process.cwd();

    return new Promise<RunResult>((resolve) => {
      const proc = spawn('claude', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.currentProcess = proc;

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

      proc.on('close', (code) => {
        this.currentProcess = null;
        resolve({ exitCode: code ?? 1 });
      });
    });
  }

  kill(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
    }
  }
}
