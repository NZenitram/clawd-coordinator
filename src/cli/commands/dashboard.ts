import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { fetchDashboardData, EMPTY_DASHBOARD_DATA } from '../dashboard/data.js';
import { createDashboard } from '../dashboard/panels.js';

export const dashboardCommand = new Command('dashboard')
  .description('Interactive TUI dashboard — shows agents, tasks, and stats in real time')
  .option('-u, --url <url>', 'Coordinator base URL (overrides config)')
  .option('-i, --interval <ms>', 'Polling interval in milliseconds', '2000')
  .action(async (options: { url?: string; interval: string }) => {
    const config = requireConfig();
    const baseUrl = options.url ?? config.coordinatorUrl ?? 'http://localhost:8080';
    const intervalMs = Math.max(500, parseInt(options.interval, 10) || 2000);
    const token = config.token;

    const dashboard = createDashboard();

    dashboard.log(`Connecting to ${baseUrl} (polling every ${intervalMs}ms)`);
    dashboard.log('Press q or Ctrl-C to quit, Tab to cycle focus');

    let lastAgentCount = -1;
    let lastTaskCount = -1;

    async function poll(): Promise<void> {
      try {
        const data = await fetchDashboardData(baseUrl, token);
        dashboard.render(data);

        // Log notable changes
        if (data.agents.length !== lastAgentCount) {
          dashboard.log(`Agents: ${data.agents.length} connected`);
          lastAgentCount = data.agents.length;
        }
        if (data.tasks.length !== lastTaskCount) {
          dashboard.log(`Tasks: ${data.tasks.length} total`);
          lastTaskCount = data.tasks.length;
        }
      } catch (err) {
        dashboard.log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
        dashboard.render(EMPTY_DASHBOARD_DATA);
      }
    }

    // Initial fetch
    await poll();

    // Start polling loop
    const timer = setInterval(() => { void poll(); }, intervalMs);

    // Clean up on exit
    process.on('SIGINT', () => {
      clearInterval(timer);
      dashboard.destroy();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      clearInterval(timer);
      dashboard.destroy();
      process.exit(0);
    });
  });
