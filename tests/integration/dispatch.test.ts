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

  it('passes allowedTools in dispatch-task through to the task:dispatch message the agent receives', async () => {
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
      name: 'tools-agent',
      os: 'linux',
      arch: 'x64',
    })));
    await new Promise(r => setTimeout(r, 50));

    // Capture the task:dispatch message received by the agent
    const dispatchReceived = new Promise<import('../../src/protocol/messages.js').AnyMessage>((resolve) => {
      agentWs.once('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (msg && msg.type === 'task:dispatch') resolve(msg);
      });
    });

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);
    await sendRequest(cliWs, 'dispatch-task', {
      agentName: 'tools-agent',
      prompt: 'do work',
      allowedTools: ['Read', 'Write'],
      disallowedTools: ['Bash'],
      addDirs: ['/tmp/workspace'],
    });

    const dispatchMsg = await dispatchReceived;
    const payload = dispatchMsg.payload as any;
    expect(payload.allowedTools).toEqual(['Read', 'Write']);
    expect(payload.disallowedTools).toEqual(['Bash']);
    expect(payload.addDirs).toEqual(['/tmp/workspace']);

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

  it('dispatches with pool to the least-loaded available agent', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    // Connect two agents in the same pool
    const connectPoolAgent = (name: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
          headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
        });
        ws.on('open', () => {
          ws.send(serializeMessage(createAgentRegister({
            name,
            os: 'linux',
            arch: 'x64',
            pool: 'staging',
            maxConcurrent: 2,
          })));
          resolve(ws);
        });
        ws.on('error', reject);
      });

    const agent1Ws = await connectPoolAgent('pool-agent-1');
    const agent2Ws = await connectPoolAgent('pool-agent-2');
    await new Promise(r => setTimeout(r, 50));

    // Both agents complete tasks immediately
    for (const agentWs of [agent1Ws, agent2Ws]) {
      agentWs.on('message', (raw) => {
        const msg = parseMessage(raw.toString());
        if (!msg || msg.type !== 'task:dispatch') return;
        agentWs.send(serializeMessage(createTaskComplete({ taskId: msg.payload.taskId })));
      });
    }

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);

    // Dispatch via pool — should resolve to an available agent
    const response = await sendRequest(cliWs, 'dispatch-task', {
      pool: 'staging',
      prompt: 'hello from pool',
    });

    const payload = (response.payload as any);
    expect(payload.error).toBeUndefined();
    expect(payload.data.taskId).toBeDefined();
    expect(['pool-agent-1', 'pool-agent-2']).toContain(payload.data.agentName);

    agent1Ws.close();
    agent2Ws.close();
    cliWs.close();
  });

  it('returns error when dispatching to pool with no available agents', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    // Connect an agent in the pool, fill its capacity
    const agentWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
      });
      ws.on('open', () => {
        ws.send(serializeMessage(createAgentRegister({
          name: 'full-pool-agent',
          os: 'linux',
          arch: 'x64',
          pool: 'full-pool',
          maxConcurrent: 1,
        })));
        resolve(ws);
      });
      ws.on('error', reject);
    });
    await new Promise(r => setTimeout(r, 50));

    const cliWs = await connectCli(`ws://localhost:${TEST_PORT}`, TEST_TOKEN);

    // Fill the single slot
    await sendRequest(cliWs, 'dispatch-task', { agentName: 'full-pool-agent', prompt: 'fill slot' });

    // Now dispatch via pool — all agents at capacity
    const response = await sendRequest(cliWs, 'dispatch-task', {
      pool: 'full-pool',
      prompt: 'should fail',
    });

    const payload = (response.payload as any);
    expect(payload.error).toContain('No available agents in pool');

    agentWs.close();
    cliWs.close();
  });
});
