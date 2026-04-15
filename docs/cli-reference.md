# CLI Reference

Complete reference for all `coord` CLI commands and options.

## Command Summary

| Command | Description |
|---------|-------------|
| `coord init` | Initialize coordination config and generate auth token |
| `coord serve` | Start the coordination WebSocket server |
| `coord agent` | Start the remote agent daemon |
| `coord agents` | List connected agents |
| `coord run` | Dispatch a prompt to a remote agent |
| `coord fan-out` | Dispatch a prompt to multiple agents in parallel |
| `coord tasks` | List tasks |
| `coord attach` | Stream output from a running task |
| `coord result` | Get the result of a completed task |
| `coord sessions` | List Claude Code sessions on a remote agent |
| `coord resume` | Resume a Claude Code session on a remote agent |
| `coord mcp` | Start MCP server for Claude Code integration |
| `coord dashboard` | Interactive TUI dashboard — shows agents, tasks, and stats in real time |
| `coord users list` | List all users (admin only) |
| `coord users create` | Create a new user (admin only) |
| `coord users create-key` | Create an API key for a user (admin only) |
| `coord orgs list` | List orgs you belong to |
| `coord orgs create` | Create a new organization (admin only) |
| `coord orgs add-member` | Add a member to an org (org admin only) |
| `coord orgs remove-member` | Remove a member from an org (org admin only) |
| `coord send-message` | Send a message from one agent to another |

---

## Core Commands

### coord init

Initialize coordination config and generate auth token.

**Usage:**
```
coord init [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--force` | - | Overwrite existing config |
| `--show-token` | - | Display the generated token |

**Examples:**
```bash
# Initialize config with token stored securely
coord init

# Generate new token and display it
coord init --show-token

# Regenerate config, overwriting existing
coord init --force
```

---

### coord serve

Start the coordination WebSocket server.

**Usage:**
```
coord serve [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `8080` | Port to listen on |
| `--tls-cert <path>` | - | Path to TLS certificate file |
| `--tls-key <path>` | - | Path to TLS private key file |
| `--storage <type>` | `memory` | Storage backend: memory or sqlite |
| `--db-path <path>` | `~/.coord/tasks.db` | SQLite database file path |

**Examples:**
```bash
# Start coordinator on default port 8080
coord serve

# Start coordinator on custom port
coord serve --port 9000

# Start with TLS
coord serve --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem

# Use SQLite for persistent task storage
coord serve --storage sqlite

# Use SQLite with custom database path
coord serve --storage sqlite --db-path /var/lib/coord/tasks.db
```

---

### coord agent

Start the remote agent daemon.

**Usage:**
```
coord agent [options]
```

**Options:**
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--url <url>` | Yes | - | Coordinator WebSocket URL (e.g., wss://host:8080) |
| `--token <token>` | Yes | - | Auth token |
| `--name <name>` | Yes | - | Agent name |
| `--cwd <directory>` | - | - | Working directory for Claude Code |
| `--allowed-tools <tools>` | - | - | Comma-separated pre-authorized tools (e.g., "Read,Write,Edit,Bash(git:*)") |
| `--disallowed-tools <tools>` | - | - | Comma-separated tools to deny (overrides any include) |
| `--add-dirs <dirs>` | - | - | Comma-separated additional directories to allow access to |
| `--permission-mode <mode>` | - | `default` | Permission mode: default, auto, plan, acceptEdits |
| `--dangerously-skip-permissions` | - | - | Skip all Claude permission prompts (mutually exclusive with permission flags) |
| `--max-concurrent <n>` | - | `1` | Maximum concurrent tasks |
| `--isolation <none\|worktree\|tmpdir>` | - | `none` | Per-task workspace isolation strategy |

**Permission Flags**

- `--allowed-tools` — Comma-separated list of tools to pre-authorize. Tools can be specific (e.g., `Read`, `Write`, `Edit`) or scoped (e.g., `Bash(git:*)` for git-only access). Used with `--permission-mode auto` or `plan`.
- `--disallowed-tools` — Tools to explicitly deny. Takes precedence over `--allowed-tools`.
- `--add-dirs` — Additional directory paths Claude can access. Extends the default `--cwd` access.
- `--permission-mode` — How Claude Code handles permissions:
  - `default` — Interactive prompting on each tool use (most control)
  - `auto` — Pre-authorized tools execute without prompting (headless)
  - `plan` — Claude shows a plan, waits for approval, then executes
  - `acceptEdits` — Auto-accept file edits, prompt for other tools

**Note:** `--dangerously-skip-permissions` and permission flags are mutually exclusive. Using both will error.

**Examples:**

Development agent (auto-approve in project):
```bash
coord agent --url wss://coordinator.example.com:8080 --token abc123 --name dev-agent \
  --cwd /home/ubuntu/project \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

Read-only agent (monitoring/inspection):
```bash
coord agent --url wss://coordinator.example.com:8080 --token abc123 --name monitor-agent \
  --cwd /home/ubuntu \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*),Bash(ls:*)" \
  --permission-mode default
```

Ops agent with system access:
```bash
coord agent --url wss://coordinator.example.com:8080 --token abc123 --name ops-agent \
  --cwd /home/ubuntu \
  --allowed-tools "Read,Write,Edit,Bash" \
  --add-dirs "/etc,/var/log,/var/lib" \
  --permission-mode auto
```

Agent with custom permission workflow:
```bash
coord agent --url wss://coordinator.example.com:8080 --token abc123 --name ci-agent \
  --allowed-tools "Read,Write,Edit,Bash" \
  --permission-mode plan
```

Basic agent with default interactive prompting (no pre-auth):
```bash
coord agent --url wss://coordinator.example.com:8080 --token abc123 --name agent-1 --cwd /home/ubuntu/workdir
```

---

### coord agents

List connected agents.

**Usage:**
```
coord agents [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# List agents connected to default coordinator
coord agents

# List agents from custom coordinator
coord agents --url wss://coordinator.example.com:8080
```

---

## Task Commands

### coord run

Dispatch a prompt to a remote agent.

**Usage:**
```
coord run <prompt> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<prompt>` | Yes | The prompt to send |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--on <agent>` | - | Target agent name (required) |
| `--bg` | - | Run in background and return task ID |
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |
| `--session <id>` | - | Resume a specific Claude Code session |
| `--budget <usd>` | - | Maximum budget in USD for this task |
| `--allowed-tools <tools>` | - | Restrict (but not expand) agent's pre-authorized tools for this task |
| `--disallowed-tools <tools>` | - | Additional tools to deny for this task |
| `--add-dirs <dirs>` | - | Restrict to a subset of agent's allowed directories |

**Permission Overrides**

Per-task permission flags can restrict (but never expand) the agent's baseline permissions:

- `--allowed-tools` — Only these tools are permitted for this task (must be subset of agent config)
- `--disallowed-tools` — These tools are denied, even if in agent's `--allowed-tools`
- `--add-dirs` — Restrict to these directories only (subset of agent's `--add-dirs`)

These are useful for sensitive tasks where you want to narrow scope beyond the agent's default permissions.

**Examples:**

Run and stream output:
```bash
coord run "Create a hello world Python script" --on agent-1
```

Run in background:
```bash
coord run "Analyze data.csv" --on agent-1 --bg
```

Run with budget limit:
```bash
coord run "Generate report" --on agent-1 --budget 5.00
```

Run on specific session:
```bash
coord run "Continue the work" --on agent-1 --session abc123def456
```

Run with restricted permissions (audit task on ops agent):
```bash
coord run "audit the config files" --on ops-agent \
  --allowed-tools "Read" \
  --add-dirs "/etc/openclaw"
```

Run a safe refactoring with pre-approved tools:
```bash
coord run "refactor auth module" --on dev-agent \
  --allowed-tools "Read,Write,Edit"
```

Run on custom coordinator:
```bash
coord run "Deploy changes" --on agent-1 --url wss://coordinator.example.com:8080
```

---

### coord fan-out

Dispatch a prompt to multiple agents in parallel.

**Usage:**
```
coord fan-out <prompt> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<prompt>` | Yes | The prompt to send |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--on <agents>` | - | Comma-separated agent names (required) |
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |
| `--budget <usd>` | - | Maximum budget in USD per task |
| `--allowed-tools <tools>` | - | Restrict tools for all dispatched tasks |
| `--disallowed-tools <tools>` | - | Additional tools to deny for all tasks |
| `--add-dirs <dirs>` | - | Restrict directories for all tasks |

**Permission Overrides**

Same as `coord run` — permission flags apply to all tasks in the fan-out. Useful for bulk operations where you want consistent permission constraints across agents.

**Examples:**

Dispatch to multiple agents:
```bash
coord fan-out "Run tests" --on agent-1,agent-2,agent-3
```

Dispatch with budget limit per task:
```bash
coord fan-out "Benchmark system" --on agent-1,agent-2 --budget 2.50
```

Dispatch with restricted permissions (e.g., read-only audit across all agents):
```bash
coord fan-out "Check for security issues" --on agent-1,agent-2,agent-3 \
  --allowed-tools "Read"
```

Dispatch to custom coordinator:
```bash
coord fan-out "Sync database" --on agent-1,agent-2 --url wss://coordinator.example.com:8080
```

---

### coord tasks

List tasks.

**Usage:**
```
coord tasks [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--status <status>` | - | Filter by status (pending, running, completed, error, dead-letter) |
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# List all tasks
coord tasks

# List running tasks only
coord tasks --status running

# List completed tasks
coord tasks --status completed

# List failed tasks
coord tasks --status error

# List tasks from custom coordinator
coord tasks --url wss://coordinator.example.com:8080
```

---

### coord attach

Stream output from a running task.

**Usage:**
```
coord attach <task-id> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<task-id>` | Yes | Task ID (or prefix) |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# Attach to running task by full ID
coord attach abc123def456

# Attach to task by ID prefix
coord attach abc123de

# Attach from custom coordinator
coord attach abc123def456 --url wss://coordinator.example.com:8080
```

---

### coord result

Get the result of a completed task.

**Usage:**
```
coord result <task-id> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<task-id>` | Yes | Task ID (or prefix) |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# Get result of completed task by full ID
coord result abc123def456

# Get result by ID prefix
coord result abc123de

# Get result from custom coordinator
coord result abc123def456 --url wss://coordinator.example.com:8080
```

---

## Session Commands

### coord sessions

List Claude Code sessions on a remote agent.

**Usage:**
```
coord sessions [options]
```

**Options:**
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--on <agent>` | Yes | - | Target agent name |
| `--url <url>` | - | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# List sessions on agent
coord sessions --on agent-1

# List sessions on custom coordinator
coord sessions --on agent-1 --url wss://coordinator.example.com:8080
```

---

### coord resume

Resume a Claude Code session on a remote agent.

**Usage:**
```
coord resume <session-id> [prompt] [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<session-id>` | Yes | Session ID to resume |
| `[prompt]` | - | Optional prompt to send when resuming (defaults to "continue") |

**Options:**
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--on <agent>` | Yes | - | Target agent name |
| `--url <url>` | - | `ws://localhost:8080` | Coordinator URL |
| `--bg` | - | - | Run in background and return task ID |

**Examples:**
```bash
# Resume session with default "continue" prompt
coord resume abc123 --on agent-1

# Resume session with custom prompt
coord resume abc123 "Add documentation" --on agent-1

# Resume in background
coord resume abc123 --on agent-1 --bg

# Resume on custom coordinator
coord resume abc123 --on agent-1 --url wss://coordinator.example.com:8080
```

---

## Integration Commands

### coord mcp

Start MCP server for Claude Code integration.

**Usage:**
```
coord mcp [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL (overrides config) |

**Examples:**
```bash
# Start MCP server (uses config defaults)
coord mcp

# Start MCP server with custom coordinator
coord mcp --url wss://coordinator.example.com:8080
```

---

### coord dashboard

Interactive TUI dashboard — shows agents, tasks, and stats in real time.

**Usage:**
```
coord dashboard [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `-u, --url <url>` | `http://localhost:8080` | Coordinator base URL (overrides config) |
| `-i, --interval <ms>` | `2000` | Polling interval in milliseconds |

**Examples:**
```bash
# Start dashboard with default settings
coord dashboard

# Start dashboard with custom polling interval
coord dashboard --interval 5000

# Start dashboard with custom coordinator
coord dashboard --url http://coordinator.example.com:8080

# Start dashboard with fast polling
coord dashboard --interval 500
```

**Keyboard Controls:**
- Press `q` or `Ctrl+C` to quit
- Press `Tab` to cycle focus between panels

---

## User Management Commands

### coord users list

List all users (admin only).

**Usage:**
```
coord users list [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# List all users
coord users list

# List users from custom coordinator
coord users list --url wss://coordinator.example.com:8080
```

---

### coord users create

Create a new user (admin only).

**Usage:**
```
coord users create <username> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<username>` | Yes | Username |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--role <role>` | `operator` | Role: admin, operator, viewer |
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# Create user with default operator role
coord users create alice

# Create admin user
coord users create bob --role admin

# Create viewer user
coord users create charlie --role viewer

# Create user on custom coordinator
coord users create dave --role operator --url wss://coordinator.example.com:8080
```

---

### coord users create-key

Create an API key for a user (admin only). Key is shown only once.

**Usage:**
```
coord users create-key <username> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<username>` | Yes | Username |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--label <label>` | - | Label for the key |
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# Create API key for user
coord users create-key alice

# Create labeled API key
coord users create-key alice --label "CI/CD Pipeline"

# Create key on custom coordinator
coord users create-key bob --label "Staging" --url wss://coordinator.example.com:8080
```

---

## Organization Management Commands

### coord orgs list

List orgs you belong to.

**Usage:**
```
coord orgs list [options]
```

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# List your organizations
coord orgs list

# List orgs on custom coordinator
coord orgs list --url wss://coordinator.example.com:8080
```

---

### coord orgs create

Create a new organization (admin only).

**Usage:**
```
coord orgs create <name> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<name>` | Yes | Organization name |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# Create new organization
coord orgs create "Acme Corp"

# Create org on custom coordinator
coord orgs create "DevOps Team" --url wss://coordinator.example.com:8080
```

---

### coord orgs add-member

Add a member to an org (org admin only).

**Usage:**
```
coord orgs add-member <org> <username> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<org>` | Yes | Org ID or name |
| `<username>` | Yes | Username to add |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--role <role>` | `operator` | Role: admin, operator, viewer |
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# Add member to org with default operator role
coord orgs add-member "Acme Corp" alice

# Add admin member to org
coord orgs add-member "Acme Corp" bob --role admin

# Add viewer to org
coord orgs add-member "Acme Corp" charlie --role viewer

# Add member to org on custom coordinator
coord orgs add-member acme-123 dave --role operator --url wss://coordinator.example.com:8080
```

---

### coord orgs remove-member

Remove a member from an org (org admin only).

**Usage:**
```
coord orgs remove-member <org> <username> [options]
```

**Arguments:**
| Argument | Required | Description |
|----------|----------|-------------|
| `<org>` | Yes | Org ID or name |
| `<username>` | Yes | Username to remove |

**Options:**
| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `ws://localhost:8080` | Coordinator URL |

**Examples:**
```bash
# Remove member from org
coord orgs remove-member "Acme Corp" alice

# Remove member by org ID
coord orgs remove-member acme-123 bob

# Remove member from org on custom coordinator
coord orgs remove-member "Acme Corp" charlie --url wss://coordinator.example.com:8080
```

---

## Environment Variables

The following environment variables can be used to override defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `COORD_URL` | - | Coordinator WebSocket URL |
| `COORD_TOKEN` | - | Auth token (if not in config file) |
| `COORD_CONFIG_DIR` | `~/.coord` | Configuration directory |

---

## Configuration File

Configuration is stored at `~/.coord/config.json`:

```json
{
  "token": "generated-token-string",
  "port": 8080,
  "coordinatorUrl": "wss://coordinator.example.com:8080",
  "tls": {
    "cert": "/path/to/cert.pem",
    "key": "/path/to/key.pem"
  },
  "agentTokens": {
    "agent-1": "token-for-agent-1"
  }
}
```

---

### coord send-message

Send a message from one agent to another via the coordinator relay.

**Usage:**
```
coord send-message --from <agent> --to <agent> --topic <topic> --body <body> [options]
```

**Options:**
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--from <agent>` | Yes | — | Source agent name |
| `--to <agent>` | Yes | — | Target agent name |
| `--topic <topic>` | Yes | — | Message topic |
| `--body <body>` | Yes | — | Message body (string or JSON) |
| `--url <url>` | No | from config | Coordinator URL |

**Examples:**
```bash
# Send a simple message
coord send-message --from agent-a --to agent-b --topic "api-contract" --body "What endpoints do you expose?"

# Send JSON data
coord send-message --from frontend --to backend --topic "data-sync" --body '{"items": [1, 2, 3]}'
```

Output: `Message sent (correlationId: abc-123, status: delivered)`

Possible statuses: `delivered`, `agent-offline`, `unknown-agent`

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error (agent not found, task failed, auth error, etc.) |

---

## Tips

- Task IDs can be abbreviated to their first 8 characters in most commands.
- Use `--bg` flag with `coord run` or `coord resume` to dispatch without waiting for completion.
- Use `coord attach <task-id>` to monitor a backgrounded task.
- Budget values are in USD (e.g., `--budget 5.00` limits task to $5.00).
- Coordinator URL defaults to `ws://localhost:8080` unless overridden via `--url` or config file.
- Press `Ctrl+C` to stop agents, the coordinator, or any streaming command.
