# Clawd Coordinator

Orchestrate remote Claude Code sessions across machines via WebSocket. Dispatch prompts to Claude instances running on cloud VMs, stream results in real time, and fan out work across multiple machines — all from your local terminal or via MCP.

SQLite persistence, per-agent concurrency control, workspace isolation, task queuing with retry/dead-letter handling, REST API, Prometheus metrics, RBAC user management, multi-tenant organizations, and interactive TUI dashboard.

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
┌──────────────────────────┐
│  Claude Code ──────────┬─┤           ┌──────────────────┐
│                        │ ├──WSS─────>│  Remote Agent    │
│  CLI (coord) ──────────┬─┤           │  (spawns claude) │
│                        │ ├──WSS─────>└──────────────────┘
│  Coordinator           │ ├──WSS─────>┌──────────────────┐
│  (WebSocket server)    │             │  Remote Agent    │
│  REST API              │ ├──HTTP────>│  (spawns claude) │
│  Prometheus metrics    │             └──────────────────┘
│  MCP server            │
│  TUI dashboard         │
│  Tailscale Funnel      │
│  (TLS termination)     │
└──────────────────────────┘
```

- Agents connect **outbound** to the coordinator (no inbound ports needed)
- Each agent spawns `claude -p --output-format stream-json` as a child process
- Task output streams back over WebSocket in real-time
- Agents auto-reconnect with exponential backoff (1s to 30s)
- Coordinator detects stale connections via WebSocket ping/pong (30s interval)
- Tasks persist to SQLite; incomplete tasks recover on coordinator restart

## CLI Commands

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `coord init` | Generate config and auth token | `--force`, `--show-token` |
| `coord serve` | Start coordinator WebSocket server | `-p, --port`, `--tls-cert`, `--tls-key`, `--storage`, `--db-path` |
| `coord agent` | Start remote agent daemon | `--url`, `--token`, `--name`, `--cwd`, `--max-concurrent`, `--isolation`, `--allowed-tools`, `--disallowed-tools`, `--add-dirs`, `--permission-mode` |
| `coord agents` | List connected agents | `--url` |
| `coord run` | Dispatch prompt to agent and stream output | `--on <agent>`, `--bg`, `--url`, `--session`, `--budget`, `--allowed-tools`, `--disallowed-tools`, `--add-dirs` |
| `coord fan-out` | Dispatch to multiple agents in parallel | `--on <a,b,c>`, `--url`, `--budget`, `--allowed-tools`, `--disallowed-tools`, `--add-dirs` |
| `coord tasks` | List all tasks (filter by status) | `--url`, `--status` |
| `coord attach` | Stream output from a running task | `--url` |
| `coord result` | Get output from completed task | `--url` |
| `coord sessions` | List sessions on an agent | `--on <agent>`, `--url` |
| `coord resume` | Resume a Claude Code session | `--on <agent>`, `--url` |
| `coord mcp` | Start MCP server for Claude Code integration | `--url` |
| `coord dashboard` | Interactive TUI dashboard — agents, tasks, stats in real time | `-u, --url`, `-i, --interval` |
| `coord users list` | List users in the coordinator | `--url` |
| `coord users create` | Create a new user | `--username`, `--role`, `--url` |
| `coord users create-key` | Create API key for a user | `--user-id`, `--label`, `--url` |
| `coord orgs list` | List organizations | `--url` |
| `coord orgs create` | Create a new organization | `--name`, `--url` |
| `coord orgs add-member` | Add a user to an organization | `--org-id`, `--user-id`, `--role`, `--url` |
| `coord orgs remove-member` | Remove a user from an organization | `--org-id`, `--user-id`, `--url` |
| `coord send-message` | Send a message between agents | `--from`, `--to`, `--topic`, `--body`, `--url` |

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

**Agent with pre-authorized tools (no permission prompts):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

**Task with restricted permissions:**
```bash
coord run "audit the config" --on ops-agent \
  --allowed-tools "Read" \
  --add-dirs "/etc/openclaw"
```

**Interactive dashboard:**
```bash
coord dashboard --url http://localhost:8080 --interval 2000
```

## REST API

The coordinator exposes a REST API on HTTP (same port as WebSocket). All endpoints require Bearer token authorization via the `Authorization: Bearer <token>` header, or API key tokens created via the users commands.

### Task Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/dispatch` | Dispatch a task to an agent |
| `GET` | `/api/tasks` | List tasks (optionally filter by status) |
| `GET` | `/api/tasks/:id` | Get a specific task |

### Agent Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all connected agents |

### User & RBAC Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/users` | List users |
| `POST` | `/api/users` | Create a new user |
| `POST` | `/api/users/:id/keys` | Create API key for a user |
| `DELETE` | `/api/keys/:id` | Revoke an API key |

### Organization Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/orgs` | List organizations |
| `POST` | `/api/orgs` | Create an organization |
| `POST` | `/api/orgs/:id/members` | Add a user to an org |
| `DELETE` | `/api/orgs/:id/members/:userId` | Remove a user from an org |

### Agent Messaging Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/message` | Send a message from one agent to another |

### Metrics & Monitoring Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/metrics` | Prometheus-format metrics (OpenMetrics) |
| `GET` | `/api/stats` | JSON-format metrics (tasks dispatched, completed, errored, queue depth, etc.) |

### REST Examples

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

**Get Prometheus metrics:**
```bash
curl http://localhost:8080/metrics
```

**Get JSON stats:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/stats
```

**Send agent-to-agent message:**
```bash
curl -X POST http://localhost:8080/api/message \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fromAgent": "agent-a",
    "toAgent": "agent-b",
    "topic": "data-sync",
    "body": "{ \"items\": [...] }"
  }'
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

## Dashboard

The interactive TUI dashboard displays real-time agent status, task queue, and metrics:

```bash
coord dashboard --url http://localhost:8080 --interval 2000
```

Shows:
- Connected agents and their health status
- Running, pending, and completed tasks
- Queue depth and task duration metrics
- System uptime and agent activity

Navigate with Tab to cycle focus, press q or Ctrl-C to exit.

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

Tasks, users, orgs, and results persist to SQLite. On restart, incomplete running tasks are recovered and automatically retried. Completed and error tasks remain in the database for audit trails.

## Task Queuing

When agents are at max concurrency, tasks are queued automatically and processed in FIFO order.

**Behavior:**
- Task status: `pending` -> `running` -> `completed` (or `error` or `dead-letter`)
- Agents reject new tasks if at capacity (queue holds them)
- Queue stores pending tasks until agent capacity is available
- Per-agent concurrency limit is configurable via `--max-concurrent`

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

## Retry & Dead-Letter Handling

Tasks can fail due to transient network errors or agent issues. The coordinator implements exponential backoff retry with dead-letter support.

**Retry behavior:**
- Retryable errors (network, timeout, agent disconnect): automatically retried
- Permanent errors (validation, agent crash): immediately dead-lettered
- Default: 3 max retries with exponential backoff (5s, 10s, 20s, capped at 60s)
- Retries respect the agent's availability — if agent goes offline, tasks wait in pending state

**Dead-letter status:**
- Tasks that exhaust retries or hit permanent errors are moved to `dead-letter` status
- Dead-lettered tasks remain in the database for audit/replay
- Query dead-letter tasks: `coord tasks --status dead-letter`
- Dead-letter tasks can be manually re-dispatched once the issue is resolved

**Example:**
```bash
# Task fails after 3 retries
coord run "unstable operation" --on my-agent

# Check dead-letter tasks
coord tasks --status dead-letter

# Fix the issue, then replay
coord run "unstable operation" --on my-agent
```

## Cross-Session Agent Communication

Agents can communicate with each other directly via topic-based messaging. This enables distributed workflows like data aggregation, result fanout, and inter-agent coordination.

**Via CLI:**
```bash
coord send-message --from agent-a --to agent-b --topic "api-contract" --body "What endpoints do you expose?"
```

**Via REST API:**
```bash
curl -X POST http://localhost:8080/api/message \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fromAgent": "agent-a",
    "toAgent": "agent-b",
    "topic": "data-sync",
    "body": "{ \"items\": [...] }"
  }'
```

**Via WebSocket protocol:**
Messages are delivered in real-time over WebSocket using the `agent:message` and `agent:message-reply` message types.

**Use cases:**
- Coordinator fanout: agent-a fans out a task to agents b, c, d and collects results
- Data aggregation: multiple agents collect data and send to a single aggregator agent
- Pipeline: agent-a produces data for agent-b, agent-b processes and sends to agent-c

## Permissions

Claude Code has three permission modes: default (interactive prompting), pre-authorized tools (granular allowlist), and skip-all (headless). The coordinator now supports Claude's native permission flags, allowing you to configure permissions at the agent level or override them per-task.

### Three Permission Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `default` | Claude prompts for permission on each tool use | Interactive development, high control |
| `auto` | Uses pre-authorized tools without prompting | Headless agents, pre-approved workflows |
| `plan` | Claude shows a plan, waits for approval, then executes | Structured workflows with review checkpoints |
| `acceptEdits` | Auto-accepts file edits (Write/Edit), prompts for other tools | Development with auto-save, manual control for Bash/CLI |

### Agent-Level Configuration

Configure baseline permissions when starting an agent:

```bash
# Development agent — read/write/edit in project dir
coord agent --url wss://host:8080 --token TOKEN --name dev-agent \
  --cwd /home/user/project \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto

# Read-only monitoring agent
coord agent --url wss://host:8080 --token TOKEN --name monitor-agent \
  --cwd /home/user \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*),Bash(ls:*)" \
  --permission-mode default

# Ops agent with broad access
coord agent --url wss://host:8080 --token TOKEN --name ops-agent \
  --cwd /home/user \
  --allowed-tools "Read,Write,Edit,Bash" \
  --add-dirs "/etc,/var/log" \
  --permission-mode auto
```

### Per-Task Permission Overrides

Restrict (but never expand) permissions for individual tasks:

```bash
# Audit task — restrict ops agent to read-only
coord run "audit the config files" --on ops-agent \
  --allowed-tools "Read" \
  --add-dirs "/etc/openclaw"

# Safe refactoring — pre-approve specific tools
coord run "refactor authentication module" --on dev-agent \
  --allowed-tools "Read,Write,Edit" \
  --add-dirs "/home/user/project/auth"
```

### MCP Tool Permission Parameters

When using the MCP server, the `dispatch_task` tool accepts optional permission parameters:

```
dispatch_task(
  agentName: string,
  prompt: string,
  allowedTools?: string,      # comma-separated tools (e.g., "Read,Write,Edit")
  disallowedTools?: string,   # tools to deny (overrides agent config)
  addDirs?: string            # additional allowed directories
)
```

### Permission Matrix — Tool Access

| Tool | Description | Examples |
|------|-------------|----------|
| `Read` | Read files and directories | View code, inspect configs |
| `Write` | Create and write files | Create new files, write logs |
| `Edit` | Edit existing files | Modify code, fix bugs |
| `Bash` | Execute shell commands | Run tests, deploy, git operations |
| `Bash(git:*)` | Git-only shell access | `git clone`, `git push`, etc. |
| `Bash(cat:*)` | Cat-only shell access | Read file contents safely |

### Key Behaviors

1. **Mutually exclusive with `--dangerously-skip-permissions`** — Error if both are set
2. **Per-task overrides restrict only** — Cannot expand beyond the agent's baseline permissions
3. **Backward compatible** — Omitting all flags = Claude Code's default permission prompting
4. **Shown in agent status** — `coord agents` displays each agent's configured permissions

### Permission Examples by Use Case

**Development (auto-approve in project dir):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name dev-agent \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

**CI/CD (broad access with approval):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name ci-agent \
  --allowed-tools "Read,Write,Edit,Bash" \
  --add-dirs "/etc/systemd/system,/var/lib" \
  --permission-mode plan
```

**Monitoring (read-only with safe commands):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name monitor-agent \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*),Bash(ps:*)" \
  --permission-mode default
```

**Agent management (edit system files, run systemctl):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name manager-agent \
  --allowed-tools "Read,Write,Edit,Bash(systemctl:*)" \
  --add-dirs "/etc/systemd/system" \
  --permission-mode auto
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

## User Management & RBAC

Multi-user support with role-based access control. Create users with different permission levels and API keys for programmatic access.

**Roles:**

| Role | Permissions |
|------|-------------|
| `admin` | Full access (dispatch, list, create users, manage orgs) |
| `operator` | Can dispatch tasks and list agents/tasks |
| `viewer` | Read-only access (list agents/tasks, view results) |

**Commands:**

```bash
# Create a user
coord users create --username alice --role operator --url http://localhost:8080

# Create API key for a user
coord users create-key --user-id <user-id> --label "my-key" --url http://localhost:8080

# List all users
coord users list --url http://localhost:8080
```

**Permission matrix:**

| Action | Admin | Operator | Viewer |
|--------|-------|----------|--------|
| Dispatch task | Yes | Yes | No |
| List tasks | Yes | Yes | Yes |
| Get task result | Yes | Yes | Yes |
| List agents | Yes | Yes | Yes |
| Get agent info | Yes | Yes | Yes |
| Create user | Yes | No | No |
| Manage API keys | Yes | No | No |

## Multi-Tenant Organizations

Organize users and agents into isolated organizations. Each org has its own users, agents, and tasks.

**Commands:**

```bash
# Create an organization
coord orgs create --name "team-a" --url http://localhost:8080

# Add a user to an org
coord orgs add-member --org-id <org-id> --user-id <user-id> --role operator --url http://localhost:8080

# Remove a user from an org
coord orgs remove-member --org-id <org-id> --user-id <user-id> --url http://localhost:8080

# List all orgs
coord orgs list --url http://localhost:8080
```

**Isolation:**
- Users in org A cannot see agents or tasks from org B
- Each API key is bound to a user and inherits the user's org membership
- Coordinator routes tasks and agents by org automatically

## Rate Limiting

The coordinator implements rate limiting to prevent abuse and ensure fair resource allocation.

**Limits:**
- Per-IP connection rate: max 100 connections per minute
- Per-socket message rate: 1000 messages per 10 seconds (refill at 100 msg/sec)
- Message body size: 1MB max

**Behavior:**
- Connections exceeding rate limit are rejected with 429 Too Many Requests
- Messages exceeding rate limit are dropped (backpressure)
- Limits apply globally; all clients share the same bucket

## Prometheus Metrics

The coordinator exposes Prometheus-format metrics on `/metrics`:

```bash
curl http://localhost:8080/metrics | head -20
```

**Available metrics:**
- `coord_tasks_dispatched_total` — Total tasks dispatched
- `coord_tasks_completed_total` — Total tasks completed successfully
- `coord_tasks_errored_total` — Total tasks that errored
- `coord_task_duration_seconds` — Task duration histogram (buckets: 1s, 5s, 15s, 30s, 60s, 120s, 300s, 600s)
- `coord_connected_agents` — Current connected agent count
- `coord_queue_depth` — Current number of pending tasks
- `coord_active_tasks` — Current number of running tasks

**JSON metrics endpoint:**

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/stats
# Returns: { "tasksDispatched": 42, "tasksCompleted": 40, "tasksErrored": 2, ... }
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

**Shared token (default):**
- Single token in `~/.coord/config.json` for all agents and CLI clients
- Generated by `coord init` with cryptographic randomness
- Agent names are self-reported (no guarantee of identity)
- Use in trusted environments or add application-level authorization

**Per-agent tokens:**
- Each agent can have its own token (`agentTokens` map in config)
- Separate tokens for CLI and agents for tighter access control
- Fallback to shared token if agent token not configured

**API keys:**
- Users can create API keys for programmatic access
- Keys are hashed and stored in SQLite
- Each key is bound to a user and inherits their permissions
- Revoke keys individually via REST API

### Environment Variables

- Spawned Claude processes inherit the full environment
- Minimize sensitive env vars on agent machines
- Run agents in containers with restricted environments for sensitive workloads

### Process Isolation

- Use `--isolation worktree` or `--isolation tmpdir` for filesystem isolation
- Each task runs in its own Claude session (not shared across tasks)
- No cross-task communication within the same agent (use agent messaging for inter-agent comms)

### Workspace Isolation

- `--isolation none`: tasks share the same directory (fastest)
- `--isolation worktree`: git worktrees prevent file clobber (recommended for CI/CD)
- `--isolation tmpdir`: full directory copy per task (maximum isolation, slowest)

## Testing

Run the automated test suite:

```bash
npm test                   # 268 tests across 24 suites
npm run lint               # TypeScript type-check
npm run dev                # Watch mode for development
```

### Manual Integration Testing

See [docs/testing.md](docs/testing.md) for the full manual test procedure.

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

**Dashboard connection error:**
- Verify `--url` matches the coordinator (convert `wss://` to `http://`)
- Check Authorization header with correct token
- Ensure metrics and stats endpoints are reachable

**Rate limit exceeded (429):**
- Per-IP connection limit: 100 conn/min
- Per-socket message limit: 1000 msg/10s
- Reduce connection frequency or batch messages

## Development

### Stack

- TypeScript, Node.js (ESM, `"type": "module"`)
- `ws` for WebSocket
- `commander` for CLI
- `pino` for structured logging
- `sql.js` for SQLite (pure JS/WASM, no native dependencies)
- `@modelcontextprotocol/sdk` for MCP server
- `blessed` and `blessed-contrib` for TUI dashboard
- `prom-client` for Prometheus metrics
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
│   ├── rest.ts               # REST API handler
│   ├── user-store.ts         # User/org/key management
│   ├── rbac.ts               # Role-based access control
│   └── messaging.ts          # Agent-to-agent messaging
├── agent/
│   ├── daemon.ts             # WSS client, reconnect, heartbeat
│   ├── executor.ts           # Spawns claude CLI in headless mode
│   ├── health.ts             # Claude availability check
│   └── isolation.ts          # Workspace isolation strategies
├── cli/
│   ├── index.ts              # Commander entrypoint
│   ├── output.ts             # WS client helper
│   ├── dashboard/            # TUI dashboard components
│   └── commands/             # One file per command group
├── mcp/
│   └── server.ts             # MCP server implementation
└── shared/
    ├── config.ts             # ~/.coord/config.json loading
    ├── auth.ts               # Token generation and validation
    ├── logger.ts             # Structured logging (pino)
    ├── metrics.ts            # Prometheus metrics collector
    ├── rate-limiter.ts       # Token-bucket rate limiter
    └── ws-utils.ts           # WebSocket backpressure helpers
tests/
├── protocol/
├── coordinator/
├── agent/
├── cli/
├── mcp/
├── integration/
├── shared/
└── org/
```

### Development Workflow

```bash
npm install
npm run build          # tsc
npm run dev            # tsc --watch
npm test               # vitest run (268 tests)
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
