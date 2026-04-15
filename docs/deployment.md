# Remote Deployment

## Prerequisites

### Coordinator Machine

**All platforms:**
- Node.js >= 18
- npm or yarn
- Network access to remote agent machines (inbound on port 8080 or custom port)

**Optional:**
- [Tailscale](https://tailscale.com/) for secure, public exposure without TLS certificates
- TLS certificates (for direct HTTPS)

### Remote Agent Machines

**All platforms:**
- Node.js >= 18
- npm or yarn
- Git
- Claude Code installed and authenticated
- Network access to coordinator (outbound only -- no inbound ports needed on agent)
- ANTHROPIC_API_KEY environment variable set or authenticated via `claude` OAuth

## Platform-Specific Installation

Use `coord setup` to automatically detect and install missing dependencies:

```bash
coord setup
```

This command checks for Node.js, git, Claude Code, and authentication, then offers to install missing components. Alternatively, follow the manual setup for your platform below.

## Install clawd-coordinator

### From git (current)

```bash
git clone https://github.com/NZenitram/clawd-coordinator.git
cd clawd-coordinator
npm install && npm run build
npm link  # makes `coord` available globally
```

### From npm (once published)

```bash
npm install -g clawd-coordinator
```

## Setup

### 1. Initialize config (coordinator machine)

```bash
coord init
```

This creates `~/.coord/config.json` with a generated auth token (file permissions 0600). Use `--show-token` to display the token for copying to remote machines.

### 2. Start the coordinator

**Option A: Tailscale Funnel (recommended, no certs needed)**

```bash
coord serve -p 8080
tailscale funnel 8080
```

Tailscale Funnel provides TLS automatically and gives you a public `https://<machine-name>.<tailnet>.ts.net` URL. The WebSocket URL for agents is `wss://<machine-name>.<tailnet>.ts.net`.

**Option B: Direct TLS**

```bash
coord serve -p 8080 --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

**Option C: Plaintext (local/testing only)**

```bash
coord serve -p 8080
```

A warning will be printed. Only use this on localhost or trusted networks.

### 3. Copy the token to remote machines

The token is in `~/.coord/config.json` on the coordinator machine. Copy it securely to each remote machine (e.g., via `scp`, secrets manager, or environment variable).

```bash
# On the coordinator machine
coord init --show-token
# Copy the displayed token
```

### 4. Start agents on remote machines

On each remote machine:

```bash
coord agent \
  --url wss://<coordinator-host>:8080 \
  --token <token> \
  --name <unique-agent-name> \
  --cwd /path/to/working/directory
```

The agent connects outbound to the coordinator. No inbound ports or firewall rules are needed on the agent machine. If the connection drops, the agent automatically reconnects with exponential backoff.

To run as a background service (systemd example):

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
  --cwd /home/deploy/workspace
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now coord-agent
```

### 5. Verify connectivity

From the coordinator machine:

```bash
coord agents
```

Should list all connected agents with their status, platform, and uptime.

## Coordinator Configuration

### Storage Backend

**Default (in-memory):**
```bash
coord serve -p 8080
# All state lost on restart
```

**SQLite (persistent):**
```bash
coord serve -p 8080 --storage sqlite --db-path ~/.coord/tasks.db
```

On restart, incomplete running tasks are automatically recovered and retried. Completed and error tasks remain in the database for audit trails and troubleshooting.

### Permission Configuration

Agents support three permission approaches: default interactive prompting, granular pre-authorized tools, or `--dangerously-skip-permissions` for full headless access. Choose based on your trust and operational requirements.

### Permission Modes

| Mode | Prompting | Use Case |
|------|-----------|----------|
| `default` | Interactive (prompts on each tool) | Development with human oversight |
| `auto` | None (pre-approved tools only) | Headless automation |
| `plan` | Plan approval (show plan, wait for OK, then execute) | Structured workflows with checkpoints |
| `acceptEdits` | Auto-accept file edits, prompt for other tools | Development with auto-save |

### Configure Agent Permissions

Development agent (auto-approve specified tools):
```bash
coord agent --url wss://host:8080 --token TOKEN --name dev-agent \
  --cwd /home/ubuntu/project \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

Read-only agent (monitoring):
```bash
coord agent --url wss://host:8080 --token TOKEN --name monitor-agent \
  --cwd /home/ubuntu \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*),Bash(ps:*)" \
  --permission-mode default
```

Ops agent (broad access with approval):
```bash
coord agent --url wss://host:8080 --token TOKEN --name ops-agent \
  --cwd /home/ubuntu \
  --allowed-tools "Read,Write,Edit,Bash" \
  --add-dirs "/etc,/var/log,/var/lib" \
  --permission-mode plan
```

Agent managing other agents (systemd access):
```bash
coord agent --url wss://host:8080 --token TOKEN --name manager-agent \
  --cwd /home/ubuntu \
  --allowed-tools "Read,Write,Edit,Bash(systemctl:*)" \
  --add-dirs "/etc/systemd/system" \
  --permission-mode auto
```

### Systemd Service with Permissions

Example systemd service file with permission configuration:

```ini
# /etc/systemd/system/coord-agent-dev.service
[Unit]
Description=Clawd Coordinator Agent (Development)
After=network.target

[Service]
Type=simple
User=deploy
Environment=COORD_LOG_LEVEL=info
ExecStart=/usr/local/bin/coord agent \
  --url wss://coordinator.example.ts.net \
  --token <token> \
  --name dev-agent \
  --cwd /home/deploy/project \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto \
  --max-concurrent 2 \
  --isolation worktree
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/coord-agent-monitor.service
[Unit]
Description=Clawd Coordinator Agent (Read-Only Monitor)
After=network.target

[Service]
Type=simple
User=deploy
Environment=COORD_LOG_LEVEL=info
ExecStart=/usr/local/bin/coord agent \
  --url wss://coordinator.example.ts.net \
  --token <token> \
  --name monitor-agent \
  --cwd /home/deploy \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*),Bash(ps:*)" \
  --permission-mode default
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Per-Task Permission Overrides

Restrict permissions for a specific task:

```bash
# Audit task on ops agent — read-only only
coord run "audit security configs" --on ops-agent \
  --allowed-tools "Read" \
  --add-dirs "/etc/openclaw"

# Safe refactoring — limit to project directory
coord run "refactor auth module" --on dev-agent \
  --allowed-tools "Read,Write,Edit" \
  --add-dirs "/home/deploy/project/auth"
```

### Security Notes

1. **Pre-authorized tools + mode auto** — Claude executes without prompting. Use only for trusted operations.
2. **Per-task restrictions** — Can only restrict, never expand. Useful for narrowing scope on sensitive operations.
3. **Tool scoping** — `Bash(git:*)` limits shell to git commands. `Bash(cat:*)` limits to cat only.
4. **Directory access** — `--add-dirs` extends beyond `--cwd`. Useful for system agents accessing `/etc`, `/var/log`.

## Per-Agent Configuration

**Maximum concurrent tasks:**
```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent --max-concurrent 4
```

Agents reject new tasks if they exceed this limit (unless a task queue is enabled). Default is 1.

**Workspace isolation:**
```bash
# No isolation (fastest, default)
coord agent --url wss://host:8080 --token TOKEN --name my-agent --isolation none

# Git worktrees (recommended for repositories)
coord agent --url wss://host:8080 --token TOKEN --name my-agent --isolation worktree

# Temp directories (maximum isolation, slower)
coord agent --url wss://host:8080 --token TOKEN --name my-agent --isolation tmpdir
```

See [Workspace Isolation](#workspace-isolation) below for detailed comparison.

## Usage

### Dispatch a task

```bash
coord run "fix the bug in src/auth.ts" --on my-agent
```

Output streams in real-time. Use `--bg` to run in the background.

### Dispatch with budget limit

```bash
coord run "analyze large file" --on my-agent --budget 2.50
```

Task will error if Claude's usage exceeds the budget.

### Fan out to multiple agents

```bash
coord fan-out "run the test suite and report results" --on agent-1,agent-2,agent-3
```

### Monitor tasks

```bash
coord tasks                    # list all tasks
coord attach <task-id>         # stream output from a running task
coord result <task-id>         # get output from a completed task
```

### Use REST API

```bash
TOKEN=$(cat ~/.coord/config.json | jq -r .token)

# Dispatch via HTTP
curl -X POST http://localhost:8080/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentName": "my-agent", "prompt": "run tests"}'

# List agents
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/agents

# List tasks
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/tasks?status=running
```

### Use MCP Server

Add to Claude Code's configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "clawd-coordinator": {
      "command": "node",
      "args": ["/path/to/clawd-coordinator/dist/cli/index.js", "mcp", "--url", "wss://coordinator.example.ts.net"]
    }
  }
}
```

Now use Claude Code naturally:
```
I have 3 agents connected. Run the test suite on staging and report results.
```

Claude will automatically dispatch via the MCP integration.

## Workspace Isolation

Each task can run in an isolated workspace on the agent machine. This prevents concurrent tasks from interfering with each other's files.

### Isolation Strategies

| Strategy | Description | Use Case | Tradeoff |
|----------|-------------|----------|----------|
| `none` | Tasks share the same working directory | Sequential tasks, no filesystem conflicts | Fastest, but tasks must not clobber files |
| `worktree` | Each task gets a dedicated git worktree | Git repositories with concurrent tasks | Good balance; requires git repo |
| `tmpdir` | Each task gets a copy of the working directory in `/tmp` | Any directory, maximum isolation | Slowest; copies entire directory per task |

### Examples

**Sequential tasks (no isolation needed):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent --isolation none
```

**Parallel tasks in a git repository:**
```bash
# Creates isolated git worktrees per task
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --max-concurrent 4 --isolation worktree
```

Now you can safely run 4 concurrent tasks:
```bash
for i in {1..4}; do
  coord run "make test" --on my-agent --bg &
done
wait
```

Each task runs in its own git worktree, preventing branch/file conflicts.

**Maximum isolation for untrusted code:**
```bash
# Copies entire directory to temp location per task
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --max-concurrent 2 --isolation tmpdir
```

## Architecture

```
Local Machine                          Remote Machines
+-----------------------+
|  coord serve          |
|  (WebSocket server)   |              +------------------+
|                       |--- WSS ----->|  coord agent     |
|  Tailscale Funnel     |              |  (spawns claude) |
|  (TLS termination)    |              +------------------+
|                       |              +------------------+
|  coord run / agents   |--- WSS ----->|  coord agent     |
|  (CLI client)         |              |  (spawns claude) |
+-----------------------+              +------------------+
```

- Agents connect **outbound** to the coordinator (no inbound ports needed)
- Each agent spawns `claude -p --output-format stream-json` as a child process
- Task output streams back over WebSocket in real-time
- Agents auto-reconnect with exponential backoff (1s to 30s)
- Coordinator detects dead connections via WebSocket ping/pong (30s interval)

## Troubleshooting

**Agent can't connect:**
- Verify the coordinator URL is reachable from the agent machine: `curl -I https://<coordinator-host>:8080`
- Check the token matches: the agent will be silently disconnected on auth failure
- Server logs auth failures at warn level: `"msg":"Authentication failed"`

**Agent shows as stale/disconnected:**
- The coordinator evicts idle agents after 90s without a heartbeat
- Busy agents are evicted after 5 minutes without a heartbeat
- Check agent logs for reconnect messages: `"msg":"Scheduling reconnect"`

**Task hangs:**
- Tasks have a 30-minute default timeout (configurable via `taskTimeoutMs` in agent options)
- After timeout: SIGTERM, then SIGKILL after 5s
- The coordinator will error the task if the agent becomes unresponsive

**Name conflict:**
- Each agent name must be unique. A second agent with the same name will be rejected with code 4003
- Server logs: `"msg":"Agent name hijack attempt rejected"`

**SQLite "database is locked" error:**
- Only one coordinator process can use the same `.db` file at a time
- Use different `--db-path` for different coordinator instances
- If the previous instance crashed, the lock file will remain; delete it: `rm ~/.coord/tasks.db-journal`

**Tasks queued but not processing:**
- Ensure the agent has capacity: `coord agents | grep agent-name`
- Agent may be disconnected (shows status `disconnected`)
- Check agent logs: `"msg":"Task received"` when work begins

**Worktree isolation fails with permission errors:**
- Ensure the agent's working directory is inside a git repository
- The git repository must be writable by the agent process user
- Check git status: `cd $cwd && git status` (should succeed)

## Per-Agent Tokens

V2 supports per-agent authentication tokens for tighter access control. Instead of a single shared token, each agent can have its own token.

### Configure per-agent tokens

Edit `~/.coord/config.json`:

```json
{
  "token": "sk-shared-token",
  "agentTokens": {
    "staging-agent": "sk-staging-...",
    "prod-agent": "sk-prod-...",
    "gpu-agent": "sk-gpu-..."
  }
}
```

### Start agents with per-agent tokens

```bash
coord agent \
  --url wss://host:8080 \
  --token sk-staging-... \
  --name staging-agent
```

The coordinator will validate the token against `agentTokens.staging-agent` in the config.

### Fallback to shared token

If an agent's name is not in `agentTokens`, the coordinator accepts the shared `token` for backward compatibility.

## Task Queuing Behavior

When agents reach max concurrency, new tasks are automatically queued and processed in FIFO order.

### Example

Agent with `--max-concurrent 2`:

```bash
# Dispatch 5 tasks
for i in {1..5}; do
  coord run "sleep 5 && echo task-$i" --on my-agent --bg
done

# Check status immediately
coord tasks

# Output:
# task-1  running   (started immediately)
# task-2  running   (started immediately)
# task-3  pending   (queued)
# task-4  pending   (queued)
# task-5  pending   (queued)

# As task-1 completes, task-3 automatically starts
# As task-2 completes, task-4 automatically starts
```

Tasks are processed in dispatch order (FIFO). No tasks are rejected due to capacity — they queue instead.
