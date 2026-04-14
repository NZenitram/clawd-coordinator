import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Coordinator } from '../../src/coordinator/server.js';
import {
  parseMessage,
  serializeMessage,
  createAgentRegister,
  createTaskOutput,
  createTaskComplete,
  createCliRequest,
} from '../../src/protocol/messages.js';
import { connectCli, sendRequest } from '../../src/cli/output.js';

const TEST_TOKEN = 'integration-test-token';
const TEST_PORT = 9878;

describe('End-to-end dispatch', () => {
  let coordinator: Coordinator;

  afterEach(async () => {
    if (coordinator) await coordinator.stop();
  });

  it('dispatches a task and streams output back to CLI', async () => {
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
      name: 'fake-agent',
      os: 'linux',
      arch: 'x64',
    })));
    await new Promise(r => setTimeout(r, 50));

    // Make fake agent respond to dispatch
    agentWs.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg || msg.type !== 'task:dispatch') return;

      const taskId = msg.payload.taskId;

      agentWs.send(serializeMessage(createTaskOutput({
        taskId,
        data: '{"type":"assistant","content":"I will fix the bug"}',
      })));
      agentWs.send(serializeMessage(createTaskOutput({
        taskId,
        data: '{"type":"assistant","content":"Bug fixed!"}',
      })));
      agentWs.send(serializeMessage(createTaskComplete({ taskId })));
    });

    // Connect CLI and dispatch
    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);
    const dispatchResponse = await sendRequest(cliWs, 'dispatch-task', {
      agentName: 'fake-agent',
      prompt: 'fix the bug',
    });

    const payload = (dispatchResponse.payload as any);
    expect(payload.error).toBeUndefined();
    expect(payload.data.taskId).toBeDefined();

    const taskId = payload.data.taskId;

    // Collect streamed output
    const output: string[] = [];
    await new Promise<void>((resolve) => {
      cliWs.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (!msg) return;

        if (msg.type === 'task:output' && msg.payload.taskId === taskId) {
          output.push(msg.payload.data);
        }
        if (msg.type === 'task:complete' && msg.payload.taskId === taskId) {
          resolve();
        }
      });
    });

    expect(output).toHaveLength(2);
    expect(output[0]).toContain('I will fix the bug');
    expect(output[1]).toContain('Bug fixed');

    agentWs.close();
    cliWs.close();
  });

  it('returns error when dispatching to unknown agent', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);
    const response = await sendRequest(cliWs, 'dispatch-task', {
      agentName: 'nonexistent',
      prompt: 'test',
    });

    const payload = (response.payload as any);
    expect(payload.error).toContain('not found');

    cliWs.close();
  });

  it('dispatches multiple tasks to agent with maxConcurrent > 1', async () => {
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
      name: 'multi-agent',
      os: 'linux',
      arch: 'x64',
      maxConcurrent: 3,
    })));
    await new Promise(r => setTimeout(r, 50));

    // Agent completes tasks immediately
    agentWs.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg || msg.type !== 'task:dispatch') return;
      agentWs.send(serializeMessage(createTaskComplete({ taskId: msg.payload.taskId })));
    });

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);

    // Dispatch 3 tasks — all should succeed
    const r1 = await sendRequest(cliWs, 'dispatch-task', { agentName: 'multi-agent', prompt: 'task 1' });
    const r2 = await sendRequest(cliWs, 'dispatch-task', { agentName: 'multi-agent', prompt: 'task 2' });
    const r3 = await sendRequest(cliWs, 'dispatch-task', { agentName: 'multi-agent', prompt: 'task 3' });

    expect((r1.payload as any).data.taskId).toBeDefined();
    expect((r2.payload as any).data.taskId).toBeDefined();
    expect((r3.payload as any).data.taskId).toBeDefined();

    agentWs.close();
    cliWs.close();
  });

  it('queues task when agent is at capacity', async () => {
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
      name: 'busy-agent',
      os: 'linux',
      arch: 'x64',
    })));
    await new Promise(r => setTimeout(r, 50));

    // Agent does NOT complete — stays busy
    agentWs.on('message', () => {});

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);

    // First dispatch succeeds
    const first = await sendRequest(cliWs, 'dispatch-task', {
      agentName: 'busy-agent',
      prompt: 'task 1',
    });
    expect((first.payload as any).data.status).toBe('dispatched');

    // Second dispatch is queued (not rejected)
    const second = await sendRequest(cliWs, 'dispatch-task', {
      agentName: 'busy-agent',
      prompt: 'task 2',
    });
    expect((second.payload as any).data.status).toBe('queued');
    expect((second.payload as any).data.taskId).toBeDefined();

    agentWs.close();
    cliWs.close();
  });
});
