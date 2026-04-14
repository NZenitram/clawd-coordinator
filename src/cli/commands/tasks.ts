import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest, formatTable, formatDuration } from '../output.js';
import { parseMessage } from '../../protocol/messages.js';

const tasksListCommand = new Command('tasks')
  .description('List tasks')
  .option('--status <status>', 'Filter by status (pending, running, completed, error)')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { status?: string; url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'list-tasks', { status: options.status });
    ws.close();

    const tasks = (response.payload as any).data.tasks as any[];
    if (tasks.length === 0) {
      console.log('No tasks.');
      return;
    }

    const now = Date.now();
    const rows = tasks.map(t => [
      t.id.slice(0, 8),
      t.agentName,
      t.status,
      t.prompt.slice(0, 50) + (t.prompt.length > 50 ? '...' : ''),
      formatDuration(now - t.createdAt),
    ]);

    console.log(formatTable(['ID', 'AGENT', 'STATUS', 'PROMPT', 'AGE'], rows));
  });

const attachCommand = new Command('attach')
  .description('Stream output from a running task')
  .argument('<task-id>', 'Task ID (or prefix)')
  .option('--url <url>', 'Coordinator URL')
  .action(async (taskId: string, options: { url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);

    const taskResponse = await sendRequest(ws, 'get-task', { taskId });
    const task = (taskResponse.payload as any).data.task;

    if (!task) {
      console.error(`Task not found: ${taskId}`);
      ws.close();
      process.exit(1);
    }

    for (const line of task.output) {
      process.stdout.write(line + '\n');
    }

    if (task.status === 'completed') {
      console.log('\n--- Task completed ---');
      ws.close();
      return;
    }
    if (task.status === 'error') {
      console.error(`\n--- Task failed: ${task.error} ---`);
      ws.close();
      process.exit(1);
    }

    await sendRequest(ws, 'subscribe-task', { taskId: task.id });

    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      if (msg.type === 'task:output' && msg.payload.taskId === task.id) {
        process.stdout.write(msg.payload.data + '\n');
      } else if (msg.type === 'task:complete' && msg.payload.taskId === task.id) {
        console.log('\n--- Task completed ---');
        ws.close();
      } else if (msg.type === 'task:error' && msg.payload.taskId === task.id) {
        console.error(`\n--- Task failed: ${msg.payload.error} ---`);
        ws.close();
        process.exit(1);
      }
    });
  });

const resultCommand = new Command('result')
  .description('Get the result of a completed task')
  .argument('<task-id>', 'Task ID (or prefix)')
  .option('--url <url>', 'Coordinator URL')
  .action(async (taskId: string, options: { url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'get-task', { taskId });
    ws.close();

    const task = (response.payload as any).data.task;
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }

    for (const line of task.output) {
      process.stdout.write(line + '\n');
    }

    if (task.error) {
      console.error(`\nError: ${task.error}`);
      process.exit(1);
    }
  });

export { tasksListCommand, attachCommand, resultCommand };
