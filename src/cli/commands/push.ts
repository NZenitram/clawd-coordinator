import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';
import { parseMessage, serializeMessage, createFileChunk, createFileTransferStart, createFileTransferComplete, type FileChunkAckPayload } from '../../protocol/messages.js';
import WebSocket from 'ws';
import * as tar from 'tar';
import type { TarOptionsWithAliasesAsyncNoFile } from 'tar';

const CHUNK_SIZE = 512 * 1024;

async function statPath(src: string): Promise<{ size: number; isDirectory: boolean }> {
  const stat = fs.statSync(src);
  return { size: stat.size, isDirectory: stat.isDirectory() };
}

function waitForAck(ws: WebSocket, transferId: string, chunkIndex: number): Promise<void> {
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
        const errPayload = msg.payload as { transferId: string; error: string };
        if (errPayload.transferId === transferId) {
          ws.removeListener('message', listener);
          reject(new Error(errPayload.error));
        }
      }
    };
    ws.on('message', listener);
  });
}

async function pushFile(
  ws: WebSocket,
  transferId: string,
  sourcePath: string,
  destPath: string,
  agentName: string,
  exclude: string[],
): Promise<void> {
  const { size, isDirectory } = await statPath(sourcePath);
  const filename = path.basename(sourcePath);

  if (isDirectory) {
    // Build exclude filter from patterns
    const excludePatterns = exclude.slice();
    const filterFn: TarOptionsWithAliasesAsyncNoFile['filter'] = excludePatterns.length > 0
      ? (entryPath: string) => !excludePatterns.some((p) => {
          const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          return new RegExp(`(^|/)${escaped}($|/)`).test(entryPath);
        })
      : undefined;

    const createOpts: TarOptionsWithAliasesAsyncNoFile = { cwd: sourcePath, gzip: false, filter: filterFn };
    const tarStream = tar.create(createOpts, ['.']);

    // Send transfer-start (size=0 since we don't know tar output size)
    ws.send(serializeMessage(createFileTransferStart({
      transferId,
      direction: 'push',
      filename,
      sourcePath,
      destPath,
      totalBytes: 0,
      totalChunks: 0,
      isDirectory: true,
      destAgent: agentName,
    })));

    // Wait for initial ack (chunkIndex -1) from agent via coordinator
    await waitForAck(ws, transferId, -1);

    let buffer = Buffer.alloc(0);
    let chunkIndex = 0;

    await new Promise<void>((resolve, reject) => {
      tarStream.on('data', async (chunk: Buffer) => {
        tarStream.pause();
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= CHUNK_SIZE) {
          const slice = buffer.subarray(0, CHUNK_SIZE);
          buffer = buffer.subarray(CHUNK_SIZE);
          const data = slice.toString('base64');
          const idx = chunkIndex++;
          ws.send(serializeMessage(createFileChunk({ transferId, chunkIndex: idx, data })));
          process.stderr.write(`\rPushing... chunk ${idx + 1}`);
          await waitForAck(ws, transferId, idx);
        }

        tarStream.resume();
      });

      tarStream.on('end', async () => {
        if (buffer.length > 0) {
          const data = buffer.toString('base64');
          const idx = chunkIndex++;
          ws.send(serializeMessage(createFileChunk({ transferId, chunkIndex: idx, data })));
          await waitForAck(ws, transferId, idx);
        }
        ws.send(serializeMessage(createFileTransferComplete({ transferId })));
        resolve();
      });

      tarStream.on('error', reject);
    });
  } else {
    const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));

    ws.send(serializeMessage(createFileTransferStart({
      transferId,
      direction: 'push',
      filename,
      sourcePath,
      destPath,
      totalBytes: size,
      totalChunks,
      isDirectory: false,
      destAgent: agentName,
    })));

    // Wait for initial ack from agent
    await waitForAck(ws, transferId, -1);

    const fileStream = fs.createReadStream(sourcePath, { highWaterMark: CHUNK_SIZE });
    let chunkIndex = 0;

    for await (const chunk of fileStream) {
      const data = (chunk as Buffer).toString('base64');
      const idx = chunkIndex++;
      ws.send(serializeMessage(createFileChunk({ transferId, chunkIndex: idx, data })));
      const pct = Math.round((idx + 1) / totalChunks * 100);
      process.stderr.write(`\r[${'>'.repeat(Math.floor(pct / 5)).padEnd(20, ' ')}] ${pct}% (chunk ${idx + 1}/${totalChunks})`);
      await waitForAck(ws, transferId, idx);
    }

    process.stderr.write('\n');
    ws.send(serializeMessage(createFileTransferComplete({ transferId })));
  }
}

export const pushCommand = new Command('push')
  .description('Push a local file or directory to a remote agent')
  .argument('<source>', 'Local file or directory path')
  .requiredOption('--on <agent>', 'Target agent name')
  .requiredOption('--dest <path>', 'Destination path on the agent')
  .option('--exclude <patterns>', 'Comma-separated exclude globs (for directories)')
  .option('--url <url>', 'Coordinator URL')
  .action(async (
    source: string,
    options: { on: string; dest: string; exclude?: string; url?: string },
  ) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
    const exclude = options.exclude ? options.exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
    const sourcePath = path.resolve(source);
    const { size, isDirectory } = await statPath(sourcePath);
    const filename = path.basename(sourcePath);
    const transferId = randomUUID();

    const ws = await connectCli(url, config.token);

    // Register transfer with coordinator
    const response = await sendRequest(ws, 'push-file', {
      agentName: options.on,
      destPath: options.dest,
      filename,
      totalBytes: size,
      isDirectory,
      totalChunks: Math.max(1, Math.ceil(size / CHUNK_SIZE)),
      transferId,
    });

    const payload = response.payload as { data: unknown; error?: string };
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      ws.close();
      process.exit(1);
    }

    console.log(`Transfer ${transferId} registered — streaming...`);

    try {
      await pushFile(ws, transferId, sourcePath, options.dest, options.on, exclude);
      console.log(`\nPush complete.`);
    } catch (err) {
      console.error(`\nPush failed: ${err instanceof Error ? err.message : String(err)}`);
      ws.close();
      process.exit(1);
    }

    ws.close();
  });
