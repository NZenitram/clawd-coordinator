# Remote Deployment

## Prerequisites

**Coordinator machine (local):**
- Node.js >= 18
- [Tailscale](https://tailscale.com/) installed (for exposing the coordinator without public IPs)

**Each remote agent machine:**
- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` available in PATH)
- Network access to the coordinator (outbound only -- no inbound ports needed)

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

## Usage

### Dispatch a task

```bash
coord run "fix the bug in src/auth.ts" --on my-agent
```

Output streams in real-time. Use `--bg` to run in the background.

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
