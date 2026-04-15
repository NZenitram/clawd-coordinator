import { Command } from 'commander';
import { AgentDaemon } from '../../agent/daemon.js';
import type { IsolationMode } from '../../agent/isolation.js';

export const agentCommand = new Command('agent')
  .description('Start the remote agent daemon')
  .requiredOption('--url <url>', 'Coordinator WebSocket URL (e.g., wss://host:8080)')
  .requiredOption('--token <token>', 'Auth token')
  .requiredOption('--name <name>', 'Agent name')
  .option('--cwd <directory>', 'Working directory for Claude Code')
  .option('--dangerously-skip-permissions', 'Skip Claude permission prompts for headless use')
  .option('--max-concurrent <n>', 'Maximum concurrent tasks (default: 1)', '1')
  .option('--isolation <none|worktree|tmpdir>', 'Per-task workspace isolation strategy (default: none)', 'none')
  .option('--allowed-tools <tools>', 'Comma-separated tools to pre-authorize (e.g., "Read,Write,Edit,Bash")')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny')
  .option('--add-dirs <dirs>', 'Comma-separated additional directory paths to allow')
  .option('--permission-mode <mode>', 'Permission mode: acceptEdits, auto, default, plan')
  .action(async (options: { url: string; token: string; name: string; cwd?: string; dangerouslySkipPermissions?: boolean; maxConcurrent?: string; isolation?: string; allowedTools?: string; disallowedTools?: string; addDirs?: string; permissionMode?: string }) => {
    if (options.dangerouslySkipPermissions && (options.allowedTools || options.permissionMode)) {
      console.error('Error: --dangerously-skip-permissions is mutually exclusive with --allowed-tools and --permission-mode');
      process.exit(1);
    }

    const allowedTools = options.allowedTools ? options.allowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const disallowedTools = options.disallowedTools ? options.disallowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const addDirs = options.addDirs ? options.addDirs.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const daemon = new AgentDaemon({
      name: options.name,
      coordinatorUrl: options.url,
      token: options.token,
      workingDirectory: options.cwd,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      maxConcurrent: options.maxConcurrent ? parseInt(options.maxConcurrent, 10) : undefined,
      isolation: (options.isolation ?? 'none') as IsolationMode,
      allowedTools,
      disallowedTools,
      addDirs,
      permissionMode: options.permissionMode,
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
