import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { AgentDaemon } from '../../src/agent/daemon.js';
import { Coordinator } from '../../src/coordinator/server.js';
import {
  parseMessage,
  serializeMessage,
  createCliRequest,
} from '../../src/protocol/messages.js';

const TEST_TOKEN = 'daemon-test-token';
const TEST_PORT = 9877;

describe('AgentDaemon', () => {
  let coordinator: Coordinator;
  let daemon: AgentDaemon;

  afterEach(async () => {
    if (daemon) await daemon.stop();
    if (coordinator) await coordinator.stop();
  });

  it('connects to coordinator and registers', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    daemon = new AgentDaemon({
      name: 'test-agent',
      coordinatorUrl: `ws://localhost:${TEST_PORT}`,
      token: TEST_TOKEN,
    });
    await daemon.start();

    const cli = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cli?token=${TEST_TOKEN}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    const responsePromise = new Promise<string>((resolve) => {
      cli.once('message', (data) => resolve(data.toString()));
    });
    cli.send(serializeMessage(createCliRequest({ command: 'list-agents' })));
    const response = await responsePromise;
    const msg = parseMessage(response);
    const agents = (msg!.payload as any).data.agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('test-agent');

    cli.close();
  });

  it('unregisters on stop', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    daemon = new AgentDaemon({
      name: 'test-agent',
      coordinatorUrl: `ws://localhost:${TEST_PORT}`,
      token: TEST_TOKEN,
    });
    await daemon.start();
    await daemon.stop();

    await new Promise(r => setTimeout(r, 100));

    const cli = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cli?token=${TEST_TOKEN}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    const responsePromise = new Promise<string>((resolve) => {
      cli.once('message', (data) => resolve(data.toString()));
    });
    cli.send(serializeMessage(createCliRequest({ command: 'list-agents' })));
    const response = await responsePromise;
    const msg = parseMessage(response);
    const agents = (msg!.payload as any).data.agents;
    expect(agents).toHaveLength(0);

    cli.close();
  });
});
