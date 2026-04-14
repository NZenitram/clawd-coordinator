# Clawd Coordinator

Orchestrate remote Claude Code sessions across machines via WebSocket. Dispatch prompts to Claude instances running on cloud VMs, stream results in real time, and fan out work across multiple machines — all from your local terminal or via MCP.

SQLite persistence, per-agent concurrency, workspace isolation, REST API, and MCP server integration.

## Quick Start

### 1. Install

From git (current):
```bash
git clone https://github.com/NZenitram/clawd-coordinator.git
cd clawd-coordinator
npm install && npm run build
npm link  # makes `coord` available globally
```

From npm (once published):
```bash
npm install -g clawd-coordinator
```

### 2. Initialize

```bash
coord init
```

Generates `~/.coord/config.json` with an auth token (file permissions 0600).

### 3. Start the coordinator

```bash
coord serve -p 8080
```

In another terminal, expose it securely:

```bash
tailscale funnel 8080
# Now available at wss://<machine-name>.<tailnet>.ts.net
```

Or use direct TLS:
```bash
coord serve -p 8080 --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

### 4. Connect a remote agent

On the remote machine (Claude Code must be installed and authenticated):

```bash
TOKEN=$(cat ~/.coord/config.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

coord agent \
  --url wss://<coordinator-host>:8080 \
  --token "$TOKEN" \
  --name my-agent
```

### 5. Dispatch tasks

From your local machine:

```bash
# Run and stream output
coord run "fix the bug in src/auth.ts" --on my-agent

# Run in background
coord run "run the test suite" --on my-agent --bg

# Fan out to multiple agents
coord fan-out "linting check" --on agent-1,agent-2,agent-3

# List agents
coord agents

# List tasks
coord tasks

# Stream output from a running task
coord attach <task-id>

# Get output from completed task
coord result <task-id>
```

## Architecture

```
Local Machine                          Remote Machines
┌─────────────────────────┐
│  Claude Code ──────────┬┤           ┌──────────────────┐
│                        │├──WSS─────>│  Remote Agent    │
│  CLI (coord) ──────────┬┤           │  (spawns claude) │
│                        │├──WSS─────>└──────────────────┘
│  Coordinator           │├──WSS─────>┌──────────────────┐
│  (WebSocket server)    │            │  Remote Agent    │
│  REST API              │├──HTTP────>│  (spawns claude) │
│  MCP server            │            └──────────────────┘
│  Tailscale Funnel      │
│  (TLS termination)     │
└─────────────────────────┘
```

- Agents connect **outbound** to the coordinator (no inbound ports needed)
- Each agent spawns `claude -p --output-format stream-json` as a child process
- Task output streams back over WebSocket in real-time
- Agents auto-reconnect with exponential backoff (1s to 30s)
- Coordinator detects stale connections via WebSocket ping/pong (30s interval)

## CLI Commands

| Command | Description | Flags |
|---------|-------------|-------|
| `coord init` | Generate config and auth token | `--force`, `--show-token` |
| `coord serve` | Start coordinator WebSocket server | `-p, --port`, `--tls-cert`, `--tls-key`, `--storage`, `--db-path` |
| `coord agent` | Start remote agent daemon | `--url`, `--token`, `--name`, `--cwd`, `--max-concurrent`, `--isolation`, `--dangerously-skip-permissions` |
| `coord agents` | List connected agents | `--url` |
| `coord run` | Dispatch prompt to agent and stream output | `--on <agent>`, `--bg`, `--url`, `--session`, `--budget` |
| `coord fan-out` | Dispatch to multiple agents in parallel | `--on <a,b,c>`, `--url`, `--budget` |
| `coord tasks` | List all tasks | `--url`, `--status` |
| `coord attach` | Stream output from a running task | `--url` |
| `coord result` | Get output from completed task | `--url` |
| `coord sessions` | List sessions on an agent | `--on <agent>`, `--url` |
| `coord resume` | Resume a Claude Code session | `--on <agent>`, `--url` |
| `coord mcp` | Start MCP server for Claude Code integration | `--url` |

### Common Patterns

**Dispatch with budget limit:**
```bash
coord run "analyze and summarize report" --on my-agent --budget 2.50
```

**Background dispatch:**
```bash
TASK_ID=$(coord run "long operation" --on my-agent --bg)
coord attach $TASK_ID  # Stream later
```

**Resume a session:**
```bash
coord resume abc-123-def --on my-agent
```

**Per-agent concurrency (up to 4 concurrent tasks):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent --max-concurrent 4
```

**Workspace isolation (git worktrees):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent --isolation worktree
```

## REST API

The coordinator exposes a REST API on HTTP (same port as WebSocket). All endpoints require Bearer token authorization.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all connected agents |
| `POST` | `/api/dispatch` | Dispatch a task to an agent |
| `GET` | `/api/tasks` | List tasks (optionally filter by status) |
| `GET` | `/api/tasks/:id` | Get a specific task |

### Examples

**List agents:**
```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/agents
```

**Dispatch a task:**
```bash
curl -X POST http://localhost:8080/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "my-agent",
    "prompt": "run the tests",
    "maxBudgetUsd": 1.50
  }'
```

**List tasks with status filter:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/api/tasks?status=running"
```

**Get task result:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/tasks/abc-123-def
```

## MCP Server

Run the coordinator as an MCP server for seamless Claude Code integration:

```bash
coord mcp --url wss://<coordinator-host>:8080
```

Then add to Claude Code's configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "clawd-coordinator": {
      "command": "node",
      "args": ["/path/to/clawd-coordinator/dist/cli/index.js", "mcp", "--url", "wss://your-coordinator.ts.net"]
    }
  }
}
```

The MCP server exposes these tools:
- `dispatch_task` — Dispatch a prompt to an agent
- `list_agents` — List connected agents
- `list_tasks` — List tasks with optional status filter
- `get_task_result` — Get output from a completed task

Inside Claude Code, you can now use:

```
I have agents connected. Can you run tests on staging-box and report the results?
```

Claude will automatically dispatch to the agent via the MCP integration.

## Persistence & State

### In-Memory (Default)

```bash
coord serve -p 8080
# All task state lost on restart
```

### SQLite Persistence

```bash
coord serve -p 8080 --storage sqlite --db-path ~/.coord/tasks.db
```

Tasks and results are persisted to SQLite. On restart, incomplete running tasks are recovered and automatically retried. Completed and error tasks remain in the database for audit trails.

## Task Queuing

When agents are at max concurrency, tasks are queued automatically and processed in FIFO order.

**Behavior:**
- Task status: `pending` -> `running` -> `completed` (or `error`)
- Agents reject new tasks if at capacity (unless task queue is enabled)
- Queue stores pending tasks until agent capacity is available

**Example with per-agent concurrency:**
```bash
# Agent accepts max 2 concurrent tasks
coord agent --url wss://host:8080 --token TOKEN --name my-agent --max-concurrent 2

# Dispatch 5 tasks in quick succession
for i in {1..5}; do
  coord run "task $i" --on my-agent --bg &
done
wait

# First 2 start immediately, remaining 3 queue and process sequentially
coord tasks  # Shows 2 running, 3 pending
```

## Workspace Isolation

Each task can run in an isolated workspace, preventing filesystem conflicts.

**Strategies:**

| Strategy | Use Case | Tradeoff |
|----------|----------|----------|
| `none` | Sequential tasks in same directory | Fastest, but tasks can interfere |
| `worktree` | Git repositories, parallel tasks | Uses git worktrees (isolated checkouts) |
| `tmpdir` | Any directory, maximum isolation | Slowest; copies entire directory per task |

**Example:**
```bash
# Create isolated git worktrees for each task
coord agent --url wss://host:8080 --token TOKEN --name my-agent --isolation worktree

# Now 5 concurrent tasks each get their own worktree
coord agent --url wss://host:8080 --token TOKEN --name my-agent --max-concurrent 5 --isolation worktree
```

## Configuration

Config file at `~/.coord/config.json`:

```json
{
  "token": "sk-...",
  "agentTokens": {
    "my-agent": "sk-agent-..."
  },
  "coordinatorUrl": "wss://myhost.ts.net",
  "port": 8080,
  "tls": {
    "cert": "/path/to/cert.pem",
    "key": "/path/to/key.pem"
  }
}
```

**Fields:**
- `token` — Shared token for local CLI clients (generated by `coord init`)
- `agentTokens` — Per-agent tokens (optional)
- `coordinatorUrl` — Default coordinator URL for CLI commands
- `port` — Default port for `coord serve`
- `tls` — Optional TLS certificate paths

File permissions are set to 0600 (readable/writable by owner only).

## Security

### Transport Security

- Use TLS in production: `--tls-cert` and `--tls-key` flags
- Or use Tailscale Funnel for automatic TLS
- Avoid plaintext (`ws://`) over untrusted networks

### Authentication

**Shared token:**
- Single token in `~/.coord/config.json` for all agents and CLI clients
- Agent names are self-reported (no guarantee of identity)
- Use in trusted environments or add application-level authorization

**Per-agent tokens:**
- Each agent can have its own token (`agentTokens` map in config)
- Separate tokens for CLI and agents for tighter access control

### Environment Variables

- Spawned Claude processes inherit the full environment
- Minimize sensitive env vars on agent machines
- Run agents in containers with restricted environments for sensitive workloads

### Process Isolation

- Use `--isolation worktree` or `--isolation tmpdir` for filesystem isolation
- Each task runs in its own Claude session (not shared across tasks)
- No cross-task communication within the same agent

## Testing

Run the automated test suite:

```bash
npm test                   # 152 tests across 15 suites
npm run lint               # TypeScript type-check
npm run dev                # Watch mode for development
```

### Manual Integration Testing

See [docs/testing.md](docs/testing.md) for the full manual test procedure (12 steps).

Quick smoke test:

```bash
# Terminal 1: Start coordinator
npm run build
coord init --force
COORD_LOG_LEVEL=info coord serve -p 9999

# Terminal 2: Connect agent
TOKEN=$(cat ~/.coord/config.json | jq -r .token)
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" --name test-agent

# Terminal 3: Dispatch task
coord run "respond with 'ok'" --on test-agent --url ws://localhost:9999
```

## Deployment

### Prerequisites

**Coordinator machine:**
- Node.js >= 18
- Tailscale (optional, for Funnel)

**Each remote agent machine:**
- Node.js >= 18
- Claude Code installed and authenticated
- Network access to coordinator (outbound only)

### Deploy Agent as Systemd Service

```ini
# /etc/systemd/system/coord-agent.service
[Unit]
Description=Clawd Coordinator Agent
After=network.target

[Service]
Type=simple
User=deploy
Environment=COORD_LOG_LEVEL=info
ExecStart=/usr/local/bin/coord agent \
  --url wss://coordinator.example.ts.net \
  --token <token> \
  --name %H \
  --cwd /home/deploy/workspace \
  --max-concurrent 4 \
  --isolation worktree
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable --now coord-agent
sudo systemctl logs -u coord-agent -f  # Watch logs
```

See [docs/deployment.md](docs/deployment.md) for complete setup instructions.

## Logging

Set `COORD_LOG_LEVEL` to control verbosity:

```bash
COORD_LOG_LEVEL=silent npm test      # No logs (default for tests)
COORD_LOG_LEVEL=debug coord serve    # Verbose (pino level 20)
COORD_LOG_LEVEL=info coord serve     # Info (pino level 30, default)
COORD_LOG_LEVEL=warn coord serve     # Warnings only
```

Logs are structured JSON (pino format) for easy parsing and aggregation.

## Troubleshooting

**Agent can't connect:**
- Verify coordinator URL is reachable: `curl -I https://<coordinator-host>:8080`
- Check token matches the coordinator's token
- Server logs auth failures: `"msg":"Authentication failed"`

**Agent shows stale/disconnected:**
- Coordinator evicts agents idle > 90s (or > 5m if busy)
- Check agent logs for reconnect messages: `"msg":"Scheduling reconnect"`

**Task hangs:**
- Default timeout is 30 minutes (configurable in agent options)
- After timeout: SIGTERM, then SIGKILL after 5s
- Coordinator errors the task if agent becomes unresponsive

**Name conflict:**
- Each agent name must be unique
- A second agent with the same name will be rejected
- Server logs: `"msg":"Agent name hijack attempt rejected"`

**SQLite "database is locked" error:**
- Only one coordinator process can use the same `.db` file
- Use different `--db-path` for different coordinator instances

## Development

### Stack

- TypeScript, Node.js (ESM, `"type": "module"`)
- `ws` for WebSocket
- `commander` for CLI
- `pino` for structured logging
- `sql.js` for SQLite (pure JS/WASM, no native dependencies)
- `@modelcontextprotocol/sdk` for MCP server
- `vitest` for testing

### Project Structure

```
src/
├── protocol/messages.ts      # Shared message types and serialization
├── coordinator/
│   ├── server.ts             # WebSocket server, connection routing
│   ├── registry.ts           # Agent registry (name, status, heartbeat)
│   ├── tasks.ts              # Task lifecycle (in-memory)
│   ├── sqlite-store.ts       # SQLite persistence layer
│   ├── queue.ts              # Task queuing (FIFO)
│   └── rest.ts               # REST API handler
├── agent/
│   ├── daemon.ts             # WSS client, reconnect, heartbeat
│   ├── executor.ts           # Spawns claude CLI in headless mode
│   ├── health.ts             # Claude availability check
│   └── isolation.ts          # Workspace isolation strategies
├── cli/
│   ├── index.ts              # Commander entrypoint
│   ├── output.ts             # WS client helper
│   └── commands/             # One file per command group
├── mcp/
│   └── server.ts             # MCP server implementation
└── shared/
    ├── config.ts             # ~/.coord/config.json loading
    └── auth.ts               # Token generation and validation
tests/
├── protocol/
├── coordinator/
├── agent/
├── mcp/
├── integration/
└── shared/
```

### Development Workflow

```bash
npm install
npm run build          # tsc
npm run dev            # tsc --watch
npm test               # vitest run (152 tests)
npm run lint           # tsc --noEmit
```

All tests must pass before committing:

```bash
npm test && npm run lint && npm run build
```

## License

MIT. See [LICENSE](LICENSE).

## Repo

- GitHub: [NZenitram/clawd-coordinator](https://github.com/NZenitram/clawd-coordinator)
- npm: [clawd-coordinator](https://www.npmjs.com/package/clawd-coordinator)
- CLI binary: `coord`
- Author: [SoazCloud](https://soazcloud.com)
