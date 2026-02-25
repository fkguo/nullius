// @autoresearch/orchestrator — McpClient (NEW-05a Stage 1 + NEW-RT-02 Reconnect)
// MCP stdio client with automatic reconnect on subprocess crash/exit.

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { type RetryPolicy, DEFAULT_RETRY_POLICY } from '@autoresearch/shared';
import type { LedgerWriter } from './ledger-writer.js';

export interface McpToolResult {
  ok: boolean;
  isError: boolean;
  rawText: string;
  json: unknown | null;
  errorCode: string | null;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export interface McpClientOptions {
  ledger?: LedgerWriter;
  /** Max reconnect attempts before giving up (default: 3). */
  maxReconnects?: number;
  /** Retry policy for reconnect backoff (uses H-19 defaults). */
  reconnectPolicy?: RetryPolicy;
}

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ledger: LedgerWriter | null;
  private initialized = false;

  // NEW-RT-02: Reconnect state
  private startCommand: string = '';
  private startArgs: string[] = [];
  private startEnv: Record<string, string> | undefined;
  private reconnectCount = 0;
  private readonly maxReconnects: number;
  private readonly reconnectPolicy: RetryPolicy;
  private reconnecting = false;
  private closed = false;

  constructor(options?: McpClientOptions) {
    this.ledger = options?.ledger ?? null;
    this.maxReconnects = options?.maxReconnects ?? 3;
    this.reconnectPolicy = options?.reconnectPolicy ?? DEFAULT_RETRY_POLICY;
  }

  /** Start the MCP server subprocess and perform initialize/initialized handshake. */
  async start(command: string, args: string[], env?: Record<string, string>): Promise<void> {
    if (this.proc) throw new Error('McpClient already started');

    // Store for reconnect
    this.startCommand = command;
    this.startArgs = args;
    this.startEnv = env;
    this.closed = false;

    await this.doStart(command, args, env);
  }

  /** Internal start logic (shared between initial start and reconnect). */
  private async doStart(command: string, args: string[], env?: Record<string, string>): Promise<void> {
    const mergedEnv = { ...process.env, ...(env ?? {}) };
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
    });

    if (!this.proc.stdout) throw new Error('No stdout from MCP process');

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg['id'];
        if (typeof id === 'number') {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.resolve(msg);
          }
        }
      } catch {
        // Skip non-JSON lines (CONTRACT-EXEMPT: CODE-01.5 skip non-JSON stdout noise)
      }
    });

    // NEW-RT-02: Detect process exit and trigger reconnect
    this.proc.on('exit', (code) => {
      const wasConnected = this.initialized;
      this.initialized = false;

      // Reject all pending requests
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP process exited with code ${code}`));
      }
      this.pending.clear();

      // Attempt reconnect if not explicitly closed
      if (wasConnected && !this.closed && !this.reconnecting) {
        this.handleDisconnect(code);
      }
    });

    // MCP protocol: initialize handshake
    const initResponse = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: '@autoresearch/orchestrator', version: '0.0.1' },
    });

    // Send initialized notification (no id = notification, no response expected)
    if (this.proc?.stdin) {
      const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.proc.stdin.write(notification + '\n');
    }

    this.initialized = true;
    this.ledger?.log('mcp_client.started', { details: { command, args, serverInfo: initResponse['result'] } });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // NEW-RT-02: Reconnect logic
  // ───────────────────────────────────────────────────────────────────────────

  private handleDisconnect(exitCode: number | null): void {
    if (this.reconnectCount >= this.maxReconnects) {
      this.ledger?.log('mcp_client.reconnect_exhausted', {
        details: { exitCode, attempts: this.reconnectCount, maxReconnects: this.maxReconnects },
      });
      return;
    }

    this.reconnecting = true;
    this.reconnectCount++;

    const attempt = this.reconnectCount;
    const delay = Math.min(
      this.reconnectPolicy.baseDelayMs * 2 ** (attempt - 1),
      this.reconnectPolicy.maxDelayMs,
    );

    this.ledger?.log('mcp_client.reconnecting', {
      details: { exitCode, attempt, delay, maxReconnects: this.maxReconnects },
    });

    setTimeout(async () => {
      // Re-check closed state — close() may have been called during the delay
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      try {
        this.proc = null;
        await this.doStart(this.startCommand, this.startArgs, this.startEnv);
        this.reconnectCount = 0; // Reset on success
        this.reconnecting = false;
        this.ledger?.log('mcp_client.reconnected', { details: { attempt } });
      } catch (err) {
        this.reconnecting = false;
        this.ledger?.log('mcp_client.reconnect_failed', {
          details: { attempt, error: err instanceof Error ? err.message : String(err) },
        });
        // Try again if under limit
        if (!this.closed) {
          this.handleDisconnect(null);
        }
      }
    }, delay);
  }

  /** Whether the client is connected and ready for tool calls. */
  get isConnected(): boolean {
    return this.initialized && this.proc !== null && !this.closed;
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    if (!this.proc?.stdin) throw new Error('McpClient not started');

    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params: params ?? {} };

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.proc!.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  /** Call an MCP tool and return a structured result.
   *  Requires that initialize handshake has been completed. */
  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
    if (!this.initialized) throw new Error('McpClient not initialized — call start() first');

    const response = await this.request('tools/call', { name: toolName, arguments: args }, timeoutMs);

    const result = response['result'] as Record<string, unknown> | undefined;
    const error = response['error'] as Record<string, unknown> | undefined;

    if (error) {
      return {
        ok: false,
        isError: true,
        rawText: String(error['message'] ?? ''),
        json: null,
        errorCode: String(error['code'] ?? ''),
      };
    }

    const content = (result?.['content'] as Array<Record<string, unknown>>) ?? [];
    const textParts = content
      .filter((c) => c['type'] === 'text')
      .map((c) => String(c['text'] ?? ''));
    const rawText = textParts.join('\n');

    let json: unknown = null;
    try {
      json = JSON.parse(rawText);
    } catch {
      // Not JSON — keep rawText only
    }

    return {
      ok: !result?.['isError'],
      isError: Boolean(result?.['isError']),
      rawText,
      json,
      errorCode: null,
    };
  }

  /** Close the MCP server subprocess. */
  async close(): Promise<void> {
    this.closed = true;
    if (!this.proc) return;

    try {
      this.proc.stdin?.end();
    } catch {
      // CONTRACT-EXEMPT: CODE-01.5 best-effort shutdown cleanup
    }

    // Give process time to exit gracefully
    await new Promise<void>((resolve) => {
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
