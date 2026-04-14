import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest, formatTable } from '../output.js';

export const sessionsCommand = new Command('sessions')
  .description('List Claude Code sessions on a remote agent')
  .requiredOption('--on <agent>', 'Target agent name')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { on: string; url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'list-sessions', { agentName: options.on });
    ws.close();

    const payload = response.payload as { requestId: string; data: unknown; error?: string };
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      process.exit(1);
    }

    const sessions = ((payload.data as { sessions?: unknown }).sessions ?? []) as Array<{
      id: string;
      name?: string;
      createdAt?: string;
    }>;

    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }

    const rows = sessions.map(s => [
      s.id,
      s.name ?? '-',
      s.createdAt ?? '-',
    ]);

    console.log(formatTable(['SESSION ID', 'NAME', 'CREATED AT'], rows));
  });

export const resumeCommand = new Command('resume')
  .description('Resume a Claude Code session on a remote agent')
  .argument('<session-id>', 'Session ID to resume')
  .requiredOption('--on <agent>', 'Target agent name')
  .argument('[prompt]', 'Optional prompt to send when resuming')
  .option('--url <url>', 'Coordinator URL')
  .option('--bg', 'Run in background and return task ID')
  .action(async (
    sessionId: string,
    prompt: string | undefined,
    options: { on: string; url?: string; bg?: boolean },
  ) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const resolvedPrompt = prompt ?? 'continue';

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'dispatch-task', {
      agentName: options.on,
      prompt: resolvedPrompt,
      sessionId,
    });

    const payload = response.payload as { requestId: string; data: unknown; error?: string };
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      ws.close();
      process.exit(1);
    }

    const taskId = (payload.data as { taskId: string }).taskId;

    if (options.bg) {
      console.log(`Task dispatched: ${taskId}`);
      ws.close();
      return;
    }

    const { parseMessage } = await import('../../protocol/messages.js');

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
