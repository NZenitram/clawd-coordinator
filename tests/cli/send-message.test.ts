import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the command
vi.mock('../../src/shared/config.js', () => ({
  requireConfig: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('../../src/cli/output.js', () => ({
  connectCli: vi.fn(),
  sendRequest: vi.fn(),
  formatTable: vi.fn(),
  formatDuration: vi.fn(),
}));

import { requireConfig } from '../../src/shared/config.js';
import { connectCli, sendRequest } from '../../src/cli/output.js';
import { sendMessageCommand } from '../../src/cli/commands/send-message.js';
import type { AnyMessage } from '../../src/protocol/messages.js';
import WebSocket from 'ws';

const mockRequireConfig = vi.mocked(requireConfig);
const mockConnectCli = vi.mocked(connectCli);
const mockSendRequest = vi.mocked(sendRequest);

function makeFakeWs(): WebSocket {
  return { readyState: WebSocket.OPEN, close: vi.fn(), send: vi.fn() } as unknown as WebSocket;
}

function makeCliResponse(data: unknown, error?: string): AnyMessage {
  return {
    id: 'test-id',
    type: 'cli:response',
    version: 1,
    timestamp: Date.now(),
    payload: { requestId: 'req-id', data, error },
  };
}

describe('send-message CLI command', () => {
  let fakeWs: WebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeWs = makeFakeWs();
    mockRequireConfig.mockReturnValue({
      token: 'test-token',
      coordinatorUrl: 'ws://localhost:8080',
    });
    mockConnectCli.mockResolvedValue(fakeWs);
  });

  it('sends a message and prints correlationId and status on success', async () => {
    mockSendRequest.mockResolvedValue(
      makeCliResponse({ correlationId: 'corr-abc', status: 'delivered' }),
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Parse args directly by calling the action
    await sendMessageCommand.parseAsync([
      '--from', 'agent-a',
      '--to', 'agent-b',
      '--topic', 'ping',
      '--body', 'hello',
    ], { from: 'user' });

    expect(mockConnectCli).toHaveBeenCalledWith('ws://localhost:8080', 'test-token');
    expect(mockSendRequest).toHaveBeenCalledWith(fakeWs, 'send-message', {
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      topic: 'ping',
      body: 'hello',
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('corr-abc'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('delivered'),
    );

    consoleSpy.mockRestore();
  });

  it('uses the --url option when provided instead of config coordinatorUrl', async () => {
    mockSendRequest.mockResolvedValue(
      makeCliResponse({ correlationId: 'corr-xyz', status: 'unknown-agent' }),
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendMessageCommand.parseAsync([
      '--from', 'a',
      '--to', 'b',
      '--topic', 't',
      '--body', 'msg',
      '--url', 'ws://custom-host:9090',
    ], { from: 'user' });

    expect(mockConnectCli).toHaveBeenCalledWith('ws://custom-host:9090', 'test-token');

    consoleSpy.mockRestore();
  });

  it('exits with code 1 and prints error when coordinator returns an error', async () => {
    mockSendRequest.mockResolvedValue(
      makeCliResponse(null, 'Missing required arguments'),
    );

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

    await sendMessageCommand.parseAsync([
      '--from', 'a',
      '--to', 'b',
      '--topic', 't',
      '--body', 'msg',
    ], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Missing required arguments'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
