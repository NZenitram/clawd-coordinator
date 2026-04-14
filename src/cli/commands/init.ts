import { Command } from 'commander';
import { generateToken } from '../../shared/auth.js';
import { saveConfig, loadConfig, getConfigPath } from '../../shared/config.js';

export const initCommand = new Command('init')
  .description('Initialize coordination config and generate auth token')
  .option('--force', 'Overwrite existing config')
  .action((options: { force?: boolean }) => {
    const existing = loadConfig();
    if (existing && !options.force) {
      console.log(`Config already exists at ${getConfigPath()}`);
      console.log('Use --force to regenerate.');
      return;
    }

    const token = generateToken();
    saveConfig({ token, port: 8080 });

    console.log(`Config written to ${getConfigPath()}`);
    console.log(`Token: ${token}`);
    console.log('');
    console.log('Start the coordinator:');
    console.log('  coord serve');
    console.log('');
    console.log('Connect a remote agent:');
    console.log(`  coord agent --url wss://<coordinator-host>:8080 --token ${token} --name <agent-name>`);
  });
