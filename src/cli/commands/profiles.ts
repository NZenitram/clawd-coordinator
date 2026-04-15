import { Command } from 'commander';
import { loadConfig, saveConfig, requireConfig } from '../../shared/config.js';
import type { AgentProfile } from '../../shared/config.js';

const profilesCommand = new Command('profiles')
  .description('Manage agent profiles');

const profilesListCommand = new Command('list')
  .description('List all agent profiles')
  .action(() => {
    const config = loadConfig();
    const profiles = config?.agentProfiles ?? {};
    const names = Object.keys(profiles);

    if (names.length === 0) {
      console.log('No profiles found. Use "coord profiles create <name>" to create one.');
      return;
    }

    const header = 'NAME                 URL                                      NAME (agent)         MAX-CONCURRENT  ISOLATION';
    const separator = '-'.repeat(header.length);
    console.log(header);
    console.log(separator);
    for (const profileName of names) {
      const p = profiles[profileName];
      const col1 = profileName.padEnd(20);
      const col2 = (p.url ?? '').padEnd(40);
      const col3 = (p.name ?? '').padEnd(20);
      const col4 = String(p.maxConcurrent ?? '').padEnd(15);
      const col5 = p.isolation ?? 'none';
      console.log(`${col1} ${col2} ${col3} ${col4} ${col5}`);
    }
  });

const profilesShowCommand = new Command('show')
  .description('Show a profile\'s configuration as JSON')
  .argument('<name>', 'Profile name')
  .action((name: string) => {
    const config = loadConfig();
    const profile = config?.agentProfiles?.[name];

    if (!profile) {
      console.error(`Error: profile "${name}" not found.`);
      process.exit(1);
    }

    console.log(JSON.stringify(profile, null, 2));
  });

const profilesCreateCommand = new Command('create')
  .description('Create or update an agent profile')
  .argument('<name>', 'Profile name')
  .option('--url <url>', 'Coordinator WebSocket URL')
  .option('--token <token>', 'Auth token')
  .option('--name <agentName>', 'Agent name')
  .option('--cwd <directory>', 'Working directory for Claude Code')
  .option('--dangerously-skip-permissions', 'Skip Claude permission prompts for headless use')
  .option('--max-concurrent <n>', 'Maximum concurrent tasks')
  .option('--isolation <none|worktree|tmpdir>', 'Per-task workspace isolation strategy')
  .option('--allowed-tools <tools>', 'Comma-separated tools to pre-authorize')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny')
  .option('--add-dirs <dirs>', 'Comma-separated additional directory paths to allow')
  .option('--permission-mode <mode>', 'Permission mode: acceptEdits, auto, default, plan')
  .option('--pool <pool>', 'Pool name for this agent')
  .action((profileName: string, options: {
    url?: string;
    name?: string;
    token?: string;
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
    const config = requireConfig();

    const profile: AgentProfile = {};

    if (options.url !== undefined) profile.url = options.url;
    if (options.token !== undefined) profile.token = options.token;
    if (options.name !== undefined) profile.name = options.name;
    if (options.cwd !== undefined) profile.cwd = options.cwd;
    if (options.dangerouslySkipPermissions) profile.dangerouslySkipPermissions = true;
    if (options.maxConcurrent !== undefined) profile.maxConcurrent = parseInt(options.maxConcurrent, 10);
    if (options.isolation !== undefined) profile.isolation = options.isolation;
    if (options.allowedTools !== undefined) {
      profile.allowedTools = options.allowedTools.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (options.disallowedTools !== undefined) {
      profile.disallowedTools = options.disallowedTools.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (options.addDirs !== undefined) {
      profile.addDirs = options.addDirs.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (options.permissionMode !== undefined) profile.permissionMode = options.permissionMode;
    if (options.pool !== undefined) profile.pool = options.pool;

    const updatedConfig = {
      ...config,
      agentProfiles: {
        ...(config.agentProfiles ?? {}),
        [profileName]: profile,
      },
    };

    saveConfig(updatedConfig);
    console.log(`Profile "${profileName}" saved.`);
  });

const profilesDeleteCommand = new Command('delete')
  .description('Delete an agent profile')
  .argument('<name>', 'Profile name')
  .action((name: string) => {
    const config = requireConfig();
    const profiles = config.agentProfiles ?? {};

    if (!(name in profiles)) {
      console.error(`Error: profile "${name}" not found.`);
      process.exit(1);
    }

    const { [name]: _removed, ...remaining } = profiles;

    const updatedConfig = {
      ...config,
      agentProfiles: remaining,
    };

    saveConfig(updatedConfig);
    console.log(`Profile "${name}" deleted.`);
  });

profilesCommand.addCommand(profilesListCommand);
profilesCommand.addCommand(profilesShowCommand);
profilesCommand.addCommand(profilesCreateCommand);
profilesCommand.addCommand(profilesDeleteCommand);

export { profilesCommand };
