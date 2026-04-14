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
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}${path}`);
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

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent?token=wrong`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4001);
  });

  it('accepts agent connection with valid token and registration', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const ws = await connectWs(`/agent?token=${TEST_TOKEN}`);
    const registerMsg = createAgentRegister({ name: 'test-agent', os: 'linux', arch: 'x64' });
    ws.send(serializeMessage(registerMsg));

    await new Promise(r => setTimeout(r, 50));

    const cli = await connectWs(`/cli?token=${TEST_TOKEN}`);
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

    const ws = await connectWs(`/agent?token=${TEST_TOKEN}`);
    const registerMsg = createAgentRegister({ name: 'test-agent', os: 'linux', arch: 'x64' });
    ws.send(serializeMessage(registerMsg));
    await new Promise(r => setTimeout(r, 50));

    const heartbeatMsg = createAgentHeartbeat({ name: 'test-agent' });
    ws.send(serializeMessage(heartbeatMsg));
    await new Promise(r => setTimeout(r, 50));

    ws.close();
  });

  it('removes agent on disconnect', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const ws = await connectWs(`/agent?token=${TEST_TOKEN}`);
    const registerMsg = createAgentRegister({ name: 'test-agent', os: 'linux', arch: 'x64' });
    ws.send(serializeMessage(registerMsg));
    await new Promise(r => setTimeout(r, 50));

    ws.close();
    await new Promise(r => setTimeout(r, 50));

    const cli = await connectWs(`/cli?token=${TEST_TOKEN}`);
    const response = await sendAndReceive(
      cli,
      serializeMessage(createCliRequest({ command: 'list-agents' }))
    );
    const parsed = parseMessage(response);
    const agents = (parsed!.payload as { data: { agents: unknown[] } }).data.agents;
    expect(agents).toHaveLength(0);

    cli.close();
  });
});
