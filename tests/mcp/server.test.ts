import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the CLI output module before importing CoordMcpServer
vi.mock('../../src/cli/output.js', () => ({
  connectCli: vi.fn(),
  sendRequest: vi.fn(),
  formatTable: vi.fn(),
  formatDuration: vi.fn(),
}));

// Mock StdioServerTransport to avoid stdin/stdout manipulation in tests
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  })),
}));

import WebSocket from 'ws';
import { connectCli, sendRequest } from '../../src/cli/output.js';
import { CoordMcpServer } from '../../src/mcp/server.js';
import type { AnyMessage } from '../../src/protocol/messages.js';

const mockConnectCli = vi.mocked(connectCli);
const mockSendRequest = vi.mocked(sendRequest);

// Build a minimal fake WebSocket that is OPEN
function makeFakeWs(): WebSocket {
  const ws = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
  return ws;
}

// Build a minimal cli:response AnyMessage wrapping arbitrary payload data
function makeResponse(data: unknown, error?: string): AnyMessage {
  return {
    id: 'test-id',
    type: 'cli:response',
    version: 1,
    timestamp: Date.now(),
    payload: { requestId: 'req-id', data, error },
  };
}

// Extract the handler function for a registered tool from McpServer's internal registry.
// McpServer._registeredTools is a plain object keyed by tool name, with each value having
// a `handler` property that is the callable function.
function getToolHandler(
  server: CoordMcpServer,
  toolName: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mcpInstance = (server as any).mcp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolEntry = (mcpInstance._registeredTools ?? {})[toolName] as any;
  if (!toolEntry) throw new Error(`Tool '${toolName}' not registered on McpServer`);
  return toolEntry.handler;
}

describe('CoordMcpServer tool handlers', () => {
  let server: CoordMcpServer;
  let fakeWs: WebSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeWs = makeFakeWs();
    mockConnectCli.mockResolvedValue(fakeWs);
    server = new CoordMcpServer('ws://localhost:8080', 'test-token');
    // Inject the fake WebSocket so handlers have an OPEN connection without calling start()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).ws = fakeWs;
  });

  // ------------------------------------------------------------------
  // dispatch_task
  // ------------------------------------------------------------------
  describe('dispatch_task', () => {
    it('returns taskId and status on success', async () => {
      mockSendRequest.mockResolvedValue(
        makeResponse({ taskId: 'task-abc', status: 'dispatched' }),
      );

      const handler = getToolHandler(server, 'dispatch_task');
      const result = await handler({
        agentName: 'agent-1',
        prompt: 'hello world',
      }) as { content: Array<{ type: string; text: string }> };

      expect(mockSendRequest).toHaveBeenCalledWith(fakeWs, 'dispatch-task', {
        agentName: 'agent-1',
        prompt: 'hello world',
        sessionId: undefined,
        maxBudgetUsd: undefined,
      });

      expect(result.content).toHaveLength(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.taskId).toBe('task-abc');
      expect(parsed.status).toBe('dispatched');
    });

    it('passes optional sessionId and maxBudgetUsd', async () => {
      mockSendRequest.mockResolvedValue(
        makeResponse({ taskId: 'task-xyz', status: 'dispatched' }),
      );

      const handler = getToolHandler(server, 'dispatch_task');
      await handler({
        agentName: 'agent-2',
        prompt: 'do work',
        sessionId: 'sess-1',
        maxBudgetUsd: 2.5,
      });

      expect(mockSendRequest).toHaveBeenCalledWith(fakeWs, 'dispatch-task', {
        agentName: 'agent-2',
        prompt: 'do work',
        sessionId: 'sess-1',
        maxBudgetUsd: 2.5,
      });
    });

    it('returns isError true when coordinator returns an error', async () => {
      mockSendRequest.mockResolvedValue(makeResponse(null, 'agent not found'));

      const handler = getToolHandler(server, 'dispatch_task');
      const result = await handler({ agentName: 'ghost', prompt: 'hi' }) as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('agent not found');
    });
  });

  // ------------------------------------------------------------------
  // list_agents
  // ------------------------------------------------------------------
  describe('list_agents', () => {
    it('returns the agents array from the coordinator', async () => {
      const agents = [
        { name: 'agent-1', status: 'idle', os: 'linux', arch: 'x64' },
        { name: 'agent-2', status: 'busy', os: 'darwin', arch: 'arm64' },
      ];
      mockSendRequest.mockResolvedValue(makeResponse(agents));

      const handler = getToolHandler(server, 'list_agents');
      const result = await handler({}) as { content: Array<{ type: string; text: string }> };

      expect(mockSendRequest).toHaveBeenCalledWith(fakeWs, 'list-agents');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('agent-1');
      expect(parsed[1].name).toBe('agent-2');
    });

    it('returns isError true when coordinator returns an error', async () => {
      mockSendRequest.mockResolvedValue(makeResponse(null, 'internal error'));

      const handler = getToolHandler(server, 'list_agents');
      const result = await handler({}) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('internal error');
    });
  });

  // ------------------------------------------------------------------
  // list_tasks
  // ------------------------------------------------------------------
  describe('list_tasks', () => {
    it('returns all tasks when no status filter provided', async () => {
      const tasks = [
        { id: 't-1', agentName: 'a1', status: 'complete' },
        { id: 't-2', agentName: 'a1', status: 'running' },
      ];
      mockSendRequest.mockResolvedValue(makeResponse(tasks));

      const handler = getToolHandler(server, 'list_tasks');
      const result = await handler({}) as { content: Array<{ type: string; text: string }> };

      expect(mockSendRequest).toHaveBeenCalledWith(fakeWs, 'list-tasks', { status: undefined });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
    });

    it('passes the status filter to the coordinator', async () => {
      mockSendRequest.mockResolvedValue(makeResponse([]));

      const handler = getToolHandler(server, 'list_tasks');
      await handler({ status: 'running' });

      expect(mockSendRequest).toHaveBeenCalledWith(fakeWs, 'list-tasks', { status: 'running' });
    });

    it('returns isError true when coordinator returns an error', async () => {
      mockSendRequest.mockResolvedValue(makeResponse(null, 'db error'));

      const handler = getToolHandler(server, 'list_tasks');
      const result = await handler({}) as { isError: boolean };
      expect(result.isError).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // get_task_result
  // ------------------------------------------------------------------
  describe('get_task_result', () => {
    it('returns the full task record including output', async () => {
      const task = {
        id: 'task-abc',
        agentName: 'agent-1',
        status: 'complete',
        prompt: 'hello',
        output: 'world',
        completedAt: 1700000000000,
      };
      mockSendRequest.mockResolvedValue(makeResponse(task));

      const handler = getToolHandler(server, 'get_task_result');
      const result = await handler({ taskId: 'task-abc' }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(mockSendRequest).toHaveBeenCalledWith(fakeWs, 'get-task', { taskId: 'task-abc' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('task-abc');
      expect(parsed.output).toBe('world');
      expect(parsed.status).toBe('complete');
    });

    it('returns isError true when the task is not found', async () => {
      mockSendRequest.mockResolvedValue(makeResponse(null, 'task not found'));

      const handler = getToolHandler(server, 'get_task_result');
      const result = await handler({ taskId: 'missing' }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('task not found');
    });
  });

  // ------------------------------------------------------------------
  // Lifecycle: start / stop
  // ------------------------------------------------------------------
  describe('lifecycle', () => {
    it('start() connects to coordinator via connectCli and calls mcp.connect', async () => {
      const freshWs = makeFakeWs();
      mockConnectCli.mockResolvedValue(freshWs);

      const freshServer = new CoordMcpServer('ws://coord:8080', 'my-token');
      // Spy on mcp.connect so we don't start a real stdio transport
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpConnectSpy = vi.spyOn((freshServer as any).mcp, 'connect').mockResolvedValue(undefined);

      await freshServer.start();

      expect(mockConnectCli).toHaveBeenCalledWith('ws://coord:8080', 'my-token');
      expect(mcpConnectSpy).toHaveBeenCalledOnce();
    });

    it('stop() closes the WebSocket and the MCP server', async () => {
      const closeSpy = vi.fn();
      fakeWs.close = closeSpy;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpCloseSpy = vi.spyOn((server as any).mcp, 'close').mockResolvedValue(undefined);

      await server.stop();

      expect(mcpCloseSpy).toHaveBeenCalledOnce();
      expect(closeSpy).toHaveBeenCalled();
    });
  });
});
