#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command();

program
  .name('coord')
  .description('Orchestrate remote Claude Code sessions')
  .version('0.1.0');

program.parse();
