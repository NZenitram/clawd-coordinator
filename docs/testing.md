# Testing Procedures

## Unit & Integration Tests

Run the automated test suite:

```bash
npm test          # 152 tests across 15 suites
npm run lint      # TypeScript type-check (tsc --noEmit)
```

Tests are silenced for pino output via `COORD_LOG_LEVEL=silent` in the test script.

### Test Suites

| Suite | Tests | Covers |
|-------|-------|--------|
| `tests/protocol/messages.test.ts` | 13 | Message creation, serialization, round-trip, parseMessage validation, MessageDeduplicator |
| `tests/coordinator/registry.test.ts` | 17 | Agent registration, heartbeat, status transitions, stale agent detection, dead busy agent detection, concurrency (addTask/removeTask/hasCapacity), health updates |
| `tests/coordinator/tasks.test.ts` | 12 | Task lifecycle, output append, output cap, truncation, cleanup, status filtering |
| `tests/coordinator/queue.test.ts` | 8 | Task queue enqueue, dequeue, capacity checks, FIFO ordering |
| `tests/coordinator/sqlite.test.ts` | 12 | SQLite persistence, recovery of stale tasks, task lifecycle with storage backend |
| `tests/coordinator/server.test.ts` | 15 | Auth rejection, agent registration, heartbeat, disconnect, arg validation, status filter validation, name hijacking, task ownership, unhealthy agent dispatch refusal, per-agent tokens |
| `tests/coordinator/rest.test.ts` | 10 | REST API auth, GET /api/agents, GET /api/tasks, POST /api/dispatch, task status filtering |
| `tests/agent/executor.test.ts` | 10 | Prompt execution, error exit, sessionId flag, timeout, dangerouslySkipPermissions, maxBudgetUsd, concurrent process tracking, killTask, kill-all |
| `tests/agent/daemon.test.ts` | 6 | Connect/register, unregister on stop, non-UUID taskId rejection, oversized prompt rejection, per-agent token auth |
| `tests/agent/health.test.ts` | 2 | Claude CLI health check (available/unavailable) |
| `tests/agent/isolation.test.ts` | 6 | NoneStrategy, WorktreeStrategy, TempDirStrategy setup/cleanup |
| `tests/integration/dispatch.test.ts` | 6 | End-to-end dispatch+streaming, unknown agent error, capacity rejection, multi-task concurrent dispatch, queue processing |
| `tests/shared/auth.test.ts` | 7 | Token generation, validation, per-agent token matching, token format validation |
| `tests/mcp/server.test.ts` | 15 | dispatch_task tool, list_agents tool, list_tasks tool, get_task_result tool, error handling |
| `tests/mcp/integration.test.ts` | 5 | MCP server startup, tool invocation end-to-end, coordinator communication |

## Manual Integration Test

This procedure validates the full system with a live coordinator, agent, and CLI. Requires Claude Code installed and authenticated on the machine.

### 1. Build

```bash
npm run build
```

### 2. Initialize config

```bash
node dist/cli/index.js init --force --show-token
```

Verify:
- Config written to `~/.coord/config.json`
- Token displayed only when `--show-token` is passed
- Without `--show-token`, prints "Token saved to config file"

### 3. Start the coordinator

```bash
COORD_LOG_LEVEL=info node dist/cli/index.js serve -p 9999
```

Expected output:
- TLS warning: `Warning: Coordinator running without TLS...`
- Structured JSON log: `{"level":30,...,"port":9999,"msg":"Coordinator started"}`
- `Coordinator listening on port 9999`

### 4. Connect an agent

In a second terminal:

```bash
TOKEN=$(cat ~/.coord/config.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
COORD_LOG_LEVEL=info node dist/cli/index.js agent --url ws://localhost:9999 --token "$TOKEN" --name test-agent-1
```

Expected output:
- Agent log: `{"level":30,...,"msg":"Agent connected"}`
- `Agent "test-agent-1" connected to ws://localhost:9999`

Server should log: `{"level":30,...,"agent":"test-agent-1","os":"darwin","arch":"arm64","msg":"Agent registered"}`

### 5. List agents

```bash
node dist/cli/index.js agents --url ws://localhost:9999
```

Expected:
```
NAME          STATUS  PLATFORM      UPTIME  CURRENT TASK
------------  ------  ------------  ------  ------------
test-agent-1  idle    darwin/arm64  Xs      -
```

### 6. Dispatch a task and stream output

```bash
node dist/cli/index.js run "respond with just the word 'pong'" --on test-agent-1 --url ws://localhost:9999
```

Expected:
- Claude stream-json output streams to stdout
- Agent log shows: `Task received` then `Task finished` with `exitCode: 0`
- Server log shows: `Task dispatched` then `Task completed`

### 7. List tasks after completion

```bash
node dist/cli/index.js tasks --url ws://localhost:9999
```

Expected: task shows with status `completed`.

### 8. Get task result

```bash
node dist/cli/index.js result <task-id> --url ws://localhost:9999
```

Expected: full stream-json output from Claude.

### 9. Background dispatch + busy rejection

```bash
# Dispatch a long task in background
node dist/cli/index.js run "count from 1 to 100" --on test-agent-1 --url ws://localhost:9999 --bg

# Immediately try another dispatch
node dist/cli/index.js run "say hello" --on test-agent-1 --url ws://localhost:9999 --bg
```

Expected:
- First dispatch succeeds with task ID
- Second dispatch fails: `Error: Agent "test-agent-1" is at capacity (1/1 tasks)`
- Exit code 1 on the second command
- `coord agents` shows status `busy` with the task ID

### 10. Agent name hijacking prevention

While the original agent is connected, try starting a second agent with the same name:

```bash
node dist/cli/index.js agent --url ws://localhost:9999 --token "$TOKEN" --name test-agent-1
```

Expected:
- Second agent enters a reconnect loop (keeps getting rejected)
- Server logs: `{"level":40,...,"agent":"test-agent-1","msg":"Agent name hijack attempt rejected"}`
- `coord agents` still shows exactly one `test-agent-1`

### 11. Verify structured logging

Check server and agent logs for structured JSON output at every lifecycle event:

| Event | Log Level | Message |
|-------|-----------|---------|
| Server start | info (30) | `Coordinator started` |
| Auth failure | warn (40) | `Authentication failed` |
| Agent register | info (30) | `Agent registered` |
| Agent disconnect | info (30) | `Agent disconnected` |
| Task dispatch | info (30) | `Task dispatched` |
| Task complete | info (30) | `Task completed` |
| Task error | error (50) | `Task failed` |
| Stale agent evicted | info (30) | `Stale agent evicted` |
| Name hijack blocked | warn (40) | `Agent name hijack attempt rejected` |
| Agent connected | info (30) | `Agent connected` |
| Task received | info (30) | `Task received` |
| Task finished | info (30) | `Task finished` |
| Reconnect scheduled | info (30) | `Scheduling reconnect` |

### 12. Cleanup

Stop all processes (Ctrl+C or `kill`). Verify server logs agent disconnection.

## SQLite Persistence Testing

Test the persistent storage backend:

### 1. Initialize with SQLite

```bash
npm run build
coord init --force
COORD_LOG_LEVEL=info coord serve -p 9999 --storage sqlite --db-path /tmp/coord-test.db
```

Expected output:
```
Using SQLite storage at /tmp/coord-test.db
Coordinator listening on port 9999
```

### 2. Connect agent and dispatch task

```bash
TOKEN=$(cat ~/.coord/config.json | jq -r .token)
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" --name persist-agent

# In another terminal
coord run "echo 'test data'" --on persist-agent --url ws://localhost:9999
```

### 3. Verify task persisted

```bash
coord tasks --url ws://localhost:9999
# Task should show with status "completed"
```

### 4. Restart coordinator

Stop the `coord serve` process (Ctrl+C). Restart it with the same `--db-path`:

```bash
COORD_LOG_LEVEL=info coord serve -p 9999 --storage sqlite --db-path /tmp/coord-test.db
```

Expected output:
```
Using SQLite storage at /tmp/coord-test.db
Coordinator listening on port 9999
```

### 5. Verify task recovered

```bash
coord tasks --url ws://localhost:9999
# Previously completed task should still be visible
```

### 6. Test stale task recovery

Dispatch a task, then kill the agent before it completes. Restart the coordinator:

```bash
# Kill agent (Ctrl+C in agent terminal)
# Restart coordinator (Ctrl+C, then re-run `coord serve`)
```

Expected:
- Coordinator logs: `Recovered X stale running task(s) from previous session`
- Stale tasks marked as `error` status: `Agent disconnected while task was running`

## REST API Testing

Test the HTTP REST API endpoints:

### 1. Start coordinator with REST enabled

```bash
npm run build
TOKEN=$(cat ~/.coord/config.json | jq -r .token)
COORD_LOG_LEVEL=info coord serve -p 8000
```

### 2. Connect agent

```bash
coord agent --url ws://localhost:8000 --token "$TOKEN" --name rest-test-agent
```

### 3. Test GET /api/agents

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/agents
```

Expected: JSON list of connected agents with status, platform, uptime.

### 4. Test POST /api/dispatch

```bash
curl -X POST http://localhost:8000/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentName": "rest-test-agent", "prompt": "echo success", "maxBudgetUsd": 1.0}'
```

Expected: `{"taskId": "...", "status": "queued|running"}`

### 5. Test GET /api/tasks

```bash
# List all tasks
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/tasks

# Filter by status
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8000/api/tasks?status=running"
```

### 6. Test GET /api/tasks/:id

```bash
TASK_ID="<from previous response>"
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/tasks/$TASK_ID
```

Expected: Full task object with prompt, status, output, createdAt, completedAt.

### 7. Test auth failure

```bash
curl -H "Authorization: Bearer wrong-token" http://localhost:8000/api/agents
```

Expected: HTTP 401 `{"error": "Unauthorized"}`

## Task Queue Testing

Test task queuing when agents are at max concurrency:

### 1. Connect agent with max-concurrent=1

```bash
npm run build
TOKEN=$(cat ~/.coord/config.json | jq -r .token)
coord agent \
  --url ws://localhost:8000 \
  --token "$TOKEN" \
  --name queue-test-agent \
  --max-concurrent 1
```

### 2. Dispatch multiple tasks

```bash
# Dispatch 3 tasks in quick succession (all in background)
for i in {1..3}; do
  coord run "echo task-$i && sleep 2" --on queue-test-agent --url ws://localhost:8000 --bg
  echo "Task $i dispatched"
done
```

### 3. Monitor task queue

```bash
# Immediately check tasks
coord tasks --url ws://localhost:8000

# Expected: 1 running, 2 pending
# As first task completes, second starts automatically
```

### 4. Verify FIFO order

Check logs to confirm tasks execute in dispatch order:
- Task 1: runs first
- Task 2: queued, runs after task 1 completes
- Task 3: queued, runs after task 2 completes

Agent logs should show:
```
Task received: task-1-uuid
Task finished: task-1-uuid
Task received: task-2-uuid
Task finished: task-2-uuid
Task received: task-3-uuid
Task finished: task-3-uuid
```

## MCP Server Testing

Test the MCP server integration with Claude Code:

### 1. Start MCP server

```bash
npm run build
TOKEN=$(cat ~/.coord/config.json | jq -r .token)
COORD_LOG_LEVEL=info coord mcp --url ws://localhost:8000
```

Expected output:
```
MCP server started on stdio
```

### 2. Configure Claude Code

Add to `~/.config/Claude/claude_desktop_config.json` (or platform-specific config location):

```json
{
  "mcpServers": {
    "clawd-coordinator": {
      "command": "node",
      "args": ["/path/to/clawd-coordinator/dist/cli/index.js", "mcp", "--url", "ws://localhost:8000"]
    }
  }
}
```

Restart Claude Code.

### 3. Test MCP tools in Claude Code

Inside Claude Code, with an agent connected:

```
I have agents connected. List them for me.
```

Claude should respond with a list of connected agents via the `list_agents` tool.

```
Dispatch a test task to my-agent that echoes 'hello world'
```

Claude should use the `dispatch_task` tool to dispatch and report the result.

### 4. Verify tool responses

All MCP tool calls should complete successfully:
- `dispatch_task` returns task ID and status
- `list_agents` returns agent list
- `list_tasks` returns task list with optional filtering
- `get_task_result` returns task output/error

## Permission Testing

Test the pre-authorized tools/paths feature to ensure granular permissions work correctly.

### 1. Start coordinator

```bash
npm run build
coord init --force
COORD_LOG_LEVEL=info coord serve -p 9999
```

### 2. Connect an agent with permission flags

In a second terminal:

```bash
TOKEN=$(cat ~/.coord/config.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name perm-agent \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

Expected output:
- Agent logs: `Agent connected with permissions: allowed=[Read,Write,Edit,Bash(git:*)], mode=auto`

### 3. Verify agent permissions in status

```bash
coord agents --url ws://localhost:9999
```

Expected: Agent shows configured permissions in the output (implementation-dependent, check agent metadata).

### 4. Test task dispatch with permission overrides

**Test case: Restrict to read-only**

```bash
coord run "cat README.md" --on perm-agent --url ws://localhost:9999 \
  --allowed-tools "Read"
```

Expected:
- Task succeeds (Read is in agent's baseline)
- Output shows file contents

**Test case: Attempt to restrict beyond baseline (should error)**

```bash
coord run "echo test > file.txt" --on perm-agent --url ws://localhost:9999 \
  --allowed-tools "Read"
```

Expected:
- Task runs but Write is restricted
- Claude either: (a) doesn't attempt Write, or (b) prompts (depending on mode)

### 5. Test permission mode transitions

**Test agent with mode=default (interactive)**

```bash
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name interactive-agent \
  --allowed-tools "Read,Write,Edit" \
  --permission-mode default
```

**Dispatch a task (will prompt in interactive session)**

```bash
coord run "list files in current dir" --on interactive-agent --url ws://localhost:9999
```

Expected:
- Task runs with interactive prompting (if Claude Code is in interactive mode)
- Logs show mode=default

**Test agent with mode=auto (headless)**

```bash
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name headless-agent \
  --allowed-tools "Read,Write,Edit" \
  --permission-mode auto
```

**Dispatch a task (no prompting)**

```bash
coord run "create a test file" --on headless-agent --url ws://localhost:9999
```

Expected:
- Task completes without interactive prompts
- File is created (Write is pre-authorized)
- Logs show mode=auto

### 6. Test per-task restrictions

Create two agents with different baseline permissions:

```bash
# Agent 1: Full access
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name full-agent \
  --allowed-tools "Read,Write,Edit,Bash" \
  --permission-mode auto &

# Agent 2: Read-only
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name readonly-agent \
  --allowed-tools "Read" \
  --permission-mode auto &
```

**Dispatch to full-agent without restriction:**

```bash
coord run "create a new file" --on full-agent --url ws://localhost:9999
```

Expected: File is created (Write allowed)

**Dispatch to readonly-agent (verify restriction):**

```bash
coord run "read a file" --on readonly-agent --url ws://localhost:9999 \
  --allowed-tools "Read"
```

Expected: File is read (Read allowed)

**Attempt write on readonly-agent:**

```bash
coord run "create a new file" --on readonly-agent --url ws://localhost:9999 \
  --allowed-tools "Read"
```

Expected: Task runs but Write is denied; Claude should report insufficient permissions

### 7. Test directory restrictions

```bash
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name dir-agent \
  --cwd /tmp \
  --allowed-tools "Read,Write" \
  --add-dirs "/var/log" \
  --permission-mode auto
```

**Access allowed directory:**

```bash
coord run "list /var/log" --on dir-agent --url ws://localhost:9999 \
  --add-dirs "/var/log"
```

Expected: Task succeeds

**Attempt access outside allowed:**

```bash
coord run "list /root" --on dir-agent --url ws://localhost:9999
```

Expected: Task fails (directory not in allowed list)

### 8. Test mutation-exclusive flags

**Verify --dangerously-skip-permissions and permission flags are mutually exclusive:**

```bash
coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name conflict-agent \
  --allowed-tools "Read" \
  --dangerously-skip-permissions
```

Expected: Command fails with error about mutually exclusive flags

### 9. Test permission matrix

Test access to different tool categories:

| Tool | Command | Expected |
|------|---------|----------|
| `Read` | `cat file.txt` | Success (if file exists) |
| `Write` | `echo test > file.txt` | Success (if Write allowed) |
| `Edit` | Claude edits file | Success (if Edit allowed) |
| `Bash(git:*)` | `git status` | Success (if Bash(git:*) allowed) |
| `Bash(cat:*)` | `cat file.txt` (via bash) | Success (if Bash(cat:*) allowed) |
| `Bash` | `git push` | Success (if Bash allowed, denied if only Bash(git:*)) |

**Test Bash scoping:**

```bash
# Agent with git-only bash
COORD_LOG_LEVEL=info coord agent --url ws://localhost:9999 --token "$TOKEN" \
  --name git-agent \
  --allowed-tools "Read,Bash(git:*)" \
  --permission-mode auto

# This should work
coord run "git status" --on git-agent --url ws://localhost:9999

# This should fail (rm is not git)
coord run "rm -rf ." --on git-agent --url ws://localhost:9999
```

Expected: git status succeeds, rm fails

### 10. Test MCP permission parameters

If MCP server is integrated, test permission parameters on `dispatch_task` tool:

```bash
# Start MCP server
coord mcp --url ws://localhost:9999 &

# In Claude Code, use:
# dispatch_task(agentName="perm-agent", prompt="read a file", allowedTools="Read")
```

Expected:
- Task dispatches with restricted permissions
- Output contains file contents (Read allowed)

### 11. Cleanup

Stop all agents and the coordinator:

```bash
pkill coord
```

Verify all processes are terminated.

### Permission Test Checklist

- [ ] Agent starts with permission flags
- [ ] Agent permissions shown in status
- [ ] Task dispatches with baseline permissions
- [ ] Per-task restrictions applied
- [ ] Mode transitions work (default -> auto -> plan -> acceptEdits)
- [ ] Directory restrictions enforced
- [ ] Tool scoping enforced (Bash(git:*) vs Bash)
- [ ] Mutually exclusive flags rejected
- [ ] Permission matrix verified for all tool types
- [ ] MCP permission parameters work (if integrated)
- [ ] Logs show permission configuration at agent startup
- [ ] Logs show permission application at task dispatch
