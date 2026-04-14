import { Command } from 'commander';
import { Coordinator } from '../../coordinator/server.js';
import { requireConfig } from '../../shared/config.js';

export const serveCommand = new Command('serve')
  .description('Start the coordination WebSocket server')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .action(async (options: { port: string }) => {
    const config = requireConfig();
    const port = parseInt(options.port, 10) || config.port || 8080;

    const coordinator = new Coordinator({ port, token: config.token });
    await coordinator.start();

    console.log(`Coordinator listening on port ${port}`);
    console.log('Expose with: tailscale funnel ' + port);
    console.log('Press Ctrl+C to stop.');

    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await coordinator.stop();
      process.exit(0);
    });
  });
