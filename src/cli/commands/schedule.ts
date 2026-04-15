import { Command } from 'commander';
import http from 'node:http';
import https from 'node:https';
import { requireConfig } from '../../shared/config.js';

interface HttpResponse {
  statusCode: number;
  body: unknown;
}

function apiRequest(
  method: string,
  coordinatorUrl: string,
  path: string,
  token: string,
  body?: unknown
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(coordinatorUrl);
    const scheme = url.protocol === 'wss:' ? 'https:' : 'http:';
    const host = url.hostname;
    const port = url.port || (scheme === 'https:' ? '443' : '80');
    const httpUrl = `${scheme}//${host}:${port}${path}`;

    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (bodyStr !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const lib = scheme === 'https:' ? https : http;
    const req = lib.request(httpUrl, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsedBody = null;
        }
        resolve({ statusCode: res.statusCode ?? 0, body: parsedBody });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function getCoordinatorHttpUrl(options: { url?: string }, config: ReturnType<typeof requireConfig>): string {
  return options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
}

function fmtDate(ms: number | undefined): string {
  if (ms === undefined) return '-';
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export const scheduleCommand = new Command('schedule')
  .description('Manage scheduled tasks');

const scheduleCreateCommand = new Command('create')
  .description('Create a new scheduled task')
  .requiredOption('--cron <expr>', 'Cron expression (e.g. "0 6 * * *")')
  .requiredOption('--on <agent>', 'Target agent name')
  .requiredOption('--prompt <prompt>', 'Prompt to dispatch on each run')
  .option('--budget <usd>', 'Budget per run in USD')
  .option('--tools <tools>', 'Comma-separated list of allowed tools')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { cron: string; on: string; prompt: string; budget?: string; tools?: string; url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);

    const body: Record<string, unknown> = {
      cronExpr: options.cron,
      agentName: options.on,
      prompt: options.prompt,
    };
    if (options.budget !== undefined) {
      body['budgetUsd'] = parseFloat(options.budget);
    }
    if (options.tools !== undefined) {
      body['allowedTools'] = options.tools.split(',').map(t => t.trim()).filter(Boolean);
    }

    const res = await apiRequest('POST', baseUrl, '/api/schedules', config.token, body);
    if (res.statusCode !== 201) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const schedule = (res.body as any).schedule;
    console.log(`Created schedule: ${schedule.id}`);
    console.log(`  Cron     : ${schedule.cronExpr}`);
    console.log(`  Agent    : ${schedule.agentName}`);
    console.log(`  Next run : ${fmtDate(schedule.nextRunAt)}`);
  });

const scheduleListCommand = new Command('list')
  .description('List all scheduled tasks')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('GET', baseUrl, '/api/schedules', config.token);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const schedules = (res.body as any).schedules as Array<{
      id: string;
      cronExpr: string;
      agentName: string;
      paused: boolean;
      runCount: number;
      nextRunAt?: number;
      prompt: string;
    }>;
    if (schedules.length === 0) {
      console.log('No schedules found.');
      return;
    }
    const header = 'ID                                    CRON            AGENT                STATUS   RUNS  NEXT RUN';
    const separator = '-'.repeat(header.length);
    console.log(header);
    console.log(separator);
    for (const s of schedules) {
      const status = s.paused ? 'paused ' : 'active ';
      const next = fmtDate(s.nextRunAt);
      console.log(
        `${s.id}  ${s.cronExpr.padEnd(15)} ${s.agentName.padEnd(20)} ${status}  ${String(s.runCount).padStart(4)}  ${next}`
      );
    }
  });

const scheduleDeleteCommand = new Command('delete')
  .description('Delete a scheduled task')
  .argument('<id>', 'Schedule ID')
  .option('--url <url>', 'Coordinator URL')
  .action(async (id: string, options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('DELETE', baseUrl, `/api/schedules/${id}`, config.token);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    console.log(`Deleted schedule ${id}`);
  });

const schedulePauseCommand = new Command('pause')
  .description('Pause a scheduled task')
  .argument('<id>', 'Schedule ID')
  .option('--url <url>', 'Coordinator URL')
  .action(async (id: string, options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('PATCH', baseUrl, `/api/schedules/${id}`, config.token, { paused: true });
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    console.log(`Paused schedule ${id}`);
  });

const scheduleResumeCommand = new Command('resume')
  .description('Resume a paused scheduled task')
  .argument('<id>', 'Schedule ID')
  .option('--url <url>', 'Coordinator URL')
  .action(async (id: string, options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('PATCH', baseUrl, `/api/schedules/${id}`, config.token, { paused: false });
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    console.log(`Resumed schedule ${id}`);
  });

scheduleCommand.addCommand(scheduleCreateCommand);
scheduleCommand.addCommand(scheduleListCommand);
scheduleCommand.addCommand(scheduleDeleteCommand);
scheduleCommand.addCommand(schedulePauseCommand);
scheduleCommand.addCommand(scheduleResumeCommand);
