import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';

export const selfUpdateCommand = new Command('self-update')
  .description('Update a remote agent to the latest version and restart it')
  .requiredOption('--on <agent>', 'Target agent name')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { on: string; url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);
    console.log(`Requesting self-update on ${options.on}...`);

    const response = await sendRequest(ws, 'self-update', { agentName: options.on });
    ws.close();

    const payload = response.payload as { requestId: string; data: unknown; error?: string };
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      process.exit(1);
    }

    const data = payload.data as {
      success: boolean;
      message: string;
      oldVersion?: string;
      newVersion?: string;
    };

    if (data.success) {
      const versionInfo = (data.oldVersion && data.newVersion)
        ? ` ${data.oldVersion} -> ${data.newVersion}`
        : '';
      console.log(`Update successful${versionInfo}`);
      console.log('Agent is restarting with the same configuration.');
    } else {
      console.error(`Update failed: ${data.message}`);
      process.exit(1);
    }
  });
