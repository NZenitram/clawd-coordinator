import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../../src/coordinator/server.js';
import {
  parseMessage,
  serializeMessage,
  createAgentRegister,
  createCliRequest,
  createFileChunkAck,
  createFileChunk,
  createFileTransferStart,
  createFileTransferComplete,
  type FileTransferStartPayload,
  type FileChunkPayload,
  type FileChunkAckPayload,
  type FileTransferCompletePayload,
  type FilePullRequestPayload,
} from '../../src/protocol/messages.js';

const TEST_TOKEN = 'file-transfer-test-token';
const TEST_PORT = 9893;

function connectWs(portNum: number, pathStr: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${portNum}${pathStr}`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, predicate: (msg: ReturnType<typeof parseMessage>) => boolean): Promise<ReturnType<typeof parseMessage>> {
  return new Promise((resolve) => {
    const listener = (raw: Buffer | string) => {
      const msg = parseMessage(raw.toString());
      if (msg && predicate(msg)) {
        ws.removeListener('message', listener);
        resolve(msg);
      }
    };
    ws.on('message', listener);
  });
}

describe('File Transfer Integration', () => {
  let coordinator: Coordinator;
  let tmpDir: string;

  afterEach(async () => {
    if (coordinator) await coordinator.stop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('push-file: coordinator returns transferId for valid agent', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await connectWs(TEST_PORT, '/agent');
    agentWs.send(serializeMessage(createAgentRegister({ name: 'agent-push', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const cliWs = await connectWs(TEST_PORT, '/cli');
    const requestId = randomUUID();
    const requestMsg = serializeMessage(createCliRequest({
      command: 'push-file',
      args: {
        agentName: 'agent-push',
        destPath: '/remote/file.txt',
        filename: 'file.txt',
        totalBytes: 100,
        isDirectory: false,
        totalChunks: 1,
      },
    }));

    const responsePromise = waitForMessage(cliWs, (m) => m?.type === 'cli:response');
    cliWs.send(requestMsg);
    const response = await responsePromise;

    expect(response).not.toBeNull();
    expect(response!.type).toBe('cli:response');
    const payload = (response!.payload as { data: unknown; error?: string });
    expect(payload.error).toBeUndefined();
    const data = payload.data as { transferId: string; ready: boolean };
    expect(data.transferId).toBeDefined();
    expect(data.ready).toBe(true);

    agentWs.close();
    cliWs.close();
  });

  it('push-file: returns error when agent not found', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cliWs = await connectWs(TEST_PORT, '/cli');
    const responsePromise = waitForMessage(cliWs, (m) => m?.type === 'cli:response');
    cliWs.send(serializeMessage(createCliRequest({
      command: 'push-file',
      args: {
        agentName: 'nonexistent-agent',
        destPath: '/remote/file.txt',
        filename: 'file.txt',
        totalBytes: 0,
        isDirectory: false,
        totalChunks: 0,
      },
    })));

    const response = await responsePromise;
    const payload = response!.payload as { error?: string };
    expect(payload.error).toContain('not found');

    cliWs.close();
  });

  it('pull-file: coordinator returns transferId and sends pull-request to agent', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentWs = await connectWs(TEST_PORT, '/agent');
    agentWs.send(serializeMessage(createAgentRegister({ name: 'agent-pull', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 50));

    const cliWs = await connectWs(TEST_PORT, '/cli');

    // Start listening on agent side for pull-request
    const pullRequestPromise = waitForMessage(agentWs, (m) => m?.type === 'file:pull-request');

    // CLI sends pull-file request
    const responsePromise = waitForMessage(cliWs, (m) => m?.type === 'cli:response');
    cliWs.send(serializeMessage(createCliRequest({
      command: 'pull-file',
      args: { agentName: 'agent-pull', sourcePath: '/remote/data.bin' },
    })));

    const [response, pullRequest] = await Promise.all([responsePromise, pullRequestPromise]);

    const payload = response!.payload as { data: unknown; error?: string };
    expect(payload.error).toBeUndefined();
    const data = payload.data as { transferId: string; ready: boolean };
    expect(data.transferId).toBeDefined();

    expect(pullRequest!.type).toBe('file:pull-request');
    const prPayload = pullRequest!.payload as FilePullRequestPayload;
    expect(prPayload.sourcePath).toBe('/remote/data.bin');
    expect(prPayload.transferId).toBe(data.transferId);

    agentWs.close();
    cliWs.close();
  });

  it('transfer-file: errors when source agent not found', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cliWs = await connectWs(TEST_PORT, '/cli');
    const responsePromise = waitForMessage(cliWs, (m) => m?.type === 'cli:response');
    cliWs.send(serializeMessage(createCliRequest({
      command: 'transfer-file',
      args: {
        fromAgent: 'missing-agent',
        toAgent: 'also-missing',
        sourcePath: '/src/file.txt',
        destPath: '/dst/file.txt',
      },
    })));

    const response = await responsePromise;
    const payload = response!.payload as { error?: string };
    expect(payload.error).toContain('not found');

    cliWs.close();
  });

  it('transfer-file: initiates agent-to-agent transfer when both agents present', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const agentA = await connectWs(TEST_PORT, '/agent');
    const agentB = await connectWs(TEST_PORT, '/agent');
    agentA.send(serializeMessage(createAgentRegister({ name: 'agent-a', os: 'linux', arch: 'x64' })));
    agentB.send(serializeMessage(createAgentRegister({ name: 'agent-b', os: 'linux', arch: 'x64' })));
    await new Promise(r => setTimeout(r, 80));

    // Listen on agent-a for pull-request and agent-b for transfer-start
    const pullReqPromise = waitForMessage(agentA, (m) => m?.type === 'file:pull-request');
    const transferStartPromise = waitForMessage(agentB, (m) => m?.type === 'file:transfer-start');

    const cliWs = await connectWs(TEST_PORT, '/cli');
    const responsePromise = waitForMessage(cliWs, (m) => m?.type === 'cli:response');
    cliWs.send(serializeMessage(createCliRequest({
      command: 'transfer-file',
      args: {
        fromAgent: 'agent-a',
        toAgent: 'agent-b',
        sourcePath: '/home/data/file.dat',
        destPath: '/home/recv/file.dat',
      },
    })));

    const [response, pullReq, transferStart] = await Promise.all([
      responsePromise,
      pullReqPromise,
      transferStartPromise,
    ]);

    const payload = response!.payload as { data: unknown; error?: string };
    expect(payload.error).toBeUndefined();
    const data = payload.data as { transferId: string; status: string };
    expect(data.transferId).toBeDefined();
    expect(data.status).toBe('initiated');

    const prPayload = pullReq!.payload as FilePullRequestPayload;
    expect(prPayload.sourcePath).toBe('/home/data/file.dat');

    const tsPayload = transferStart!.payload as FileTransferStartPayload;
    expect(tsPayload.destPath).toBe('/home/recv/file.dat');
    expect(tsPayload.transferId).toBe(data.transferId);

    agentA.close();
    agentB.close();
    cliWs.close();
  });

  it('list-transfers: returns active transfer list', async () => {
    coordinator = new Coordinator({ port: TEST_PORT, token: TEST_TOKEN });
    await coordinator.start();

    const cliWs = await connectWs(TEST_PORT, '/cli');
    const responsePromise = waitForMessage(cliWs, (m) => m?.type === 'cli:response');
    cliWs.send(serializeMessage(createCliRequest({ command: 'list-transfers' })));

    const response = await responsePromise;
    const payload = response!.payload as { data: { transfers: unknown[] }; error?: string };
    expect(payload.error).toBeUndefined();
    expect(Array.isArray(payload.data.transfers)).toBe(true);

    cliWs.close();
  });
});
