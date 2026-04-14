import { Command } from 'commander';

export const sessionsCommand = new Command('sessions')
  .description('List Claude Code sessions on a remote agent')
  .requiredOption('--on <agent>', 'Target agent name')
  .option('--url <url>', 'Coordinator URL')
  .action(async () => {
    console.log('Session listing not yet implemented — coming in a future version.');
    console.log('Use "coord run" with --session to resume a known session ID.');
  });

export const resumeCommand = new Command('resume')
  .description('Resume a Claude Code session on a remote agent')
  .argument('<session-id>', 'Session ID to resume')
  .requiredOption('--on <agent>', 'Target agent name')
  .argument('[prompt]', 'New prompt for the session')
  .option('--url <url>', 'Coordinator URL')
  .action(async (sessionId: string, prompt: string | undefined, options: { on: string; url?: string }) => {
    if (!prompt) {
      console.error('Prompt is required when resuming a session.');
      process.exit(1);
    }
    console.log(`Resuming session ${sessionId} on ${options.on}...`);
    console.log('Use: coord run "prompt" --on ' + options.on + ' --session ' + sessionId);
  });
