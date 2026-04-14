import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest, formatTable, formatDuration } from '../output.js';

export const agentsCommand = new Command('agents')
  .description('List connected agents')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'list-agents');
    ws.close();

    const agents = (response.payload as any).data.agents as any[];
    if (agents.length === 0) {
      console.log('No agents connected.');
      return;
    }

    const now = Date.now();
    const rows = agents.map(a => [
      a.name,
      a.status,
      `${a.os}/${a.arch}`,
      formatDuration(now - a.connectedAt),
      a.currentTaskId ?? '-',
    ]);

    console.log(formatTable(
      ['NAME', 'STATUS', 'PLATFORM', 'UPTIME', 'CURRENT TASK'],
      rows
    ));
  });
