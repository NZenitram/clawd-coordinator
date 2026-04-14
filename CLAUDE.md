# Clawd Coordinator

CLI tool for orchestrating remote Claude Code sessions across machines via WebSocket.

## Stack

- TypeScript, Node.js (ESM)
- `ws` for WebSocket client/server
- `commander` for CLI
- `vitest` for testing

## Conventions

- ESM modules (`"type": "module"` in package.json)
- Strict TypeScript
- Single quotes, 2-space indent
- Tests in `tests/` mirroring `src/` structure
- Run `npm test` before committing
- Run `npm run lint` to type-check without emitting

## Architecture

Three modes via subcommand:
- `coord serve` — WebSocket coordinator server
- `coord agent` — remote agent daemon
- `coord run` / `coord fan-out` — task dispatch CLI

Remote agents execute `claude -p --output-format stream-json` as child processes.
