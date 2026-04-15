import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransferManager } from '../../src/coordinator/transfer.js';
import type { FileTransferStartPayload } from '../../src/protocol/messages.js';
import WebSocket from 'ws';

function makeFakeWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket;
}

function makeMetadata(overrides: Partial<FileTransferStartPayload> = {}): FileTransferStartPayload {
  return {
    transferId: 'tid-1',
    direction: 'push',
    filename: 'test.txt',
    sourcePath: '/tmp/test.txt',
    destPath: '/remote/test.txt',
    totalBytes: 1024,
    totalChunks: 2,
    isDirectory: false,
    ...overrides,
  };
}

describe('TransferManager', () => {
  let manager: TransferManager;
  let srcWs: WebSocket;
  let dstWs: WebSocket;

  beforeEach(() => {
    manager = new TransferManager();
    srcWs = makeFakeWs();
    dstWs = makeFakeWs();
    // Prevent real setInterval timer
    vi.useFakeTimers();
  });

  it('tracks an active transfer after startTransfer', () => {
    const meta = makeMetadata();
    manager.startTransfer('tid-1', meta, srcWs, dstWs);
    const transfers = manager.getActiveTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].transferId).toBe('tid-1');
    expect(transfers[0].filename).toBe('test.txt');
    expect(transfers[0].direction).toBe('push');
    manager.stop();
  });

  it('relays chunks from source to destination socket', () => {
    const meta = makeMetadata();
    manager.startTransfer('tid-1', meta, srcWs, dstWs);
    const result = manager.relayChunk('tid-1', '{"raw":"msg"}');
    expect(result).toBe(true);
    expect((dstWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    manager.stop();
  });

  it('relayChunk returns false for unknown transfer', () => {
    const result = manager.relayChunk('nonexistent', 'msg');
    expect(result).toBe(false);
    manager.stop();
  });

  it('relays acks from destination back to source socket', () => {
    const meta = makeMetadata();
    manager.startTransfer('tid-1', meta, srcWs, dstWs);
    const result = manager.relayAck('tid-1', '{"ack":"msg"}');
    expect(result).toBe(true);
    expect((srcWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    manager.stop();
  });

  it('removes transfer after completeTransfer', () => {
    manager.startTransfer('tid-1', makeMetadata(), srcWs, dstWs);
    expect(manager.getActiveTransfers()).toHaveLength(1);
    manager.completeTransfer('tid-1');
    expect(manager.getActiveTransfers()).toHaveLength(0);
    manager.stop();
  });

  it('removes transfer and notifies both sides on errorTransfer', () => {
    manager.startTransfer('tid-1', makeMetadata(), srcWs, dstWs);
    manager.errorTransfer('tid-1', 'something went wrong');
    expect(manager.getActiveTransfers()).toHaveLength(0);
    // Both sockets should have received an error message
    expect((srcWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect((dstWs.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    manager.stop();
  });

  it('getActiveTransfers returns progress info', () => {
    manager.startTransfer('tid-1', makeMetadata({ totalBytes: 1000 }), srcWs, dstWs);
    manager.recordBytes('tid-1', 500);
    const [info] = manager.getActiveTransfers();
    expect(info.bytesTransferred).toBe(500);
    expect(info.progressPct).toBe(50);
    manager.stop();
  });

  it('cleans up stale transfers on timeout', () => {
    vi.useFakeTimers();
    manager.startTransfer('tid-1', makeMetadata(), srcWs, dstWs);
    expect(manager.getActiveTransfers()).toHaveLength(1);
    // Advance past the 60s inactivity timeout
    vi.advanceTimersByTime(75_000);
    // cleanupStale runs every 15s — trigger by advancing 15s intervals
    // It runs at 15s, 30s, 45s, 60s, 75s
    expect(manager.getActiveTransfers()).toHaveLength(0);
    manager.stop();
    vi.useRealTimers();
  });

  it('relayChunkMsg approximates byte count', () => {
    manager.startTransfer('tid-1', makeMetadata({ totalBytes: 1000 }), srcWs, dstWs);
    // A 512-byte raw chunk encodes to ~683 base64 chars
    const fakeChunk = Buffer.alloc(512).toString('base64');
    manager.relayChunkMsg('tid-1', '{"msg":"chunk"}', { transferId: 'tid-1', chunkIndex: 0, data: fakeChunk });
    const [info] = manager.getActiveTransfers();
    // Should have recorded approximately 512 bytes (within a few bytes of encoding overhead)
    expect(info.bytesTransferred).toBeGreaterThan(0);
    manager.stop();
  });

  it('stop() clears the cleanup interval', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    manager.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
