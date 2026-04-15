import { Command } from 'commander';
import {
  loadTemplate,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  type TaskTemplate,
  type TaskTemplateVariable,
} from '../../shared/templates.js';

/** Parse a --var flag value: "name:description:required:default" */
function parseVarFlag(raw: string): [string, TaskTemplateVariable] {
  const parts = raw.split(':');
  const name = parts[0] ?? '';
  if (!name) throw new Error(`Invalid --var value: "${raw}" — expected name:description:required:default`);
  const def: TaskTemplateVariable = {};
  if (parts[1]) def.description = parts[1];
  if (parts[2]) def.required = parts[2].toLowerCase() === 'true' || parts[2] === '1';
  if (parts[3] !== undefined && parts[3] !== '') def.default = parts[3];
  return [name, def];
}

const listCmd = new Command('list')
  .description('List all saved templates')
  .action(() => {
    const templates = listTemplates();
    if (templates.length === 0) {
      console.log('No templates found. Create one with: coord templates create <name> --prompt "..."');
      return;
    }
    const nameWidth = Math.max(4, ...templates.map((t) => t.name.length));
    const header = `${'NAME'.padEnd(nameWidth)}  DESCRIPTION`;
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const t of templates) {
      console.log(`${t.name.padEnd(nameWidth)}  ${t.description ?? ''}`);
    }
  });

const showCmd = new Command('show')
  .description('Pretty-print a template')
  .argument('<name>', 'Template name')
  .action((name: string) => {
    const tmpl = loadTemplate(name);
    if (!tmpl) {
      console.error(`Template "${name}" not found.`);
      process.exit(1);
    }
    console.log(JSON.stringify(tmpl, null, 2));
  });

const createCmd = new Command('create')
  .description('Create a new template')
  .argument('<name>', 'Template name (used as filename)')
  .requiredOption('--prompt <text>', 'Prompt text (use {{varName}} for variables)')
  .option('--description <text>', 'Human-readable description')
  .option('--on <agent>', 'Default target agent')
  .option('--budget <usd>', 'Default budget in USD')
  .option('--allowed-tools <tools>', 'Comma-separated tools to allow')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny')
  .option('--add-dirs <dirs>', 'Comma-separated additional directories')
  .option(
    '--var <spec>',
    'Variable definition: name:description:required:default (repeatable)',
    (v: string, acc: string[]) => { acc.push(v); return acc; },
    [] as string[]
  )
  .action((name: string, options: {
    prompt: string;
    description?: string;
    on?: string;
    budget?: string;
    allowedTools?: string;
    disallowedTools?: string;
    addDirs?: string;
    var: string[];
  }) => {
    const template: TaskTemplate = {
      name,
      prompt: options.prompt,
    };
    if (options.description) template.description = options.description;
    if (options.on) template.on = options.on;
    if (options.budget) template.budget = options.budget;
    if (options.allowedTools) {
      template.allowedTools = options.allowedTools.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (options.disallowedTools) {
      template.disallowedTools = options.disallowedTools.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (options.addDirs) {
      template.addDirs = options.addDirs.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (options.var.length > 0) {
      template.variables = {};
      for (const raw of options.var) {
        const [varName, varDef] = parseVarFlag(raw);
        template.variables[varName] = varDef;
      }
    }

    saveTemplate(template);
    console.log(`Template "${name}" saved.`);
  });

const deleteCmd = new Command('delete')
  .description('Delete a template')
  .argument('<name>', 'Template name')
  .action((name: string) => {
    try {
      deleteTemplate(name);
      console.log(`Template "${name}" deleted.`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

export const templatesCommand = new Command('templates')
  .description('Manage reusable task templates')
  .addCommand(listCmd)
  .addCommand(showCmd)
  .addCommand(createCmd)
  .addCommand(deleteCmd);
