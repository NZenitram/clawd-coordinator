import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
import { UserStore } from '../../src/coordinator/user-store.js';
import {
  parseMessage,
  serializeMessage,
  createAgentRegister,
  createTaskOutput,
  createTaskComplete,
} from '../../src/protocol/messages.js';
import { connectCli, sendRequest } from '../../src/cli/output.js';

const TEST_TOKEN = 'multi-tenant-test-token';
const TEST_PORT = 9901;

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function connectAgent(port: number, token: string, name: string): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://localhost:${port}/agent`, {
      headers: { 'authorization': `Bearer ${token}` },
    });
    w.on('open', () => resolve(w));
    w.on('error', reject);
  });
  ws.send(serializeMessage(createAgentRegister({ name, os: 'linux', arch: 'x64' })));
  // Make the agent echo task:dispatch with output + complete
  ws.on('message', (raw) => {
    const msg = parseMessage(raw.toString());
    if (!msg || msg.type !== 'task:dispatch') return;
    const taskId = msg.payload.taskId;
    ws.send(serializeMessage(createTaskOutput({ taskId, data: `output from ${name}` })));
    ws.send(serializeMessage(createTaskComplete({ taskId })));
  });
  await sleep(50);
  return ws;
}

describe('Multi-tenant org isolation', () => {
  let coordinator: Coordinator;
  let userStore: UserStore;

  afterEach(async () => {
    if (coordinator) await coordinator.stop();
  });

  it('agent in org A is not visible from CLI in org B', async () => {
    userStore = await UserStore.create();

    // Create two orgs
    const orgA = userStore.createOrg('org-a');
    const orgB = userStore.createOrg('org-b');

    // Create users
    const userA = userStore.createUser('user-a', 'operator');
    const userB = userStore.createUser('user-b', 'operator');
    userStore.addOrgMember(orgA.id, userA.id, 'operator');
    userStore.addOrgMember(orgB.id, userB.id, 'operator');

    // Create API keys
    const { key: keyA } = userStore.createApiKey(userA.id, 'key-a');
    const { key: keyB } = userStore.createApiKey(userB.id, 'key-b');

    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN, userStore });
    await coordinator.start();

    // Connect agent to org A
    await connectAgent(TEST_PORT, keyA, 'agent-alpha');

    // CLI for org B — should see no agents
    const cliB = await connectCli(`ws://localhost:${TEST_PORT}`, keyB);
    const agentsResponse = await sendRequest(cliB, 'list-agents', {});
    const agents = (agentsResponse.payload as any).data.agents as unknown[];
    expect(agents).toHaveLength(0);

    cliB.close();
  });

  it('task dispatched in org A is not visible from org B list-tasks', async () => {
    userStore = await UserStore.create();

    const orgA = userStore.createOrg('alpha');
    const orgB = userStore.createOrg('beta');

    const userA = userStore.createUser('alice', 'operator');
    const userB = userStore.createUser('bob', 'operator');
    userStore.addOrgMember(orgA.id, userA.id, 'operator');
    userStore.addOrgMember(orgB.id, userB.id, 'operator');

    const { key: keyA } = userStore.createApiKey(userA.id);
    const { key: keyB } = userStore.createApiKey(userB.id);

    coordinator = new Coordinator({ port: TEST_PORT + 1, token: TEST_TOKEN, userStore });
    await coordinator.start();

    // Connect agent for org A
    await connectAgent(TEST_PORT + 1, keyA, 'agent-a');

    // Dispatch task as org A
    const cliA = await connectCli(`ws://localhost:${TEST_PORT + 1}`, keyA);
    const dispatchRes = await sendRequest(cliA, 'dispatch-task', {
      agentName: 'agent-a',
      prompt: 'hello from org A',
    });
    expect((dispatchRes.payload as any).error).toBeUndefined();
    await sleep(100);

    // List tasks from org B — should be empty
    const cliB = await connectCli(`ws://localhost:${TEST_PORT + 1}`, keyB);
    const tasksRes = await sendRequest(cliB, 'list-tasks', {});
    const tasks = (tasksRes.payload as any).data.tasks as unknown[];
    expect(tasks).toHaveLength(0);

    cliA.close();
    cliB.close();
  });

  it('legacy shared token uses default org — backward compatible', async () => {
    coordinator = new Coordinator({ port: TEST_PORT + 2, token: TEST_TOKEN });
    await coordinator.start();

    // Agent and CLI both use the shared token (no UserStore)
    const agentWs = await connectAgent(TEST_PORT + 2, TEST_TOKEN, 'legacy-agent');

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT + 2}`, TEST_TOKEN);
    const agentsResponse = await sendRequest(cliWs, 'list-agents', {});
    const agents = (agentsResponse.payload as any).data.agents as Array<{ name: string }>;
    expect(agents.some(a => a.name === 'legacy-agent')).toBe(true);

    agentWs.close();
    cliWs.close();
  });

  it('two agents in the same org can be listed by a CLI in that org', async () => {
    userStore = await UserStore.create();

    const orgA = userStore.createOrg('shared-org');

    const userAgent1 = userStore.createUser('agent-user-1', 'operator');
    const userAgent2 = userStore.createUser('agent-user-2', 'operator');
    const userCli = userStore.createUser('cli-user', 'operator');

    userStore.addOrgMember(orgA.id, userAgent1.id, 'operator');
    userStore.addOrgMember(orgA.id, userAgent2.id, 'operator');
    userStore.addOrgMember(orgA.id, userCli.id, 'operator');

    const { key: keyAgent1 } = userStore.createApiKey(userAgent1.id);
    const { key: keyAgent2 } = userStore.createApiKey(userAgent2.id);
    const { key: keyCli } = userStore.createApiKey(userCli.id);

    coordinator = new Coordinator({ port: TEST_PORT + 3, token: TEST_TOKEN, userStore });
    await coordinator.start();

    await connectAgent(TEST_PORT + 3, keyAgent1, 'bot-one');
    await connectAgent(TEST_PORT + 3, keyAgent2, 'bot-two');

    const cli = await connectCli(`ws://localhost:${TEST_PORT + 3}`, keyCli);
    const agentsResponse = await sendRequest(cli, 'list-agents', {});
    const agents = (agentsResponse.payload as any).data.agents as Array<{ name: string }>;
    const names = agents.map((a: { name: string }) => a.name);
    expect(names).toContain('bot-one');
    expect(names).toContain('bot-two');

    cli.close();
  });
});
