import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';
import { parseMessage, serializeMessage, createFileChunkAck, type FileTransferStartPayload, type FileChunkPayload, type FileTransferCompletePayload } from '../../protocol/messages.js';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';

async function pullFile(
  ws: WebSocket,
  transferId: string,
  destPath: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let metadata: FileTransferStartPayload | null = null;
    let tarProcess: ReturnType<typeof spawn> | null = null;
    let fileStream: fs.WriteStream | null = null;
    let chunksReceived = 0;

    function cleanup(err?: Error): void {
      tarProcess?.kill();
      fileStream?.destroy();
      if (err) reject(err);
      else resolve();
    }

    ws.on('message', async (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;

      if (msg.type === 'file:transfer-start') {
        const p = msg.payload as FileTransferStartPayload;
        if (p.transferId !== transferId) return;
        metadata = p;

        if (p.isDirectory) {
          fs.mkdirSync(destPath, { recursive: true });
          tarProcess = spawn('tar', ['-x', '-C', destPath]);
          tarProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
          tarProcess.on('close', (code) => {
            if (code !== 0) cleanup(new Error(`tar -x exited with code ${code}`));
          });
        } else {
          const parentDir = path.dirname(destPath);
          fs.mkdirSync(parentDir, { recursive: true });
          fileStream = fs.createWriteStream(destPath);
          fileStream.on('error', cleanup);
        }

        // Ack to unblock agent (-1 signals ready)
        ws.send(serializeMessage(createFileChunkAck({ transferId, chunkIndex: -1 })));

      } else if (msg.type === 'file:chunk') {
        const chunk = msg.payload as FileChunkPayload;
        if (chunk.transferId !== transferId) return;
        const raw2 = Buffer.from(chunk.data, 'base64');

        if (tarProcess) {
          tarProcess.stdin?.write(raw2);
        } else if (fileStream) {
          fileStream.write(raw2);
        }

        chunksReceived++;
        const total = metadata?.totalChunks ?? 0;
        if (total > 0) {
          const pct = Math.round(chunksReceived / total * 100);
          process.stderr.write(`\r[${'>'.repeat(Math.floor(pct / 5)).padEnd(20, ' ')}] ${pct}%`);
        } else {
          process.stderr.write(`\rChunk ${chunksReceived} received`);
        }

        ws.send(serializeMessage(createFileChunkAck({ transferId, chunkIndex: chunk.chunkIndex })));

      } else if (msg.type === 'file:transfer-complete') {
        const complete = msg.payload as FileTransferCompletePayload;
        if (complete.transferId !== transferId) return;
        process.stderr.write('\n');

        if (tarProcess) {
          tarProcess.stdin?.end(() => {
            tarProcess!.on('close', (code) => {
              if (code === 0) resolve();
              else cleanup(new Error(`tar -x exited with code ${code}`));
            });
          });
        } else if (fileStream) {
          fileStream.end(() => resolve());
        } else {
          resolve();
        }

      } else if (msg.type === 'file:transfer-error') {
        const errPayload = msg.payload as { transferId: string; error: string };
        if (errPayload.transferId !== transferId) return;
        cleanup(new Error(errPayload.error));
      }
    });
  });
}

export const pullCommand = new Command('pull')
  .description('Pull a remote file or directory from an agent to local')
  .argument('<source>', 'Remote file or directory path')
  .requiredOption('--from <agent>', 'Source agent name')
  .requiredOption('--dest <path>', 'Local destination path')
  .option('--exclude <patterns>', 'Comma-separated exclude globs (for directories)')
  .option('--url <url>', 'Coordinator URL')
  .action(async (
    source: string,
    options: { from: string; dest: string; exclude?: string; url?: string },
  ) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
    const exclude = options.exclude ? options.exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
    const transferId = randomUUID();
    const destPath = path.resolve(options.dest);

    const ws = await connectCli(url, config.token);

    const response = await sendRequest(ws, 'pull-file', {
      agentName: options.from,
      sourcePath: source,
      transferId,
      exclude,
    });

    const payload = response.payload as { data: unknown; error?: string };
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      ws.close();
      process.exit(1);
    }

    console.log(`Transfer ${transferId} initiated — receiving...`);

    try {
      await pullFile(ws, transferId, destPath);
      console.log(`\nPull complete. Saved to ${destPath}`);
    } catch (err) {
      console.error(`\nPull failed: ${err instanceof Error ? err.message : String(err)}`);
      ws.close();
      process.exit(1);
    }

    ws.close();
  });
