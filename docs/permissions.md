# Permissions Guide

Clawd Coordinator integrates Claude Code's native permission system, allowing you to configure granular tool access at the agent level or override it per-task. This guide covers all permission modes, use cases, and security implications.

## Overview

Agents support three permission approaches:

- **`--dangerously-skip-permissions`** — Full headless access with no guardrails. Simple and effective for trusted environments.
- **Pre-authorized tools** — Granular control over which tools Claude can use, with optional per-task restrictions.
- **Default prompting** — Claude Code's standard interactive permission model (requires a TTY, not suitable for headless agents).

The pre-authorized tools approach gives you:

1. **Pre-authorize specific tools** on an agent (`--allowed-tools`)
2. **Configure a permission mode** (how Claude Code handles access requests)
3. **Override permissions per-task** (restrict, but never expand, an agent's baseline)
4. **Deny specific tools** (blacklist approach with `--disallowed-tools`)
5. **Extend directory access** (beyond `--cwd` with `--add-dirs`)

## Permission Modes

Claude Code supports four permission modes. Choose the one that fits your workflow:

### default

**Behavior:** Interactive prompting on each tool use.

**Use when:** A human is monitoring or can respond to prompts.

**Tradeoff:** Safest but requires interactivity; blocks in unattended scenarios.

```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read,Write,Edit,Bash" \
  --permission-mode default
```

### auto

**Behavior:** Pre-authorized tools execute without prompting.

**Use when:** You trust the agent and want headless operation.

**Tradeoff:** No prompts = fast execution but requires careful tool scoping.

```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

### plan

**Behavior:** Claude shows a plan, waits for approval, then executes all approved actions.

**Use when:** You want to review the plan before execution but avoid per-tool prompts.

**Tradeoff:** One approval per task; good for structured workflows.

```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read,Write,Edit,Bash" \
  --permission-mode plan
```

### acceptEdits

**Behavior:** File edits (Write/Edit) auto-approve; other tools prompt.

**Use when:** You want auto-save for development but manual control for system commands.

**Tradeoff:** Speeds up editing workflows; Bash/CLI still need approval.

```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read,Write,Edit,Bash" \
  --permission-mode acceptEdits
```

## Tool Categories

### Core Tools

| Tool | Purpose | Safe? | Notes |
|------|---------|-------|-------|
| `Read` | Read files/directories | Very safe | Information disclosure risk if secrets in files |
| `Write` | Create new files | Safe-ish | Can fill disk; can create unwanted files |
| `Edit` | Modify existing files | Medium | Can corrupt code; destructive if scoped wrong |
| `Bash` | Execute shell commands | Dangerous | Full shell access; can delete, exfiltrate, etc. |

### Tool Scoping (Bash)

You can scope Bash access to specific commands:

| Scope | Syntax | Allowed | Example |
|-------|--------|---------|---------|
| Full shell | `Bash` | Any command | `rm`, `curl`, `git`, `python`, etc. |
| Git only | `Bash(git:*)` | Git commands | `git clone`, `git push`, `git status` |
| Cat only | `Bash(cat:*)` | Cat command | `cat file.txt` |
| Specific command | `Bash(command:*)` | That command | `Bash(ls:*)` allows `ls` |

### Examples

**Development (read, write, edit, git-safe bash):**
```
Read,Write,Edit,Bash(git:*)
```

**Read-only monitoring:**
```
Read,Bash(cat:*),Bash(grep:*),Bash(ps:*)
```

**System administration (broad access):**
```
Read,Write,Edit,Bash
```

**Safe refactoring (edit-only, no shell):**
```
Read,Write,Edit
```

## Agent-Level Configuration

Set baseline permissions when starting an agent. These permissions apply to all tasks unless overridden per-task.

### Syntax

```bash
coord agent \
  --url <coordinator-url> \
  --token <token> \
  --name <agent-name> \
  --allowed-tools "<comma-separated-tools>" \
  --disallowed-tools "<optional-deny-list>" \
  --add-dirs "<comma-separated-extra-dirs>" \
  --permission-mode <mode>
```

### Use Cases

#### Development Agent

Enable auto-approval for code changes, with git-safe bash:

```bash
coord agent --url wss://coordinator.example.ts.net --token TOKEN --name dev-agent \
  --cwd /home/ubuntu/project \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

**What it allows:**
- Read any file in project
- Create new files in project
- Edit existing files in project
- Run git commands (push, pull, commit, etc.)

**What it blocks:**
- Bash commands outside git (npm, python, rm, etc.)

#### Read-Only Monitoring Agent

No modifications, safe bash access:

```bash
coord agent --url wss://coordinator.example.ts.net --token TOKEN --name monitor-agent \
  --cwd /home/ubuntu \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*),Bash(ps:*)" \
  --permission-mode default
```

**What it allows:**
- Read files
- Cat files
- Grep for patterns
- List processes

**What it blocks:**
- File creation/modification
- Most bash commands (only safe read-like commands)

#### CI/CD Agent

Broad access with plan approval:

```bash
coord agent --url wss://coordinator.example.ts.net --token TOKEN --name ci-agent \
  --cwd /home/ubuntu/project \
  --allowed-tools "Read,Write,Edit,Bash" \
  --add-dirs "/etc/systemd/system,/var/lib" \
  --permission-mode plan
```

**What it allows:**
- All file operations in project
- Full bash access
- Access to systemd configs and var/lib
- But requires plan approval before execution

**What it blocks:**
- Nothing (tool-wise), but all actions wait for plan approval

#### System Agent

Manage the machine (systemd, configs, logs):

```bash
coord agent --url wss://coordinator.example.ts.net --token TOKEN --name system-agent \
  --cwd /home/ubuntu \
  --allowed-tools "Read,Write,Edit,Bash(systemctl:*)" \
  --add-dirs "/etc,/var/log" \
  --permission-mode auto
```

**What it allows:**
- Read any system file
- Edit config files
- Create log files
- Manage systemd services (systemctl)

**What it blocks:**
- Arbitrary bash (only systemctl allowed)
- Other commands (npm, python, etc.)

## Per-Task Overrides

Restrict an agent's permissions for a specific task. Overrides can only narrow scope, never expand.

### Syntax

```bash
coord run "<prompt>" --on <agent> \
  --allowed-tools "<subset-of-agent-tools>" \
  --disallowed-tools "<additional-denies>" \
  --add-dirs "<subset-of-agent-dirs>"
```

### Examples

**Audit with restricted scope:**

Agent has broad access, but this task runs read-only:

```bash
# Agent config: --allowed-tools "Read,Write,Edit,Bash"
coord run "audit the config files" --on ops-agent \
  --allowed-tools "Read" \
  --add-dirs "/etc/openclaw"
```

Result: Task only has Read, scoped to `/etc/openclaw`.

**Safe refactoring:**

Restrict to project directory, no bash:

```bash
# Agent config: --allowed-tools "Read,Write,Edit,Bash"
coord run "refactor auth module" --on dev-agent \
  --allowed-tools "Read,Write,Edit" \
  --add-dirs "/home/user/project/auth"
```

Result: Task can edit, but no bash (can't run tests), scoped to auth dir.

**Inventory check:**

Restrict broad agent to read-only inventory check:

```bash
# Agent config: --allowed-tools "Read,Write,Edit,Bash"
coord run "check server inventory" --on admin-agent \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*)" \
  --add-dirs "/var/lib/inventory"
```

Result: Task can only read inventory files.

## Restriction-Only Behavior

**Key rule:** Per-task overrides can only restrict, never expand.

**Valid:** Agent has `Read,Write,Edit,Bash`, task uses `--allowed-tools "Read"`
- Task gets Read only (restricted)

**Invalid:** Agent has `Read`, task uses `--allowed-tools "Read,Write"`
- Error: Cannot expand permissions beyond agent baseline

**Why?** Prevents a task from escaping the agent's security boundary.

## Tool Syntax & Examples

### Single Tool

```bash
--allowed-tools "Read"
--allowed-tools "Write"
--allowed-tools "Edit"
--allowed-tools "Bash"
```

### Multiple Tools

```bash
--allowed-tools "Read,Write,Edit"
--allowed-tools "Read,Bash(git:*)"
```

### Scoped Bash

```bash
--allowed-tools "Bash(git:*)"      # git only
--allowed-tools "Bash(cat:*)"      # cat only
--allowed-tools "Bash(grep:*)"     # grep only
--allowed-tools "Bash(npm:*)"      # npm only
--allowed-tools "Bash(python:*)"   # python only
```

### Multiple Scoped Bash

```bash
--allowed-tools "Read,Bash(cat:*),Bash(grep:*)"  # read + safe bash cmds
```

## Directory Access

### --cwd (Primary Working Directory)

All agents have access to their `--cwd` by default:

```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --cwd /home/ubuntu/project
```

Agent can read/write anywhere in `/home/ubuntu/project` (if tools allow).

### --add-dirs (Additional Directories)

Extend access beyond `--cwd`:

```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --cwd /home/ubuntu \
  --add-dirs "/etc,/var/log,/var/lib"
```

Agent can access:
- `/home/ubuntu` (primary)
- `/etc` (added)
- `/var/log` (added)
- `/var/lib` (added)

### Per-Task Directory Restriction

Restrict a task to a subset of agent's directories:

```bash
# Agent config: --add-dirs "/etc,/var/log"
coord run "audit configs" --on agent \
  --add-dirs "/etc/openclaw"  # restrict to this subdir only
```

Result: Task only accesses `/etc/openclaw`, not all of `/etc`.

## Security Implications

### Threat Model

**Assume the agent machine is partly untrusted.** Permissions prevent:

1. **Exfiltration** — Deny Read/Bash(cat:*) if machine may have secrets
2. **Destructive actions** — Deny Write/Edit/Bash if machine is production
3. **Lateral movement** — Restrict Bash (e.g., `Bash(git:*)` only) to limit command scope
4. **Resource exhaustion** — Read-only agents can't create large files; Edit limits file growth

### Not a Sandbox

Permissions do NOT provide complete isolation:

- A process with Bash access can still call other commands (e.g., `Bash(git:*)` can call git, which might call other tools)
- Environment variables inherited by Claude process (set minimal env on agent machine)
- File permissions on the agent machine still apply (use OS-level permissions too)

### Recommendation

**Layered approach:**

1. Use permission flags for tool-level control
2. Use OS user/group permissions for file-level control
3. Use firewall for network-level control
4. Run agents in containers for process-level isolation
5. Monitor agent logs for suspicious activity

## Mutually Exclusive Flags

`--dangerously-skip-permissions` and permission flags are mutually exclusive:

**This will error:**
```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read" \
  --dangerously-skip-permissions
```

**Choose one approach:**

- **Old approach:** `--dangerously-skip-permissions` (all-or-nothing)
- **New approach:** Permission flags (granular control)

## REST API & MCP Integration

### REST API Dispatch

Include permission overrides in `POST /api/dispatch`:

```bash
curl -X POST http://localhost:8080/api/dispatch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "ops-agent",
    "prompt": "audit configs",
    "allowedTools": "Read",
    "addDirs": "/etc/openclaw"
  }'
```

### MCP Tool Parameters

`dispatch_task` MCP tool accepts permission overrides:

```
dispatch_task(
  agentName="ops-agent",
  prompt="audit the configs",
  allowedTools="Read",
  addDirs="/etc/openclaw"
)
```

## Migration from --dangerously-skip-permissions

If you're currently using `--dangerously-skip-permissions`, here's how to migrate:

**Before (all-or-nothing):**
```bash
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --dangerously-skip-permissions
```

**After (granular):**
```bash
# If you need full access (like before)
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read,Write,Edit,Bash" \
  --permission-mode auto

# Or if you only need specific tools
coord agent --url wss://host:8080 --token TOKEN --name my-agent \
  --allowed-tools "Read,Write,Edit,Bash(git:*)" \
  --permission-mode auto
```

The new approach gives you the same headless behavior but with finer control.

## Troubleshooting

### "Cannot expand permissions beyond agent baseline"

**Problem:** Task's `--allowed-tools` includes tools not in agent's config.

**Solution:** Remove the extra tools or expand the agent's `--allowed-tools`.

```bash
# Agent: --allowed-tools "Read"
# Task: --allowed-tools "Read,Write"  <- ERROR

# Fix: Use only Read in task
coord run "..." --on agent --allowed-tools "Read"
```

### "Bash command not in allowed scope"

**Problem:** Task tries to use bash, but agent only allows `Bash(git:*)`.

**Solution:** Either allow the command at agent level, or don't use it:

```bash
# Agent: --allowed-tools "Bash(git:*)"
# Task tries: npm install  <- ERROR (npm not in git:*)

# Fix 1: Allow npm at agent level
coord agent ... --allowed-tools "Bash(git:*),Bash(npm:*)"

# Fix 2: Don't use npm in this task
coord run "git clone ..." --on agent
```

### Agent prompts despite --permission-mode auto

**Problem:** Agent still prompts even with `--permission-mode auto`.

**Possible causes:**
- Tool not in `--allowed-tools` (Claude asks permission)
- `--permission-mode` not set correctly
- Claude Code CLI behaves differently in interactive mode

**Debug:**
1. Check agent logs: `COORD_LOG_LEVEL=debug coord agent ...`
2. Verify `--allowed-tools` includes the tool Claude wants
3. Try `--permission-mode plan` (shows plan before execution)

### Permission Denied errors in tasks

**Problem:** Task fails with "permission denied" accessing a directory.

**Causes:**
1. Directory not in `--cwd` or `--add-dirs`
2. OS-level file permissions (outside Claude's control)
3. Per-task `--add-dirs` restricted too much

**Debug:**
```bash
# Check what dirs agent can access
coord agents | grep agent-name

# Try without per-task restriction
coord run "..." --on agent

# Check OS permissions on the agent machine
ls -la /path/to/dir
```

## Permission Checklists

### Before Deploying an Agent

- [ ] Decided on permission mode (default/auto/plan/acceptEdits)
- [ ] Listed required tools (Read/Write/Edit/Bash?)
- [ ] Scoped Bash if needed (e.g., `Bash(git:*)`)
- [ ] Listed required directories (`--cwd` sufficient? Need `--add-dirs`?)
- [ ] Reviewed security implications (is this safe for the machine?)
- [ ] Tested with a non-production agent first
- [ ] Documented why each permission is needed

### Before Running a Sensitive Task

- [ ] Determined baseline permissions needed
- [ ] Applied per-task restrictions where possible
- [ ] Reviewed Claude's plan (if using `--permission-mode plan`)
- [ ] Monitored task execution (logs, output)
- [ ] Verified task only accessed intended directories/tools

### Regular Security Review

- [ ] Audit agent permissions monthly
- [ ] Remove unused tools from `--allowed-tools`
- [ ] Tighten directory access (remove unused `--add-dirs`)
- [ ] Review agent logs for suspicious patterns
- [ ] Update machine OS permissions (don't rely on Claude permissions only)

## Examples by Scenario

### Secure CI/CD Pipeline

```bash
# Builder agent (builds code)
coord agent --url wss://coord.example.ts.net --token TOKEN --name builder \
  --cwd /home/ci/workspace \
  --allowed-tools "Read,Write,Bash(git:*),Bash(npm:*)" \
  --permission-mode auto

# Deployer agent (deploys built artifacts)
coord agent --url wss://coord.example.ts.net --token TOKEN --name deployer \
  --cwd /home/ci/deploy \
  --allowed-tools "Read,Write,Bash(systemctl:*)" \
  --add-dirs "/etc/systemd/system" \
  --permission-mode plan

# Auditor agent (read-only checks)
coord agent --url wss://coord.example.ts.net --token TOKEN --name auditor \
  --cwd /home/ci \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*)" \
  --permission-mode default
```

### Development Environment

```bash
coord agent --url wss://coord.example.ts.net --token TOKEN --name dev-local \
  --cwd /home/developer/project \
  --allowed-tools "Read,Write,Edit,Bash" \
  --permission-mode acceptEdits
```

### Monitoring & Alerting

```bash
coord agent --url wss://coord.example.ts.net --token TOKEN --name monitor \
  --cwd /var/lib/monitoring \
  --allowed-tools "Read,Bash(cat:*),Bash(grep:*),Bash(ps:*)" \
  --add-dirs "/var/log" \
  --permission-mode default
```

### Isolated Task Execution

```bash
# Restricted agent
coord agent --url wss://coord.example.ts.net --token TOKEN --name sandbox \
  --cwd /tmp/sandbox \
  --allowed-tools "Read,Write" \
  --permission-mode auto

# Further restrict a sensitive task
coord run "process untrusted input" --on sandbox \
  --allowed-tools "Read" \
  --add-dirs "/tmp/sandbox/input"
```

## See Also

- [CLI Reference](cli-reference.md) — Full flag documentation
- [Deployment Guide](deployment.md) — Agent setup examples
- [Testing Guide](testing.md) — Permission testing procedures
