import { Command } from 'commander';
import { join } from 'node:path';
import { Coordinator, type CoordinatorOptions } from '../../coordinator/server.js';
import { requireConfig, getConfigDir } from '../../shared/config.js';
import { SqliteTaskStore } from '../../coordinator/sqlite-store.js';

export const serveCommand = new Command('serve')
  .description('Start the coordination WebSocket server')
  .option('-p, --port <port>', 'Port to listen on', '8080')
  .option('--tls-cert <path>', 'Path to TLS certificate file')
  .option('--tls-key <path>', 'Path to TLS private key file')
  .option('--storage <type>', 'Storage backend: memory (default) or sqlite', 'memory')
  .option('--db-path <path>', 'SQLite database file path (default: ~/.coord/tasks.db)')
  .action(async (options: { port: string; tlsCert?: string; tlsKey?: string; storage?: string; dbPath?: string }) => {
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

    if (options.storage === 'sqlite') {
      const dbPath = options.dbPath ?? join(getConfigDir(), 'tasks.db');
      const store = await SqliteTaskStore.create({ dbPath });
      const recovered = store.recoverStaleTasks();
      if (recovered > 0) {
        console.log(`Recovered ${recovered} stale running task(s) from previous session`);
      }
      coordinatorOptions.store = store;
      console.log(`Using SQLite storage at ${dbPath}`);
    }

    const coordinator = new Coordinator(coordinatorOptions);
    await coordinator.start();

    console.log(`Coordinator listening on port ${port}`);
    if (!coordinatorOptions.tls) {
      console.log('Expose with: tailscale funnel ' + port);
    }
    console.log('Press Ctrl+C to stop.');

    const shutdown = async () => {
      console.log('\nShutting down...');
      await coordinator.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
