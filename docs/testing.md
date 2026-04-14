# Testing Procedures

## Unit & Integration Tests

Run the automated test suite:

```bash
npm test          # 81 tests across 9 suites
npm run lint      # TypeScript type-check (tsc --noEmit)
```

Tests are silenced for pino output via `COORD_LOG_LEVEL=silent` in the test script.

### Test Suites

| Suite | Tests | Covers |
|-------|-------|--------|
| `tests/protocol/messages.test.ts` | 13 | Message creation, serialization, round-trip, parseMessage validation, MessageDeduplicator |
| `tests/coordinator/registry.test.ts` | 17 | Agent registration, heartbeat, status transitions, stale agent detection, dead busy agent detection, concurrency (addTask/removeTask/hasCapacity), health updates |
| `tests/coordinator/tasks.test.ts` | 12 | Task lifecycle, output append, output cap, truncation, cleanup, status filtering |
| `tests/coordinator/server.test.ts` | 12 | Auth rejection, agent registration, heartbeat, disconnect, arg validation, status filter validation, name hijacking, task ownership, unhealthy agent dispatch refusal |
| `tests/agent/executor.test.ts` | 10 | Prompt execution, error exit, sessionId flag, timeout, dangerouslySkipPermissions, maxBudgetUsd, concurrent process tracking, killTask, kill-all |
| `tests/agent/daemon.test.ts` | 4 | Connect/register, unregister on stop, non-UUID taskId rejection, oversized prompt rejection |
| `tests/agent/health.test.ts` | 2 | Claude CLI health check (available/unavailable) |
| `tests/integration/dispatch.test.ts` | 4 | End-to-end dispatch+streaming, unknown agent error, capacity rejection, multi-task concurrent dispatch |
| `tests/shared/auth.test.ts` | 7 | Token generation, validation, per-agent token matching |

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
