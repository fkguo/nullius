import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@nullius/shared';

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
import {
  assertToolCallAllowed,
  resolveToolExecutionPolicy,
  safeFallbackToolExecutionPolicy,
  type ToolExecutionPolicy,
  type ToolPermissionView,
} from './tool-execution-policy.js';

export type { McpToolResult } from './mcp-jsonrpc.js';
export type { ToolExecutionPolicy, ToolPermissionView } from './tool-execution-policy.js';
export type ToolCaller = {
  callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
  getExecutionPolicy?(toolName: string): ToolExecutionPolicy;
};

export interface McpClientSamplingOptions {
  defaultRoute: string;
  routingConfig?: unknown;
  backendFactory?: ChatBackendFactory;
}

export interface McpClientOptions {
  maxReconnects?: number;
  reconnectPolicy?: RetryPolicy;
  sampling?: McpClientSamplingOptions;
}

export const MCP_PREFERRED_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [MCP_PREFERRED_PROTOCOL_VERSION, '2024-11-05'] as const;

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
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
        this.scheduleReconnect();
      }
    });

    const initResponse = await this.request('initialize', {
      protocolVersion: MCP_PREFERRED_PROTOCOL_VERSION,
      capabilities: this.sampling ? { sampling: {} } : {},
      clientInfo: { name: '@nullius/orchestrator', version: '0.5.0' },
    });
    const negotiated = (initResponse.result as Record<string, unknown> | undefined)?.protocolVersion;
    if (typeof negotiated !== 'string' || negotiated.trim() === '') {
      throw new Error('MCP initialize protocol failure: result missing protocolVersion');
    }
    if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number])) {
      throw new Error(
        `MCP server negotiated unsupported protocol version: ${JSON.stringify(negotiated)} ` +
        `(client_supported=${JSON.stringify(MCP_SUPPORTED_PROTOCOL_VERSIONS)})`,
      );
    }
    writeJsonRpcMessage(this.proc?.stdin ?? null, { jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
  }

  private scheduleReconnect(): void {
    if (this.reconnectCount >= this.maxReconnects) {
      return;
    }
    this.reconnecting = true;
    this.reconnectCount += 1;
    const attempt = this.reconnectCount;
    const delay = Math.min(this.reconnectPolicy.baseDelayMs * 2 ** (attempt - 1), this.reconnectPolicy.maxDelayMs);
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
      } catch {
        this.reconnecting = false;
        if (!this.closed) {
          this.scheduleReconnect();
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

  private async requestToolCall(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
    if (!this.initialized) {
      throw new Error('McpClient not initialized — call start() first');
    }
    return toMcpToolResult(await this.request('tools/call', { name: toolName, arguments: args }, timeoutMs));
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
    return this.requestToolCall(toolName, args, timeoutMs);
  }

  getExecutionPolicy(toolName: string): ToolExecutionPolicy {
    return resolveToolExecutionPolicy(toolName);
  }

  async callToolWithPermissionView(
    toolName: string,
    args: Record<string, unknown>,
    permissionView: ToolPermissionView,
    timeoutMs?: number,
  ): Promise<McpToolResult> {
    if (!this.initialized) {
      throw new Error('McpClient not initialized — call start() first');
    }
    assertToolCallAllowed(toolName, permissionView);
    return this.requestToolCall(toolName, args, timeoutMs);
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
  }
}

export function bindToolPermissionView(toolCaller: ToolCaller, permissionView: ToolPermissionView): ToolCaller {
  const permissionViewExecutionPolicy = (toolName: string): ToolExecutionPolicy => {
    if (!permissionView.allowed_tool_names.includes(toolName)) {
      return safeFallbackToolExecutionPolicy(toolName);
    }
    return permissionView.execution_policies[toolName] ?? resolveToolExecutionPolicy(toolName);
  };
  if (toolCaller instanceof McpClient) {
    return {
      callTool: (toolName: string, args: Record<string, unknown>, timeoutMs?: number) =>
        toolCaller.callToolWithPermissionView(toolName, args, permissionView, timeoutMs),
      getExecutionPolicy: permissionViewExecutionPolicy,
    };
  }
  return {
    callTool: async (toolName: string, args: Record<string, unknown>, timeoutMs?: number) => {
      assertToolCallAllowed(toolName, permissionView);
      return toolCaller.callTool(toolName, args, timeoutMs);
    },
    getExecutionPolicy: permissionViewExecutionPolicy,
  };
}
