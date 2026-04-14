# Coordination

Orchestrate remote Claude Code sessions across machines via WebSocket.

## Quick Start

### 1. Initialize

```bash
coord init
```

Generates a config file at `~/.coord/config.json` with an auth token.

### 2. Start the coordinator

```bash
coord serve
```

Starts the WebSocket server on port 8080. Expose it via Tailscale Funnel:

```bash
tailscale funnel 8080
```

### 3. Connect a remote agent

On the remote machine (Claude Code must be installed and authenticated):

```bash
coord agent --url wss://<your-host>:8080 --token <token> --name staging-box
```

### 4. Dispatch work

```bash
# Run a prompt on a specific agent
coord run "fix the failing tests in src/auth" --on staging-box

# Run in background
coord run "refactor the database layer" --on staging-box --bg

# Fan out to multiple agents
coord fan-out "run the test suite" --on staging-box,dev-box,gpu-box
```

### 5. Monitor

```bash
# List connected agents
coord agents

# List tasks
coord tasks

# Attach to a running task
coord attach <task-id>

# Get result of completed task
coord result <task-id>
```

## Architecture

```
Local Machine                          Remote Machines
┌─────────────────────┐
│  Claude Code ──bash──┤
│                      │                ┌──────────────────┐
│  CLI (coord) ────────┤──── WSS ──────│  Remote Agent A   │
│                      │                └──────────────────┘
│  Coordinator         │                ┌──────────────────┐
│  (WebSocket server)  │──── WSS ──────│  Remote Agent B   │
│                      │                └──────────────────┘
└─────────────────────┘
```

Remote agents connect outbound — no VPN, SSH, or inbound ports needed.

## Development

```bash
npm install
npm run build
npm test
npm run dev    # watch mode
```
