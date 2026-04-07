import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { IdeaEngineRpcService, handleJsonRpcRequest } from '@autoresearch/idea-engine';
import { internalError } from '@autoresearch/shared';
import { mapRpcError } from './rpc-error-mapping.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface IdeaRpcClientOptions {
  contractDir?: string;
  rootDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC Client
// ─────────────────────────────────────────────────────────────────────────────

export class IdeaRpcClient {
  private closed = false;
  private readonly ideaEngine: IdeaEngineRpcService;

  constructor(opts: IdeaRpcClientOptions) {
    const rootDir = opts.rootDir?.trim();
    if (!rootDir) {
      throw new Error('IdeaRpcClient requires explicit rootDir; repo-local defaults are forbidden');
    }
    this.ideaEngine = new IdeaEngineRpcService({
      contractDir: opts.contractDir,
      rootDir: resolve(rootDir),
    });
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw internalError('IdeaRpcClient is closed');
    return this.callIdeaEngine(method, params);
  }

  private async callIdeaEngine(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    // idea-engine currently exposes a synchronous JSON-RPC helper; keep that assumption
    // explicit here so a future async refactor does not silently change this TS-only bridge contract.
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
  }
}
