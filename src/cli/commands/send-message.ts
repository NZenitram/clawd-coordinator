import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';

export const sendMessageCommand = new Command('send-message')
  .description('Send a message from one agent to another')
  .requiredOption('--from <agent>', 'Source agent name')
  .requiredOption('--to <agent>', 'Target agent name')
  .requiredOption('--topic <topic>', 'Message topic')
  .requiredOption('--body <body>', 'Message body')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { from: string; to: string; topic: string; body: string; url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'send-message', {
      fromAgent: options.from,
      toAgent: options.to,
      topic: options.topic,
      body: options.body,
    });
    ws.close();

    const payload = (response.payload as { data: unknown; error?: string });
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      process.exit(1);
      return;
    }

    const data = payload.data as { correlationId: string; status: string };
    console.log(`Message sent (correlationId: ${data.correlationId}, status: ${data.status})`);
  });
