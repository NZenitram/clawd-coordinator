import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { AgentDaemon } from '../../src/agent/daemon.js';
import { Coordinator } from '../../src/coordinator/server.js';
import { WebSocketServer } from 'ws';
import {
  parseMessage,
  serializeMessage,
  createCliRequest,
  createTaskDispatch,
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
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cli`, {
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
      });
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
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/cli`, {
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
      });
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

  describe('Dispatch message validation', () => {
    const MOCK_PORT = 9879;

    it('silently rejects dispatch with non-UUID taskId', async () => {
      let taskErrorReceived = false;
      const mockServer = new WebSocketServer({ port: MOCK_PORT });

      const connectionPromise = new Promise<WebSocket>((resolve) => {
        mockServer.once('connection', (ws) => {
          ws.on('message', (data) => {
            const p = parseMessage(data.toString());
            if (p?.type === 'task:error') taskErrorReceived = true;
          });
          resolve(ws);
        });
      });

      await new Promise<void>(r => mockServer.once('listening', r));

      daemon = new AgentDaemon({
        name: 'validate-agent',
        coordinatorUrl: `ws://localhost:${MOCK_PORT}`,
        token: TEST_TOKEN,
      });
      await daemon.start();
      const daemonSocket = await connectionPromise;

      daemonSocket.send(serializeMessage(createTaskDispatch({
        taskId: 'not-a-uuid',
        prompt: 'do something',
        sessionId: undefined,
      })));

      await new Promise(r => setTimeout(r, 200));
      expect(taskErrorReceived).toBe(false);

      await daemon.stop();
      for (const client of mockServer.clients) client.terminate();
      await new Promise<void>(r => mockServer.close(() => r()));
    });

    it('sends task:error for oversized prompt', async () => {
      const mockServer = new WebSocketServer({ port: MOCK_PORT });
      await new Promise<void>(r => mockServer.once('listening', r));

      const taskErrorPromise = new Promise<string>((resolve) => {
        mockServer.once('connection', (ws) => {
          ws.on('message', (data) => {
            const p = parseMessage(data.toString());
            if (p?.type === 'task:error') resolve(data.toString());
          });
        });
      });

      daemon = new AgentDaemon({
        name: 'validate-agent',
        coordinatorUrl: `ws://localhost:${MOCK_PORT}`,
        token: TEST_TOKEN,
      });
      await daemon.start();
      await new Promise(r => setTimeout(r, 50));

      // Find the daemon's socket on the server side
      const clients = Array.from(mockServer.clients);
      clients[0].send(serializeMessage(createTaskDispatch({
        taskId: '00000000-0000-0000-0000-000000000001',
        prompt: 'x'.repeat(1_000_001),
        sessionId: undefined,
      })));

      const raw = await taskErrorPromise;
      const parsed = parseMessage(raw);
      expect(parsed!.type).toBe('task:error');
      expect((parsed!.payload as any).error).toBe('Invalid or oversized prompt');

      await daemon.stop();
      for (const client of mockServer.clients) client.terminate();
      await new Promise<void>(r => mockServer.close(() => r()));
    });
  });
});
