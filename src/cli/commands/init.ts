import { Command } from 'commander';
import { generateToken } from '../../shared/auth.js';
import { saveConfig, loadConfig, getConfigPath } from '../../shared/config.js';

export const initCommand = new Command('init')
  .description('Initialize coordination config and generate auth token')
  .option('--force', 'Overwrite existing config')
  .option('--show-token', 'Display the generated token')
  .action((options: { force?: boolean; showToken?: boolean }) => {
    const existing = loadConfig();
    if (existing && !options.force) {
      console.log(`Config already exists at ${getConfigPath()}`);
      console.log('Use --force to regenerate.');
      return;
    }

    const token = generateToken();
    saveConfig({ token, port: 8080 });

    console.log(`Config written to ${getConfigPath()}`);
    if (options.showToken) {
      console.log(`Token: ${token}`);
    } else {
      console.log('Token saved to config file (use --show-token to display).');
    }
    console.log('');
    console.log('Start the coordinator:');
    console.log('  coord serve');
    console.log('');
    console.log('Connect a remote agent:');
    console.log('  coord agent --url wss://<coordinator-host>:8080 --name <agent-name>');
  });
