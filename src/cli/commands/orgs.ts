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

export const orgsCommand = new Command('orgs')
  .description('Manage organizations');

const orgsListCommand = new Command('list')
  .description('List orgs you belong to')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('GET', baseUrl, '/api/orgs', config.token);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const orgs = (res.body as any).orgs as Array<{ id: string; name: string; createdAt: number; memberRole?: string }>;
    if (!orgs || orgs.length === 0) {
      console.log('No orgs found.');
      return;
    }
    const header = 'ID                                    NAME                 ROLE       CREATED';
    const separator = '-'.repeat(header.length);
    console.log(header);
    console.log(separator);
    for (const o of orgs) {
      const date = new Date(o.createdAt).toISOString().slice(0, 10);
      const role = o.memberRole ?? '-';
      console.log(`${o.id}  ${o.name.padEnd(20)} ${role.padEnd(10)} ${date}`);
    }
  });

const orgsCreateCommand = new Command('create')
  .description('Create a new organization (admin only)')
  .argument('<name>', 'Organization name')
  .option('--url <url>', 'Coordinator URL')
  .action(async (name: string, options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);
    const res = await apiRequest('POST', baseUrl, '/api/orgs', config.token, { name });
    if (res.statusCode !== 201) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    const org = (res.body as any).org;
    console.log(`Created org: ${org.name} (id: ${org.id})`);
  });

const orgsAddMemberCommand = new Command('add-member')
  .description('Add a member to an org (org admin only)')
  .argument('<org>', 'Org ID or name')
  .argument('<username>', 'Username to add')
  .option('--role <role>', 'Role: admin, operator, viewer', 'operator')
  .option('--url <url>', 'Coordinator URL')
  .action(async (orgArg: string, username: string, options: { role: string; url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);

    // Resolve org by listing orgs
    const orgsRes = await apiRequest('GET', baseUrl, '/api/orgs', config.token);
    if (orgsRes.statusCode !== 200) {
      const err = (orgsRes.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${orgsRes.statusCode}: ${err}`);
      process.exit(1);
    }
    const orgs = (orgsRes.body as any).orgs as Array<{ id: string; name: string }>;
    const org = orgs.find(o => o.id === orgArg || o.name === orgArg);
    if (!org) {
      console.error(`Org "${orgArg}" not found.`);
      process.exit(1);
    }

    // Resolve username → user id
    const usersRes = await apiRequest('GET', baseUrl, '/api/users', config.token);
    if (usersRes.statusCode !== 200) {
      const err = (usersRes.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${usersRes.statusCode}: ${err}`);
      process.exit(1);
    }
    const users = (usersRes.body as any).users as Array<{ id: string; username: string }>;
    const user = users.find(u => u.username === username);
    if (!user) {
      console.error(`User "${username}" not found.`);
      process.exit(1);
    }

    const res = await apiRequest('POST', baseUrl, `/api/orgs/${org.id}/members`, config.token, {
      userId: user.id,
      role: options.role,
    });
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    console.log(`Added ${username} to org ${org.name} with role ${options.role}.`);
  });

const orgsRemoveMemberCommand = new Command('remove-member')
  .description('Remove a member from an org (org admin only)')
  .argument('<org>', 'Org ID or name')
  .argument('<username>', 'Username to remove')
  .option('--url <url>', 'Coordinator URL')
  .action(async (orgArg: string, username: string, options: { url?: string }) => {
    const config = requireConfig();
    const baseUrl = getCoordinatorHttpUrl(options, config);

    // Resolve org
    const orgsRes = await apiRequest('GET', baseUrl, '/api/orgs', config.token);
    if (orgsRes.statusCode !== 200) {
      const err = (orgsRes.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${orgsRes.statusCode}: ${err}`);
      process.exit(1);
    }
    const orgs = (orgsRes.body as any).orgs as Array<{ id: string; name: string }>;
    const org = orgs.find(o => o.id === orgArg || o.name === orgArg);
    if (!org) {
      console.error(`Org "${orgArg}" not found.`);
      process.exit(1);
    }

    // Resolve username → user id
    const usersRes = await apiRequest('GET', baseUrl, '/api/users', config.token);
    if (usersRes.statusCode !== 200) {
      const err = (usersRes.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${usersRes.statusCode}: ${err}`);
      process.exit(1);
    }
    const users = (usersRes.body as any).users as Array<{ id: string; username: string }>;
    const user = users.find(u => u.username === username);
    if (!user) {
      console.error(`User "${username}" not found.`);
      process.exit(1);
    }

    const res = await apiRequest('DELETE', baseUrl, `/api/orgs/${org.id}/members/${user.id}`, config.token);
    if (res.statusCode !== 200) {
      const err = (res.body as any)?.error ?? 'Unknown error';
      console.error(`Error ${res.statusCode}: ${err}`);
      process.exit(1);
    }
    console.log(`Removed ${username} from org ${org.name}.`);
  });

orgsCommand.addCommand(orgsListCommand);
orgsCommand.addCommand(orgsCreateCommand);
orgsCommand.addCommand(orgsAddMemberCommand);
orgsCommand.addCommand(orgsRemoveMemberCommand);
