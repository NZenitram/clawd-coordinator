#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { serveCommand } from './commands/serve.js';
import { agentCommand } from './commands/agent.js';
import { agentsCommand } from './commands/agents.js';
import { runCommand } from './commands/run.js';
import { fanOutCommand } from './commands/fan-out.js';
import { tasksListCommand, attachCommand, resultCommand } from './commands/tasks.js';
import { sessionsCommand, resumeCommand } from './commands/sessions.js';
import { mcpCommand } from './commands/mcp.js';
import { dashboardCommand } from './commands/dashboard.js';
import { usersCommand } from './commands/users.js';
import { orgsCommand } from './commands/orgs.js';
import { sendMessageCommand } from './commands/send-message.js';
import { pushCommand } from './commands/push.js';
import { pullCommand } from './commands/pull.js';
import { transferCommand } from './commands/transfer.js';
import { describeCommand } from './commands/describe.js';
import { claudeMdCommand } from './commands/claude-md.js';

const program = new Command();

program
  .name('coord')
  .description('Orchestrate remote Claude Code sessions')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(serveCommand);
program.addCommand(agentCommand);
program.addCommand(agentsCommand);
program.addCommand(runCommand);
program.addCommand(fanOutCommand);
program.addCommand(tasksListCommand);
program.addCommand(attachCommand);
program.addCommand(resultCommand);
program.addCommand(sessionsCommand);
program.addCommand(resumeCommand);
program.addCommand(mcpCommand);
program.addCommand(dashboardCommand);
program.addCommand(usersCommand);
program.addCommand(orgsCommand);
program.addCommand(sendMessageCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);
program.addCommand(transferCommand);
program.addCommand(describeCommand);
program.addCommand(claudeMdCommand);

program.parse();
