import { describe, it, expect } from 'vitest';
import {
  MessageDeduplicator,
  createAgentRegister,
  createAgentHeartbeat,
  createTaskDispatch,
  createTaskOutput,
  createTaskComplete,
  createTaskError,
  createCliRequest,
  createCliResponse,
  parseMessage,
  serializeMessage,
  type AgentRegister,
  type TaskDispatch,
} from '../../src/protocol/messages.js';

describe('message creation', () => {
  it('creates agent:register message', () => {
    const msg = createAgentRegister({
      name: 'staging-box',
      os: 'linux',
      arch: 'x64',
    });
    expect(msg.type).toBe('agent:register');
    expect(msg.payload.name).toBe('staging-box');
    expect(msg.payload.os).toBe('linux');
    expect(msg.payload.arch).toBe('x64');
    expect(msg.id).toBeDefined();
    expect(msg.timestamp).toBeDefined();
  });

  it('creates agent:heartbeat message', () => {
    const msg = createAgentHeartbeat({ name: 'staging-box' });
    expect(msg.type).toBe('agent:heartbeat');
    expect(msg.payload.name).toBe('staging-box');
  });

  it('creates task:dispatch message', () => {
    const msg = createTaskDispatch({
      taskId: 'task-1',
      prompt: 'fix the bug',
      sessionId: undefined,
    });
    expect(msg.type).toBe('task:dispatch');
    expect(msg.payload.taskId).toBe('task-1');
    expect(msg.payload.prompt).toBe('fix the bug');
  });

  it('creates task:output message', () => {
    const msg = createTaskOutput({
      taskId: 'task-1',
      data: '{"type":"assistant","message":"working on it"}',
    });
    expect(msg.type).toBe('task:output');
    expect(msg.payload.taskId).toBe('task-1');
  });

  it('creates task:complete message', () => {
    const msg = createTaskComplete({ taskId: 'task-1' });
    expect(msg.type).toBe('task:complete');
  });

  it('creates task:error message', () => {
    const msg = createTaskError({
      taskId: 'task-1',
      error: 'claude exited with code 1',
    });
    expect(msg.type).toBe('task:error');
    expect(msg.payload.error).toBe('claude exited with code 1');
  });

  it('creates cli:request message', () => {
    const msg = createCliRequest({
      command: 'list-agents',
    });
    expect(msg.type).toBe('cli:request');
    expect(msg.payload.command).toBe('list-agents');
  });

  it('creates cli:response message', () => {
    const msg = createCliResponse({
      requestId: 'req-1',
      data: { agents: [] },
    });
    expect(msg.type).toBe('cli:response');
    expect(msg.payload.requestId).toBe('req-1');
  });
});

describe('serialization', () => {
  it('round-trips a message through serialize/parse', () => {
    const original = createTaskDispatch({
      taskId: 'task-1',
      prompt: 'fix the bug',
      sessionId: undefined,
    });
    const serialized = serializeMessage(original);
    const parsed = parseMessage(serialized);
    expect(parsed).toEqual(original);
  });

  it('returns null for invalid JSON', () => {
    expect(parseMessage('not json')).toBeNull();
  });

  it('returns null for valid JSON missing type field', () => {
    expect(parseMessage(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });
});

describe('MessageDeduplicator', () => {
  it('detects duplicate message IDs', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.isDuplicate('msg-1')).toBe(false);
    expect(dedup.isDuplicate('msg-1')).toBe(true);
    expect(dedup.isDuplicate('msg-2')).toBe(false);
  });

  it('evicts old entries when max size exceeded', () => {
    const dedup = new MessageDeduplicator(4);
    dedup.isDuplicate('a');
    dedup.isDuplicate('b');
    dedup.isDuplicate('c');
    dedup.isDuplicate('d');
    dedup.isDuplicate('e'); // triggers eviction
    expect(dedup.isDuplicate('a')).toBe(false); // was evicted
  });
});
