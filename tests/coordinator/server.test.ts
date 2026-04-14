import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
import {
  createAgentRegister,
  createAgentHeartbeat,
  createCliRequest,
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
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4001);
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
});
