import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { upstreamError, internalError } from '@autoresearch/shared';
import { mapRpcError } from './rpc-error-mapping.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface IdeaRpcClientOptions {
  ideaCorePath: string;
  timeoutMs?: number;
  maxRestarts?: number;
  dataDir?: string;
  contractDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC Client
// ─────────────────────────────────────────────────────────────────────────────

export class IdeaRpcClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private buffer = '';
  private restartCount = 0;
  private closed = false;

  private readonly ideaCorePath: string;
  private readonly timeoutMs: number;
  private readonly maxRestarts: number;
  private readonly dataDir?: string;
  private readonly contractDir?: string;

  constructor(opts: IdeaRpcClientOptions) {
    this.ideaCorePath = opts.ideaCorePath;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.dataDir = opts.dataDir;
    this.contractDir = opts.contractDir;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw internalError('IdeaRpcClient is closed');
    this.ensureChild();

    const id = randomUUID();
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const line = JSON.stringify(request) + '\n';

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(upstreamError(`idea-core RPC timeout after ${this.timeoutMs}ms`, { method, id }));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.child!.stdin!.write(line);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(upstreamError(`Failed to write to idea-core stdin: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  close(): void {
    this.closed = true;
    this.rejectAllPending('IdeaRpcClient closed');
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  private ensureChild(): void {
    if (this.child && this.child.exitCode === null) return;
    if (this.restartCount >= this.maxRestarts) {
      throw upstreamError(
        `idea-core exceeded max restarts (${this.maxRestarts})`,
        { restartCount: this.restartCount },
      );
    }
    this.spawnChild();
  }

  private spawnChild(): void {
    const args = ['run', 'python', '-m', 'idea_core.rpc.server'];
    if (this.dataDir) args.push('--data-dir', this.dataDir);
    if (this.contractDir) args.push('--contract-dir', this.contractDir);

    this.child = spawn('uv', args, {
      cwd: this.ideaCorePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.buffer = '';

    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    this.child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(`[idea-core] ${chunk.toString('utf-8')}`);
    });

    this.child.on('exit', (code, signal) => {
      if (this.closed) return;
      const msg = `idea-core exited (code=${code}, signal=${signal})`;
      this.rejectAllPending(msg);

      if (this.restartCount < this.maxRestarts) {
        this.restartCount++;
        process.stderr.write(`[idea-mcp] ${msg}, restarting (${this.restartCount}/${this.maxRestarts})\n`);
      }
    });

    this.child.on('error', (err) => {
      this.rejectAllPending(`idea-core spawn error: ${err.message}`);
    });
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }

      const pending = this.pending.get(response.id);
      if (!pending) continue;

      this.pending.delete(response.id);
      clearTimeout(pending.timer);

      if (response.error) {
        pending.reject(mapRpcError(response.error.code, response.error.message, response.error.data));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(upstreamError(reason, { id }));
    }
    this.pending.clear();
  }
}
