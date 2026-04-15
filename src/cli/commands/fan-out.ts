import { Command } from 'commander';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';
import { parseMessage } from '../../protocol/messages.js';
import { loadTemplate, substituteVariables, parseVars, validateVariables, resolveVariables } from '../../shared/templates.js';

export const fanOutCommand = new Command('fan-out')
  .description('Dispatch a prompt to multiple agents in parallel')
  .argument('[prompt]', 'The prompt to send (optional when --template is used)')
  .option('--on <agents>', 'Comma-separated agent names')
  .option('--pool <name>', 'Target agent pool — dispatches to ALL agents in the pool')
  .option('--url <url>', 'Coordinator URL')
  .option('--budget <usd>', 'Maximum budget in USD per task')
  .option('--allowed-tools <tools>', 'Comma-separated tools to allow for this task')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny for this task')
  .option('--add-dirs <dirs>', 'Comma-separated additional directories for this task')
  .option('--upload <spec>', 'Upload <local>:<remote> to each agent before dispatch (repeatable)', (v, a: string[]) => { a.push(v); return a; }, [] as string[])
  .option('--download <spec>', 'Download <remote>:<local> from each agent after task completes (repeatable)', (v, a: string[]) => { a.push(v); return a; }, [] as string[])
  .option('--template <name>', 'Load a saved task template')
  .option('--vars <key=value,...>', 'Variable substitutions for the template (comma-separated key=value pairs)')
  .action(async (promptArg: string | undefined, options: { on?: string; pool?: string; url?: string; budget?: string; allowedTools?: string; disallowedTools?: string; addDirs?: string; upload: string[]; download: string[]; template?: string; vars?: string }) => {
    // Resolve template if provided
    let resolvedPrompt = promptArg;
    let templateBudget: string | undefined;

    if (options.template) {
      const tmpl = loadTemplate(options.template);
      if (!tmpl) {
        console.error(`Template "${options.template}" not found.`);
        process.exit(1);
      }
      const userVars = options.vars ? parseVars(options.vars) : {};
      const missing = validateVariables(tmpl, userVars);
      if (missing.length > 0) {
        console.error(`Missing required template variables: ${missing.join(', ')}`);
        process.exit(1);
      }
      const resolved = resolveVariables(tmpl, userVars);

      if (!resolvedPrompt) resolvedPrompt = substituteVariables(tmpl.prompt, resolved);
      templateBudget = tmpl.budget;
    }

    if (!resolvedPrompt) {
      console.error('Error: prompt is required (pass as argument or via --template)');
      process.exit(1);
    }

    if (options.on && options.pool) {
      console.error('Error: --on and --pool are mutually exclusive');
      process.exit(1);
    }
    if (!options.on && !options.pool) {
      console.error('Error: one of --on <agents> or --pool <name> is required');
      process.exit(1);
    }

    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
    const budget = options.budget ?? templateBudget;

    const allowedTools = options.allowedTools ? options.allowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const disallowedTools = options.disallowedTools ? options.disallowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const addDirs = options.addDirs ? options.addDirs.split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const ws = await connectCli(url, config.token);

    // Resolve agent list: named agents or all agents in pool
    let agentNames: string[];
    if (options.pool) {
      const listResponse = await sendRequest(ws, 'list-agents');
      const listPayload = listResponse.payload as { data: { agents: Array<{ name: string; pool?: string }> }; error?: string };
      if (listPayload.error) {
        console.error(`Error listing agents: ${listPayload.error}`);
        ws.close();
        process.exit(1);
      }
      agentNames = listPayload.data.agents
        .filter((a) => a.pool === options.pool)
        .map((a) => a.name);
      if (agentNames.length === 0) {
        console.error(`No agents found in pool "${options.pool}"`);
        ws.close();
        process.exit(1);
      }
    } else {
      agentNames = options.on!.split(',').map(s => s.trim());
    }

    const taskIds: string[] = [];
    const completedTasks = new Set<string>();
    const failedTasks = new Set<string>();

    for (const agentName of agentNames) {
      const response = await sendRequest(ws, 'dispatch-task', {
        agentName,
        prompt: resolvedPrompt,
        maxBudgetUsd: budget ? parseFloat(budget) : undefined,
        allowedTools,
        disallowedTools,
        addDirs,
      });

      const payload = response.payload as any;
      if (payload.error) {
        console.error(`[${agentName}] Error: ${payload.error}`);
        continue;
      }
      taskIds.push(payload.data.taskId);
      console.log(`[${agentName}] Task dispatched: ${payload.data.taskId}`);
    }

    if (taskIds.length === 0) {
      console.error('No tasks dispatched.');
      ws.close();
      process.exit(1);
    }

    const taskIdSet = new Set(taskIds);

    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      if (msg.type === 'task:output' && taskIdSet.has(msg.payload.taskId)) {
        process.stdout.write(`[${msg.payload.taskId.slice(0, 8)}] ${msg.payload.data}\n`);
      } else if (msg.type === 'task:complete' && taskIdSet.has(msg.payload.taskId)) {
        completedTasks.add(msg.payload.taskId);
        console.log(`[${msg.payload.taskId.slice(0, 8)}] Completed`);
        checkDone();
      } else if (msg.type === 'task:error' && taskIdSet.has(msg.payload.taskId)) {
        failedTasks.add(msg.payload.taskId);
        console.error(`[${msg.payload.taskId.slice(0, 8)}] Failed: ${msg.payload.error}`);
        checkDone();
      }
    });

    function checkDone() {
      if (completedTasks.size + failedTasks.size === taskIds.length) {
        console.log(`\nDone: ${completedTasks.size} completed, ${failedTasks.size} failed`);
        ws.close();
        if (failedTasks.size > 0) process.exit(1);
      }
    }
  });
