import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { connectCli, sendRequest } from '../cli/output.js';

// --- Response shape helpers ---

interface DispatchTaskData {
  taskId: string;
  status: string;
}

interface AgentEntry {
  name: string;
  status: string;
  os?: string;
  arch?: string;
}

interface TaskEntry {
  id: string;
  agentName: string;
  status: string;
  prompt?: string;
  createdAt?: number;
}

interface TaskResultData {
  id: string;
  agentName: string;
  status: string;
  prompt?: string;
  output?: string;
  error?: string;
  createdAt?: number;
  completedAt?: number;
}

interface SendMessageData {
  correlationId: string;
  status: 'delivered' | 'agent-offline' | 'unknown-agent';
}

// Narrow the opaque `unknown` payload.data coming from sendRequest.
function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- MCP Server class ---

export class CoordMcpServer {
  private readonly coordinatorUrl: string;
  private readonly token: string;
  private ws: WebSocket | null = null;
  private readonly mcp: McpServer;

  constructor(coordinatorUrl: string, token: string) {
    this.coordinatorUrl = coordinatorUrl;
    this.token = token;

    this.mcp = new McpServer(
      { name: 'clawd-coordinator', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    this.registerTools();
  }

  private registerTools(): void {
    // dispatch_task
    this.mcp.registerTool(
      'dispatch_task',
      {
        description: 'Dispatch a prompt to a named remote agent and return the task ID',
        inputSchema: z.object({
          agentName: z.string().describe('Name of the target agent'),
          prompt: z.string().describe('Prompt to send to the agent'),
          sessionId: z.string().optional().describe('Optional Claude Code session ID to resume'),
          maxBudgetUsd: z
            .number()
            .positive()
            .optional()
            .describe('Maximum spend budget in USD for this task'),
          allowedTools: z.array(z.string()).optional().describe('Tool names to allow for this task'),
          disallowedTools: z.array(z.string()).optional().describe('Tool names to deny for this task'),
          addDirs: z.array(z.string()).optional().describe('Additional directory paths to allow'),
        }),
      },
      async (args) => {
        const ws = await this.ensureConnected();
        const response = await sendRequest(ws, 'dispatch-task', {
          agentName: args.agentName,
          prompt: args.prompt,
          sessionId: args.sessionId,
          maxBudgetUsd: args.maxBudgetUsd,
          allowedTools: args.allowedTools,
          disallowedTools: args.disallowedTools,
          addDirs: args.addDirs,
        });

        const payload = response.payload as { data: unknown; error?: string };
        if (payload.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${payload.error}` }],
            isError: true,
          };
        }

        const data = asRecord(payload.data) as unknown as DispatchTaskData;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ taskId: data.taskId, status: data.status ?? 'dispatched' }),
            },
          ],
        };
      },
    );

    // list_agents
    this.mcp.registerTool(
      'list_agents',
      {
        description: 'List all agents currently connected to the coordinator',
        inputSchema: z.object({}),
      },
      async () => {
        const ws = await this.ensureConnected();
        const response = await sendRequest(ws, 'list-agents');

        const payload = response.payload as { data: unknown; error?: string };
        if (payload.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${payload.error}` }],
            isError: true,
          };
        }

        const agents = asArray(payload.data) as AgentEntry[];
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(agents) }],
        };
      },
    );

    // list_tasks
    this.mcp.registerTool(
      'list_tasks',
      {
        description: 'List tasks tracked by the coordinator, optionally filtered by status',
        inputSchema: z.object({
          status: z
            .enum(['pending', 'running', 'completed', 'error'])
            .optional()
            .describe('Filter by task status'),
        }),
      },
      async (args) => {
        const ws = await this.ensureConnected();
        const response = await sendRequest(ws, 'list-tasks', {
          status: args.status,
        });

        const payload = response.payload as { data: unknown; error?: string };
        if (payload.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${payload.error}` }],
            isError: true,
          };
        }

        const tasks = asArray(payload.data) as TaskEntry[];
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(tasks) }],
        };
      },
    );

    // get_task_result
    this.mcp.registerTool(
      'get_task_result',
      {
        description: 'Get the result and output of a completed or running task',
        inputSchema: z.object({
          taskId: z.string().describe('The task ID returned by dispatch_task'),
        }),
      },
      async (args) => {
        const ws = await this.ensureConnected();
        const response = await sendRequest(ws, 'get-task', { taskId: args.taskId });

        const payload = response.payload as { data: unknown; error?: string };
        if (payload.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${payload.error}` }],
            isError: true,
          };
        }

        const task = asRecord(payload.data) as unknown as TaskResultData;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(task) }],
        };
      },
    );

    // push_files
    this.mcp.registerTool(
      'push_files',
      {
        description: 'Push a local file or directory to a remote agent',
        inputSchema: z.object({
          agentName: z.string().describe('Target agent name'),
          sourcePath: z.string().describe('Local file or directory path to push'),
          destPath: z.string().describe('Destination path on the agent'),
          exclude: z.array(z.string()).optional().describe('Glob patterns to exclude (for directories)'),
        }),
      },
      async (args) => {
        const ws = await this.ensureConnected();
        const response = await sendRequest(ws, 'push-file', {
          agentName: args.agentName,
          destPath: args.destPath,
          filename: args.sourcePath.split('/').pop() ?? args.sourcePath,
          totalBytes: 0,
          isDirectory: false,
          totalChunks: 0,
        });

        const payload = response.payload as { data: unknown; error?: string };
        if (payload.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${payload.error}` }],
            isError: true,
          };
        }

        const data = asRecord(payload.data);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ transferId: data['transferId'], ready: data['ready'] }) }],
        };
      },
    );

    // pull_files
    this.mcp.registerTool(
      'pull_files',
      {
        description: 'Pull a file or directory from a remote agent to local',
        inputSchema: z.object({
          agentName: z.string().describe('Source agent name'),
          sourcePath: z.string().describe('Remote file or directory path'),
          destPath: z.string().describe('Local destination path'),
          exclude: z.array(z.string()).optional().describe('Glob patterns to exclude (for directories)'),
        }),
      },
      async (args) => {
        const ws = await this.ensureConnected();
        const response = await sendRequest(ws, 'pull-file', {
          agentName: args.agentName,
          sourcePath: args.sourcePath,
          exclude: args.exclude ?? [],
        });

        const payload = response.payload as { data: unknown; error?: string };
        if (payload.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${payload.error}` }],
            isError: true,
          };
        }

        const data = asRecord(payload.data);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ transferId: data['transferId'], ready: data['ready'] }) }],
        };
      },
    );

    // send_agent_message
    this.mcp.registerTool(
      'send_agent_message',
      {
        description: 'Send a message from one agent to another via the coordinator',
        inputSchema: z.object({
          fromAgent: z.string().describe('Name of the source agent'),
          toAgent: z.string().describe('Name of the target agent'),
          topic: z.string().describe('Message topic'),
          body: z.string().describe('Message body'),
        }),
      },
      async (args) => {
        const ws = await this.ensureConnected();
        const response = await sendRequest(ws, 'send-message', {
          fromAgent: args.fromAgent,
          toAgent: args.toAgent,
          topic: args.topic,
          body: args.body,
        });

        const payload = response.payload as { data: unknown; error?: string };
        if (payload.error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${payload.error}` }],
            isError: true,
          };
        }

        const data = asRecord(payload.data) as unknown as SendMessageData;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ correlationId: data.correlationId, status: data.status }),
            },
          ],
        };
      },
    );
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    // Attempt reconnect
    try {
      this.ws = await connectCli(this.coordinatorUrl, this.token);
    } catch {
      throw new Error('Not connected to coordinator and reconnect failed');
    }
    return this.ws;
  }

  /** @deprecated Use ensureConnected() for auto-reconnect */
  private requireWs(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to coordinator');
    }
    return this.ws;
  }

  async start(): Promise<void> {
    this.ws = await connectCli(this.coordinatorUrl, this.token);
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }

  async stop(): Promise<void> {
    await this.mcp.close();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
