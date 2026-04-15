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
    // Convert ws(s):// to http(s)://
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

const usersCommand = new Command('users')
  .description('Manage users and API keys');

const usersListCommand = new Command('list')
  .description('List all users (admin only)')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('GET', baseUrl, '/api/users', config.token);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const users = (res.body as any).users as Array<{ id: string; username: string; role: string; createdAt: number }>;
    if (users.length === 0) {
      console.log('No users found.');
      return;
    }
    const header = 'ID                                    USERNAME             ROLE       CREATED';
    const separator = '-'.repeat(header.length);
    console.log(header);
    console.log(separator);
    for (const u of users) {
      const date = new Date(u.createdAt).toISOString().slice(0, 10);
      console.log(`${u.id}  ${u.username.padEnd(20)} ${u.role.padEnd(10)} ${date}`);
    }
  });

const usersCreateCommand = new Command('create')
  .description('Create a new user (admin only)')
  .argument('<username>', 'Username')
  .option('--role <role>', 'Role: admin, operator, viewer', 'operator')
  .option('--url <url>', 'Coordinator URL')
  .action(async (username: string, options: { role: string; url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('POST', baseUrl, '/api/users', config.token, { username, role: options.role });
    if (res.statusCode !== 201) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const user = (res.body as any).user;
    console.log(`Created user: ${user.username} (id: ${user.id}, role: ${user.role})`);
  });

const usersCreateKeyCommand = new Command('create-key')
  .description('Create an API key for a user (admin only). Key is shown only once.')
  .argument('<username>', 'Username')
  .option('--label <label>', 'Label for the key')
  .option('--url <url>', 'Coordinator URL')
  .action(async (username: string, options: { label?: string; url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);

    // First resolve username → user id
    const listRes = await apiRequest('GET', baseUrl, '/api/users', config.token);
    if (listRes.statusCode !== 200) {
      const err = (listRes.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${listRes.statusCode}: ${err}`);
      process.exit(1);
    }
    const users = (listRes.body as any).users as Array<{ id: string; username: string }>;
    const user = users.find(u => u.username === username);
    if (!user) {
      console.error(`User "${username}" not found.`);
      process.exit(1);
    }

    const keyRes = await apiRequest('POST', baseUrl, `/api/users/${user.id}/keys`, config.token, { label: options.label });
    if (keyRes.statusCode !== 201) {
      const err = (keyRes.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${keyRes.statusCode}: ${err}`);
      process.exit(1);
    }
    const { keyId, key } = keyRes.body as any;
    console.log(`API key created for ${username}:`);
    console.log(`  Key ID : ${keyId}`);
    console.log(`  Key    : ${key}`);
    console.log('');
    console.log('Store this key securely — it will not be shown again.');
  });

usersCommand.addCommand(usersListCommand);
usersCommand.addCommand(usersCreateCommand);
usersCommand.addCommand(usersCreateKeyCommand);

export { usersCommand };
