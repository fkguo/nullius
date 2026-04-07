import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { IdeaEngineRpcService, handleJsonRpcRequest } from '@autoresearch/idea-engine';
import { upstreamError, internalError } from '@autoresearch/shared';
import { DEFAULT_IDEA_RPC_BACKEND, type IdeaRpcBackend } from './backend.js';
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

const DEFAULT_IDEA_ENGINE_ROOT = fileURLToPath(new URL('../../idea-engine/runs', import.meta.url));

export interface IdeaRpcClientOptions {
  backend?: IdeaRpcBackend;
  ideaCorePath?: string;
  timeoutMs?: number;
  maxRestarts?: number;
  dataDir?: string;
  contractDir?: string;
  rootDir?: string;
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
  private readonly backend: IdeaRpcBackend;
  private readonly ideaEngine: IdeaEngineRpcService | null;

  private readonly ideaCorePath?: string;
  private readonly timeoutMs: number;
  private readonly maxRestarts: number;
  private readonly dataDir?: string;
  private readonly contractDir?: string;

  constructor(opts: IdeaRpcClientOptions) {
    this.backend = opts.backend ?? DEFAULT_IDEA_RPC_BACKEND;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.dataDir = opts.dataDir;
    this.contractDir = opts.contractDir;
    if (this.backend === 'idea-core-python') {
      if (!opts.ideaCorePath) {
        throw new Error('ideaCorePath is required for the idea-core-python compatibility backend');
      }
      this.ideaCorePath = resolve(opts.ideaCorePath);
      this.ideaEngine = null;
      return;
    }

    const rootDir = opts.rootDir ?? opts.dataDir ?? DEFAULT_IDEA_ENGINE_ROOT;
    this.ideaCorePath = undefined;
    this.ideaEngine = new IdeaEngineRpcService({
      contractDir: this.contractDir,
      rootDir: resolve(rootDir),
    });
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw internalError('IdeaRpcClient is closed');
    if (this.backend === 'idea-engine') {
      return this.callIdeaEngine(method, params);
    }
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

  private async callIdeaEngine(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ideaEngine) {
      throw internalError('idea-engine backend missing in-process RPC service');
    }
    // idea-engine currently exposes a synchronous JSON-RPC helper; keep that assumption
    // explicit here so a future async refactor does not silently change the bridge contract.
    const response = handleJsonRpcRequest(this.ideaEngine, {
      id: randomUUID(),
      jsonrpc: '2.0',
      method,
      params,
    }) as {
      error?: { code: number; data?: unknown; message: string };
      result?: unknown;
    };

    if (response.error) {
      throw mapRpcError(response.error.code, response.error.message, response.error.data);
    }
    return response.result;
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
    if (this.backend !== 'idea-core-python') return;
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
    if (!this.ideaCorePath) {
      throw internalError('idea-core-python compatibility backend missing ideaCorePath');
    }
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
