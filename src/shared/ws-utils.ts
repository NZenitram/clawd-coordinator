import WebSocket from 'ws';

const DEFAULT_HIGH_WATER_MARK = 1024 * 1024; // 1MB

/**
 * safeSend — sends a message on a WebSocket only when the socket is open and
 * the buffered outbound data is below the high-water mark.
 *
 * Returns true when the message was accepted for sending, false when it was
 * dropped (socket not open or buffer full).
 *
 * Use this for high-volume streaming messages (task:output) where a slow
 * consumer should be back-pressured rather than crashing the process with an
 * unbounded send queue.  Control messages (task:complete, task:error) should
 * continue to use ws.send() directly so they are never silently dropped.
 */
export function safeSend(
  ws: WebSocket,
  data: string,
  highWaterMark = DEFAULT_HIGH_WATER_MARK,
): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount >= highWaterMark) return false;
  ws.send(data);
  return true;
}
