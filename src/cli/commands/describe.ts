import { Command } from 'commander';

// NOTE: This registry must be kept in sync when commands or REST endpoints change.
// It is the source of truth for LLM-readable capability descriptions.

export interface ArgDef {
  name: string;
  required: boolean;
  description: string;
}

export interface OptionDef {
  flags: string;
  required: boolean;
  description: string;
}

export interface CommandDef {
  name: string;
  description: string;
  arguments: ArgDef[];
  options: OptionDef[];
  examples: string[];
}

export interface RestEndpointDef {
  method: string;
  path: string;
  description: string;
  body?: string;
  auth: string;
}

export interface McpToolParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  params: McpToolParam[];
}

export interface DescriptionSchema {
  name: string;
  version: string;
  description: string;
  commands: CommandDef[];
  restApi: RestEndpointDef[];
  mcpTools: McpToolDef[];
}

const COMMANDS: CommandDef[] = [
  {
    name: 'init',
    description: 'Initialize coordination config and generate auth token. Writes ~/.coord/config.json.',
    arguments: [],
    options: [
      { flags: '--force', required: false, description: 'Overwrite existing config' },
      { flags: '--show-token', required: false, description: 'Display the generated token on stdout' },
    ],
    examples: [
      'coord init',
      'coord init --force --show-token',
    ],
  },
  {
    name: 'serve',
    description: 'Start the coordination WebSocket server. Accepts agent and CLI connections.',
    arguments: [],
    options: [
      { flags: '-p, --port <port>', required: false, description: 'Port to listen on (default: 8080)' },
      { flags: '--tls-cert <path>', required: false, description: 'Path to TLS certificate file' },
      { flags: '--tls-key <path>', required: false, description: 'Path to TLS private key file' },
      { flags: '--storage <type>', required: false, description: 'Storage backend: memory (default) or sqlite' },
      { flags: '--db-path <path>', required: false, description: 'SQLite database file path (default: ~/.coord/tasks.db)' },
    ],
    examples: [
      'coord serve',
      'coord serve --port 9090 --storage sqlite',
      'coord serve --tls-cert /etc/ssl/cert.pem --tls-key /etc/ssl/key.pem',
    ],
  },
  {
    name: 'agent',
    description: 'Start the remote agent daemon. Connects outbound to the coordinator and listens for tasks.',
    arguments: [],
    options: [
      { flags: '--url <url>', required: true, description: 'Coordinator WebSocket URL (e.g., wss://host:8080)' },
      { flags: '--token <token>', required: true, description: 'Auth token from coord init' },
      { flags: '--name <name>', required: true, description: 'Unique agent name' },
      { flags: '--cwd <directory>', required: false, description: 'Working directory for Claude Code' },
      { flags: '--dangerously-skip-permissions', required: false, description: 'Skip Claude permission prompts for fully headless use' },
      { flags: '--max-concurrent <n>', required: false, description: 'Maximum concurrent tasks (default: 1)' },
      { flags: '--isolation <none|worktree|tmpdir>', required: false, description: 'Per-task workspace isolation strategy (default: none)' },
      { flags: '--allowed-tools <tools>', required: false, description: 'Comma-separated tools to pre-authorize (e.g., "Read,Write,Edit,Bash")' },
      { flags: '--disallowed-tools <tools>', required: false, description: 'Comma-separated tools to deny' },
      { flags: '--add-dirs <dirs>', required: false, description: 'Comma-separated additional directory paths to allow' },
      { flags: '--permission-mode <mode>', required: false, description: 'Permission mode: acceptEdits, auto, default, plan' },
    ],
    examples: [
      'coord agent --url wss://coordinator.example.com:8080 --token <token> --name my-agent',
      'coord agent --url wss://host:8080 --token tok --name worker --dangerously-skip-permissions --max-concurrent 4',
      'coord agent --url wss://host:8080 --token tok --name dev --isolation worktree --allowed-tools "Read,Write,Edit,Bash"',
    ],
  },
  {
    name: 'agents',
    description: 'List all agents currently connected to the coordinator.',
    arguments: [],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord agents'],
  },
  {
    name: 'run',
    description: 'Dispatch a prompt to a remote agent and stream output. Optionally upload files before dispatch and download after completion.',
    arguments: [
      { name: 'prompt', required: true, description: 'The prompt to send to Claude Code on the remote agent' },
    ],
    options: [
      { flags: '--on <agent>', required: true, description: 'Target agent name' },
      { flags: '--bg', required: false, description: 'Dispatch in background and return task ID without streaming' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
      { flags: '--session <id>', required: false, description: 'Resume a specific Claude Code session by ID' },
      { flags: '--budget <usd>', required: false, description: 'Maximum budget in USD for this task' },
      { flags: '--allowed-tools <tools>', required: false, description: 'Comma-separated tools to allow for this task' },
      { flags: '--disallowed-tools <tools>', required: false, description: 'Comma-separated tools to deny for this task' },
      { flags: '--add-dirs <dirs>', required: false, description: 'Comma-separated additional directories to allow for this task' },
      { flags: '--upload <spec>', required: false, description: 'Upload <local>:<remote> before dispatch (repeatable)' },
      { flags: '--download <spec>', required: false, description: 'Download <remote>:<local> after task completes (repeatable)' },
    ],
    examples: [
      'coord run "fix the bug in auth.ts" --on my-agent',
      'coord run "run the test suite" --on ci-agent --bg',
      'coord run "analyze logs" --on agent-a --budget 2.00 --allowed-tools "Read,Bash"',
      'coord run "process data" --on agent-a --upload ./data.csv:/tmp/data.csv --download /tmp/output.json:./output.json',
    ],
  },
  {
    name: 'fan-out',
    description: 'Dispatch the same prompt to multiple agents in parallel and stream all output.',
    arguments: [
      { name: 'prompt', required: true, description: 'The prompt to send to all target agents' },
    ],
    options: [
      { flags: '--on <agents>', required: true, description: 'Comma-separated agent names' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
      { flags: '--budget <usd>', required: false, description: 'Maximum budget in USD per task' },
      { flags: '--allowed-tools <tools>', required: false, description: 'Comma-separated tools to allow' },
      { flags: '--disallowed-tools <tools>', required: false, description: 'Comma-separated tools to deny' },
      { flags: '--add-dirs <dirs>', required: false, description: 'Comma-separated additional directories to allow' },
      { flags: '--upload <spec>', required: false, description: 'Upload <local>:<remote> to each agent before dispatch (repeatable)' },
      { flags: '--download <spec>', required: false, description: 'Download <remote>:<local> from each agent after completion (repeatable)' },
    ],
    examples: [
      'coord fan-out "run benchmarks" --on agent-a,agent-b,agent-c',
      'coord fan-out "update dependencies" --on dev-1,dev-2 --budget 5.00',
    ],
  },
  {
    name: 'tasks',
    description: 'List tasks tracked by the coordinator.',
    arguments: [],
    options: [
      { flags: '--status <status>', required: false, description: 'Filter by status: pending, running, completed, error, dead-letter' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: [
      'coord tasks',
      'coord tasks --status running',
    ],
  },
  {
    name: 'attach',
    description: 'Stream output from a running task. Replays buffered output then streams live.',
    arguments: [
      { name: 'task-id', required: true, description: 'Task ID or prefix to attach to' },
    ],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord attach abc12345'],
  },
  {
    name: 'result',
    description: 'Get the full output of a completed task.',
    arguments: [
      { name: 'task-id', required: true, description: 'Task ID or prefix' },
    ],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord result abc12345'],
  },
  {
    name: 'sessions',
    description: 'List Claude Code sessions on a remote agent.',
    arguments: [],
    options: [
      { flags: '--on <agent>', required: true, description: 'Target agent name' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord sessions --on my-agent'],
  },
  {
    name: 'resume',
    description: 'Resume a Claude Code session on a remote agent by session ID.',
    arguments: [
      { name: 'session-id', required: true, description: 'Session ID to resume' },
      { name: 'prompt', required: false, description: 'Optional prompt to send when resuming (default: "continue")' },
    ],
    options: [
      { flags: '--on <agent>', required: true, description: 'Target agent name' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
      { flags: '--bg', required: false, description: 'Run in background and return task ID' },
    ],
    examples: [
      'coord resume <session-id> --on my-agent',
      'coord resume <session-id> "continue from step 3" --on my-agent',
    ],
  },
  {
    name: 'push',
    description: 'Push a local file or directory to a remote agent over WebSocket.',
    arguments: [
      { name: 'source', required: true, description: 'Local file or directory path' },
    ],
    options: [
      { flags: '--on <agent>', required: true, description: 'Target agent name' },
      { flags: '--dest <path>', required: true, description: 'Destination path on the agent' },
      { flags: '--exclude <patterns>', required: false, description: 'Comma-separated exclude globs (for directories)' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: [
      'coord push ./my-file.txt --on my-agent --dest /tmp/my-file.txt',
      'coord push ./src --on my-agent --dest /workspace/src --exclude "node_modules,*.log"',
    ],
  },
  {
    name: 'pull',
    description: 'Pull a remote file or directory from an agent to local.',
    arguments: [
      { name: 'source', required: true, description: 'Remote file or directory path on the agent' },
    ],
    options: [
      { flags: '--from <agent>', required: true, description: 'Source agent name' },
      { flags: '--dest <path>', required: true, description: 'Local destination path' },
      { flags: '--exclude <patterns>', required: false, description: 'Comma-separated exclude globs (for directories)' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: [
      'coord pull /tmp/output.json --from my-agent --dest ./output.json',
      'coord pull /workspace/dist --from my-agent --dest ./dist',
    ],
  },
  {
    name: 'transfer',
    description: 'Transfer files between two remote agents (agent-to-agent, no local disk).',
    arguments: [
      { name: 'source', required: true, description: 'Source path on the source agent' },
    ],
    options: [
      { flags: '--from <agent>', required: true, description: 'Source agent name' },
      { flags: '--to <agent>', required: true, description: 'Destination agent name' },
      { flags: '--dest <path>', required: true, description: 'Destination path on the target agent' },
      { flags: '--exclude <patterns>', required: false, description: 'Comma-separated exclude globs (for directories)' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: [
      'coord transfer /workspace/data --from agent-a --to agent-b --dest /workspace/data',
    ],
  },
  {
    name: 'send-message',
    description: 'Send a message from one agent to another via the coordinator.',
    arguments: [],
    options: [
      { flags: '--from <agent>', required: true, description: 'Source agent name' },
      { flags: '--to <agent>', required: true, description: 'Target agent name' },
      { flags: '--topic <topic>', required: true, description: 'Message topic' },
      { flags: '--body <body>', required: true, description: 'Message body' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: [
      'coord send-message --from agent-a --to agent-b --topic ping --body "hello"',
    ],
  },
  {
    name: 'mcp',
    description: 'Start MCP server for Claude Code integration (stdio transport). Exposes coordinator capabilities as MCP tools.',
    arguments: [],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord mcp'],
  },
  {
    name: 'dashboard',
    description: 'Interactive TUI dashboard showing agents, tasks, and stats in real time.',
    arguments: [],
    options: [
      { flags: '-u, --url <url>', required: false, description: 'Coordinator base URL (overrides config)' },
      { flags: '-i, --interval <ms>', required: false, description: 'Polling interval in milliseconds (default: 2000)' },
    ],
    examples: [
      'coord dashboard',
      'coord dashboard --url http://localhost:8080 --interval 1000',
    ],
  },
  {
    name: 'users list',
    description: 'List all users (admin only). Uses REST API.',
    arguments: [],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord users list'],
  },
  {
    name: 'users create',
    description: 'Create a new user (admin only).',
    arguments: [
      { name: 'username', required: true, description: 'Username for the new user' },
    ],
    options: [
      { flags: '--role <role>', required: false, description: 'Role: admin, operator, viewer (default: operator)' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord users create alice --role operator'],
  },
  {
    name: 'users create-key',
    description: 'Create an API key for a user (admin only). Key is shown only once.',
    arguments: [
      { name: 'username', required: true, description: 'Username to create the key for' },
    ],
    options: [
      { flags: '--label <label>', required: false, description: 'Label for the key' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord users create-key alice --label "ci-token"'],
  },
  {
    name: 'orgs list',
    description: 'List orgs you belong to.',
    arguments: [],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord orgs list'],
  },
  {
    name: 'orgs create',
    description: 'Create a new organization (admin only).',
    arguments: [
      { name: 'name', required: true, description: 'Organization name' },
    ],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord orgs create my-team'],
  },
  {
    name: 'orgs add-member',
    description: 'Add a member to an org (org admin only).',
    arguments: [
      { name: 'org', required: true, description: 'Org ID or name' },
      { name: 'username', required: true, description: 'Username to add' },
    ],
    options: [
      { flags: '--role <role>', required: false, description: 'Role: admin, operator, viewer (default: operator)' },
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord orgs add-member my-team alice --role operator'],
  },
  {
    name: 'orgs remove-member',
    description: 'Remove a member from an org (org admin only).',
    arguments: [
      { name: 'org', required: true, description: 'Org ID or name' },
      { name: 'username', required: true, description: 'Username to remove' },
    ],
    options: [
      { flags: '--url <url>', required: false, description: 'Coordinator URL (overrides config)' },
    ],
    examples: ['coord orgs remove-member my-team alice'],
  },
  {
    name: 'describe',
    description: 'Output a comprehensive description of clawd-coordinator for LLM consumption.',
    arguments: [],
    options: [
      { flags: '--json', required: false, description: 'Output as JSON schema instead of markdown' },
    ],
    examples: [
      'coord describe',
      'coord describe --json',
    ],
  },
  {
    name: 'claude-md',
    description: 'Output a CLAUDE.md file describing clawd-coordinator for Claude Code discovery.',
    arguments: [],
    options: [
      { flags: '--install', required: false, description: 'Write CLAUDE.md to the current directory' },
    ],
    examples: [
      'coord claude-md',
      'coord claude-md --install',
    ],
  },
];

const REST_API: RestEndpointDef[] = [
  { method: 'GET', path: '/api/agents', description: 'List all connected agents', auth: 'Bearer token required' },
  { method: 'GET', path: '/api/tasks', description: 'List tasks, optionally filtered with ?status=pending|running|completed|error|dead-letter', auth: 'Bearer token required' },
  { method: 'GET', path: '/api/tasks/:id', description: 'Get a single task by ID', auth: 'Bearer token required' },
  { method: 'POST', path: '/api/dispatch', description: 'Dispatch a task. Body: { agentName, prompt, sessionId?, maxBudgetUsd? }', body: '{ agentName: string, prompt: string, sessionId?: string, maxBudgetUsd?: number }', auth: 'Bearer token required' },
  { method: 'GET', path: '/api/users', description: 'List all users (admin only)', auth: 'Bearer token required, admin role' },
  { method: 'POST', path: '/api/users', description: 'Create a user. Body: { username, role }', body: '{ username: string, role: "admin"|"operator"|"viewer" }', auth: 'Bearer token required, admin role' },
  { method: 'POST', path: '/api/users/:id/keys', description: 'Create an API key for a user. Body: { label? }', body: '{ label?: string }', auth: 'Bearer token required, admin role' },
  { method: 'DELETE', path: '/api/keys/:id', description: 'Revoke an API key', auth: 'Bearer token required, admin role' },
  { method: 'GET', path: '/api/orgs', description: 'List orgs (admin sees all; users see their own)', auth: 'Bearer token required' },
  { method: 'POST', path: '/api/orgs', description: 'Create an org. Body: { name }', body: '{ name: string }', auth: 'Bearer token required, admin role' },
  { method: 'POST', path: '/api/orgs/:id/members', description: 'Add a member to an org. Body: { userId, role }', body: '{ userId: string, role: "admin"|"operator"|"viewer" }', auth: 'Bearer token required, org admin or global admin' },
  { method: 'DELETE', path: '/api/orgs/:id/members/:userId', description: 'Remove a member from an org', auth: 'Bearer token required, org admin or global admin' },
  { method: 'POST', path: '/api/message', description: 'Relay a message between agents. Body: { fromAgent, toAgent, topic, body }', body: '{ fromAgent: string, toAgent: string, topic: string, body: string }', auth: 'Bearer token required' },
  { method: 'GET', path: '/api/transfers', description: 'List active file transfers', auth: 'Bearer token required' },
  { method: 'POST', path: '/api/push', description: 'Initiate a push transfer. Body: { agentName, destPath, filename }', body: '{ agentName: string, destPath: string, filename: string }', auth: 'Bearer token required' },
  { method: 'POST', path: '/api/pull', description: 'Initiate a pull transfer. Body: { agentName, sourcePath }', body: '{ agentName: string, sourcePath: string }', auth: 'Bearer token required' },
  { method: 'GET', path: '/api/stats', description: 'JSON summary of key metrics', auth: 'Bearer token required' },
  { method: 'GET', path: '/metrics', description: 'Prometheus metrics in text format', auth: 'Bearer token required' },
];

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'dispatch_task',
    description: 'Dispatch a prompt to a named remote agent and return the task ID',
    params: [
      { name: 'agentName', type: 'string', required: true, description: 'Name of the target agent' },
      { name: 'prompt', type: 'string', required: true, description: 'Prompt to send to the agent' },
      { name: 'sessionId', type: 'string', required: false, description: 'Optional Claude Code session ID to resume' },
      { name: 'maxBudgetUsd', type: 'number', required: false, description: 'Maximum spend budget in USD for this task' },
      { name: 'allowedTools', type: 'string[]', required: false, description: 'Tool names to allow for this task' },
      { name: 'disallowedTools', type: 'string[]', required: false, description: 'Tool names to deny for this task' },
      { name: 'addDirs', type: 'string[]', required: false, description: 'Additional directory paths to allow' },
    ],
  },
  {
    name: 'list_agents',
    description: 'List all agents currently connected to the coordinator',
    params: [],
  },
  {
    name: 'list_tasks',
    description: 'List tasks tracked by the coordinator, optionally filtered by status',
    params: [
      { name: 'status', type: '"pending"|"running"|"completed"|"error"', required: false, description: 'Filter by task status' },
    ],
  },
  {
    name: 'get_task_result',
    description: 'Get the result and output of a completed or running task',
    params: [
      { name: 'taskId', type: 'string', required: true, description: 'The task ID returned by dispatch_task' },
    ],
  },
  {
    name: 'push_files',
    description: 'Push a local file or directory to a remote agent',
    params: [
      { name: 'agentName', type: 'string', required: true, description: 'Target agent name' },
      { name: 'sourcePath', type: 'string', required: true, description: 'Local file or directory path to push' },
      { name: 'destPath', type: 'string', required: true, description: 'Destination path on the agent' },
      { name: 'exclude', type: 'string[]', required: false, description: 'Glob patterns to exclude (for directories)' },
    ],
  },
  {
    name: 'pull_files',
    description: 'Pull a file or directory from a remote agent to local',
    params: [
      { name: 'agentName', type: 'string', required: true, description: 'Source agent name' },
      { name: 'sourcePath', type: 'string', required: true, description: 'Remote file or directory path' },
      { name: 'destPath', type: 'string', required: true, description: 'Local destination path' },
      { name: 'exclude', type: 'string[]', required: false, description: 'Glob patterns to exclude (for directories)' },
    ],
  },
  {
    name: 'send_agent_message',
    description: 'Send a message from one agent to another via the coordinator',
    params: [
      { name: 'fromAgent', type: 'string', required: true, description: 'Name of the source agent' },
      { name: 'toAgent', type: 'string', required: true, description: 'Name of the target agent' },
      { name: 'topic', type: 'string', required: true, description: 'Message topic' },
      { name: 'body', type: 'string', required: true, description: 'Message body' },
    ],
  },
];

export function getDescriptionJson(): DescriptionSchema {
  return {
    name: 'clawd-coordinator',
    version: '0.1.0',
    description:
      'CLI tool for orchestrating remote Claude Code sessions across machines via WebSocket. ' +
      'Dispatch prompts to Claude Code instances running on cloud VMs, stream results in real time, ' +
      'and fan out work across multiple machines — all from your local terminal or from within a Claude Code session via bash.',
    commands: COMMANDS,
    restApi: REST_API,
    mcpTools: MCP_TOOLS,
  };
}

export function getDescriptionMarkdown(): string {
  return `# clawd-coordinator

## What It Is

clawd-coordinator is a CLI tool for orchestrating remote Claude Code sessions across machines via WebSocket. It lets you dispatch prompts to Claude Code instances running on cloud VMs, stream results back in real time, and fan out work across multiple machines — all from your local terminal or from within a Claude Code session via bash.

## Architecture

Three components, one npm package (\`coord\` binary):

- **Coordinator** (\`coord serve\`): WebSocket server running locally or on a central host. Accepts connections from agents (\`/agent?token=\`) and CLI clients (\`/cli?token=\`). Manages agent registry, task dispatch, and output streaming. Optionally backed by SQLite for persistence.
- **Remote Agent** (\`coord agent\`): Lightweight daemon on each remote machine. Connects outbound to the coordinator (no inbound ports required). On task receipt, spawns \`claude -p --verbose --output-format stream-json\` and streams output back over WebSocket. Auto-reconnects with exponential backoff.
- **CLI** (\`coord run\`, \`coord agents\`, etc.): Connects to the coordinator over WebSocket. Dispatches tasks, streams results, lists agents and tasks.

Auth: Single shared token (V1) or per-agent tokens (V2). Token stored at \`~/.coord/config.json\`.

## CLI Commands

${COMMANDS.map((cmd) => {
  const argStr = cmd.arguments.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ');
  const lines: string[] = [
    `### coord ${cmd.name}`,
    '',
    cmd.description,
    '',
  ];
  if (cmd.arguments.length > 0) {
    lines.push('**Arguments:**');
    for (const arg of cmd.arguments) {
      lines.push(`- \`${arg.required ? '<' : '['}${arg.name}${arg.required ? '>' : ']'}\` ${arg.required ? '(required)' : '(optional)'} — ${arg.description}`);
    }
    lines.push('');
  }
  if (cmd.options.length > 0) {
    lines.push('**Options:**');
    for (const opt of cmd.options) {
      lines.push(`- \`${opt.flags}\` ${opt.required ? '(required)' : ''} — ${opt.description}`);
    }
    lines.push('');
  }
  if (cmd.examples.length > 0) {
    lines.push('**Examples:**');
    lines.push('```');
    lines.push(...cmd.examples);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}).join('\n')}

## File Transfer

Three file transfer commands operate over the same WebSocket protocol as task dispatch:

- **\`coord push\`**: Upload a local file or directory to a remote agent. Supports directories (streamed as tar).
- **\`coord pull\`**: Download a file or directory from a remote agent to local disk.
- **\`coord transfer\`**: Move files directly between two remote agents without touching local disk.
- **Inline with \`run\`**: Use \`--upload <local>:<remote>\` and \`--download <remote>:<local>\` flags on \`coord run\` to bundle transfers with task dispatch.

Transfer protocol: chunked base64 over WebSocket with per-chunk acknowledgement (512 KB chunks).

## Permission Model

Agent permission flags control what Claude Code is allowed to do on the remote machine:

| Flag | Description |
|------|-------------|
| \`--dangerously-skip-permissions\` | Skip all Claude permission prompts (fully headless). Mutually exclusive with \`--allowed-tools\` and \`--permission-mode\`. |
| \`--allowed-tools <tools>\` | Pre-authorize specific tool names (comma-separated). Example: \`"Read,Write,Edit,Bash"\` |
| \`--disallowed-tools <tools>\` | Deny specific tools (comma-separated) |
| \`--add-dirs <dirs>\` | Allow additional directory paths (comma-separated) |
| \`--permission-mode <mode>\` | Set permission mode: \`acceptEdits\`, \`auto\`, \`default\`, or \`plan\` |
| \`--isolation <none|worktree|tmpdir>\` | Per-task workspace isolation strategy (default: \`none\`) |

Per-task overrides: \`--allowed-tools\`, \`--disallowed-tools\`, \`--add-dirs\`, and \`--budget\` can also be passed on \`coord run\` and \`coord fan-out\` to override agent defaults for a single task.

## REST API

The coordinator exposes a REST API on the same port as WebSocket (default: 8080). All \`/api/*\` routes require \`Authorization: Bearer <token>\`.

${REST_API.map(ep => {
  const bodyNote = ep.body ? ` Body: \`${ep.body}\`` : '';
  return `- \`${ep.method} ${ep.path}\` — ${ep.description}${bodyNote}`;
}).join('\n')}

## MCP Tools

\`coord mcp\` starts an MCP server (stdio transport) exposing coordinator capabilities as tools for use in Claude Code or other MCP clients.

${MCP_TOOLS.map(tool => {
  const required = tool.params.filter(p => p.required).map(p => p.name);
  const optional = tool.params.filter(p => !p.required).map(p => p.name);
  const paramSummary = [
    ...(required.length > 0 ? [`required: ${required.join(', ')}`] : []),
    ...(optional.length > 0 ? [`optional: ${optional.join(', ')}`] : []),
  ].join(' | ');
  return `- **\`${tool.name}\`** — ${tool.description}${paramSummary ? ` (${paramSummary})` : ''}`;
}).join('\n')}

## Common Usage Patterns

### Setup (once per machine)
\`\`\`
# On local machine
coord init
coord serve

# On each remote machine
coord agent --url wss://<coordinator-host>:8080 --token <token> --name <agent-name>
\`\`\`

### Dispatch a task
\`\`\`
coord run "refactor the auth module" --on my-agent
coord run "fix bug" --on agent-a --bg   # background, get task ID
coord attach <task-id>                  # attach to running task
coord result <task-id>                  # get output of completed task
\`\`\`

### Fan out to multiple agents
\`\`\`
coord fan-out "run the test suite" --on agent-a,agent-b,agent-c
\`\`\`

### File transfers
\`\`\`
coord push ./data.csv --on my-agent --dest /tmp/data.csv
coord pull /tmp/output.json --from my-agent --dest ./output.json
coord transfer /workspace/data --from agent-a --to agent-b --dest /workspace/data
\`\`\`

### Within a task (upload + download inline)
\`\`\`
coord run "process the CSV and write output.json" --on my-agent \\
  --upload ./data.csv:/tmp/data.csv \\
  --download /tmp/output.json:./output.json
\`\`\`

### Use via MCP (in Claude Code)
Add to MCP config:
\`\`\`json
{
  "mcpServers": {
    "clawd": {
      "command": "coord",
      "args": ["mcp"]
    }
  }
}
\`\`\`
Then use MCP tools: \`dispatch_task\`, \`list_agents\`, \`list_tasks\`, \`get_task_result\`, \`push_files\`, \`pull_files\`, \`send_agent_message\`.

## Full Help

\`\`\`
coord --help
coord <command> --help
coord describe --json   # machine-readable schema of all capabilities
\`\`\`
`;
}

export const describeCommand = new Command('describe')
  .description('Output a comprehensive description of clawd-coordinator for LLM consumption')
  .option('--json', 'Output as JSON schema instead of markdown')
  .action((options: { json?: boolean }) => {
    if (options.json) {
      console.log(JSON.stringify(getDescriptionJson(), null, 2));
    } else {
      console.log(getDescriptionMarkdown());
    }
  });
