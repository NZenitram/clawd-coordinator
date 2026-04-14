import { Command } from 'commander';
import { AgentDaemon } from '../../agent/daemon.js';

export const agentCommand = new Command('agent')
  .description('Start the remote agent daemon')
  .requiredOption('--url <url>', 'Coordinator WebSocket URL (e.g., wss://host:8080)')
  .requiredOption('--token <token>', 'Auth token')
  .requiredOption('--name <name>', 'Agent name')
  .option('--cwd <directory>', 'Working directory for Claude Code')
  .action(async (options: { url: string; token: string; name: string; cwd?: string }) => {
    const daemon = new AgentDaemon({
      name: options.name,
      coordinatorUrl: options.url,
      token: options.token,
      workingDirectory: options.cwd,
    });

    try {
      await daemon.start();
      console.log(`Agent "${options.name}" connected to ${options.url}`);
      console.log('Waiting for tasks. Press Ctrl+C to stop.');
    } catch (err) {
      console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    process.on('SIGINT', async () => {
      console.log('\nDisconnecting...');
      await daemon.stop();
      process.exit(0);
    });
  });
