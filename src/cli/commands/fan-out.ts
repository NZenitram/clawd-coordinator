import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';
import { parseMessage } from '../../protocol/messages.js';

export const fanOutCommand = new Command('fan-out')
  .description('Dispatch a prompt to multiple agents in parallel')
  .argument('<prompt>', 'The prompt to send')
  .requiredOption('--on <agents>', 'Comma-separated agent names')
  .option('--url <url>', 'Coordinator URL')
  .option('--budget <usd>', 'Maximum budget in USD per task')
  .option('--allowed-tools <tools>', 'Comma-separated tools to allow for this task')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny for this task')
  .option('--add-dirs <dirs>', 'Comma-separated additional directories for this task')
  .option('--upload <spec>', 'Upload <local>:<remote> to each agent before dispatch (repeatable)', (v, a: string[]) => { a.push(v); return a; }, [] as string[])
  .option('--download <spec>', 'Download <remote>:<local> from each agent after task completes (repeatable)', (v, a: string[]) => { a.push(v); return a; }, [] as string[])
  .action(async (prompt: string, options: { on: string; url?: string; budget?: string; allowedTools?: string; disallowedTools?: string; addDirs?: string; upload: string[]; download: string[] }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
    const agentNames = options.on.split(',').map(s => s.trim());

    const allowedTools = options.allowedTools ? options.allowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const disallowedTools = options.disallowedTools ? options.disallowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const addDirs = options.addDirs ? options.addDirs.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const ws = await connectCli(url, config.token);

    const taskIds: string[] = [];
    const completedTasks = new Set<string>();
    const failedTasks = new Set<string>();

    for (const agentName of agentNames) {
      const response = await sendRequest(ws, 'dispatch-task', {
        agentName,
        prompt,
        maxBudgetUsd: options.budget ? parseFloat(options.budget) : undefined,
        allowedTools,
        disallowedTools,
        addDirs,
      });

      const payload = response.payload as any;
      if (payload.error) {
        console.error(`[${agentName}] Error: ${payload.error}`);
        continue;
      }
      taskIds.push(payload.data.taskId);
      console.log(`[${agentName}] Task dispatched: ${payload.data.taskId}`);
    }

    if (taskIds.length === 0) {
      console.error('No tasks dispatched.');
      ws.close();
      process.exit(1);
    }

    const taskIdSet = new Set(taskIds);

    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      if (msg.type === 'task:output' && taskIdSet.has(msg.payload.taskId)) {
        process.stdout.write(`[${msg.payload.taskId.slice(0, 8)}] ${msg.payload.data}\n`);
      } else if (msg.type === 'task:complete' && taskIdSet.has(msg.payload.taskId)) {
        completedTasks.add(msg.payload.taskId);
        console.log(`[${msg.payload.taskId.slice(0, 8)}] Completed`);
        checkDone();
      } else if (msg.type === 'task:error' && taskIdSet.has(msg.payload.taskId)) {
        failedTasks.add(msg.payload.taskId);
        console.error(`[${msg.payload.taskId.slice(0, 8)}] Failed: ${msg.payload.error}`);
        checkDone();
      }
    });

    function checkDone() {
      if (completedTasks.size + failedTasks.size === taskIds.length) {
        console.log(`\nDone: ${completedTasks.size} completed, ${failedTasks.size} failed`);
        ws.close();
        if (failedTasks.size > 0) process.exit(1);
      }
    }
  });
