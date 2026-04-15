import { Command } from 'commander';
import { writeFileSync } from 'node:fs';

export function generateClaudeMd(): string {
  return `# clawd-coordinator

\`coord\` is a CLI tool for orchestrating remote Claude Code sessions via WebSocket.
It lets you dispatch prompts to Claude Code instances on remote machines, stream
output in real time, and transfer files — all from bash or another Claude Code session.

## Get Full Details

Run \`coord describe\` for complete markdown documentation (commands, REST API, MCP tools).
Run \`coord describe --json\` for a machine-readable JSON schema.
Run \`coord --help\` or \`coord <command> --help\` for flag details.

## Key Commands

| Command | What it does |
|---------|-------------|
| \`coord agents\` | List connected remote agents |
| \`coord run "<prompt>" --on <agent>\` | Dispatch a prompt, stream output |
| \`coord run "<prompt>" --on <agent> --bg\` | Dispatch in background, get task ID |
| \`coord fan-out "<prompt>" --on a,b,c\` | Fan out to multiple agents in parallel |
| \`coord tasks\` | List all tasks |
| \`coord attach <task-id>\` | Stream output from a running task |
| \`coord result <task-id>\` | Get output of a completed task |
| \`coord push <file> --on <agent> --dest <path>\` | Upload file to remote agent |
| \`coord pull <path> --from <agent> --dest <local>\` | Download file from remote agent |
| \`coord transfer <path> --from <a> --to <b> --dest <path>\` | Agent-to-agent file transfer |

## Connecting as an Agent

\`\`\`
coord agent --url wss://<coordinator-host>:8080 --token <token> --name <name>
\`\`\`

Options: \`--dangerously-skip-permissions\`, \`--max-concurrent <n>\`,
\`--isolation <none|worktree|tmpdir>\`, \`--allowed-tools <tools>\`

## MCP Integration

\`coord mcp\` starts an MCP server (stdio) with tools: \`dispatch_task\`,
\`list_agents\`, \`list_tasks\`, \`get_task_result\`, \`push_files\`, \`pull_files\`,
\`send_agent_message\`.
`;
}

export const claudeMdCommand = new Command('claude-md')
  .description('Output a CLAUDE.md file describing clawd-coordinator for Claude Code discovery')
  .option('--install', 'Write CLAUDE.md to the current directory')
  .action((options: { install?: boolean }) => {
    const content = generateClaudeMd();
    if (options.install) {
      writeFileSync('CLAUDE.md', content);
      console.log('CLAUDE.md written to current directory');
    } else {
      console.log(content);
    }
  });
