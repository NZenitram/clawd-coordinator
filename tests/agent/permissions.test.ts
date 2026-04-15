import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { AgentDaemon } from '../../src/agent/daemon.js';
import {
  parseMessage,
  serializeMessage,
  createTaskDispatch,
} from '../../src/protocol/messages.js';

// Mock child_process.spawn so executor never actually runs claude
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  return {
    ...original,
    spawn: vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        kill: vi.fn(),
      });
      setTimeout(() => {
        proc.stdout.push(null);
        proc.emit('close', 0);
      }, 10);
      return proc;
    }),
    execFile: original.execFile,
  };
});

const { spawn } = await import('node:child_process');

const MOCK_PORT = 9891;
const TEST_TOKEN = 'permissions-test-token';

async function startMockServer(): Promise<{ server: WebSocketServer; serverSocket: Promise<import('ws').WebSocket> }> {
  const server = new WebSocketServer({ port: MOCK_PORT });
  await new Promise<void>(r => server.once('listening', r));
  const serverSocket = new Promise<import('ws').WebSocket>((resolve) => {
    server.once('connection', (ws) => resolve(ws));
  });
  return { server, serverSocket };
}

async function startDaemon(options: ConstructorParameters<typeof AgentDaemon>[0]): Promise<AgentDaemon> {
  const daemon = new AgentDaemon(options);
  await daemon.start();
  // Allow time for register message to be exchanged
  await new Promise(r => setTimeout(r, 50));
  return daemon;
}

async function stopAll(daemon: AgentDaemon, server: WebSocketServer): Promise<void> {
  await daemon.stop();
  for (const client of server.clients) client.terminate();
  await new Promise<void>(r => server.close(() => r()));
}

function captureSpawnArgs(): string[] {
  const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
  if (calls.length === 0) return [];
  return calls[calls.length - 1][1] as string[];
}

describe('Permission intersection logic', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('intersection: agent [Read,Write,Edit,Bash] + task [Read,Bash] => effective [Read,Bash]', async () => {
    const { server, serverSocket } = await startMockServer();
    const daemon = await startDaemon({
      name: 'perm-agent',
      coordinatorUrl: `ws://localhost:${MOCK_PORT}`,
      token: TEST_TOKEN,
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    });
    const daemonWs = await serverSocket;

    const taskCompletePromise = new Promise<void>((resolve) => {
      daemonWs.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg?.type === 'task:complete' || msg?.type === 'task:error') resolve();
      });
    });

    daemonWs.send(serializeMessage(createTaskDispatch({
      taskId: '00000000-0000-0000-0000-000000000010',
      prompt: 'test intersection',
      sessionId: undefined,
      allowedTools: ['Read', 'Bash'],
    })));

    await taskCompletePromise;

    const args = captureSpawnArgs();
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const toolsArg = args[idx + 1];
    const tools = toolsArg.split(',');
    expect(tools.sort()).toEqual(['Bash', 'Read']);

    await stopAll(daemon, server);
  });

  it('intersection: agent [Read,Write] + task [Read,Write,Bash] => effective [Read,Write] (task cannot expand)', async () => {
    const { server, serverSocket } = await startMockServer();
    const daemon = await startDaemon({
      name: 'perm-agent',
      coordinatorUrl: `ws://localhost:${MOCK_PORT}`,
      token: TEST_TOKEN,
      allowedTools: ['Read', 'Write'],
    });
    const daemonWs = await serverSocket;

    const taskCompletePromise = new Promise<void>((resolve) => {
      daemonWs.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg?.type === 'task:complete' || msg?.type === 'task:error') resolve();
      });
    });

    daemonWs.send(serializeMessage(createTaskDispatch({
      taskId: '00000000-0000-0000-0000-000000000011',
      prompt: 'test no expand',
      sessionId: undefined,
      allowedTools: ['Read', 'Write', 'Bash'],
    })));

    await taskCompletePromise;

    const args = captureSpawnArgs();
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const toolsArg = args[idx + 1];
    const tools = toolsArg.split(',');
    expect(tools).not.toContain('Bash');
    expect(tools.sort()).toEqual(['Read', 'Write']);

    await stopAll(daemon, server);
  });

  it('disallowedTools are unioned: agent [Bash] + task [Write] => effective [Bash,Write]', async () => {
    const { server, serverSocket } = await startMockServer();
    const daemon = await startDaemon({
      name: 'perm-agent',
      coordinatorUrl: `ws://localhost:${MOCK_PORT}`,
      token: TEST_TOKEN,
      disallowedTools: ['Bash'],
    });
    const daemonWs = await serverSocket;

    const taskCompletePromise = new Promise<void>((resolve) => {
      daemonWs.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg?.type === 'task:complete' || msg?.type === 'task:error') resolve();
      });
    });

    daemonWs.send(serializeMessage(createTaskDispatch({
      taskId: '00000000-0000-0000-0000-000000000012',
      prompt: 'test disallowed union',
      sessionId: undefined,
      disallowedTools: ['Write'],
    })));

    await taskCompletePromise;

    const args = captureSpawnArgs();
    const idx = args.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    const toolsArg = args[idx + 1];
    const tools = toolsArg.split(',');
    expect(tools.sort()).toEqual(['Bash', 'Write']);

    await stopAll(daemon, server);
  });

  it('addDirs task-level must be subpaths of agent-level dirs', async () => {
    const { server, serverSocket } = await startMockServer();
    const daemon = await startDaemon({
      name: 'perm-agent',
      coordinatorUrl: `ws://localhost:${MOCK_PORT}`,
      token: TEST_TOKEN,
      addDirs: ['/allowed'],
    });
    const daemonWs = await serverSocket;

    const taskCompletePromise = new Promise<void>((resolve) => {
      daemonWs.on('message', (data) => {
        const msg = parseMessage(data.toString());
        if (msg?.type === 'task:complete' || msg?.type === 'task:error') resolve();
      });
    });

    daemonWs.send(serializeMessage(createTaskDispatch({
      taskId: '00000000-0000-0000-0000-000000000013',
      prompt: 'test addDirs subpath',
      sessionId: undefined,
      addDirs: ['/allowed/sub', '/outside'],
    })));

    await taskCompletePromise;

    const args = captureSpawnArgs();
    // Collect all --add-dir values
    const addDirValues: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--add-dir') addDirValues.push(args[i + 1]);
    }
    // /allowed/sub is a subpath of /allowed => allowed
    expect(addDirValues).toContain('/allowed/sub');
    // /outside is NOT a subpath of /allowed => filtered out
    expect(addDirValues).not.toContain('/outside');

    await stopAll(daemon, server);
  });
});
