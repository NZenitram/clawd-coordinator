import { Command } from 'commander';
import { Coordinator, type CoordinatorOptions } from '../../coordinator/server.js';
import { requireConfig } from '../../shared/config.js';

export const serveCommand = new Command('serve')
  .description('Start the coordination WebSocket server')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('--tls-cert <path>', 'Path to TLS certificate file')
  .option('--tls-key <path>', 'Path to TLS private key file')
  .action(async (options: { port: string; tlsCert?: string; tlsKey?: string }) => {
    const config = requireConfig();
    const port = parseInt(options.port, 10) || config.port || 8080;

    const coordinatorOptions: CoordinatorOptions = { port, token: config.token, agentTokens: config.agentTokens };

    const tlsCert = options.tlsCert ?? config.tls?.cert;
    const tlsKey = options.tlsKey ?? config.tls?.key;

    if (tlsCert && tlsKey) {
      coordinatorOptions.tls = { cert: tlsCert, key: tlsKey };
    } else if (!tlsCert) {
      console.error('Warning: Coordinator running without TLS. Use --tls-cert/--tls-key or Tailscale Funnel for secure connections.');
    }

    const coordinator = new Coordinator(coordinatorOptions);
    await coordinator.start();

    console.log(`Coordinator listening on port ${port}`);
    if (!coordinatorOptions.tls) {
      console.log('Expose with: tailscale funnel ' + port);
    }
    console.log('Press Ctrl+C to stop.');

    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await coordinator.stop();
      process.exit(0);
    });
  });
