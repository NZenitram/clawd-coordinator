import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { CoordMcpServer } from '../../mcp/server.js';

export const mcpCommand = new Command('mcp')
  .description('Start MCP server for Claude Code integration')
  .option('--url <url>', 'Coordinator URL (overrides config)')
  .action(async (options: { url?: string }) => {
    const config = requireConfig();
    const url =
      options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
    const server = new CoordMcpServer(url, config.token);
    await server.start();
  });
