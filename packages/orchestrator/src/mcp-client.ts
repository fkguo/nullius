import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@autoresearch/shared';

import type { LedgerWriter } from './ledger-writer.js';
import type { ChatBackendFactory } from './backends/backend-factory.js';
import {
  consumeJsonRpcLine,
  toMcpToolResult,
  type JsonRpcId,
  type McpToolResult,
  type PendingRequest,
  writeJsonRpcMessage,
} from './mcp-jsonrpc.js';
import { handleMcpServerRequest, type SamplingRuntime } from './mcp-server-request-handler.js';
import { loadSamplingRoutingConfig } from './routing/sampling-loader.js';

export type { McpToolResult } from './mcp-jsonrpc.js';
export type ToolCaller = {
  callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
};

export interface McpClientSamplingOptions {
  defaultRoute: string;
  routingConfig?: unknown;
  backendFactory?: ChatBackendFactory;
}

export interface McpClientOptions {
  ledger?: LedgerWriter;
  maxReconnects?: number;
  reconnectPolicy?: RetryPolicy;
  sampling?: McpClientSamplingOptions;
}

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly ledger: LedgerWriter | null;
  private readonly sampling: SamplingRuntime | null;
  private readonly maxReconnects: number;
  private readonly reconnectPolicy: RetryPolicy;
  private initialized = false;
  private startCommand = '';
  private startArgs: string[] = [];
  private startEnv: Record<string, string> | undefined;
  private reconnectCount = 0;
  private reconnecting = false;
  private closed = false;

  constructor(options?: McpClientOptions) {
    this.ledger = options?.ledger ?? null;
    this.maxReconnects = options?.maxReconnects ?? 3;
    this.reconnectPolicy = options?.reconnectPolicy ?? DEFAULT_RETRY_POLICY;
    this.sampling = options?.sampling
      ? {
          routingConfig: loadSamplingRoutingConfig(options.sampling.routingConfig, options.sampling.defaultRoute),
          backendFactory: options.sampling.backendFactory,
        }
      : null;
  }

  async start(command: string, args: string[], env?: Record<string, string>): Promise<void> {
    if (this.proc) {
      throw new Error('McpClient already started');
    }
    this.startCommand = command;
    this.startArgs = args;
    this.startEnv = env;
    this.closed = false;
    await this.doStart(command, args, env);
  }

  private async doStart(command: string, args: string[], env?: Record<string, string>): Promise<void> {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(env ?? {}) } });
    if (!proc.stdout) {
      throw new Error('No stdout from MCP process');
    }
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      consumeJsonRpcLine({
        line,
        pending: this.pending,
        onServerRequest: message => handleMcpServerRequest({
          message,
          sampling: this.sampling,
          ledger: this.ledger ?? undefined,
          writeResponse: response => writeJsonRpcMessage(this.proc?.stdin ?? null, response),
        }),
      });
    });
    proc.on('exit', code => {
      const wasConnected = this.initialized;
      this.initialized = false;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP process exited with code ${code}`));
      }
      this.pending.clear();
      if (wasConnected && !this.closed && !this.reconnecting) {
        this.scheduleReconnect(code);
      }
    });

    const initResponse = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: this.sampling ? { sampling: {} } : {},
      clientInfo: { name: '@autoresearch/orchestrator', version: '0.0.1' },
    });
    writeJsonRpcMessage(this.proc?.stdin ?? null, { jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
    this.ledger?.log('mcp_client.started', { details: { command, args, serverInfo: initResponse.result } });
  }

  private scheduleReconnect(exitCode: number | null): void {
    if (this.reconnectCount >= this.maxReconnects) {
      this.ledger?.log('mcp_client.reconnect_exhausted', {
        details: { exitCode, attempts: this.reconnectCount, maxReconnects: this.maxReconnects },
      });
      return;
    }
    this.reconnecting = true;
    this.reconnectCount += 1;
    const attempt = this.reconnectCount;
    const delay = Math.min(this.reconnectPolicy.baseDelayMs * 2 ** (attempt - 1), this.reconnectPolicy.maxDelayMs);
    this.ledger?.log('mcp_client.reconnecting', {
      details: { exitCode, attempt, delay, maxReconnects: this.maxReconnects },
    });
    setTimeout(async () => {
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      try {
        this.proc = null;
        await this.doStart(this.startCommand, this.startArgs, this.startEnv);
        this.reconnectCount = 0;
        this.reconnecting = false;
        this.ledger?.log('mcp_client.reconnected', { details: { attempt } });
      } catch (error) {
        this.reconnecting = false;
        this.ledger?.log('mcp_client.reconnect_failed', {
          details: { attempt, error: error instanceof Error ? error.message : String(error) },
        });
        if (!this.closed) {
          this.scheduleReconnect(null);
        }
      }
    }, delay);
  }

  get isConnected(): boolean {
    return this.initialized && this.proc !== null && !this.closed;
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: result => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      writeJsonRpcMessage(this.proc?.stdin ?? null, { jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
    if (!this.initialized) {
      throw new Error('McpClient not initialized — call start() first');
    }
    return toMcpToolResult(await this.request('tools/call', { name: toolName, arguments: args }, timeoutMs));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.proc) {
      return;
    }
    try {
      this.proc.stdin?.end();
    } catch {
      // CONTRACT-EXEMPT: CODE-01.5 best-effort shutdown cleanup
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 5000);
      this.proc?.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.proc = null;
    this.initialized = false;
    this.ledger?.log('mcp_client.closed');
  }
}
