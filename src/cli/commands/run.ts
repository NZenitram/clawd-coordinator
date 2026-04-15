import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';
import { parseMessage, serializeMessage, createFileChunk, createFileTransferStart, createFileTransferComplete, createFileChunkAck, type FileTransferStartPayload, type FileChunkPayload, type FileTransferCompletePayload, type FileChunkAckPayload } from '../../protocol/messages.js';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { loadTemplate, substituteVariables, parseVars, validateVariables, resolveVariables } from '../../shared/templates.js';

const CHUNK_SIZE = 512 * 1024;

function waitForFileAck(ws: WebSocket, transferId: string, chunkIndex: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (raw: Buffer | string) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;
      if (msg.type === 'file:chunk-ack') {
        const ack = msg.payload as FileChunkAckPayload;
        if (ack.transferId === transferId && ack.chunkIndex === chunkIndex) {
          ws.removeListener('message', listener);
          resolve();
        }
      } else if (msg.type === 'file:transfer-error') {
        const e = msg.payload as { transferId: string; error: string };
        if (e.transferId === transferId) { ws.removeListener('message', listener); reject(new Error(e.error)); }
      }
    };
    ws.on('message', listener);
  });
}

async function executePush(ws: WebSocket, agentName: string, localPath: string, remotePath: string): Promise<void> {
  const sourcePath = path.resolve(localPath);
  const stat = fs.statSync(sourcePath);
  const isDirectory = stat.isDirectory();
  const filename = path.basename(sourcePath);
  const totalBytes = isDirectory ? 0 : stat.size;
  const totalChunks = isDirectory ? 0 : Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE));
  const transferId = randomUUID();

  const response = await sendRequest(ws, 'push-file', {
    agentName,
    destPath: remotePath,
    filename,
    totalBytes,
    isDirectory,
    totalChunks,
    transferId,
  });
  const resp = response.payload as { data: unknown; error?: string };
  if (resp.error) throw new Error(resp.error);

  ws.send(serializeMessage(createFileTransferStart({
    transferId,
    direction: 'push',
    filename,
    sourcePath,
    destPath: remotePath,
    totalBytes,
    totalChunks,
    isDirectory,
    destAgent: agentName,
  })));

  // Wait for initial ack
  await waitForFileAck(ws, transferId, -1);

  if (isDirectory) {
    const tar = spawn('tar', ['-c', '-C', sourcePath, '.']);
    let buffer = Buffer.alloc(0);
    let chunkIndex = 0;
    await new Promise<void>((resolve, reject) => {
      tar.stdout.on('data', async (chunk: Buffer) => {
        tar.stdout.pause();
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= CHUNK_SIZE) {
          const slice = buffer.subarray(0, CHUNK_SIZE);
          buffer = buffer.subarray(CHUNK_SIZE);
          const idx = chunkIndex++;
          ws.send(serializeMessage(createFileChunk({ transferId, chunkIndex: idx, data: slice.toString('base64') })));
          await waitForFileAck(ws, transferId, idx);
        }
        tar.stdout.resume();
      });
      tar.stdout.on('end', async () => {
        if (buffer.length > 0) {
          const idx = chunkIndex++;
          ws.send(serializeMessage(createFileChunk({ transferId, chunkIndex: idx, data: buffer.toString('base64') })));
          await waitForFileAck(ws, transferId, idx);
        }
        ws.send(serializeMessage(createFileTransferComplete({ transferId })));
        resolve();
      });
      tar.on('error', reject);
    });
  } else {
    const fileStream = fs.createReadStream(sourcePath, { highWaterMark: CHUNK_SIZE });
    let chunkIndex = 0;
    for await (const chunk of fileStream) {
      const idx = chunkIndex++;
      ws.send(serializeMessage(createFileChunk({ transferId, chunkIndex: idx, data: (chunk as Buffer).toString('base64') })));
      await waitForFileAck(ws, transferId, idx);
    }
    ws.send(serializeMessage(createFileTransferComplete({ transferId })));
  }
  console.log(`Upload complete: ${localPath} -> ${agentName}:${remotePath}`);
}

async function executePull(ws: WebSocket, agentName: string, remotePath: string, localPath: string): Promise<void> {
  const transferId = randomUUID();
  const destPath = path.resolve(localPath);

  const response = await sendRequest(ws, 'pull-file', { agentName, sourcePath: remotePath, transferId });
  const resp = response.payload as { data: unknown; error?: string };
  if (resp.error) throw new Error(resp.error);

  await new Promise<void>((resolve, reject) => {
    let tarProcess: ReturnType<typeof spawn> | null = null;
    let fileStream: fs.WriteStream | null = null;

    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;
      if (msg.type === 'file:transfer-start') {
        const p = msg.payload as FileTransferStartPayload;
        if (p.transferId !== transferId) return;
        if (p.isDirectory) {
          fs.mkdirSync(destPath, { recursive: true });
          tarProcess = spawn('tar', ['-x', '-C', destPath]);
          tarProcess.on('close', (code) => { if (code !== 0) reject(new Error(`tar -x exited ${code}`)); });
        } else {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fileStream = fs.createWriteStream(destPath);
        }
        ws.send(serializeMessage(createFileChunkAck({ transferId, chunkIndex: -1 })));
      } else if (msg.type === 'file:chunk') {
        const chunk = msg.payload as FileChunkPayload;
        if (chunk.transferId !== transferId) return;
        const data = Buffer.from(chunk.data, 'base64');
        if (tarProcess) tarProcess.stdin?.write(data);
        else if (fileStream) fileStream.write(data);
        ws.send(serializeMessage(createFileChunkAck({ transferId, chunkIndex: chunk.chunkIndex })));
      } else if (msg.type === 'file:transfer-complete') {
        const p = msg.payload as FileTransferCompletePayload;
        if (p.transferId !== transferId) return;
        if (tarProcess) tarProcess.stdin?.end(() => resolve());
        else if (fileStream) fileStream.end(() => resolve());
        else resolve();
      } else if (msg.type === 'file:transfer-error') {
        const p = msg.payload as { transferId: string; error: string };
        if (p.transferId === transferId) reject(new Error(p.error));
      }
    });
  });
  console.log(`Download complete: ${agentName}:${remotePath} -> ${destPath}`);
}

function parseTransferSpec(spec: string): { local: string; remote: string } {
  const colonIdx = spec.lastIndexOf(':');
  if (colonIdx === -1) throw new Error(`Invalid transfer spec "${spec}": expected <local>:<remote>`);
  return { local: spec.slice(0, colonIdx), remote: spec.slice(colonIdx + 1) };
}

export const runCommand = new Command('run')
  .description('Dispatch a prompt to a remote agent')
  .argument('[prompt]', 'The prompt to send (optional when --template is used)')
  .option('--on <agent>', 'Target agent name')
  .option('--pool <name>', 'Target agent pool (least-loaded agent selected automatically)')
  .option('--bg', 'Run in background and return task ID')
  .option('--url <url>', 'Coordinator URL')
  .option('--session <id>', 'Resume a specific Claude Code session')
  .option('--budget <usd>', 'Maximum budget in USD for this task')
  .option('--allowed-tools <tools>', 'Comma-separated tools to allow for this task')
  .option('--disallowed-tools <tools>', 'Comma-separated tools to deny for this task')
  .option('--add-dirs <dirs>', 'Comma-separated additional directories for this task')
  .option('--upload <spec>', 'Upload <local>:<remote> before task dispatch (repeatable)', (v, a: string[]) => { a.push(v); return a; }, [] as string[])
  .option('--download <spec>', 'Download <remote>:<local> after task completes (repeatable)', (v, a: string[]) => { a.push(v); return a; }, [] as string[])
  .option('--template <name>', 'Load a saved task template')
  .option('--vars <key=value,...>', 'Variable substitutions for the template (comma-separated key=value pairs)')
  .action(async (promptArg: string | undefined, options: { on?: string; pool?: string; bg?: boolean; url?: string; session?: string; budget?: string; allowedTools?: string; disallowedTools?: string; addDirs?: string; upload: string[]; download: string[]; template?: string; vars?: string }) => {
    // Resolve template if provided
    let resolvedPrompt = promptArg;
    let templateOn: string | undefined;
    let templateBudget: string | undefined;
    let templateUpload: string[] = [];
    let templateDownload: string[] = [];

    if (options.template) {
      const tmpl = loadTemplate(options.template);
      if (!tmpl) {
        console.error(`Template "${options.template}" not found.`);
        process.exit(1);
      }
      const userVars = options.vars ? parseVars(options.vars) : {};
      const missing = validateVariables(tmpl, userVars);
      if (missing.length > 0) {
        console.error(`Missing required template variables: ${missing.join(', ')}`);
        process.exit(1);
      }
      const resolved = resolveVariables(tmpl, userVars);

      // Apply template values; CLI flags take precedence
      if (!resolvedPrompt) resolvedPrompt = substituteVariables(tmpl.prompt, resolved);
      templateOn = tmpl.on ? substituteVariables(tmpl.on, resolved) : undefined;
      templateBudget = tmpl.budget;
      templateUpload = (tmpl.upload ?? []).map((s) => substituteVariables(s, resolved));
      templateDownload = (tmpl.download ?? []).map((s) => substituteVariables(s, resolved));
    }

    if (!resolvedPrompt) {
      console.error('Error: prompt is required (pass as argument or via --template)');
      process.exit(1);
    }

    const agentName = options.on ?? templateOn;

    // Validate: exactly one of --on or --pool must be provided
    if (agentName && options.pool) {
      console.error('Error: --on and --pool are mutually exclusive');
      process.exit(1);
    }
    if (!agentName && !options.pool) {
      console.error('Error: one of --on <agent> or --pool <name> is required');
      process.exit(1);
    }

    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;

    const allowedTools = options.allowedTools ? options.allowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const disallowedTools = options.disallowedTools ? options.disallowedTools.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const addDirs = options.addDirs ? options.addDirs.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const budget = options.budget ?? templateBudget;

    // Merge upload/download: CLI flags win, otherwise use template values
    const uploads = options.upload.length > 0 ? options.upload : templateUpload;
    const downloads = options.download.length > 0 ? options.download : templateDownload;

    const ws = await connectCli(url, config.token);

    // Execute uploads before dispatch (only when targeting a named agent directly)
    if (agentName) {
      for (const spec of uploads) {
        const { local, remote } = parseTransferSpec(spec);
        await executePush(ws, agentName, local, remote);
      }
    }

    const dispatchArgs = options.pool
      ? { pool: options.pool, prompt: resolvedPrompt, sessionId: options.session, maxBudgetUsd: budget ? parseFloat(budget) : undefined, allowedTools, disallowedTools, addDirs }
      : { agentName, prompt: resolvedPrompt, sessionId: options.session, maxBudgetUsd: budget ? parseFloat(budget) : undefined, allowedTools, disallowedTools, addDirs };

    const response = await sendRequest(ws, 'dispatch-task', dispatchArgs);

    const payload = response.payload as any;
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      ws.close();
      process.exit(1);
    }

    const taskId = payload.data.taskId;
    // When dispatched via pool, server returns the chosen agentName
    const resolvedAgentName: string = payload.data.agentName ?? agentName ?? '';

    if (options.bg) {
      if (options.pool) {
        console.log(`Task dispatched: ${taskId} (agent: ${resolvedAgentName})`);
      } else {
        console.log(`Task dispatched: ${taskId}`);
      }
      ws.close();
      return;
    }

    // Stream output until task completes
    await new Promise<void>((resolve) => {
      ws.on('message', async (raw) => {
        const msg = parseMessage(raw.toString());
        if (!msg) return;

        if (msg.type === 'task:output' && msg.payload.taskId === taskId) {
          process.stdout.write(msg.payload.data + '\n');
        } else if (msg.type === 'task:complete' && msg.payload.taskId === taskId) {
          // Execute downloads after task completes
          for (const spec of downloads) {
            const { local: remote, remote: local } = parseTransferSpec(spec);
            await executePull(ws, resolvedAgentName, remote, local).catch((err) => {
              console.error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          resolve();
        } else if (msg.type === 'task:error' && msg.payload.taskId === taskId) {
          console.error(`\nTask failed: ${msg.payload.error}`);
          ws.close();
          process.exit(1);
        }
      });
    });

    ws.close();
  });
