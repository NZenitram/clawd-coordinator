import { Command } from 'commander';
import { AgentDaemon } from '../../agent/daemon.js';

export const agentCommand = new Command('agent')
  .description('Start the remote agent daemon')
  .requiredOption('--url <url>', 'Coordinator WebSocket URL (e.g., wss://host:8080)')
  .requiredOption('--token <token>', 'Auth token')
  .requiredOption('--name <name>', 'Agent name')
  .option('--cwd <directory>', 'Working directory for Claude Code')
  .option('--dangerously-skip-permissions', 'Skip Claude permission prompts for headless use')
  .option('--max-concurrent <n>', 'Maximum concurrent tasks (default: 1)', '1')
  .action(async (options: { url: string; token: string; name: string; cwd?: string; dangerouslySkipPermissions?: boolean; maxConcurrent?: string }) => {
    const daemon = new AgentDaemon({
      name: options.name,
      coordinatorUrl: options.url,
      token: options.token,
      workingDirectory: options.cwd,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      maxConcurrent: options.maxConcurrent ? parseInt(options.maxConcurrent, 10) : undefined,
    });

    try {
      await daemon.start();
      console.log(`Agent "${options.name}" connected to ${options.url}`);
      console.log('Waiting for tasks. Press Ctrl+C to stop.');
    } catch (err) {
      console.error(`Failed to connect: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const shutdown = async () => {
      console.log('\nDisconnecting...');
      await daemon.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
