# Clawd-Coordinator V2: Full Feature Expansion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all FATAL/SEVERE/PRODUCT findings from the architecture, SRE, and product reviews — transforming clawd-coordinator from a personal tool into a reliable, production-ready orchestration system.

**Architecture:** 7 phases, each independently deployable. Phases 1-2 are zero-dependency quick fixes. Phases 3-5 build the infrastructure backbone (persistence, concurrency, isolation). Phases 6-7 are product expansion (REST API, MCP server). Each phase has its own branch, tests, and commit.

**Tech Stack:** TypeScript/Node.js ESM, ws, commander, pino, better-sqlite3 (Phase 5), @modelcontextprotocol/sdk (Phase 7)

## Progress

| Phase | Status | Tests Added |
|-------|--------|-------------|
| Phase 1 (FATAL fixes) | COMPLETE | 57 → 61 |
| Phase 2 (Protocol + Auth + Budget) | COMPLETE | 61 → 68 |
| Phase 3 (Agent health) | COMPLETE | 68 → 73 |
| Phase 4 (Per-agent concurrency) | COMPLETE | 73 → 81 |
| Phase 4.5 (Remediation) | COMPLETE | 81 → 84 |
| Phase 5 (SQLite + task queue) | TODO (depends on 4) | — |
| Phase 6 (Workspace isolation) | TODO (depends on 4) | — |
| Phase 7 (REST + MCP + Sessions) | TODO (depends on 5) | — |

**Next up:** Phase 5 (SQLite persistence + task queue) — Phase 6 (workspace isolation) can follow after.

---

## Phase Map & Dependencies

```
Phase 1 (FATAL fixes) ──────────┐
                                  ├── Phase 3 (Agent health + CLI budget)
Phase 2 (Protocol + Auth) ──────┤
                                  ├── Phase 4 (Per-agent concurrency)
                                  │       │
                                  │       ├── Phase 5 (SQLite + task queue)
                                  │       │
                                  │       └── Phase 6 (Workspace isolation)
                                  │
                                  └── Phase 7 (REST API + MCP + Sessions)
```

Phases 1 and 2 can run in parallel. Everything else is sequential.

---

## Phase 1: FATAL Operational Fixes

**Branch:** `phase-1/fatal-fixes`
**Effort:** Small (3-5 hours)
**Dependencies:** None

### Task 1.1: Immediate task error on agent disconnect

**Files:**
- Modify: `src/coordinator/server.ts` (handleAgentConnection ws.on('close') handler, ~line 287)
- Test: `tests/coordinator/server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('errors running task when agent disconnects', async () => {
  coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
  await coordinator.start();

  const agentWs = await connectWs('/agent');
  agentWs.send(serializeMessage(createAgentRegister({ name: 'crash-agent', os: 'linux', arch: 'x64' })));
  await new Promise(r => setTimeout(r, 50));

  const cli = await connectWs('/cli');
  const dispatchResponse = await sendAndReceive(
    cli,
    serializeMessage(createCliRequest({ command: 'dispatch-task', args: { agentName: 'crash-agent', prompt: 'work' } }))
  );
  const taskId = (parseMessage(dispatchResponse)!.payload as any).data.taskId;

  // Subscribe to task output
  await sendAndReceive(cli, serializeMessage(createCliRequest({ command: 'subscribe-task', args: { taskId } })));

  // Agent crashes
  agentWs.close();

  // CLI should receive task:error
  const errorMsg = await new Promise<string>((resolve) => {
    cli.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (msg?.type === 'task:error' && msg.payload.taskId === taskId) {
        resolve(msg.payload.error);
      }
    });
  });

  expect(errorMsg).toBe('Agent disconnected while task was running');
  cli.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --reporter verbose 2>&1 | tail -20`
Expected: FAIL — task:error never received (timeout)

- [ ] **Step 3: Implement the fix**

In `src/coordinator/server.ts`, expand the `ws.on('close')` handler in `handleAgentConnection`:

```typescript
ws.on('close', () => {
  if (agentName) {
    // Error any running task immediately
    const agent = this.registry.get(agentName);
    if (agent && agent.status === 'busy' && agent.currentTaskId) {
      const taskId = agent.currentTaskId;
      this.tasks.setError(taskId, 'Agent disconnected while task was running');
      const subs = this.taskSubscribers.get(taskId);
      if (subs) {
        const errMsg = serializeMessage(createTaskError({
          taskId,
          error: 'Agent disconnected while task was running',
        }));
        for (const cli of subs) {
          if (cli.readyState === WebSocket.OPEN) {
            cli.send(errMsg);
          }
        }
        this.taskSubscribers.delete(taskId);
      }
    }
    logger.info({ agent: agentName }, 'Agent disconnected');
    this.registry.unregister(agentName);
    this.agentSockets.delete(agentName);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/coordinator/server.ts tests/coordinator/server.test.ts
git commit -m "fix: immediately error tasks when agent disconnects"
```

---

### Task 1.2: Observable output truncation

**Files:**
- Modify: `src/coordinator/tasks.ts` (Task interface, appendOutput)
- Modify: `src/coordinator/server.ts` (task:output handler)
- Test: `tests/coordinator/tasks.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('marks task as truncated and appends marker line', () => {
  const smallTracker = new TaskTracker({ maxOutputLines: 3 });
  const task = smallTracker.create({ agentName: 'a', prompt: 'test' });
  smallTracker.setRunning(task.id);
  smallTracker.appendOutput(task.id, 'line 1');
  smallTracker.appendOutput(task.id, 'line 2');
  smallTracker.appendOutput(task.id, 'line 3');
  const result = smallTracker.appendOutput(task.id, 'line 4');
  expect(result).toBe(false);
  const updated = smallTracker.get(task.id)!;
  expect(updated.truncated).toBe(true);
  expect(updated.output).toHaveLength(4); // 3 lines + marker
  expect(updated.output[3]).toBe('[OUTPUT TRUNCATED at 3 lines]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `truncated` property does not exist on Task

- [ ] **Step 3: Implement**

In `src/coordinator/tasks.ts`:

Add `truncated: boolean` to `Task` interface (default `false` in `create()`).

Update `appendOutput`:

```typescript
appendOutput(id: string, data: string): boolean {
  const task = this.tasks.get(id);
  if (!task) return false;
  if (task.truncated) return false;
  if (task.output.length >= this.maxOutputLines) {
    task.truncated = true;
    task.output.push(`[OUTPUT TRUNCATED at ${this.maxOutputLines} lines]`);
    return false;
  }
  task.output.push(data);
  return true;
}
```

- [ ] **Step 4: Update existing test that checks output cap**

The existing test "caps output at maxOutputLines" expects `output.toHaveLength(3)`. Update it: the 4th append triggers truncation, adding a marker, so output length becomes 4.

- [ ] **Step 5: Run tests to verify all pass**

Run: `npm test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/coordinator/tasks.ts tests/coordinator/tasks.test.ts
git commit -m "fix: emit truncation marker when output cap is reached"
```

---

### Task 1.3: Claude headless permission flag

**Files:**
- Modify: `src/agent/executor.ts` (RunOptions, args array)
- Modify: `src/agent/daemon.ts` (AgentDaemonOptions, pass-through)
- Modify: `src/cli/commands/agent.ts` (CLI flag)
- Test: `tests/agent/executor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('includes --dangerouslySkipPermissions when enabled', async () => {
  const executor = new Executor();
  await executor.run({
    prompt: 'test',
    dangerouslySkipPermissions: true,
    onOutput: () => {},
  });

  expect(spawn).toHaveBeenCalledWith(
    'claude',
    expect.arrayContaining(['--dangerouslySkipPermissions']),
    expect.any(Object)
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `dangerouslySkipPermissions` not in RunOptions

- [ ] **Step 3: Implement**

In `src/agent/executor.ts`, add `dangerouslySkipPermissions?: boolean` to `RunOptions`. In `run()`, after the initial args array:

```typescript
if (options.dangerouslySkipPermissions) {
  args.unshift('--dangerouslySkipPermissions');
}
```

In `src/agent/daemon.ts`, add `dangerouslySkipPermissions?: boolean` to `AgentDaemonOptions`. Pass through in `handleTask`:

```typescript
dangerouslySkipPermissions: this.options.dangerouslySkipPermissions,
```

In `src/cli/commands/agent.ts`, add the option:

```typescript
.option('--dangerously-skip-permissions', 'Skip Claude permission prompts (for headless use)')
```

Pass to `AgentDaemon` constructor.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/executor.ts src/agent/daemon.ts src/cli/commands/agent.ts tests/agent/executor.test.ts
git commit -m "feat: add --dangerously-skip-permissions flag for headless agents"
```

---

## Phase 2: Protocol & Auth Hardening

**Branch:** `phase-2/protocol-auth`
**Effort:** Medium (3-5 hours)
**Dependencies:** None (parallel with Phase 1)

### Task 2.1: Log correlation via traceId

**Files:**
- Modify: `src/protocol/messages.ts` (TaskDispatchPayload, TaskOutputPayload, TaskCompletePayload, TaskErrorPayload)
- Modify: `src/coordinator/tasks.ts` (Task interface)
- Modify: `src/coordinator/server.ts` (generate traceId on dispatch, include in logs)
- Modify: `src/agent/daemon.ts` (extract traceId from dispatch, include in output/complete/error)
- Test: `tests/integration/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/integration/dispatch.test.ts`, add:

```typescript
it('includes traceId in task output and completion messages', async () => {
  // ... setup coordinator, fake agent, CLI (same as existing test) ...
  // In the fake agent handler, verify dispatch has traceId, echo it back
  // In the CLI, verify task:output and task:complete include traceId

  // Assert traceId is a UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  expect(traceId).toMatch(uuidRegex);
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add traceId to protocol payloads**

In `src/protocol/messages.ts`, add `traceId?: string` to `TaskDispatchPayload`, `TaskOutputPayload`, `TaskCompletePayload`, `TaskErrorPayload`.

- [ ] **Step 4: Generate traceId in server dispatch handler**

In `src/coordinator/server.ts`, dispatch-task case: generate `const traceId = randomUUID()`. Store on task. Include in `createTaskDispatch`. Include in all log statements.

- [ ] **Step 5: Propagate traceId in daemon**

In `src/agent/daemon.ts`, extract `traceId` from dispatch payload. Include in all `createTaskOutput`, `createTaskComplete`, `createTaskError` calls. Include in log statements.

- [ ] **Step 6: Store traceId on Task**

In `src/coordinator/tasks.ts`, add `traceId?: string` to Task interface. Accept in `create()`.

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add src/protocol/messages.ts src/coordinator/server.ts src/coordinator/tasks.ts src/agent/daemon.ts tests/integration/dispatch.test.ts
git commit -m "feat: add traceId for log correlation across coordinator and agents"
```

---

### Task 2.2: Per-agent auth tokens

**Files:**
- Modify: `src/shared/config.ts` (CoordConfig with agentTokens)
- Modify: `src/shared/auth.ts` (validateAgentToken)
- Modify: `src/coordinator/server.ts` (handleConnection dual auth)
- Modify: `src/cli/commands/init.ts` (--add-agent flag)
- Create: `tests/shared/auth.test.ts`

- [ ] **Step 1: Write failing auth test**

```typescript
import { describe, it, expect } from 'vitest';
import { generateToken, validateToken } from '../../src/shared/auth.js';

describe('auth', () => {
  it('generates a 64-char hex token', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates correct token', () => {
    expect(validateToken('abc', 'abc')).toBe(true);
  });

  it('rejects wrong token of same length', () => {
    expect(validateToken('abc', 'xyz')).toBe(false);
  });

  it('rejects wrong-length token', () => {
    expect(validateToken('short', 'longer-token')).toBe(false);
  });
});
```

- [ ] **Step 2: Run — should PASS (existing code works)**

- [ ] **Step 3: Add validateAgentToken and failing test**

```typescript
import { validateAgentToken } from '../../src/shared/auth.js';

it('validates agent token and returns matched agent name', () => {
  const tokens = { 'agent-1': 'token-aaa', 'agent-2': 'token-bbb' };
  expect(validateAgentToken('token-aaa', tokens)).toBe('agent-1');
  expect(validateAgentToken('token-bbb', tokens)).toBe('agent-2');
  expect(validateAgentToken('token-ccc', tokens)).toBeNull();
});
```

- [ ] **Step 4: Implement validateAgentToken in auth.ts**

```typescript
export function validateAgentToken(provided: string, agentTokens: Record<string, string>): string | null {
  for (const [name, token] of Object.entries(agentTokens)) {
    if (validateToken(provided, token)) return name;
  }
  return null;
}
```

- [ ] **Step 5: Update config and server to support per-agent tokens**

Add `agentTokens?: Record<string, string>` to `CoordConfig`. Update `handleConnection` to try admin token first, then agent tokens. If agent token matches, pass expected agent name to `handleAgentConnection`.

- [ ] **Step 6: Run tests, commit**

```bash
git commit -m "feat: add per-agent auth tokens with backward compat"
```

---

### Task 2.3: Pre-auth connection rejection

**Files:**
- Modify: `src/coordinator/server.ts` (WebSocketServer verifyClient option)
- Modify: `tests/coordinator/server.test.ts` (update bad-token test)

- [ ] **Step 1: Update the existing bad-token test**

The test currently expects WebSocket close code 4001. With `verifyClient`, the connection never opens. Change to expect a connection error:

```typescript
it('rejects agent connection with bad token', async () => {
  coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
  await coordinator.start();

  const ws = new WebSocket(`ws://localhost:${TEST_PORT}/agent`, {
    headers: { 'authorization': 'Bearer wrong' },
  });

  const error = await new Promise<Error>((resolve) => {
    ws.on('error', resolve);
  });
  expect(error.message).toContain('401');
});
```

- [ ] **Step 2: Run test — fails (still gets WS close, not HTTP error)**

- [ ] **Step 3: Implement verifyClient**

In `src/coordinator/server.ts`, add `verifyClient` to WebSocketServer options:

```typescript
const verifyClient = (info: { req: IncomingMessage }, cb: (result: boolean, code?: number, message?: string) => void) => {
  const token = (info.req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
  if (!validateToken(token, this.options.token)) {
    // Also check agent tokens if configured
    logger.warn({ remoteAddress: info.req.socket.remoteAddress }, 'Authentication failed');
    cb(false, 401, 'Unauthorized');
    return;
  }
  cb(true);
};
```

Pass `verifyClient` to both TLS and non-TLS WebSocketServer constructors.

Remove the token check from `handleConnection` (now redundant).

- [ ] **Step 4: Run tests, all pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix: reject unauthenticated connections before WebSocket upgrade"
```

---

## Phase 3: Agent Health & CLI Budget

**Branch:** `phase-3/agent-health`
**Effort:** Medium (3-4 hours)
**Dependencies:** Phases 1 and 2

### Task 3.1: Agent auth health check

**Files:**
- Create: `src/agent/health.ts`
- Modify: `src/agent/daemon.ts`
- Modify: `src/protocol/messages.ts` (heartbeat payload)
- Modify: `src/coordinator/registry.ts` (health fields on AgentInfo)
- Modify: `src/coordinator/server.ts` (refuse dispatch to unhealthy agents)
- Create: `tests/agent/health.test.ts`

- [ ] **Step 1: Write health check module test**

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => 'claude 1.0.0'),
}));

const { checkClaudeHealth } = await import('../../src/agent/health.js');

describe('checkClaudeHealth', () => {
  it('returns available when claude --version succeeds', async () => {
    const result = await checkClaudeHealth();
    expect(result.available).toBe(true);
    expect(result.version).toBe('claude 1.0.0');
  });
});
```

- [ ] **Step 2: Create health.ts**

```typescript
import { execSync } from 'node:child_process';

export interface HealthStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export function checkClaudeHealth(): HealthStatus {
  try {
    const output = execSync('claude --version', { timeout: 10000, encoding: 'utf-8' }).trim();
    return { available: true, version: output };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 3: Wire into daemon heartbeat and server dispatch**

Add `health?: { claudeAvailable: boolean; version?: string }` to `AgentHeartbeatPayload` and `AgentRegisterPayload`. Run health check on agent startup and every 5 minutes. Server refuses dispatch to agents with `claudeAvailable === false`.

- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat: add Claude health check on agents, refuse dispatch to unhealthy"
```

---

### Task 3.2: Wire --max-budget-usd through CLI

**Files:**
- Modify: `src/cli/commands/run.ts` (add --budget option)
- Modify: `src/cli/commands/fan-out.ts` (add --budget option)
- Modify: `src/protocol/messages.ts` (add maxBudgetUsd to TaskDispatchPayload)
- Modify: `src/coordinator/server.ts` (pass through in dispatch)
- Modify: `src/agent/daemon.ts` (extract and pass to executor)
- Test: `tests/agent/executor.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('passes --max-budget-usd flag when budget is set', async () => {
  const executor = new Executor();
  await executor.run({
    prompt: 'test',
    maxBudgetUsd: 5.0,
    onOutput: () => {},
  });

  expect(spawn).toHaveBeenCalledWith(
    'claude',
    expect.arrayContaining(['--max-budget-usd', '5']),
    expect.any(Object)
  );
});
```

- [ ] **Step 2: Verify this test already passes** (executor already supports maxBudgetUsd)

- [ ] **Step 3: Add `--budget` to run.ts and fan-out.ts**

```typescript
.option('--budget <usd>', 'Maximum budget in USD for this task')
```

Pass as `maxBudgetUsd: options.budget ? parseFloat(options.budget) : undefined` in dispatch args.

- [ ] **Step 4: Add `maxBudgetUsd` to TaskDispatchPayload and wire through server + daemon**

- [ ] **Step 5: Run tests, commit**

```bash
git commit -m "feat: wire --budget flag through CLI to executor"
```

---

## Phase 4: Per-Agent Task Concurrency

**Branch:** `phase-4/concurrency`
**Effort:** Large (4-8 hours)
**Dependencies:** Phase 1

### Task 4.1: Refactor executor for multiple processes

**Files:**
- Modify: `src/agent/executor.ts`
- Test: `tests/agent/executor.test.ts`

- [ ] **Step 1: Write test for concurrent execution**

```typescript
it('tracks multiple concurrent processes by taskId', async () => {
  const executor = new Executor();
  const output1: string[] = [];
  const output2: string[] = [];

  const p1 = executor.run({ prompt: 'task1', taskId: 'id-1', onOutput: (d) => output1.push(d) });
  const p2 = executor.run({ prompt: 'task2', taskId: 'id-2', onOutput: (d) => output2.push(d) });

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1.exitCode).toBe(0);
  expect(r2.exitCode).toBe(0);
});
```

- [ ] **Step 2: Refactor executor**

Replace `private currentProcess: ChildProcess | null` with `private processes = new Map<string, ChildProcess>()`. Add required `taskId` to `RunOptions`. `kill()` kills all. Add `killTask(taskId)` for individual.

- [ ] **Step 3: Update all existing executor tests** for new `taskId` param

- [ ] **Step 4: Run tests, commit**

---

### Task 4.2: Refactor registry for concurrent tasks

**Files:**
- Modify: `src/coordinator/registry.ts`
- Test: `tests/coordinator/registry.test.ts`

- [ ] **Step 1: Write tests for multi-task tracking**

```typescript
it('tracks multiple concurrent tasks per agent', () => {
  registry.register('multi-agent', { os: 'linux', arch: 'x64', maxConcurrent: 3 });
  registry.addTask('multi-agent', 'task-1');
  registry.addTask('multi-agent', 'task-2');
  const agent = registry.get('multi-agent')!;
  expect(agent.currentTaskIds).toEqual(['task-1', 'task-2']);
  expect(agent.status).toBe('active'); // has capacity
  registry.addTask('multi-agent', 'task-3');
  expect(registry.get('multi-agent')!.status).toBe('busy'); // at capacity
});
```

- [ ] **Step 2: Implement**

Replace `currentTaskId?: string` with `currentTaskIds: string[]`, `maxConcurrent: number`. Replace `setBusy`/`setIdle` with `addTask`/`removeTask`. Add `hasCapacity()`. Status derived: idle (0 tasks), active (< max), busy (>= max).

- [ ] **Step 3: Update all 12+ existing registry tests**

- [ ] **Step 4: Run tests, commit**

---

### Task 4.3: Update server and daemon for concurrency

**Files:**
- Modify: `src/coordinator/server.ts`
- Modify: `src/agent/daemon.ts`
- Modify: `src/protocol/messages.ts` (maxConcurrent in register payload)
- Test: `tests/integration/dispatch.test.ts`

- [ ] **Step 1: Update server dispatch to use hasCapacity()**
- [ ] **Step 2: Update daemon to accept --max-concurrent, track running count**
- [ ] **Step 3: Update integration tests**
- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat: per-agent task concurrency with configurable max"
```

---

## Phase 5: SQLite Persistence + Task Queue

**Branch:** `phase-5/persistence`
**Effort:** Large (6-10 hours)
**Dependencies:** Phases 1, 4

### Task 5.1: Extract TaskStore interface

**Files:**
- Modify: `src/coordinator/tasks.ts` (extract interface, rename class)
- Test: `tests/coordinator/tasks.test.ts` (unchanged, verify still passes)

- [ ] **Step 1: Extract `TaskStore` interface from TaskTracker**

```typescript
export interface TaskStore {
  create(params: { agentName: string; prompt: string; sessionId?: string; traceId?: string }): Task;
  get(id: string): Task | null;
  list(status?: TaskStatus): Task[];
  setRunning(id: string): void;
  appendOutput(id: string, data: string): boolean;
  setCompleted(id: string): void;
  setError(id: string, error: string): void;
  cleanup(maxAgeMs: number): number;
}
```

- [ ] **Step 2: Run tests — all pass (no behavior change)**
- [ ] **Step 3: Commit**

---

### Task 5.2: Implement SQLite store

**Files:**
- Create: `src/coordinator/sqlite-store.ts`
- Create: `tests/coordinator/sqlite-store.test.ts`

- [ ] **Step 1: Install better-sqlite3**

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

- [ ] **Step 2: Write tests (mirror TaskTracker tests)**
- [ ] **Step 3: Implement SqliteTaskStore**

Use `:memory:` for tests. Auto-create tables on construction. Store output as JSON text. Implement same interface as TaskStore.

- [ ] **Step 4: Run tests, commit**

---

### Task 5.3: Implement task queue

**Files:**
- Create: `src/coordinator/queue.ts`
- Create: `tests/coordinator/queue.test.ts`

- [ ] **Step 1: Write queue tests**

```typescript
it('enqueues and dequeues tasks in FIFO order', () => { ... });
it('dequeues for specific agent first, then any-agent tasks', () => { ... });
it('returns null when queue is empty', () => { ... });
```

- [ ] **Step 2: Implement TaskQueue** (SQLite-backed or in-memory)
- [ ] **Step 3: Run tests, commit**

---

### Task 5.4: Wire SQLite + queue into coordinator

**Files:**
- Modify: `src/coordinator/server.ts`
- Modify: `src/shared/config.ts` (storage config)
- Modify: `src/cli/commands/serve.ts` (--storage, --db-path flags)

- [ ] **Step 1: Add storage config options**
- [ ] **Step 2: In server, use SqliteTaskStore when configured**
- [ ] **Step 3: On task:complete/task:error, process queue**
- [ ] **Step 4: On agent register (idle), process queue**
- [ ] **Step 5: Run full test suite, commit**

```bash
git commit -m "feat: SQLite persistence and task queue"
```

---

## Phase 6: Workspace Isolation

**Branch:** `phase-6/isolation`
**Effort:** Medium (3-5 hours)
**Dependencies:** Phase 4

### Task 6.1: Isolation strategy interface + implementations

**Files:**
- Create: `src/agent/isolation.ts`
- Create: `tests/agent/isolation.test.ts`

- [ ] **Step 1: Write tests for WorktreeStrategy**

```typescript
it('creates a git worktree for the task', async () => {
  // Mock execSync, verify git worktree add called
});

it('removes the worktree on cleanup', async () => {
  // Mock execSync, verify git worktree remove called
});
```

- [ ] **Step 2: Implement IsolationStrategy interface**

```typescript
export interface IsolationStrategy {
  setup(taskId: string, baseDir: string): Promise<string>;
  cleanup(taskId: string): Promise<void>;
}
```

Implementations: `NoneStrategy` (passthrough), `WorktreeStrategy` (git worktree), `TempDirStrategy` (copy).

- [ ] **Step 3: Wire into daemon with --isolation flag**
- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat: per-task workspace isolation via git worktrees"
```

---

## Phase 7: Product Expansion

**Branch:** `phase-7/product`
**Effort:** Large (8-12 hours)
**Dependencies:** All prior phases

### Task 7.1: REST API layer

**Files:**
- Create: `src/coordinator/rest.ts`
- Modify: `src/coordinator/server.ts` (share HTTP server between WS and REST)
- Create: `tests/coordinator/rest.test.ts`

- [ ] **Step 1: Write REST endpoint tests**

```typescript
it('POST /api/dispatch returns taskId', async () => { ... });
it('GET /api/tasks returns task list', async () => { ... });
it('GET /api/tasks/:id returns task with output', async () => { ... });
it('GET /api/agents returns agent list', async () => { ... });
it('rejects requests without auth header', async () => { ... });
```

- [ ] **Step 2: Implement REST handler** (raw http module, no Express)
- [ ] **Step 3: Switch server.ts to explicit http.createServer() for non-TLS path**

Currently `new WebSocketServer({ port })` creates its own HTTP server internally. Change to:
```typescript
const httpServer = createServer(restHandler);
this.wss = new WebSocketServer({ server: httpServer, maxPayload: ... });
httpServer.listen(port, () => resolve());
```

This matches the TLS path which already uses this pattern.

- [ ] **Step 4: Run tests, commit**

```bash
git commit -m "feat: REST API for CI/CD integration"
```

---

### Task 7.2: MCP Server

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/cli/commands/mcp.ts`
- Modify: `src/cli/index.ts` (register mcp command)
- Create: `tests/mcp/server.test.ts`

- [ ] **Step 1: Install MCP SDK**

```bash
npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: Write MCP tool tests**

```typescript
it('dispatch_task tool dispatches and returns taskId', async () => { ... });
it('list_agents tool returns connected agents', async () => { ... });
it('get_task_result tool returns task output', async () => { ... });
```

- [ ] **Step 3: Implement MCP server**

Tools: `dispatch_task`, `list_agents`, `get_task_result`, `list_tasks`. Transport: stdio. Connects to coordinator as a CLI client.

- [ ] **Step 4: Add `coord mcp` command**

```typescript
export const mcpCommand = new Command('mcp')
  .description('Start MCP server for Claude Code integration')
  .option('--url <url>', 'Coordinator URL')
  .action(async (options) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
    const server = new CoordMcpServer(url, config.token);
    await server.start();
  });
```

- [ ] **Step 5: Run tests, commit**

```bash
git commit -m "feat: MCP server for Claude Code tool integration"
```

---

### Task 7.3: Session discovery + resume

**Files:**
- Modify: `src/protocol/messages.ts` (session message types)
- Modify: `src/agent/daemon.ts` (handle session:list-request)
- Modify: `src/coordinator/server.ts` (relay session requests)
- Create: `src/cli/commands/sessions.ts` (reimplemented, not stubs)
- Test: `tests/integration/sessions.test.ts`

- [ ] **Step 1: Add protocol messages for sessions**
- [ ] **Step 2: Implement session listing on agent** (calls `claude sessions list`)
- [ ] **Step 3: Add relay in coordinator**
- [ ] **Step 4: Implement CLI commands**
- [ ] **Step 5: Run tests, commit**

```bash
git commit -m "feat: session discovery and resume across agents"
```

---

## Verification

After all phases are complete:

1. **Run full test suite:** `npm test` — all tests pass
2. **Type check:** `npm run lint` — clean
3. **Build:** `npm run build` — clean
4. **Manual integration test:** Follow `docs/testing.md` procedure
5. **REST API test:** `curl -H "Authorization: Bearer <token>" http://localhost:8080/api/agents`
6. **MCP test:** Add to Claude Code config, verify `dispatch_task` tool works
7. **Persistence test:** Start coordinator with `--storage sqlite`, dispatch tasks, restart coordinator, verify tasks survive
8. **Queue test:** Dispatch more tasks than agents, verify queued tasks execute as agents free up
9. **Concurrency test:** Start agent with `--max-concurrent 3`, dispatch 3 tasks simultaneously, verify all run

---

## Effort Summary

| Phase | Items | Effort | Dependencies |
|-------|-------|--------|-------------|
| 1 | F1, F2, F3 | 3-5h | None |
| 2 | S6, S7, S8 | 3-5h | None |
| 3 | S1, S5 | 3-4h | Phases 1, 2 |
| 4 | S2 | 4-8h | Phase 1 |
| 5 | S4 | 6-10h | Phases 1, 4 |
| 6 | S3 | 3-5h | Phase 4 |
| 7 | P1, P2, P3 | 8-12h | All above |
| **Total** | | **30-49h** | |
