# File Transfer Design Spec

**Goal:** Bidirectional file and directory transfer between the coordinator, CLI clients, and remote agents over the existing WebSocket transport. Supports local-to-agent, agent-to-local, and agent-to-agent transfers.

**Architecture:** Chunked transfer over WebSocket using the existing relay model. Files are split into 512KB chunks, base64-encoded, and sent as protocol messages. Directories are tar-streamed. Chunk acknowledgments provide flow control. No external dependencies (no S3, no direct peer connections).

**Tech Stack:** TypeScript/Node.js ESM, existing ws transport, node:child_process (tar), node:fs streaming

---

## Protocol Messages

Five new message types added to `src/protocol/messages.ts`:

### file:transfer-start

Initiates a transfer. Sent by the originator (CLI for push, agent for pull response).

```typescript
interface FileTransferStartPayload {
  transferId: string;        // UUID
  direction: 'push' | 'pull';
  filename: string;          // file or directory name
  sourcePath: string;        // absolute path on source machine
  destPath: string;          // absolute path on destination
  totalBytes: number;        // total size in bytes
  totalChunks: number;       // expected chunk count
  isDirectory: boolean;      // if true, data is a tar stream
  sourceAgent?: string;      // agent name (for agent-to-agent)
  destAgent?: string;        // agent name
}
```

### file:chunk

A single data chunk. Sent sequentially, one at a time (wait for ack before next).

```typescript
interface FileChunkPayload {
  transferId: string;
  chunkIndex: number;
  data: string;              // base64-encoded binary data
}
```

### file:chunk-ack

Receiver acknowledges a chunk. Provides backpressure.

```typescript
interface FileChunkAckPayload {
  transferId: string;
  chunkIndex: number;
}
```

### file:transfer-complete

Sender signals all chunks have been sent.

```typescript
interface FileTransferCompletePayload {
  transferId: string;
  checksum?: string;         // optional SHA-256 of full content for verification
}
```

### file:transfer-error

Either side can abort the transfer.

```typescript
interface FileTransferErrorPayload {
  transferId: string;
  error: string;
}
```

---

## Transfer Flow

### Push (CLI to Agent)

```
CLI                       Coordinator                Agent
 ── cli:request ──────────>
    (push-file, agentName,
     destPath, metadata)
 <── cli:response ────────
    (transferId, ready)
 ── file:transfer-start ──>  ── relay ──────────────>
 <── file:chunk-ack ──────  <── relay ───────────────
 ── file:chunk 0 ─────────>  ── relay ──────────────>
 <── file:chunk-ack 0 ────  <── relay ───────────────
 ── file:chunk 1 ─────────>  ── relay ──────────────>
 <── file:chunk-ack 1 ────  <── relay ───────────────
 ...
 ── file:transfer-complete >  ── relay ──────────────>
 <── file:chunk-ack (done)   <── relay ───────────────
```

### Pull (Agent to CLI)

```
CLI                       Coordinator                Agent
 ── cli:request ──────────>
    (pull-file, agentName,
     sourcePath)
                            ── file:pull-request ───>
                            <── file:transfer-start ─
 <── file:transfer-start ──
 ── file:chunk-ack (ready) >  ── relay ──────────────>
                            <── file:chunk 0 ────────
 <── file:chunk 0 ─────────
 ── file:chunk-ack 0 ──────>  ── relay ──────────────>
 ...
                            <── file:transfer-complete
 <── file:transfer-complete
```

### Agent-to-Agent Transfer

```
CLI                       Coordinator            Agent A (source)    Agent B (dest)
 ── cli:request ──────────>
    (transfer-file,
     fromAgent, toAgent,
     sourcePath, destPath)
                            ── pull-request ────>
                            <── transfer-start ──
                            ── transfer-start ──────────────────────>
                            <── chunk-ack (ready) ──────────────────
                            ── chunk-ack ───────>
                            <── chunk 0 ─────────
                            ── chunk 0 ─────────────────────────────>
                            <── chunk-ack 0 ────────────────────────
                            ── chunk-ack 0 ─────>
                            ...
                            <── transfer-complete
                            ── transfer-complete ───────────────────>
 <── cli:response ────────
    (transfer complete)
```

The coordinator acts as a relay. It does not store file data — chunks pass through without buffering.

---

## Chunking Strategy

- **Chunk size:** 512KB raw binary (682KB base64-encoded, well under 1MB maxPayload)
- **Encoding:** base64 string in JSON payload (simple, universal, ~33% overhead)
- **Flow control:** One chunk in flight at a time. Sender waits for `file:chunk-ack` before sending next chunk. This prevents overwhelming slow receivers or the coordinator's WebSocket buffers.
- **Ordering:** Chunks are numbered sequentially (chunkIndex 0, 1, 2...). Receiver validates order.

### Performance Estimates

| File Size | Chunks | Time (100 Mbps) | Time (10 Mbps) |
|-----------|--------|------------------|-----------------|
| 1MB | 2 | <1s | <1s |
| 50MB | 100 | ~5s | ~50s |
| 500MB | 1000 | ~50s | ~8min |
| 1GB | 2000 | ~2min | ~16min |

Base64 overhead adds ~33% to transfer time. Acceptable for the simplicity it provides. A future optimization could use binary WebSocket frames.

---

## Directory Handling

Directories are tar-streamed:

**Sender side:**
```typescript
const tar = spawn('tar', ['-c', ...excludeFlags, '-C', baseDir, '.']);
// Read tar.stdout in 512KB chunks, send as file:chunk messages
```

**Receiver side:**
```typescript
const tar = spawn('tar', ['-x', '-C', destDir]);
// Write each received chunk to tar.stdin
```

**Exclude patterns:** Passed via `--exclude` flags on the CLI command. Applied to `tar -c --exclude=<pattern>`. Examples:
```bash
coord push ./project --on agent-1 --dest /home/user/project \
  --exclude "node_modules,dist,.git,*.log"
```

Each comma-separated pattern becomes a `--exclude` argument to tar.

---

## CLI Commands

### coord push

Push a local file or directory to a remote agent.

```
coord push <source> --on <agent> --dest <path> [--exclude <patterns>] [--url <url>]
```

| Argument/Flag | Required | Description |
|---------------|----------|-------------|
| `<source>` | Yes | Local file or directory path |
| `--on <agent>` | Yes | Target agent name |
| `--dest <path>` | Yes | Destination path on the agent |
| `--exclude <patterns>` | No | Comma-separated exclude globs |
| `--url <url>` | No | Coordinator URL |

### coord pull

Pull a remote file or directory from an agent to local.

```
coord pull <source> --from <agent> --dest <path> [--exclude <patterns>] [--url <url>]
```

| Argument/Flag | Required | Description |
|---------------|----------|-------------|
| `<source>` | Yes | Remote file or directory path |
| `--from <agent>` | Yes | Source agent name |
| `--dest <path>` | Yes | Local destination path |
| `--exclude <patterns>` | No | Comma-separated exclude globs |
| `--url <url>` | No | Coordinator URL |

### coord transfer

Transfer files between two agents.

```
coord transfer <source> --from <agent> --to <agent> --dest <path> [--exclude <patterns>] [--url <url>]
```

| Argument/Flag | Required | Description |
|---------------|----------|-------------|
| `<source>` | Yes | Source path on the source agent |
| `--from <agent>` | Yes | Source agent name |
| `--to <agent>` | Yes | Destination agent name |
| `--dest <path>` | Yes | Destination path on the target agent |
| `--exclude <patterns>` | No | Comma-separated exclude globs |
| `--url <url>` | No | Coordinator URL |

### Task-Attached Transfers (on coord run / coord fan-out)

```
coord run "run tests" --on agent-1 \
  --upload ./project:/home/user/project \
  --download /home/user/report.html:./report.html
```

| Flag | Description |
|------|-------------|
| `--upload <local>:<remote>` | Push local path to agent before task starts |
| `--download <remote>:<local>` | Pull remote path from agent after task completes |

Both accept `--exclude` for the transfer. Multiple `--upload` and `--download` flags can be specified.

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/push` | Initiate a push transfer. Body: `{ agentName, destPath, filename, totalBytes, isDirectory }`. Returns `{ transferId }`. Client then streams chunks over WebSocket. |
| `POST` | `/api/pull` | Initiate a pull transfer. Body: `{ agentName, sourcePath }`. Returns `{ transferId }`. Agent streams chunks back over WebSocket. |
| `GET` | `/api/transfers` | List active transfers with progress (transferId, direction, filename, progress%, bytesTransferred, totalBytes). |

## MCP Tools

| Tool | Description |
|------|-------------|
| `push_files` | Push files to an agent. Params: `agentName, sourcePath, destPath, exclude?` |
| `pull_files` | Pull files from an agent. Params: `agentName, sourcePath, destPath, exclude?` |

---

## Agent-Side File Handler

New file: `src/agent/file-handler.ts`

### Sending (for pull / transfer source)

```typescript
export class FileSender {
  async send(
    ws: WebSocket,
    transferId: string,
    sourcePath: string,
    options: { exclude?: string[]; chunkSize?: number }
  ): Promise<void>;
}
```

1. Stat the path — determine file vs directory, get total size
2. If directory: spawn `tar -c --exclude=... -C <dir> .` and stream stdout
3. If file: create read stream
4. Read in 512KB chunks, base64-encode, send as `file:chunk`
5. Wait for `file:chunk-ack` after each chunk (backpressure)
6. Send `file:transfer-complete` with optional SHA-256 checksum

### Receiving (for push / transfer destination)

```typescript
export class FileReceiver {
  async receive(
    transferId: string,
    destPath: string,
    metadata: FileTransferStartPayload
  ): Promise<void>;
}
```

1. Validate destPath is within allowed directories (see Security)
2. If directory (tar stream): spawn `tar -x -C <destPath>` and pipe chunks to stdin
3. If file: create write stream at destPath
4. On each `file:chunk`: decode base64, write, send `file:chunk-ack`
5. On `file:transfer-complete`: close stream, optionally verify checksum

---

## Security

### Path Validation

The daemon must reject transfers where source or destination resolves outside the agent's allowed directories (`--cwd` + `--add-dirs`).

```typescript
function isPathAllowed(targetPath: string, cwd: string, addDirs: string[]): boolean {
  const resolved = path.resolve(targetPath);
  const allowed = [cwd, ...addDirs];
  return allowed.some(dir => resolved.startsWith(path.resolve(dir)));
}
```

Applied on:
- **Receive (push destination):** before accepting any chunks
- **Send (pull source):** before reading any data
- **Both sides of agent-to-agent transfers**

### Transfer Size Limits

- Default max transfer size: 2GB (configurable via `--max-transfer-size` on daemon)
- Coordinator rejects `file:transfer-start` if `totalBytes` exceeds the agent's configured limit
- Prevents accidental multi-GB transfers that could fill disk

### Auth

Transfers use the same auth as all other operations (shared token or API key). The CLI/MCP client must be authenticated to initiate a transfer. The coordinator validates the requesting client has permission for the target agent (org scoping applies).

---

## Coordinator Transfer Manager

New file: `src/coordinator/transfer.ts`

```typescript
export class TransferManager {
  private activeTransfers = new Map<string, TransferState>();

  startTransfer(metadata: FileTransferStartPayload): void;
  handleChunk(transferId: string, chunk: FileChunkPayload): void;
  handleAck(transferId: string, ack: FileChunkAckPayload): void;
  completeTransfer(transferId: string): void;
  errorTransfer(transferId: string, error: string): void;
  getActiveTransfers(): TransferInfo[];
}
```

The TransferManager:
- Tracks active transfers for progress reporting (`GET /api/transfers`)
- Does NOT buffer chunks — relays immediately to the destination socket
- Cleans up transfer state on completion, error, or timeout (60s inactivity)
- Limits concurrent transfers per agent (default: 2)

---

## Progress Reporting

- CLI shows a progress bar during transfers: `[=====>    ] 45% 23MB/50MB 12MB/s`
- `GET /api/transfers` returns active transfer list with progress
- TUI dashboard shows active transfers in the stats panel
- Metrics: `transfers_total`, `transfer_bytes_total` counters

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/coordinator/transfer.ts` | TransferManager — tracks and relays transfers |
| `src/agent/file-handler.ts` | FileSender + FileReceiver — tar/untar, chunked I/O, path validation |
| `src/cli/commands/push.ts` | `coord push` command |
| `src/cli/commands/pull.ts` | `coord pull` command |
| `src/cli/commands/transfer.ts` | `coord transfer` command |
| `tests/coordinator/transfer.test.ts` | TransferManager unit tests |
| `tests/agent/file-handler.test.ts` | FileSender/FileReceiver unit tests |
| `tests/integration/file-transfer.test.ts` | End-to-end push/pull/transfer tests |

## Files to Modify

| File | Changes |
|------|---------|
| `src/protocol/messages.ts` | 5 new message types + payloads + factories |
| `src/coordinator/server.ts` | Relay logic for file messages, 3 CLI request handlers, TransferManager integration |
| `src/agent/daemon.ts` | File send/receive handlers, path validation |
| `src/cli/commands/run.ts` | `--upload` / `--download` flags |
| `src/cli/commands/fan-out.ts` | Same flags |
| `src/cli/index.ts` | Register push/pull/transfer commands |
| `src/coordinator/rest.ts` | `POST /api/push`, `POST /api/pull`, `GET /api/transfers` |
| `src/mcp/server.ts` | `push_files`, `pull_files` tools |

---

## Effort Estimate

| Component | Hours |
|-----------|-------|
| Protocol messages + types | 1 |
| TransferManager (coordinator) | 3 |
| FileSender + FileReceiver (agent) | 4 |
| CLI commands (push/pull/transfer) | 3 |
| Task-attached upload/download on run/fan-out | 2 |
| REST endpoints | 1 |
| MCP tools | 1 |
| Tests (unit + integration) | 4 |
| **Total** | **~19 hours** |
