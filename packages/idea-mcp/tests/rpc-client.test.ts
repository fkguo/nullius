import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Writable, Readable } from 'stream';

// Mock child_process.spawn before importing IdeaRpcClient
const mockStdin = new Writable({
  write(_chunk, _encoding, callback) { callback(); },
});
const mockStdout = new Readable({ read() {} });
const mockStderr = new Readable({ read() {} });

const mockChild = Object.assign(new EventEmitter(), {
  stdin: mockStdin,
  stdout: mockStdout,
  stderr: mockStderr,
  exitCode: null as number | null,
  kill: vi.fn(),
  pid: 12345,
});

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockChild),
}));

import { IdeaRpcClient } from '../src/rpc-client.js';

describe('IdeaRpcClient', () => {
  let client: IdeaRpcClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild.exitCode = null;
    mockChild.removeAllListeners();
    // Re-attach listeners that were removed
    Object.assign(mockChild, {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
    });

    client = new IdeaRpcClient({
      ideaCorePath: '/fake/idea-core',
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    client.close();
  });

  it('sends JSON-RPC request and resolves with result', async () => {
    // Track what's written to stdin
    const written: string[] = [];
    mockChild.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const promise = client.call('campaign.init', { topic: 'dark matter' });

    // Wait for stdin write
    await new Promise(r => setTimeout(r, 10));

    expect(written.length).toBe(1);
    const request = JSON.parse(written[0]!.trim());
    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('campaign.init');
    expect(request.params).toEqual({ topic: 'dark matter' });

    // Simulate response
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { campaign_id: 'test-123', status: 'active' },
    }) + '\n';

    mockChild.stdout!.push(response);

    const result = await promise;
    expect(result).toEqual({ campaign_id: 'test-123', status: 'active' });
  });

  it('maps JSON-RPC error -32601 to invalidParams', async () => {
    const written: string[] = [];
    mockChild.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const promise = client.call('nonexistent.method', {});

    await new Promise(r => setTimeout(r, 10));
    const request = JSON.parse(written[0]!.trim());

    mockChild.stdout!.push(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'Method not found' },
    }) + '\n');

    await expect(promise).rejects.toThrow('method_not_found');
    try { await promise; } catch (err: any) {
      expect(err.code).toBe('INVALID_PARAMS');
      expect(err.retryable).toBe(false);
    }
  });

  it('maps JSON-RPC error -32603 to internalError', async () => {
    const written: string[] = [];
    mockChild.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const promise = client.call('campaign.init', { topic: 'test' });

    await new Promise(r => setTimeout(r, 10));
    const request = JSON.parse(written[0]!.trim());

    mockChild.stdout!.push(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32603, message: 'Internal error' },
    }) + '\n');

    await expect(promise).rejects.toThrow('JSON-RPC error -32603');
    try { await promise; } catch (err: any) {
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.retryable).toBe(false);
    }
  });

  it('rejects all pending on process exit', async () => {
    mockChild.stdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    });

    const promise = client.call('campaign.status', { campaign_id: 'x' });

    await new Promise(r => setTimeout(r, 10));

    // Simulate child process exit
    mockChild.exitCode = 1;
    mockChild.emit('exit', 1, null);

    await expect(promise).rejects.toThrow('idea-core exited');
    try { await promise; } catch (err: any) {
      expect(err.code).toBe('UPSTREAM_ERROR');
      expect(err.retryable).toBe(true);
    }
  });

  it('rejects with timeout when no response', async () => {
    // Use a very short timeout
    const fastClient = new IdeaRpcClient({
      ideaCorePath: '/fake/idea-core',
      timeoutMs: 50,
    });

    mockChild.stdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    });

    const promise = fastClient.call('campaign.init', { topic: 'slow' });

    await expect(promise).rejects.toThrow('timeout');
    try { await promise; } catch (err: any) {
      expect(err.code).toBe('UPSTREAM_ERROR');
      expect(err.retryable).toBe(true);
    }

    fastClient.close();
  });

  it('rejects after close', async () => {
    client.close();
    await expect(client.call('campaign.init', { topic: 'test' })).rejects.toThrow('closed');
  });
});
