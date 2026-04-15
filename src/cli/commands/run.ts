import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';
import { parseMessage } from '../../protocol/messages.js';

export const runCommand = new Command('run')
  .description('Dispatch a prompt to a remote agent')
  .argument('<prompt>', 'The prompt to send')
  .requiredOption('--on <agent>', 'Target agent name')
  .option('--bg', 'Run in background and return task ID')
  .option('--url <url>', 'Coordinator URL')
  .option('--session <id>', 'Resume a specific Claude Code session')
  .option('--budget <usd>', 'Maximum budget in USD for this task')
  .option('--allowed-tools <tools>', 'Comma-separated tools to allow for this task')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny for this task')
  .option('--add-dirs <dirs>', 'Comma-separated additional directories for this task')
  .action(async (prompt: string, options: { on: string; bg?: boolean; url?: string; session?: string; budget?: string; allowedTools?: string; disallowedTools?: string; addDirs?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const allowedTools = options.allowedTools ? options.allowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const disallowedTools = options.disallowedTools ? options.disallowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const addDirs = options.addDirs ? options.addDirs.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'dispatch-task', {
      agentName: options.on,
      prompt,
      sessionId: options.session,
      maxBudgetUsd: options.budget ? parseFloat(options.budget) : undefined,
      allowedTools,
      disallowedTools,
      addDirs,
    });

    const payload = response.payload as any;
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      ws.close();
      process.exit(1);
    }

    const taskId = payload.data.taskId;

    if (options.bg) {
      console.log(`Task dispatched: ${taskId}`);
      ws.close();
      return;
    }

    // Stream output until task completes
    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      if (msg.type === 'task:output' && msg.payload.taskId === taskId) {
        process.stdout.write(msg.payload.data + '\n');
      } else if (msg.type === 'task:complete' && msg.payload.taskId === taskId) {
        ws.close();
      } else if (msg.type === 'task:error' && msg.payload.taskId === taskId) {
        console.error(`\nTask failed: ${msg.payload.error}`);
        ws.close();
        process.exit(1);
      }
    });
  });
