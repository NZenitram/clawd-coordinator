import WebSocket from 'ws';
import {
  serializeMessage,
  parseMessage,
  createCliRequest,
  type AnyMessage,
} from '../protocol/messages.js';

export function connectCli(coordinatorUrl: string, token: string, timeoutMs = 10000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${coordinatorUrl}/cli`, { headers: { 'authorization': `Bearer ${token}` } });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

export function sendRequest(
  ws: WebSocket,
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = 30000
): Promise<AnyMessage> {
  return new Promise((resolve, reject) => {
    const msg = createCliRequest({ command, args });
    const requestId = msg.id;

    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Request '${command}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      const parsed = parseMessage(raw.toString());
      if (parsed && parsed.type === 'cli:response' && parsed.payload.requestId === requestId) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(parsed);
      }
    };

    ws.on('message', handler);
    ws.send(serializeMessage(msg));
  });
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), 0);
    return Math.max(h.length, maxRow);
  });

  const header = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '-'.repeat(w)).join('  ');
  const body = rows.map(row =>
    row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ')
  ).join('\n');

  return `${header}\n${separator}\n${body}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
