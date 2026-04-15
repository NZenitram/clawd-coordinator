import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import type { TarOptionsWithAliasesAsyncNoFile } from 'tar';
import type { Writable } from 'node:stream';
import WebSocket from 'ws';
import { logger } from '../shared/logger.js';
import { safeSend } from '../shared/ws-utils.js';
import {
  serializeMessage,
  createFileTransferStart,
  createFileChunk,
  createFileChunkAck,
  createFileTransferComplete,
  createFileTransferError,
  type FileTransferStartPayload,
  type FileChunkPayload,
  type FileChunkAckPayload,
  type FileTransferCompletePayload,
} from '../protocol/messages.js';

export const CHUNK_SIZE = 384 * 1024; // 384KB raw → ~512KB base64, well under 1MB maxPayload

/** Returns true iff targetPath is inside cwd or one of addDirs. */
export function isPathAllowed(targetPath: string, cwd: string, addDirs: string[]): boolean {
  const resolved = path.resolve(targetPath);
  const allowed = [cwd, ...addDirs];
  return allowed.some((dir) => {
    const resolvedDir = path.resolve(dir);
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
  });
}

// ─── FileSender ────────────────────────────────────────────────────────────────

export interface FileSenderOptions {
  exclude?: string[];
  chunkSize?: number;
}

/**
 * Sends a file or directory over WebSocket in base64-encoded chunks.
 * Waits for file:chunk-ack after each chunk for backpressure.
 */
export class FileSender {
  private pendingAcks = new Map<string, (ack: FileChunkAckPayload) => void>();

  /** Call this when a file:chunk-ack arrives to unblock the sender. */
  handleAck(ack: FileChunkAckPayload): void {
    const resolve = this.pendingAcks.get(ack.transferId + ':' + ack.chunkIndex);
    if (resolve) {
      this.pendingAcks.delete(ack.transferId + ':' + ack.chunkIndex);
      resolve(ack);
    }
  }

  private waitForAck(transferId: string, chunkIndex: number): Promise<FileChunkAckPayload> {
    return new Promise((resolve) => {
      this.pendingAcks.set(transferId + ':' + chunkIndex, resolve);
    });
  }

  async send(
    ws: WebSocket,
    transferId: string,
    sourcePath: string,
    options: FileSenderOptions = {},
  ): Promise<void> {
    const chunkSize = options.chunkSize ?? CHUNK_SIZE;
    const stat = await fsPromises.stat(sourcePath);
    const isDirectory = stat.isDirectory();

    if (isDirectory) {
      await this.sendDirectory(ws, transferId, sourcePath, options.exclude ?? [], chunkSize);
    } else {
      await this.sendFile(ws, transferId, sourcePath, stat.size, chunkSize);
    }
  }

  private async sendFile(
    ws: WebSocket,
    transferId: string,
    filePath: string,
    totalBytes: number,
    chunkSize: number,
  ): Promise<void> {
    const filename = path.basename(filePath);
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));

    // Send file:transfer-start
    const startPayload: FileTransferStartPayload = {
      transferId,
      direction: 'pull',
      filename,
      sourcePath: filePath,
      destPath: '',
      totalBytes,
      totalChunks,
      isDirectory: false,
    };
    safeSend(ws, serializeMessage(createFileTransferStart(startPayload)));

    // Stream chunks
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
      let chunkIndex = 0;
      const hash = createHash('sha256');
      let paused = false;

      stream.on('data', async (chunk: string | Buffer) => {
        stream.pause();
        paused = true;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        try {
          hash.update(buf);
          const data = buf.toString('base64');
          const currentIndex = chunkIndex++;
          safeSend(ws, serializeMessage(createFileChunk({ transferId, chunkIndex: currentIndex, data })));
          await this.waitForAck(transferId, currentIndex);
          stream.resume();
          paused = false;
        } catch (err) {
          reject(err);
        }
      });

      stream.on('end', async () => {
        if (paused) return; // handled by data handler
        const checksum = hash.digest('hex');
        safeSend(ws, serializeMessage(createFileTransferComplete({ transferId, checksum })));
        resolve();
      });

      stream.on('error', reject);
    });

    const finalHash = createHash('sha256');
    // Already sent complete above; this path handles the hash finishing inline
  }

  private async sendDirectory(
    ws: WebSocket,
    transferId: string,
    dirPath: string,
    exclude: string[],
    chunkSize: number,
  ): Promise<void> {
    const filename = path.basename(dirPath);
    const baseDir = dirPath;

    // We don't know tar output size ahead of time — send 0 as placeholder
    const startPayload: FileTransferStartPayload = {
      transferId,
      direction: 'pull',
      filename,
      sourcePath: dirPath,
      destPath: '',
      totalBytes: 0,
      totalChunks: 0,
      isDirectory: true,
    };
    safeSend(ws, serializeMessage(createFileTransferStart(startPayload)));

    // Build exclude filter from patterns (sanitized to avoid path injection)
    const excludePatterns: string[] = [];
    for (const pattern of exclude) {
      const sanitized = pattern.replace(/[^\w.*?/\-[\]{}]/g, '');
      if (sanitized && !sanitized.startsWith('-')) {
        excludePatterns.push(sanitized);
      }
    }

    const filterFn: TarOptionsWithAliasesAsyncNoFile['filter'] = excludePatterns.length > 0
      ? (entryPath: string) => !excludePatterns.some((p) => {
          // Simple glob: support * wildcard
          const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          return new RegExp(`(^|/)${escaped}($|/)`).test(entryPath);
        })
      : undefined;

    const createOpts: TarOptionsWithAliasesAsyncNoFile = { cwd: baseDir, gzip: false, filter: filterFn };
    const tarStream = tar.create(createOpts, ['.']);

    let chunkIndex = 0;
    const hash = createHash('sha256');

    await new Promise<void>((resolve, reject) => {
      let buffer = Buffer.alloc(0);

      tarStream.on('data', async (chunk: Buffer) => {
        tarStream.pause();
        hash.update(chunk);
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= chunkSize) {
          const slice = buffer.subarray(0, chunkSize);
          buffer = buffer.subarray(chunkSize);
          const data = slice.toString('base64');
          const currentIndex = chunkIndex++;
          safeSend(ws, serializeMessage(createFileChunk({ transferId, chunkIndex: currentIndex, data })));
          await this.waitForAck(transferId, currentIndex);
        }

        tarStream.resume();
      });

      tarStream.on('end', async () => {
        // Flush remaining bytes
        if (buffer.length > 0) {
          const data = buffer.toString('base64');
          const currentIndex = chunkIndex++;
          safeSend(ws, serializeMessage(createFileChunk({ transferId, chunkIndex: currentIndex, data })));
          await this.waitForAck(transferId, currentIndex);
        }
        const checksum = hash.digest('hex');
        safeSend(ws, serializeMessage(createFileTransferComplete({ transferId, checksum })));
        resolve();
      });

      tarStream.on('error', reject);
    });
  }
}

// ─── FileReceiver ──────────────────────────────────────────────────────────────

const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024; // 2GB default limit

interface ReceiverSession {
  metadata: FileTransferStartPayload;
  destPath: string;
  /** Set when receiving a directory — a tar.extract() writable stream */
  tarSink?: Writable;
  /** Set when receiving a plain file */
  fileStream?: fs.WriteStream;
  bytesReceived: number;
  maxBytes: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Receives a chunked file or directory transfer.
 * Caller must wire incoming file:chunk and file:transfer-complete messages here.
 */
export class FileReceiver {
  private sessions = new Map<string, ReceiverSession>();

  /**
   * Begins receiving a transfer. Returns a promise that resolves when the
   * transfer completes (i.e., after file:transfer-complete is processed).
   *
   * Caller is responsible for sending file:chunk-ack replies.
   */
  startReceive(
    transferId: string,
    destPath: string,
    metadata: FileTransferStartPayload,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (metadata.totalBytes > MAX_TRANSFER_BYTES) {
        reject(new Error(`Transfer exceeds maximum size (${metadata.totalBytes} > ${MAX_TRANSFER_BYTES})`));
        return;
      }
      if (metadata.isDirectory) {
        // Ensure destination directory exists
        fs.mkdirSync(destPath, { recursive: true });
        const extractStream = tar.extract({ cwd: destPath }) as unknown as Writable;
        const session: ReceiverSession = {
          metadata,
          destPath,
          tarSink: extractStream,
          bytesReceived: 0,
          maxBytes: MAX_TRANSFER_BYTES,
          resolve,
          reject,
        };
        this.sessions.set(transferId, session);

        extractStream.on('error', (err: Error) => reject(err));
      } else {
        // Ensure parent directory exists
        const parentDir = path.dirname(destPath);
        fs.mkdirSync(parentDir, { recursive: true });
        const fileStream = fs.createWriteStream(destPath);
        const session: ReceiverSession = {
          metadata,
          destPath,
          fileStream,
          bytesReceived: 0,
          maxBytes: MAX_TRANSFER_BYTES,
          resolve,
          reject,
        };
        this.sessions.set(transferId, session);

        fileStream.on('error', (err: Error) => reject(err));
      }
    });
  }

  /**
   * Handles an incoming file:chunk.
   * Returns the ack payload so the caller can send it back.
   */
  handleChunk(chunk: FileChunkPayload): FileChunkAckPayload | null {
    const session = this.sessions.get(chunk.transferId);
    if (!session) return null;

    const raw = Buffer.from(chunk.data, 'base64');
    session.bytesReceived += raw.length;
    if (session.bytesReceived > session.maxBytes) {
      session.reject(new Error(`Transfer exceeded maximum size (${session.maxBytes} bytes)`));
      this.sessions.delete(chunk.transferId);
      return null;
    }

    if (session.tarSink) {
      session.tarSink.write(raw);
    } else if (session.fileStream) {
      session.fileStream.write(raw);
    }

    return { transferId: chunk.transferId, chunkIndex: chunk.chunkIndex };
  }

  /**
   * Finalizes the transfer. Closes streams and resolves the promise from startReceive.
   */
  handleComplete(complete: FileTransferCompletePayload): void {
    const session = this.sessions.get(complete.transferId);
    if (!session) return;
    this.sessions.delete(complete.transferId);

    if (session.tarSink) {
      session.tarSink.end(() => {
        session.resolve();
      });
    } else if (session.fileStream) {
      session.fileStream.end(() => {
        session.resolve();
      });
    } else {
      session.resolve();
    }
  }

  /** Abort an active receive session. */
  handleError(transferId: string, error: string): void {
    const session = this.sessions.get(transferId);
    if (!session) return;
    this.sessions.delete(transferId);

    if (session.tarSink) {
      session.tarSink.destroy();
    }
    if (session.fileStream) {
      session.fileStream.destroy();
    }
    // Clean up partial files/directories
    try {
      if (fs.existsSync(session.destPath)) {
        const stat = fs.statSync(session.destPath);
        if (stat.isDirectory()) {
          fs.rmSync(session.destPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(session.destPath);
        }
        logger.info({ transferId, destPath: session.destPath }, 'Cleaned up partial transfer');
      }
    } catch (cleanupErr) {
      logger.warn({ transferId, error: String(cleanupErr) }, 'Failed to clean up partial transfer');
    }
    session.reject(new Error(error));
  }

  /** Clean up all active sessions (for shutdown/disconnect) */
  cleanupAll(): void {
    for (const [transferId, session] of this.sessions) {
      if (session.tarSink) session.tarSink.destroy();
      if (session.fileStream) session.fileStream.destroy();
      try {
        if (fs.existsSync(session.destPath)) {
          const stat = fs.statSync(session.destPath);
          if (stat.isDirectory()) {
            fs.rmSync(session.destPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(session.destPath);
          }
        }
      } catch { /* best effort */ }
      session.reject(new Error('Transfer aborted — connection closed'));
    }
    this.sessions.clear();
  }

  hasSession(transferId: string): boolean {
    return this.sessions.has(transferId);
  }
}
