import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
import { UserStore } from '../../src/coordinator/user-store.js';
import {
  createAgentRegister,
  createAgentHeartbeat,
  createCliRequest,
  createTaskError,
  serializeMessage,
  parseMessage,
} from '../../src/protocol/messages.js';

const TEST_TOKEN = 'test-token-abc123';
const TEST_PORT = 9876;

function connectWs(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}${path}`, {
      headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
  });
}

function sendAndReceive(ws: WebSocket, msg: string): Promise<string> {
  const p = waitForMessage(ws);
  ws.send(msg);
  return p;
}

describe('Coordinator', () => {
  let coordinator: Coordinator;

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
  });

  it('starts and stops', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();
    await coordinator.stop();
  });

  it('rejects agent connection with bad token', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
      headers: { 'authorization': 'Bearer wrong' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => resolve()); // Rejected at HTTP 401 before WS upgrade
      ws.on('open', () => reject(new Error('Should not have connected')));
    });
  });

  it('accepts agent connection with valid token and registration', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const ws = await connectWs('/agent');
    const registerMsg = createAgentRegister({ name: 'test-agent', os: 'linux', arch: 'x64' });
    ws.send(serializeMessage(registerMsg));

    await new Promise(r => setTimeout(r, 50));

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'list-agents' }))
    );
    const parsed = parseMessage(response);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('cli:response');
    const agents = (parsed!.payload as { data: { agents: unknown[] } }).data.agents;
    expect(agents).toHaveLength(1);

    ws.close();
    cli.close();
  });

  it('handles agent heartbeat', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const ws = await connectWs('/agent');
    const registerMsg = createAgentRegister({ name: 'test-agent', os: 'linux', arch: 'x64' });
    ws.send(serializeMessage(registerMsg));
    await new Promise(r => setTimeout(r, 50));

    const heartbeatMsg = createAgentHeartbeat({ name: 'test-agent' });
    ws.send(serializeMessage(heartbeatMsg));
    await new Promise(r => setTimeout(r, 50));

    ws.close();
  });

  it('rejects dispatch-task with missing args', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: {} }))
    );
    const parsed = parseMessage(response);
    expect(parsed).not.toBeNull();
    expect((parsed!.payload as any).error).toContain('Missing required arguments');

    cli.close();
  });

  it('rejects list-tasks with invalid status filter', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'list-tasks', args: { status: 'bogus' } }))
    );
    const parsed = parseMessage(response);
    expect(parsed).not.toBeNull();
    expect((parsed!.payload as any).error).toContain('Invalid status filter');

    cli.close();
  });

  it('removes agent on disconnect', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const ws = await connectWs('/agent');
    const registerMsg = createAgentRegister({ name: 'test-agent', os: 'linux', arch: 'x64' });
    ws.send(serializeMessage(registerMsg));
    await new Promise(r => setTimeout(r, 50));

    ws.close();
    await new Promise(r => setTimeout(r, 50));

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'list-agents' }))
    );
    const parsed = parseMessage(response);
    const agents = (parsed!.payload as { data: { agents: unknown[] } }).data.agents;
    expect(agents).toHaveLength(0);

    cli.close();
  });

  it('rejects duplicate agent name while original is connected', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const ws1 = await connectWs('/agent');
    ws1.send(serializeMessage(createAgentRegister({ name: 'dup-agent', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const ws2 = await connectWs('/agent');
    ws2.send(serializeMessage(createAgentRegister({ name: 'dup-agent', os: 'linux', arch: 'x64' })));

    const code = await new Promise<number>((resolve) => {
      ws2.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4003);

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'list-agents' }))
    );
    const parsed = parseMessage(response);
    const agents = (parsed!.payload as { data: { agents: unknown[] } }).data.agents;
    expect(agents).toHaveLength(1);

    ws1.close();
    cli.close();
  });

  it('errors running task when agent disconnects', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await connectWs('/agent');
    agentWs.send(serializeMessage(createAgentRegister({ name: 'crash-agent', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const cli = await connectWs('/cli');
    const dispatchResponse = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'crash-agent', prompt: 'work' } }))
    );
    const taskId = (parseMessage(dispatchResponse)!.payload as any).data.taskId;

    agentWs.close();

    const errorMsg = await new Promise<string>((resolve) => {
      cli.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (msg?.type === 'task:error' && (msg.payload as any).taskId === taskId) {
          resolve((msg.payload as any).error);
        }
      });
    });

    expect(errorMsg).toBe('Agent disconnected while task was running');
    cli.close();
  });

  it('prevents second CLI from subscribing to another CLIs task', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await connectWs('/agent');
    agentWs.send(serializeMessage(createAgentRegister({ name: 'owner-agent', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const cli1 = await connectWs('/cli');
    const dispatchResponse = await sendAndReceive(
      cli1,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'owner-agent', prompt: 'hello' } }))
    );
    const taskId = (parseMessage(dispatchResponse)!.payload as any).data.taskId;

    const cli2 = await connectWs('/cli');
    const subResponse = await sendAndReceive(
      cli2,
      serializeMessage(createCliRequest({ command: 'subscribe-task', args: { taskId } }))
    );
    expect((parseMessage(subResponse)!.payload as any).error).toBe('Not authorized to subscribe to this task');

    agentWs.close();
    cli1.close();
    cli2.close();
  });

  it('refuses dispatch to unhealthy agent', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await connectWs('/agent');
    // Register with health indicating Claude is unavailable
    const registerMsg = createAgentRegister({
      name: 'sick-agent',
      os: 'linux',
      arch: 'x64',
      health: { claudeAvailable: false },
    });
    agentWs.send(serializeMessage(registerMsg));
    await new Promise(r => setTimeout(r, 50));

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'sick-agent', prompt: 'test' } }))
    );
    const parsed = parseMessage(response);
    expect((parsed!.payload as any).error).toContain('unhealthy');

    agentWs.close();
    cli.close();
  });

  it('prevents second CLI from getting another CLIs task', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await connectWs('/agent');
    agentWs.send(serializeMessage(createAgentRegister({ name: 'owner-agent2', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const cli1 = await connectWs('/cli');
    const dispatchResponse = await sendAndReceive(
      cli1,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'owner-agent2', prompt: 'hello' } }))
    );
    const taskId = (parseMessage(dispatchResponse)!.payload as any).data.taskId;

    const cli2 = await connectWs('/cli');
    const getResponse = await sendAndReceive(
      cli2,
      serializeMessage(createCliRequest({ command: 'get-task', args: { taskId } }))
    );
    expect((parseMessage(getResponse)!.payload as any).error).toBe('Not authorized to access this task');

    agentWs.close();
    cli1.close();
    cli2.close();
  });

  // ── RBAC / UserStore integration ────────────────────────────────────────────

  it('viewer cannot dispatch tasks (insufficient permissions)', async () => {
    const userStore = await UserStore.create();
    const user = userStore.createUser('viewer-user', 'viewer');
    const { key } = userStore.createApiKey(user.id, 'test');

    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN, userStore });
    await coordinator.start();

    const agentWs = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
      headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      agentWs.on('open', () => {
        agentWs.send(serializeMessage(createAgentRegister({ name: 'rbac-agent', os: 'linux', arch: 'x64' })));
        setTimeout(resolve, 50);
      });
      agentWs.on('error', reject);
    });

    const viewerWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cli`, {
        headers: { 'authorization': `Bearer ${key}` },
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    const response = await sendAndReceive(
      viewerWs,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'rbac-agent', prompt: 'hello' } }))
    );
    const parsed = parseMessage(response);
    expect((parsed!.payload as any).error).toBe('Insufficient permissions');

    agentWs.close();
    viewerWs.close();
  });

  it('operator can dispatch tasks', async () => {
    const userStore = await UserStore.create();
    const user = userStore.createUser('op-user', 'operator');
    const { key } = userStore.createApiKey(user.id, 'test');

    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN, userStore });
    await coordinator.start();

    const agentWs = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
      headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      agentWs.on('open', () => {
        agentWs.send(serializeMessage(createAgentRegister({ name: 'op-agent', os: 'linux', arch: 'x64' })));
        setTimeout(resolve, 50);
      });
      agentWs.on('error', reject);
    });

    const opWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cli`, {
        headers: { 'authorization': `Bearer ${key}` },
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    const response = await sendAndReceive(
      opWs,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'op-agent', prompt: 'work' } }))
    );
    const parsed = parseMessage(response);
    expect((parsed!.payload as any).error).toBeUndefined();
    expect((parsed!.payload as any).data.taskId).toBeDefined();

    agentWs.close();
    opWs.close();
  });

  it('legacy shared token works as admin (backward compat)', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
      headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      agentWs.on('open', () => {
        agentWs.send(serializeMessage(createAgentRegister({ name: 'legacy-agent', os: 'linux', arch: 'x64' })));
        setTimeout(resolve, 50);
      });
      agentWs.on('error', reject);
    });

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'legacy-agent', prompt: 'run' } }))
    );
    const parsed = parseMessage(response);
    // Should succeed (no permission error)
    expect((parsed!.payload as any).error).toBeUndefined();
    expect((parsed!.payload as any).data.taskId).toBeDefined();

    agentWs.close();
    cli.close();
  });

  it('API key auth rejects bad key with 401', async () => {
    const userStore = await UserStore.create();
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN, userStore });
    await coordinator.start();

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cli`, {
      headers: { 'authorization': 'Bearer not-a-valid-api-key' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => resolve()); // Should get 401
      ws.on('open', () => reject(new Error('Should not have connected')));
    });
  });

  // ── Retry / Dead-letter ─────────────────────────────────────────────────────

  it('retryable error re-enqueues task instead of erroring', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    // Register agent — agent stays connected so retry is eligible
    const agentWs = await connectWs('/agent');
    agentWs.send(serializeMessage(createAgentRegister({ name: 'retry-agent', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    // Dispatch task — this sets status to 'running'
    const cli = await connectWs('/cli');
    const dispatchResp = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'retry-agent', prompt: 'work' } }))
    );
    const taskId = (parseMessage(dispatchResp)!.payload as any).data.taskId;

    // Agent sends a retryable error (capacity-related)
    agentWs.send(serializeMessage(createTaskError({ taskId, error: 'Agent at local capacity (1/1)' })));
    // Give coordinator time to process error and schedule retry
    await new Promise(r => setTimeout(r, 100));

    // Task should be in pending (retrying) state, not error
    const taskResp = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'get-task', args: { taskId } }))
    );
    const task = (parseMessage(taskResp)!.payload as any).data.task;
    expect(task.status).toBe('pending');
    expect(task.retryCount).toBe(1);

    agentWs.close();
    cli.close();
  });

  it('non-retryable error dead-letters the task', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await connectWs('/agent');
    agentWs.send(serializeMessage(createAgentRegister({ name: 'dl-agent', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const cli = await connectWs('/cli');
    const dispatchResp = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'dl-agent', prompt: 'work' } }))
    );
    const taskId = (parseMessage(dispatchResp)!.payload as any).data.taskId;

    // Agent sends a non-retryable error
    agentWs.send(serializeMessage(createTaskError({ taskId, error: 'Claude exited with code 1: fatal error' })));

    // Wait for task:error from coordinator
    const errorMsg = await new Promise<string>((resolve) => {
      cli.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (msg?.type === 'task:error' && (msg.payload as any).taskId === taskId) {
          resolve((msg.payload as any).error);
        }
      });
    });
    expect(errorMsg).toContain('fatal error');

    // Task should be dead-lettered
    const taskResp = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'get-task', args: { taskId } }))
    );
    const task = (parseMessage(taskResp)!.payload as any).data.task;
    expect(task.status).toBe('dead-letter');
    expect(task.deadLettered).toBe(true);

    agentWs.close();
    cli.close();
  });

  it('list-tasks accepts dead-letter status filter', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cli = await connectWs('/cli');
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'list-tasks', args: { status: 'dead-letter' } }))
    );
    const parsed = parseMessage(response);
    expect((parsed!.payload as any).error).toBeUndefined();
    expect(Array.isArray((parsed!.payload as any).data.tasks)).toBe(true);

    cli.close();
  });

  // ── Agent-to-agent messaging ─────────────────────────────────────────────────

  it('relays agent:message between two agents', async () => {
    const { createAgentMessage } = await import('../../src/protocol/messages.js');

    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentA = await connectWs('/agent');
    agentA.send(serializeMessage(createAgentRegister({ name: 'agent-a', os: 'linux', arch: 'x64' })));
    const agentB = await connectWs('/agent');
    agentB.send(serializeMessage(createAgentRegister({ name: 'agent-b', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    // Collect messages on agentB
    const bMessages: string[] = [];
    agentB.on('message', (raw) => bMessages.push(raw.toString()));

    // Collect ack messages on agentA
    const aMessages: string[] = [];
    agentA.on('message', (raw) => aMessages.push(raw.toString()));

    const correlationId = 'test-corr-123';
    agentA.send(serializeMessage(createAgentMessage({
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      correlationId,
      topic: 'greeting',
      body: 'hello!',
    })));

    // Wait for relay
    await new Promise(r => setTimeout(r, 100));

    // agentB should have received the message
    const relayedMsgs = bMessages.map(m => parseMessage(m)).filter(m => m?.type === 'agent:message');
    expect(relayedMsgs).toHaveLength(1);
    expect((relayedMsgs[0]!.payload as any).fromAgent).toBe('agent-a');
    expect((relayedMsgs[0]!.payload as any).body).toBe('hello!');

    // agentA should have received an ack with 'delivered'
    const acks = aMessages.map(m => parseMessage(m)).filter(m => m?.type === 'agent:message-ack');
    expect(acks).toHaveLength(1);
    expect((acks[0]!.payload as any).status).toBe('delivered');
    expect((acks[0]!.payload as any).correlationId).toBe(correlationId);

    agentA.close();
    agentB.close();
  });

  it('sends unknown-agent ack when target agent is not registered', async () => {
    const { createAgentMessage } = await import('../../src/protocol/messages.js');

    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentA = await connectWs('/agent');
    agentA.send(serializeMessage(createAgentRegister({ name: 'sender-agent', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const ackPromise = new Promise<string>((resolve) => {
      agentA.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (msg?.type === 'agent:message-ack') {
          resolve((msg.payload as any).status);
        }
      });
    });

    agentA.send(serializeMessage(createAgentMessage({
      fromAgent: 'sender-agent',
      toAgent: 'nonexistent-agent',
      correlationId: 'corr-999',
      topic: 'test',
      body: 'ping',
    })));

    const ackStatus = await ackPromise;
    expect(ackStatus).toBe('unknown-agent');

    agentA.close();
  });

  // --- self-update tests ---

  it('self-update relays agent:self-update to agent and routes response back to CLI', async () => {
    const { createAgentSelfUpdateResponse } = await import('../../src/protocol/messages.js');

    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agent = await connectWs('/agent');
    agent.send(serializeMessage(createAgentRegister({ name: 'update-target', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    // Capture what the agent receives
    const agentMsgPromise = new Promise<ReturnType<typeof parseMessage>>((resolve) => {
      agent.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (msg?.type === 'agent:self-update') resolve(msg);
      });
    });

    const cli = await connectWs('/cli');

    // CLI sends self-update request
    const cliResponsePromise = waitForMessage(cli);
    cli.send(serializeMessage(createCliRequest({ command: 'self-update', args: { agentName: 'update-target' } })));

    // Agent receives the self-update message
    const agentMsg = await agentMsgPromise;
    expect(agentMsg).not.toBeNull();
    expect(agentMsg!.type).toBe('agent:self-update');
    const requestId = (agentMsg!.payload as { requestId: string }).requestId;

    // Agent sends back success response
    agent.send(serializeMessage(createAgentSelfUpdateResponse({
      requestId,
      success: true,
      message: 'Update complete. Restarting...',
      oldVersion: '0.1.0',
      newVersion: '0.2.0',
    })));

    const cliResponse = parseMessage(await cliResponsePromise);
    expect(cliResponse).not.toBeNull();
    expect(cliResponse!.type).toBe('cli:response');
    const data = (cliResponse!.payload as { data: { success: boolean; oldVersion: string; newVersion: string } }).data;
    expect(data.success).toBe(true);
    expect(data.oldVersion).toBe('0.1.0');
    expect(data.newVersion).toBe('0.2.0');

    agent.close();
    cli.close();
  });

  it('self-update returns error when agent is not registered', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cli = await connectWs('/cli');
    const cliResponsePromise = waitForMessage(cli);
    cli.send(serializeMessage(createCliRequest({ command: 'self-update', args: { agentName: 'ghost-agent' } })));

    const cliResponse = parseMessage(await cliResponsePromise);
    expect(cliResponse).not.toBeNull();
    expect(cliResponse!.type).toBe('cli:response');
    const payload = cliResponse!.payload as { error?: string };
    expect(payload.error).toMatch(/not reachable/);

    cli.close();
  });

  it('self-update returns error when agentName is missing', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cli = await connectWs('/cli');
    const cliResponsePromise = waitForMessage(cli);
    cli.send(serializeMessage(createCliRequest({ command: 'self-update', args: {} })));

    const cliResponse = parseMessage(await cliResponsePromise);
    expect(cliResponse).not.toBeNull();
    const payload = cliResponse!.payload as { error?: string };
    expect(payload.error).toMatch(/agentName/);

    cli.close();
  });

  it('self-update routes failure response back to CLI when agent reports failure', async () => {
    const { createAgentSelfUpdateResponse } = await import('../../src/protocol/messages.js');

    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agent = await connectWs('/agent');
    agent.send(serializeMessage(createAgentRegister({ name: 'update-fail-agent', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const agentMsgPromise = new Promise<ReturnType<typeof parseMessage>>((resolve) => {
      agent.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (msg?.type === 'agent:self-update') resolve(msg);
      });
    });

    const cli = await connectWs('/cli');
    const cliResponsePromise = waitForMessage(cli);
    cli.send(serializeMessage(createCliRequest({ command: 'self-update', args: { agentName: 'update-fail-agent' } })));

    const agentMsg = await agentMsgPromise;
    const requestId = (agentMsg!.payload as { requestId: string }).requestId;

    // Agent reports failure
    agent.send(serializeMessage(createAgentSelfUpdateResponse({
      requestId,
      success: false,
      message: 'git pull failed: merge conflict',
    })));

    const cliResponse = parseMessage(await cliResponsePromise);
    expect(cliResponse).not.toBeNull();
    const payload = cliResponse!.payload as { error?: string; data: { success: boolean; message: string } };
    expect(payload.error).toBe('git pull failed: merge conflict');
    expect(payload.data.success).toBe(false);

    agent.close();
    cli.close();
  });
});
