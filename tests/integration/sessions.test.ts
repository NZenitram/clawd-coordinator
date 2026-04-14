import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
import {
  parseMessage,
  serializeMessage,
  createAgentRegister,
  createSessionListResponse,
} from '../../src/protocol/messages.js';
import { connectCli, sendRequest } from '../../src/cli/output.js';

const TEST_TOKEN = 'sessions-test-token';
const TEST_PORT = 9880;

describe('Session discovery', () => {
  let coordinator: Coordinator;

  afterEach(async () => {
    if (coordinator) await coordinator.stop();
  });

  it('forwards session:list-request to agent and relays response to CLI', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    // Connect a fake agent
    const agentWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    agentWs.send(serializeMessage(createAgentRegister({
      name: 'session-agent',
      os: 'linux',
      arch: 'x64',
    })));
    await new Promise(r => setTimeout(r, 50));

    const mockSessions = [
      { id: 'sess-abc123', name: 'my-project', createdAt: '2026-04-01T10:00:00Z' },
      { id: 'sess-def456', name: undefined, createdAt: '2026-04-10T14:30:00Z' },
    ];

    // Fake agent handles session:list-request and sends back a response
    agentWs.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg || msg.type !== 'session:list-request') return;

      const { agentName, requestId } = msg.payload;
      agentWs.send(serializeMessage(createSessionListResponse({
        agentName,
        sessions: mockSessions,
        requestId,
      })));
    });

    // CLI sends list-sessions command
    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);
    const response = await sendRequest(cliWs, 'list-sessions', { agentName: 'session-agent' });

    const payload = response.payload as { requestId: string; data: unknown; error?: string };
    expect(payload.error).toBeUndefined();

    const data = payload.data as { sessions: Array<{ id: string; name?: string; createdAt?: string }> };
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions[0].id).toBe('sess-abc123');
    expect(data.sessions[0].name).toBe('my-project');
    expect(data.sessions[1].id).toBe('sess-def456');

    agentWs.close();
    cliWs.close();
  });

  it('returns error when agent is not connected', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);
    const response = await sendRequest(cliWs, 'list-sessions', { agentName: 'ghost-agent' });

    const payload = response.payload as { requestId: string; data: unknown; error?: string };
    expect(payload.error).toContain('not found');

    cliWs.close();
  });

  it('relays agent-side error back to CLI', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    agentWs.send(serializeMessage(createAgentRegister({
      name: 'error-agent',
      os: 'linux',
      arch: 'x64',
    })));
    await new Promise(r => setTimeout(r, 50));

    // Agent responds with an error
    agentWs.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg || msg.type !== 'session:list-request') return;

      const { agentName, requestId } = msg.payload;
      agentWs.send(serializeMessage(createSessionListResponse({
        agentName,
        sessions: [],
        requestId,
        error: 'claude: command not found',
      })));
    });

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);
    const response = await sendRequest(cliWs, 'list-sessions', { agentName: 'error-agent' });

    const payload = response.payload as { requestId: string; data: unknown; error?: string };
    expect(payload.error).toBe('claude: command not found');

    agentWs.close();
    cliWs.close();
  });

  it('returns missing argument error when agentName is omitted', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);
    const response = await sendRequest(cliWs, 'list-sessions', {});

    const payload = response.payload as { requestId: string; data: unknown; error?: string };
    expect(payload.error).toContain('agentName');

    cliWs.close();
  });
});
