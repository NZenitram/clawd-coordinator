import { Command } from 'commander';
import { AgentDaemon } from '../../agent/daemon.js';
import { loadConfig } from '../../shared/config.js';
import type { IsolationMode } from '../../agent/isolation.js';

export const agentCommand = new Command('agent')
  .description('Start the remote agent daemon')
  .option('--profile <name>', 'Load agent configuration from a stored profile')
  .option('--url <url>', 'Coordinator WebSocket URL (e.g., wss://host:8080)')
  .option('--token <token>', 'Auth token')
  .option('--name <name>', 'Agent name')
  .option('--cwd <directory>', 'Working directory for Claude Code')
  .option('--dangerously-skip-permissions', 'Skip Claude permission prompts for headless use')
  .option('--max-concurrent <n>', 'Maximum concurrent tasks (default: 1)')
  .option('--isolation <none|worktree|tmpdir>', 'Per-task workspace isolation strategy (default: none)')
  .option('--allowed-tools <tools>', 'Comma-separated tools to pre-authorize (e.g., "Read,Write,Edit,Bash")')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny')
  .option('--add-dirs <dirs>', 'Comma-separated additional directory paths to allow')
  .option('--permission-mode <mode>', 'Permission mode: acceptEdits, auto, default, plan')
  .option('--pool <name>', 'Pool name to register this agent in')
  .action(async (options: {
    profile?: string;
    url?: string;
    token?: string;
    name?: string;
    cwd?: string;
    dangerouslySkipPermissions?: boolean;
    maxConcurrent?: string;
    isolation?: string;
    allowedTools?: string;
    disallowedTools?: string;
    addDirs?: string;
    permissionMode?: string;
    pool?: string;
  }) => {
    // Build merged options: profile values as defaults, CLI flags override
    let url = options.url;
    let token = options.token ?? process.env.COORD_TOKEN;
    let name = options.name;
    let cwd = options.cwd;
    let dangerouslySkipPermissions = options.dangerouslySkipPermissions;
    let maxConcurrentStr = options.maxConcurrent;
    let isolation = options.isolation;
    let allowedToolsStr = options.allowedTools;
    let disallowedToolsStr = options.disallowedTools;
    let addDirsStr = options.addDirs;
    let permissionMode = options.permissionMode;
    const pool = options.pool;

    if (options.profile) {
      const config = loadConfig();
      const profile = config?.agentProfiles?.[options.profile];
      if (!profile) {
        console.error(`Error: profile "${options.profile}" not found. Run "coord profiles list" to see available profiles.`);
        process.exit(1);
      }

      // Apply profile values as defaults — CLI flags take precedence
      if (url === undefined && profile.url !== undefined) url = profile.url;
      if (token === undefined && profile.token !== undefined) token = profile.token;
      if (name === undefined && profile.name !== undefined) name = profile.name;
      if (cwd === undefined && profile.cwd !== undefined) cwd = profile.cwd;
      if (dangerouslySkipPermissions === undefined && profile.dangerouslySkipPermissions !== undefined) {
        dangerouslySkipPermissions = profile.dangerouslySkipPermissions;
      }
      if (maxConcurrentStr === undefined && profile.maxConcurrent !== undefined) {
        maxConcurrentStr = String(profile.maxConcurrent);
      }
      if (isolation === undefined && profile.isolation !== undefined) isolation = profile.isolation;
      if (allowedToolsStr === undefined && profile.allowedTools !== undefined) {
        allowedToolsStr = profile.allowedTools.join(',');
      }
      if (disallowedToolsStr === undefined && profile.disallowedTools !== undefined) {
        disallowedToolsStr = profile.disallowedTools.join(',');
      }
      if (addDirsStr === undefined && profile.addDirs !== undefined) {
        addDirsStr = profile.addDirs.join(',');
      }
      if (permissionMode === undefined && profile.permissionMode !== undefined) {
        permissionMode = profile.permissionMode;
      }
    }

    // Validate required fields after merge
    if (!url) {
      console.error('Error: --url is required (or provide it in the profile)');
      process.exit(1);
    }
    if (!token) {
      console.error('Error: --token is required (or provide it in the profile)');
      process.exit(1);
    }
    if (!name) {
      console.error('Error: --name is required (or provide it in the profile)');
      process.exit(1);
    }

    if (dangerouslySkipPermissions && (allowedToolsStr || permissionMode)) {
      console.error('Error: --dangerously-skip-permissions is mutually exclusive with --allowed-tools and --permission-mode');
      process.exit(1);
    }

    const allowedTools = allowedToolsStr ? allowedToolsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const disallowedTools = disallowedToolsStr ? disallowedToolsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const addDirs = addDirsStr ? addDirsStr.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const daemon = new AgentDaemon({
      name,
      coordinatorUrl: url,
      token,
      workingDirectory: cwd,
      dangerouslySkipPermissions,
      maxConcurrent: maxConcurrentStr ? parseInt(maxConcurrentStr, 10) : undefined,
      isolation: (isolation ?? 'none') as IsolationMode,
      allowedTools,
      disallowedTools,
      addDirs,
      permissionMode,
      pool,
    });

    try {
      await daemon.start();
      // Redact token from process title to prevent exposure via ps aux
      process.title = `coord-agent:${name}`;
      console.log(`Agent "${name}" connected to ${url}`);
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
