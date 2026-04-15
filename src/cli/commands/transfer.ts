import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { requireConfig } from '../../shared/config.js';
import { connectCli, sendRequest } from '../output.js';
import { parseMessage, type FileTransferCompletePayload } from '../../protocol/messages.js';
import WebSocket from 'ws';

async function waitForTransferComplete(ws: WebSocket, transferId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = parseMessage(raw.toString());
      if (!msg) return;
      if (msg.type === 'file:transfer-complete') {
        const p = msg.payload as FileTransferCompletePayload;
        if (p.transferId === transferId) resolve();
      } else if (msg.type === 'file:transfer-error') {
        const p = msg.payload as { transferId: string; error: string };
        if (p.transferId === transferId) reject(new Error(p.error));
      }
    });
  });
}

export const transferCommand = new Command('transfer')
  .description('Transfer files between two remote agents')
  .argument('<source>', 'Source path on the source agent')
  .requiredOption('--from <agent>', 'Source agent name')
  .requiredOption('--to <agent>', 'Destination agent name')
  .requiredOption('--dest <path>', 'Destination path on the target agent')
  .option('--exclude <patterns>', 'Comma-separated exclude globs (for directories)')
  .option('--url <url>', 'Coordinator URL')
  .action(async (
    source: string,
    options: { from: string; to: string; dest: string; exclude?: string; url?: string },
  ) => {
    const config = requireConfig();
    const url = options.url ?? config.coordinatorUrl ?? `ws://localhost:${config.port ?? 8080}`;
    const exclude = options.exclude ? options.exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
    const transferId = randomUUID();

    const ws = await connectCli(url, config.token);

    const response = await sendRequest(ws, 'transfer-file', {
      fromAgent: options.from,
      toAgent: options.to,
      sourcePath: source,
      destPath: options.dest,
      transferId,
      exclude,
    });

    const payload = response.payload as { data: unknown; error?: string };
    if (payload.error) {
      console.error(`Error: ${payload.error}`);
      ws.close();
      process.exit(1);
    }

    console.log(`Transfer ${transferId} initiated — waiting for completion...`);

    try {
      await waitForTransferComplete(ws, transferId);
      console.log('Transfer complete.');
    } catch (err) {
      console.error(`Transfer failed: ${err instanceof Error ? err.message : String(err)}`);
      ws.close();
      process.exit(1);
    }

    ws.close();
  });
