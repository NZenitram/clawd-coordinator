import { Command } from 'commander';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, saveConfig } from '../../shared/config.js';
import { checkCommandExists, detectPackageManager, shellOpts } from '../../shared/platform.js';
import { platform } from 'node:os';

const execFileAsync = promisify(execFileCb);

function platformName(): string {
  const p = platform();
  const names: Record<string, string> = {
    darwin: 'macOS',
    linux: 'Linux',
    win32: 'Windows',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
  };
  return names[p] ?? p;
}

function nodeVersionOk(): boolean {
  const [major] = process.version.replace('v', '').split('.').map(Number);
  return major >= 18;
}

async function promptYN(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) {
    console.log(`${question} [auto: yes]`);
    return true;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

async function runInstall(installCmd: string): Promise<void> {
  const parts = installCmd.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);
  await execFileAsync(cmd, args, shellOpts({ timeout: 120000 }));
}

export const setupCommand = new Command('setup')
  .description('Set up a machine to run as a clawd-coordinator agent')
  .option('--yes', 'Accept all defaults without prompting')
  .option('--url <url>', 'Coordinator URL (saved to profile)')
  .option('--token <token>', 'Auth token (saved to profile)')
  .option('--name <name>', 'Agent name (saved to profile)')
  .option('--profile <name>', 'Save configuration as a named profile')
  .action(async (options: {
    yes?: boolean;
    url?: string;
    token?: string;
    name?: string;
    profile?: string;
  }) => {
    const autoYes = options.yes ?? false;
    const checks: { label: string; ok: boolean; note?: string }[] = [];

    // Step 1: Platform detection
    const os = platformName();
    console.log(`\nPlatform: ${os}`);

    // Step 2: Node.js version
    const nodeOk = nodeVersionOk();
    if (nodeOk) {
      console.log(`Node.js ${process.version} — OK`);
      checks.push({ label: 'Node.js >= 18', ok: true });
    } else {
      console.error(`Node.js ${process.version} — FAIL (requires >= 18.0.0)`);
      checks.push({ label: 'Node.js >= 18', ok: false, note: 'Upgrade Node.js before continuing' });
    }

    // Step 3: Git
    const git = await checkCommandExists('git');
    if (git.exists) {
      console.log(`git — OK (${git.version?.split('\n')[0] ?? ''})`);
      checks.push({ label: 'git', ok: true });
    } else {
      console.log('git — NOT FOUND');
      const pkgMgr = await detectPackageManager();
      if (pkgMgr) {
        const install = await promptYN(`Install git via ${pkgMgr.name}?`, autoYes);
        if (install) {
          try {
            console.log(`Running: ${pkgMgr.installCmd('git')}`);
            await runInstall(pkgMgr.installCmd('git'));
            console.log('git installed successfully.');
            checks.push({ label: 'git', ok: true, note: 'Installed' });
          } catch (err) {
            console.error(`Failed to install git: ${err instanceof Error ? err.message : String(err)}`);
            checks.push({ label: 'git', ok: false, note: 'Install failed — install manually' });
          }
        } else {
          checks.push({ label: 'git', ok: false, note: `Run: ${pkgMgr.installCmd('git')}` });
        }
      } else {
        console.log('No package manager detected. Install git manually.');
        checks.push({ label: 'git', ok: false, note: 'Install git manually' });
      }
    }

    // Step 4: Claude Code
    const claude = await checkCommandExists('claude');
    if (claude.exists) {
      console.log(`claude — OK (${claude.version?.split('\n')[0] ?? ''})`);
      checks.push({ label: 'Claude Code', ok: true });
    } else {
      console.log('claude — NOT FOUND');
      const install = await promptYN('Install Claude Code via npm?', autoYes);
      if (install) {
        try {
          console.log('Running: npm install -g @anthropic-ai/claude-code');
          await execFileAsync('npm', ['install', '-g', '@anthropic-ai/claude-code'], shellOpts({ timeout: 120000 }));
          console.log('Claude Code installed successfully.');
          checks.push({ label: 'Claude Code', ok: true, note: 'Installed' });
        } catch (err) {
          console.error(`Failed to install Claude Code: ${err instanceof Error ? err.message : String(err)}`);
          checks.push({ label: 'Claude Code', ok: false, note: 'Install failed — run: npm install -g @anthropic-ai/claude-code' });
        }
      } else {
        checks.push({ label: 'Claude Code', ok: false, note: 'Run: npm install -g @anthropic-ai/claude-code' });
      }
    }

    // Step 5: Auth — check ANTHROPIC_API_KEY
    const hasApiKey = Boolean(process.env['ANTHROPIC_API_KEY']);
    if (hasApiKey) {
      console.log('ANTHROPIC_API_KEY — OK');
      checks.push({ label: 'Anthropic auth', ok: true });
    } else {
      console.log('ANTHROPIC_API_KEY — not set');
      console.log('  Run `claude` to authenticate via OAuth, or set ANTHROPIC_API_KEY in your environment.');
      checks.push({ label: 'Anthropic auth', ok: false, note: 'Run `claude` to authenticate via OAuth' });
    }

    // Step 6: Profile — if url/token/name provided, save as profile
    if (options.url || options.token || options.name) {
      const profileName = options.profile ?? 'default';
      const config = loadConfig() ?? { token: options.token ?? '' };

      if (options.token && !config.token) {
        config.token = options.token;
      } else if (options.token) {
        config.token = options.token;
      }

      if (options.url) {
        config.coordinatorUrl = options.url;
      }

      if (!config.agentProfiles) {
        config.agentProfiles = {};
      }

      config.agentProfiles[profileName] = {
        url: options.url,
        token: options.token,
        name: options.name,
      };

      try {
        saveConfig(config);
        console.log(`Profile "${profileName}" saved to ~/.coord/config.json`);
        checks.push({ label: `Profile "${profileName}"`, ok: true });
      } catch (err) {
        console.error(`Failed to save profile: ${err instanceof Error ? err.message : String(err)}`);
        checks.push({ label: `Profile "${profileName}"`, ok: false, note: 'Save failed' });
      }
    }

    // Step 7: Summary
    console.log('\n--- Setup Summary ---');
    for (const check of checks) {
      const icon = check.ok ? '[OK]' : '[!!]';
      const note = check.note ? ` — ${check.note}` : '';
      console.log(`  ${icon} ${check.label}${note}`);
    }

    const allOk = checks.every((c) => c.ok);
    if (allOk) {
      console.log('\nSetup complete. Start the agent with:');
      const urlPart = options.url ? ` --url ${options.url}` : ' --url <coordinator-url>';
      const tokenPart = options.token ? ` --token <token>` : ' --token <token>';
      const namePart = options.name ? ` --name ${options.name}` : ' --name <agent-name>';
      console.log(`  coord agent${urlPart}${tokenPart}${namePart}`);
    } else {
      console.log('\nAddress the issues above, then re-run `coord setup` or start the agent manually.');
      process.exit(1);
    }
  });
