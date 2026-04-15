import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest, formatTable } from '../output.js';

interface AgentEntry {
  name: string;
  status: 'idle' | 'active' | 'busy' | 'offline';
  pool?: string;
  currentTaskIds: string[];
  maxConcurrent: number;
}

export const poolsCommand = new Command('pools')
  .description('List agent pools and their capacity')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { url?: string }) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const ws = await connectCli(url, config.token);
    const response = await sendRequest(ws, 'list-agents');
    ws.close();

    const agents = (response.payload as any).data.agents as AgentEntry[];

    // Group agents by pool; agents without a pool are skipped
    const poolMap = new Map<string, AgentEntry[]>();
    for (const agent of agents) {
      if (!agent.pool) continue;
      const list = poolMap.get(agent.pool) ?? [];
      list.push(agent);
      poolMap.set(agent.pool, list);
    }

    if (poolMap.size === 0) {
      console.log('No agent pools found. Start agents with --pool <name> to create pools.');
      return;
    }

    const rows = Array.from(poolMap.entries()).map(([poolName, members]) => {
      const idle = members.filter((a) => a.status === 'idle').length;
      const active = members.filter((a) => a.status === 'active').length;
      const busy = members.filter((a) => a.status === 'busy').length;
      const usedSlots = members.reduce((sum, a) => sum + a.currentTaskIds.length, 0);
      const totalSlots = members.reduce((sum, a) => sum + a.maxConcurrent, 0);
      return [
        poolName,
        String(members.length),
        `${idle} idle / ${active} active / ${busy} busy`,
        `${usedSlots}/${totalSlots}`,
      ];
    });

    console.log(formatTable(
      ['POOL', 'AGENTS', 'STATUS', 'CAPACITY (used/total)'],
      rows,
    ));
  });
