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
  body?: unknown,
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

function getCoordinatorUrl(options: { url?: string }, config: ReturnType<typeof requireConfig>): string {
  return options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
}

const webhookCommand = new Command('webhook')
  .description('Manage webhook triggers');

const webhookCreateCommand = new Command('create')
  .description('Create a webhook that dispatches a task when triggered')
  .requiredOption('--name <name>', 'Unique webhook name')
  .requiredOption('--on <agent>', 'Agent to dispatch tasks to')
  .requiredOption('--prompt <template>', 'Prompt template (use {{payload.field}} for substitution)')
  .option('--secret <secret>', 'HMAC-SHA256 secret for signature verification')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { name: string; on: string; prompt: string; secret?: string; url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorUrl(options, config);
    const res = await apiRequest('POST', baseUrl, '/api/webhooks', config.token, {
      name: options.name,
      agentName: options.on,
      promptTemplate: options.prompt,
      secret: options.secret,
    });
    if (res.statusCode !== 201) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const webhook = (res.body as any).webhook;
    console.log(`Webhook "${webhook.name}" created (id: ${webhook.id})`);
    console.log(`  Agent    : ${webhook.agentName}`);
    console.log(`  Template : ${webhook.promptTemplate}`);
    console.log(`  Trigger  : POST /hooks/${webhook.name}`);
  });

const webhookListCommand = new Command('list')
  .description('List all webhooks')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorUrl(options, config);
    const res = await apiRequest('GET', baseUrl, '/api/webhooks', config.token);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const webhooks = (res.body as any).webhooks as Array<{
      id: string;
      name: string;
      agentName: string;
      promptTemplate: string;
      triggerCount: number;
      lastTriggeredAt?: number;
      createdAt: number;
    }>;
    if (webhooks.length === 0) {
      console.log('No webhooks found. Use "coord webhook create" to create one.');
      return;
    }
    const header = 'NAME                 AGENT                TRIGGERS  CREATED';
    const separator = '-'.repeat(header.length);
    console.log(header);
    console.log(separator);
    for (const w of webhooks) {
      const date = new Date(w.createdAt).toISOString().slice(0, 10);
      const col1 = w.name.padEnd(20);
      const col2 = w.agentName.padEnd(20);
      const col3 = String(w.triggerCount).padEnd(9);
      console.log(`${col1} ${col2} ${col3} ${date}`);
    }
  });

const webhookDeleteCommand = new Command('delete')
  .description('Delete a webhook')
  .argument('<name>', 'Webhook name')
  .option('--url <url>', 'Coordinator URL')
  .action(async (name: string, options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorUrl(options, config);
    const res = await apiRequest('DELETE', baseUrl, `/api/webhooks/${encodeURIComponent(name)}`, config.token);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    console.log(`Webhook "${name}" deleted.`);
  });

const webhookTestCommand = new Command('test')
  .description('Dry-run a webhook with a sample payload (no task dispatched)')
  .argument('<name>', 'Webhook name')
  .option('--payload <json>', 'JSON payload to render the template with', '{}')
  .option('--url <url>', 'Coordinator URL')
  .action(async (name: string, options: { payload: string; url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorUrl(options, config);
    let samplePayload: unknown;
    try {
      samplePayload = JSON.parse(options.payload);
    } catch {
      console.error('Error: --payload must be valid JSON');
      process.exit(1);
    }
    const res = await apiRequest('POST', baseUrl, `/api/webhooks/${encodeURIComponent(name)}/test`, config.token, samplePayload);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const result = res.body as any;
    console.log(`Rendered prompt for webhook "${result.webhook}":`);
    console.log('');
    console.log(result.renderedPrompt);
  });

webhookCommand.addCommand(webhookCreateCommand);
webhookCommand.addCommand(webhookListCommand);
webhookCommand.addCommand(webhookDeleteCommand);
webhookCommand.addCommand(webhookTestCommand);

export { webhookCommand };
