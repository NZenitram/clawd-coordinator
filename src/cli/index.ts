#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './commands/init.js';

const program = new Command();

program
  .name('coord')
  .description('Orchestrate remote Claude Code sessions')
  .version('0.1.0');

program.addCommand(initCommand);

program.parse();
