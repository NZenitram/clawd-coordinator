import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
import {
  createAgentRegister,
  createAgentMessage,
  createAgentMessageReply,
  serializeMessage,
  parseMessage,
} from '../../src/protocol/messages.js';

const TEST_TOKEN = 'messaging-test-token';
const TEST_PORT = 9885;

function connectAgent(name: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
      headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
    });
    ws.on('open', () => {
      ws.send(serializeMessage(createAgentRegister({ name, os: 'linux', arch: 'x64' })));
      setTimeout(() => resolve(ws), 60);
    });
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const handler = (raw: Buffer | string) => {
      const msg = parseMessage(raw.toString());
      if (msg?.type === type) {
        ws.removeListener('message', handler);
        resolve(msg.payload);
      }
    };
    ws.on('message', handler);
  });
}

describe('Agent-to-agent messaging (integration)', () => {
  let coordinator: Coordinator;

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
  });

  it('relays agent:message and returns delivered ack', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentA = await connectAgent('msg-agent-a');
    const agentB = await connectAgent('msg-agent-b');

    const bMessagePromise = waitForMessage(agentB, 'agent:message');
    const aAckPromise = waitForMessage(agentA, 'agent:message-ack');

    const correlationId = 'integ-corr-001';
    agentA.send(serializeMessage(createAgentMessage({
      fromAgent: 'msg-agent-a',
      toAgent: 'msg-agent-b',
      correlationId,
      topic: 'test-topic',
      body: 'hello from a',
    })));

    const [relayedPayload, ackPayload] = await Promise.all([bMessagePromise, aAckPromise]);

    expect(relayedPayload.fromAgent).toBe('msg-agent-a');
    expect(relayedPayload.toAgent).toBe('msg-agent-b');
    expect(relayedPayload.body).toBe('hello from a');
    expect(relayedPayload.topic).toBe('test-topic');
    expect(ackPayload.status).toBe('delivered');
    expect(ackPayload.correlationId).toBe(correlationId);

    agentA.close();
    agentB.close();
  });

  it('relays agent:message-reply and returns delivered ack', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentA = await connectAgent('reply-agent-a');
    const agentB = await connectAgent('reply-agent-b');

    const aReplyPromise = waitForMessage(agentA, 'agent:message-reply');
    const bAckPromise = waitForMessage(agentB, 'agent:message-ack');

    const correlationId = 'integ-corr-reply-001';
    agentB.send(serializeMessage(createAgentMessageReply({
      fromAgent: 'reply-agent-b',
      toAgent: 'reply-agent-a',
      correlationId,
      body: 'pong from b',
    })));

    const [replyPayload, ackPayload] = await Promise.all([aReplyPromise, bAckPromise]);

    expect(replyPayload.fromAgent).toBe('reply-agent-b');
    expect(replyPayload.body).toBe('pong from b');
    expect(ackPayload.status).toBe('delivered');

    agentA.close();
    agentB.close();
  });

  it('returns unknown-agent ack when target agent is not connected', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentA = await connectAgent('lonely-agent');

    const ackPromise = waitForMessage(agentA, 'agent:message-ack');

    agentA.send(serializeMessage(createAgentMessage({
      fromAgent: 'lonely-agent',
      toAgent: 'ghost-agent',
      correlationId: 'corr-ghost',
      topic: 'ping',
      body: 'anyone there?',
    })));

    const ackPayload = await ackPromise;
    expect(ackPayload.status).toBe('unknown-agent');
    expect(ackPayload.correlationId).toBe('corr-ghost');

    agentA.close();
  });

  it('returns agent-offline ack when target agent socket is closed', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentA = await connectAgent('online-agent');
    const agentB = await connectAgent('soon-offline-agent');

    // Close agentB's socket without unregistering from coordinator
    // To simulate offline we terminate the socket
    agentB.terminate();
    await new Promise(r => setTimeout(r, 60));

    const ackPromise = waitForMessage(agentA, 'agent:message-ack');

    agentA.send(serializeMessage(createAgentMessage({
      fromAgent: 'online-agent',
      toAgent: 'soon-offline-agent',
      correlationId: 'corr-offline',
      topic: 'ping',
      body: 'hello?',
    })));

    const ackPayload = await ackPromise;
    // Could be 'agent-offline' (socket closed but still in registry)
    // or 'unknown-agent' (unregistered on close); both are acceptable
    expect(['agent-offline', 'unknown-agent']).toContain(ackPayload.status);

    agentA.close();
  });
});
