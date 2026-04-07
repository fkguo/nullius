import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable, Writable } from 'stream';

function createMockChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    exitCode: null as number | null,
    kill: vi.fn(),
    pid: 12345,
  });
}

let mockChild = createMockChild();
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));
spawnMock.mockImplementation(() => mockChild);

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import { IdeaRpcClient } from '../src/rpc-client.js';

describe('IdeaRpcClient', () => {
  let client: IdeaRpcClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = createMockChild();
    spawnMock.mockImplementation(() => mockChild);
    client = new IdeaRpcClient({
      backend: 'idea-core-python',
      ideaCorePath: '/fake/idea-core',
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    client.close();
  });

  it('defaults to the in-process idea-engine backend when a rootDir is provided', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-mcp-engine-'));
    const engineClient = new IdeaRpcClient({ rootDir, timeoutMs: 5000 });

    try {
      const initResult = await engineClient.call('campaign.init', {
        budget: {
          max_cost_usd: 100,
          max_steps: 5,
          max_tokens: 10_000,
          max_wall_clock_s: 3600,
        },
        charter: {
          approval_gate_ref: 'gate://idea.default-host',
          campaign_name: 'default-engine-backend',
          domain: 'hep-ph',
          scope: 'idea-mcp default backend regression',
        },
        idempotency_key: 'default-engine-init',
        seed_pack: {
          seeds: [{ content: 'seed-a', seed_type: 'text' }],
        },
      }) as Record<string, unknown>;

      expect(typeof initResult.campaign_id).toBe('string');
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      engineClient.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('sends a JSON-RPC request and resolves with the result payload', async () => {
    const written: string[] = [];
    mockChild.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const promise = client.call('campaign.init', { idempotency_key: 'k' });
    await new Promise(resolve => setTimeout(resolve, 10));

    const request = JSON.parse(written[0]!.trim());
    expect(request).toMatchObject({
      jsonrpc: '2.0',
      method: 'campaign.init',
      params: { idempotency_key: 'k' },
    });

    mockChild.stdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { campaign_id: 'test-123', status: 'running' },
    }) + '\n');

    await expect(promise).resolves.toEqual({ campaign_id: 'test-123', status: 'running' });
  });

  it('maps method_not_implemented to INTERNAL_ERROR and preserves JSON-RPC details', async () => {
    const written: string[] = [];
    mockChild.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const promise = client.call('campaign.pause', { campaign_id: 'x', idempotency_key: 'pause-1' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const request = JSON.parse(written[0]!.trim());

    mockChild.stdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32000,
        message: 'method_not_implemented',
        data: { reason: 'method_not_implemented', details: { method: 'campaign.pause' } },
      },
    }) + '\n');

    await expect(promise).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
      data: {
        reason: 'method_not_implemented',
        rpc: { code: -32000, message: 'method_not_implemented' },
      },
    });
  });

  it('maps budget_exhausted to INVALID_PARAMS without retryability', async () => {
    const written: string[] = [];
    mockChild.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const promise = client.call('search.step', { campaign_id: 'x', n_steps: 1, idempotency_key: 'search-1' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const request = JSON.parse(written[0]!.trim());

    mockChild.stdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32001,
        message: 'budget_exhausted',
        data: { reason: 'budget_exhausted', campaign_id: 'x' },
      },
    }) + '\n');

    await expect(promise).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      retryable: false,
      data: {
        reason: 'budget_exhausted',
        rpc: { code: -32001, message: 'budget_exhausted' },
      },
    });
  });

  it('maps campaign_not_found to NOT_FOUND', async () => {
    const written: string[] = [];
    mockChild.stdin = new Writable({
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        callback();
      },
    });

    const promise = client.call('campaign.status', { campaign_id: 'x' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const request = JSON.parse(written[0]!.trim());

    mockChild.stdout.push(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32003,
        message: 'campaign_not_found',
        data: { reason: 'campaign_not_found', campaign_id: 'x' },
      },
    }) + '\n');

    await expect(promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
      retryable: false,
      data: {
        reason: 'campaign_not_found',
        rpc: { code: -32003, message: 'campaign_not_found' },
      },
    });
  });

  it('rejects all pending requests when the child exits', async () => {
    const promise = client.call('campaign.status', { campaign_id: 'x' });
    await new Promise(resolve => setTimeout(resolve, 10));

    mockChild.exitCode = 1;
    mockChild.emit('exit', 1, null);

    await expect(promise).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
  });

  it('rejects with a timeout when no response arrives', async () => {
    const fastClient = new IdeaRpcClient({
      backend: 'idea-core-python',
      ideaCorePath: '/fake/idea-core',
      timeoutMs: 50,
    });
    const promise = fastClient.call('campaign.init', { idempotency_key: 'slow' });

    await expect(promise).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });

    fastClient.close();
  });

  it('rejects calls after close', async () => {
    client.close();
    await expect(client.call('campaign.init', { idempotency_key: 'closed' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: false,
    });
  });
});
