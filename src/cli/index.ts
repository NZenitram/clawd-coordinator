#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { serveCommand } from './commands/serve.js';
import { agentCommand } from './commands/agent.js';
import { agentsCommand } from './commands/agents.js';
import { runCommand } from './commands/run.js';
import { fanOutCommand } from './commands/fan-out.js';
import { tasksListCommand, attachCommand, resultCommand } from './commands/tasks.js';

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

program.parse();
