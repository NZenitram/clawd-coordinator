import { WebSocket } from 'ws';
import { logger } from '../shared/logger.js';
import { safeSend } from '../shared/ws-utils.js';
import {
  serializeMessage,
  createFileTransferError,
  type FileTransferStartPayload,
  type FileChunkPayload,
  type FileChunkAckPayload,
} from '../protocol/messages.js';

// How long a transfer may be inactive before it is cancelled (ms)
const TRANSFER_TIMEOUT_MS = 60_000;

export interface TransferState {
  transferId: string;
  direction: 'push' | 'pull' | 'transfer';
  filename: string;
  totalBytes: number;
  totalChunks: number;
  chunksReceived: number;
  bytesTransferred: number;
  sourceSocket: WebSocket;
  destSocket: WebSocket;
  startedAt: number;
  lastActivityAt: number;
}

export interface TransferInfo {
  transferId: string;
  direction: 'push' | 'pull' | 'transfer';
  filename: string;
  totalBytes: number;
  totalChunks: number;
  chunksReceived: number;
  bytesTransferred: number;
  progressPct: number;
  startedAt: number;
}

export class TransferManager {
  private activeTransfers = new Map<string, TransferState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Check for stale transfers every 15 seconds
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 15_000);
  }

  startTransfer(
    id: string,
    metadata: FileTransferStartPayload,
    sourceWs: WebSocket,
    destWs: WebSocket,
  ): void {
    const state: TransferState = {
      transferId: id,
      direction: metadata.direction,
      filename: metadata.filename,
      totalBytes: metadata.totalBytes,
      totalChunks: metadata.totalChunks,
      chunksReceived: 0,
      bytesTransferred: 0,
      sourceSocket: sourceWs,
      destSocket: destWs,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.activeTransfers.set(id, state);
    logger.info({ transferId: id, direction: metadata.direction, filename: metadata.filename }, 'Transfer started');
  }

  /** Relay a chunk from source to destination. Returns false if transfer unknown. */
  relayChunk(transferId: string, rawMsg: string): boolean {
    const state = this.activeTransfers.get(transferId);
    if (!state) return false;
    state.chunksReceived++;
    state.lastActivityAt = Date.now();
    safeSend(state.destSocket, rawMsg);
    return true;
  }

  /** Relay an ack from destination back to source. Returns false if transfer unknown. */
  relayAck(transferId: string, rawMsg: string): boolean {
    const state = this.activeTransfers.get(transferId);
    if (!state) return false;
    state.lastActivityAt = Date.now();
    safeSend(state.sourceSocket, rawMsg);
    return true;
  }

  /** Record bytes transferred (called after we know the chunk size). */
  recordBytes(transferId: string, bytes: number): void {
    const state = this.activeTransfers.get(transferId);
    if (state) {
      state.bytesTransferred += bytes;
      state.lastActivityAt = Date.now();
    }
  }

  completeTransfer(transferId: string): void {
    const state = this.activeTransfers.get(transferId);
    if (!state) return;
    logger.info({ transferId, filename: state.filename }, 'Transfer completed');
    this.activeTransfers.delete(transferId);
  }

  errorTransfer(transferId: string, error: string): void {
    const state = this.activeTransfers.get(transferId);
    if (!state) return;
    logger.warn({ transferId, error }, 'Transfer errored');
    // Notify both sides
    const errMsg = serializeMessage(createFileTransferError({ transferId, error }));
    safeSend(state.sourceSocket, errMsg);
    safeSend(state.destSocket, errMsg);
    this.activeTransfers.delete(transferId);
  }

  getActiveTransfers(): TransferInfo[] {
    return Array.from(this.activeTransfers.values()).map((s) => ({
      transferId: s.transferId,
      direction: s.direction,
      filename: s.filename,
      totalBytes: s.totalBytes,
      totalChunks: s.totalChunks,
      chunksReceived: s.chunksReceived,
      bytesTransferred: s.bytesTransferred,
      progressPct: s.totalBytes > 0 ? Math.round((s.bytesTransferred / s.totalBytes) * 100) : 0,
      startedAt: s.startedAt,
    }));
  }

  private cleanupStale(): void {
    const now = Date.now();
    for (const [id, state] of this.activeTransfers) {
      if (now - state.lastActivityAt > TRANSFER_TIMEOUT_MS) {
        logger.warn({ transferId: id }, 'Transfer timed out — cleaning up');
        this.errorTransfer(id, 'Transfer timed out due to inactivity');
      }
    }
  }

  /** Relay a file:chunk payload message object (already parsed). */
  relayChunkMsg(transferId: string, rawMsg: string, chunkData: FileChunkPayload): boolean {
    const ok = this.relayChunk(transferId, rawMsg);
    if (ok) {
      // base64 length → approximate raw byte count
      const rawBytes = Math.floor(chunkData.data.length * 0.75);
      this.recordBytes(transferId, rawBytes);
    }
    return ok;
  }

  /** Relay a file:chunk-ack payload (already parsed). */
  relayAckMsg(transferId: string, rawMsg: string, _ack: FileChunkAckPayload): boolean {
    return this.relayAck(transferId, rawMsg);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
