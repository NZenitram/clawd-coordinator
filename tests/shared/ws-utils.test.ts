import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { safeSend } from '../../src/shared/ws-utils.js';

function makeWs(overrides: Partial<{ readyState: number; bufferedAmount: number; send: () => void }>): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    ...overrides,
  } as unknown as WebSocket;
}

describe('safeSend', () => {
  it('sends data and returns true when socket is OPEN and buffer is empty', () => {
    const ws = makeWs({});
    const result = safeSend(ws, 'hello');
    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('hello');
  });

  it('returns false and does not send when readyState is CONNECTING', () => {
    const ws = makeWs({ readyState: WebSocket.CONNECTING });
    const result = safeSend(ws, 'hello');
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('returns false and does not send when readyState is CLOSING', () => {
    const ws = makeWs({ readyState: WebSocket.CLOSING });
    const result = safeSend(ws, 'hello');
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('returns false and does not send when readyState is CLOSED', () => {
    const ws = makeWs({ readyState: WebSocket.CLOSED });
    const result = safeSend(ws, 'hello');
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('returns false and does not send when bufferedAmount equals the high-water mark', () => {
    const highWaterMark = 1024 * 1024;
    const ws = makeWs({ bufferedAmount: highWaterMark });
    const result = safeSend(ws, 'hello');
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('returns false and does not send when bufferedAmount exceeds the high-water mark', () => {
    const highWaterMark = 1024 * 1024;
    const ws = makeWs({ bufferedAmount: highWaterMark + 1 });
    const result = safeSend(ws, 'hello');
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends and returns true when bufferedAmount is just below the high-water mark', () => {
    const highWaterMark = 1024 * 1024;
    const ws = makeWs({ bufferedAmount: highWaterMark - 1 });
    const result = safeSend(ws, 'hello');
    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('hello');
  });

  it('respects a custom high-water mark passed as the third argument', () => {
    const customMark = 512;
    const ws = makeWs({ bufferedAmount: 512 });
    const result = safeSend(ws, 'hello', customMark);
    expect(result).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends with custom high-water mark when buffer is below it', () => {
    const customMark = 512;
    const ws = makeWs({ bufferedAmount: 511 });
    const result = safeSend(ws, 'hello', customMark);
    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('hello');
  });
});
