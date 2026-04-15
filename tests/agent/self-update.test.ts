import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

// Shared state for the execFile mock — must be set up before the module under test loads.
// We use module-level variables that the mock factory closes over so tests can control behavior.
const execFileCallArgs: string[][] = [];
let execFileImpl: (
  cmd: string,
  args: string[] | null | undefined,
  opts: Record<string, unknown>,
  cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
) => void = (_cmd, _args, _opts, cb) => {
  cb(null, { stdout: '0.1.0\n', stderr: '' });
};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Replace execFile with a wrapper that delegates to execFileImpl
  // promisify reads the custom promisify symbol, so we need to set it
  const mockExecFile = function (
    cmd: string,
    args: string[] | null | undefined,
    opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) {
    execFileCallArgs.push([cmd, ...(Array.isArray(args) ? args : [])]);
    // opts may be the callback when no options are passed
    const callback = typeof opts === 'function' ? (opts as typeof cb) : cb;
    execFileImpl(cmd, args, typeof opts === 'object' && opts !== null ? (opts as Record<string, unknown>) : {}, callback);
  } as unknown as typeof actual.execFile;

  // Attach custom promisify so promisify() wraps our mock
  (mockExecFile as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom') as symbol
  ] = (
    cmd: string,
    args: string[] | null | undefined,
    opts?: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
      execFileCallArgs.push([cmd, ...(Array.isArray(args) ? args : [])]);
      execFileImpl(
        cmd,
        args,
        opts ?? {},
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        },
      );
    });
  };

  return {
    ...actual,
    execFile: mockExecFile,
    spawn: vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
      return { unref: vi.fn() };
    }),
  };
});

import {
  parseMessage,
  serializeMessage,
  createAgentSelfUpdate,
} from '../../src/protocol/messages.js';
import { AgentDaemon } from '../../src/agent/daemon.js';

const MOCK_PORT = 9894;
const TEST_TOKEN = 'self-update-test-token';

function waitForTypedMessage(
  ws: WebSocket,
  type: string,
  timeoutMs = 5000,
): Promise<ReturnType<typeof parseMessage>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timed out waiting for message type: ${type}`));
    }, timeoutMs);
    const handler = (raw: WebSocket.RawData) => {
      const msg = parseMessage(raw.toString());
      if (msg?.type === type) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe('AgentDaemon self-update', () => {
  let mockServer: WebSocketServer;
  let daemon: AgentDaemon;
  let serverSocket: WebSocket;

  beforeEach(async () => {
    execFileCallArgs.length = 0;
    // Default: succeed for everything
    execFileImpl = (_cmd, _args, _opts, cb) => {
      cb(null, { stdout: '0.1.0\n', stderr: '' });
    };
    mockServer = new WebSocketServer({ port: MOCK_PORT });
    await new Promise<void>((r) => mockServer.once('listening', r));
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    for (const client of mockServer.clients) client.terminate();
    await new Promise<void>((r) => mockServer.close(() => r()));
  });

  function captureServerSocket(): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve) => {
      mockServer.once('connection', (ws) => {
        serverSocket = ws;
        resolve(ws);
      });
    });
  }

  async function startDaemon(name: string): Promise<WebSocket> {
    const socketPromise = captureServerSocket();
    daemon = new AgentDaemon({
      name,
      coordinatorUrl: `ws://localhost:${MOCK_PORT}`,
      token: TEST_TOKEN,
    });
    await daemon.start();
    return socketPromise;
  }

  it('sends success response after successful git pull / npm install / build', async () => {
    // Default execFileImpl succeeds — no override needed
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });

    const sock = await startDaemon('update-agent-ok');

    const responsePromise = waitForTypedMessage(sock, 'agent:self-update-response');

    sock.send(serializeMessage(createAgentSelfUpdate({ requestId: 'req-success' })));

    const response = await responsePromise;
    expect(response).not.toBeNull();
    expect(response!.type).toBe('agent:self-update-response');
    const payload = response!.payload as {
      requestId: string;
      success: boolean;
      message: string;
      oldVersion?: string;
      newVersion?: string;
    };
    expect(payload.requestId).toBe('req-success');
    expect(payload.success).toBe(true);
    expect(payload.message).toContain('Update complete');

    exitSpy.mockRestore();
  });

  it('sends failure response when git pull fails', async () => {
    execFileImpl = (_cmd, args, _opts, cb) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs.includes('pull')) {
        cb(new Error('git pull failed: merge conflict'), { stdout: '', stderr: 'CONFLICT' });
      } else {
        cb(null, { stdout: '0.1.0\n', stderr: '' });
      }
    };

    const sock = await startDaemon('update-agent-git-fail');

    const responsePromise = waitForTypedMessage(sock, 'agent:self-update-response');

    sock.send(serializeMessage(createAgentSelfUpdate({ requestId: 'req-git-fail' })));

    const response = await responsePromise;
    expect(response).not.toBeNull();
    const payload = response!.payload as { requestId: string; success: boolean; message: string };
    expect(payload.requestId).toBe('req-git-fail');
    expect(payload.success).toBe(false);
    expect(payload.message).toContain('git pull failed');
  });

  it('sends failure response when npm install fails', async () => {
    execFileImpl = (_cmd, args, _opts, cb) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs.includes('install')) {
        cb(new Error('npm install failed: EACCES'), { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '0.1.0\n', stderr: '' });
      }
    };

    const sock = await startDaemon('update-agent-npm-fail');

    const responsePromise = waitForTypedMessage(sock, 'agent:self-update-response');

    sock.send(serializeMessage(createAgentSelfUpdate({ requestId: 'req-npm-fail' })));

    const response = await responsePromise;
    const payload = response!.payload as { success: boolean; message: string };
    expect(payload.success).toBe(false);
    expect(payload.message).toContain('npm install failed');
  });

  it('sends failure response when npm run build fails', async () => {
    execFileImpl = (_cmd, args, _opts, cb) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs.includes('run') && callArgs.includes('build')) {
        cb(new Error('TypeScript compilation failed'), { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '0.1.0\n', stderr: '' });
      }
    };

    const sock = await startDaemon('update-agent-build-fail');

    const responsePromise = waitForTypedMessage(sock, 'agent:self-update-response');

    sock.send(serializeMessage(createAgentSelfUpdate({ requestId: 'req-build-fail' })));

    const response = await responsePromise;
    const payload = response!.payload as { success: boolean; message: string };
    expect(payload.success).toBe(false);
    expect(payload.message).toContain('TypeScript compilation failed');
  });

  it('executes git pull, npm install, npm run build in sequence on success', async () => {
    const callOrder: string[] = [];
    execFileImpl = (_cmd, args, _opts, cb) => {
      const callArgs = Array.isArray(args) ? args : [];
      if (callArgs.includes('pull')) callOrder.push('git-pull');
      else if (callArgs.includes('install')) callOrder.push('npm-install');
      else if (callArgs.includes('run') && callArgs.includes('build')) callOrder.push('npm-build');
      cb(null, { stdout: '0.1.0\n', stderr: '' });
    };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });

    const sock = await startDaemon('update-agent-sequence');

    const responsePromise = waitForTypedMessage(sock, 'agent:self-update-response');

    sock.send(serializeMessage(createAgentSelfUpdate({ requestId: 'req-seq' })));

    await responsePromise;

    expect(callOrder).toContain('git-pull');
    expect(callOrder).toContain('npm-install');
    expect(callOrder).toContain('npm-build');
    expect(callOrder.indexOf('git-pull')).toBeLessThan(callOrder.indexOf('npm-install'));
    expect(callOrder.indexOf('npm-install')).toBeLessThan(callOrder.indexOf('npm-build'));

    exitSpy.mockRestore();
  });
});
