import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  type ToolPermissionView,
} from './tool-execution-policy.js';

export type { McpToolResult } from './mcp-jsonrpc.js';
export type { ToolPermissionView } from './tool-execution-policy.js';
export type ToolCaller = {
  callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
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
  shutdownGraceMs?: number;
  killGraceMs?: number;
}

export type McpProcessContainment = 'required' | 'best_effort';

export interface McpClientStartOptions {
  /** Non-secret server configuration. Credential-shaped names are rejected. */
  configEnv?: Record<string, string>;
  /** Explicit credential name/value map. Values are never included in errors. */
  credentials?: Record<string, string>;
  /** Credentials the configured server requires. Missing or empty values fail before spawn. */
  requiredCredentialNames?: string[];
  /** Explicit working directory. Defaults to the client's isolated temporary home. */
  cwd?: string;
  /** POSIX process-group containment is required unless best-effort is explicitly selected. */
  containment?: McpProcessContainment;
}

export const MCP_PREFERRED_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [MCP_PREFERRED_PROTOCOL_VERSION, '2024-11-05'] as const;

const AMBIENT_ENV_ALLOWLIST = [
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

const DANGEROUS_ENV_KEYS = new Set([
  'BASH_ENV',
  'CDPATH',
  'ENV',
  'GLOBIGNORE',
  'GCONV_PATH',
  'IFS',
  'JAVA_TOOL_OPTIONS',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LUA_CPATH',
  'LUA_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PERL5OPT',
  'PERL5LIB',
  'PROMPT_COMMAND',
  'PS4',
  'PYTHONHOME',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'RUBYLIB',
  'SHELL',
  'SHELLOPTS',
  'ZDOTDIR',
  '_JAVA_OPTIONS',
]);
const CONTROLLED_ENV_KEYS = new Set(['HOME']);

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_KEY_PATTERN = /(?:^|_)(?:ACCESS_?KEY|API_?KEY|AUTH|BEARER|CLIENT_?SECRET|CREDENTIALS?|PASS(?:WORD|WD)?|PAT|PRIVATE_?KEY|SECRET|SESSION_?KEY|TOKEN)(?:_|$)/i;

function assertSafeEnvironmentMap(
  kind: 'config' | 'credentials',
  values: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`MCP ${kind} environment contains an invalid key: ${JSON.stringify(key)}`);
    }
    const normalizedKey = key.toUpperCase();
    if (DANGEROUS_ENV_KEYS.has(normalizedKey) || normalizedKey.startsWith('DYLD_')) {
      throw new Error(`MCP ${kind} environment rejects dangerous key: ${key}`);
    }
    if (CONTROLLED_ENV_KEYS.has(normalizedKey)) {
      throw new Error(`MCP ${kind} environment cannot override controlled key: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new Error(`MCP ${kind} environment value must be a string: ${key}`);
    }
    if (kind === 'config' && CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new Error(`MCP credential-like key must be supplied through credentials: ${key}`);
    }
  }
}

function safeAmbientEnvironmentValue(key: string, value: string): string | null {
  if (!/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(key)) return value;
  try {
    const parsed = new URL(value);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return value;
  } catch {
    return null;
  }
}

function buildMcpSubprocessEnvironment(
  controlledHome: string,
  configEnv: Record<string, string>,
  credentials: Record<string, string>,
  requiredCredentialNames: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  assertSafeEnvironmentMap('config', configEnv);
  assertSafeEnvironmentMap('credentials', credentials);
  const credentialKeys = new Set(Object.keys(credentials).map(key => key.toUpperCase()));
  for (const key of Object.keys(configEnv)) {
    if (credentialKeys.has(key.toUpperCase())) {
      throw new Error(`MCP environment key is declared as both config and credential: ${key}`);
    }
  }
  const required = new Set<string>();
  for (const key of requiredCredentialNames) {
    if (required.has(key)) throw new Error(`MCP required credential is declared more than once: ${key}`);
    required.add(key);
    assertSafeEnvironmentMap('credentials', { [key]: '<required>' });
    if (!Object.hasOwn(credentials, key) || credentials[key]!.trim() === '') {
      throw new Error(`MCP required credential is missing: ${key}`);
    }
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of AMBIENT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string') {
      const safeValue = safeAmbientEnvironmentValue(key, value);
      if (safeValue !== null) env[key] = safeValue;
    }
  }
  env.HOME = controlledHome;
  return { ...env, ...configEnv, ...credentials };
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

// POSIX servers run under an anchor: a small Node process spawned with setsid
// (`detached`), so it leads the server's session and process group and the
// group number is the anchor's pid. The anchor reads the server's environment
// as one JSON line on fd 3 (the anchor itself runs with an empty one, which
// the runtime may extend), starts the server in its group with exactly that
// environment, reports on fd 3 how the server ended, and then stays in the
// group, ignoring the signals that end the server, until the client sends
// SIGKILL. The anchor's pid cannot be reissued before the client reaps it, so
// a group signal sent while the anchor is unreaped reaches the server's group,
// also after the server itself has exited and left descendants behind.
// The anchor never leaves while the rest of the group may still run: if fd 3
// ends or fails (the client exited without stopping it) or the anchor itself
// fails, it stops the group on its own, SIGTERM and then, after the client's
// kill grace (passed as its first argument), SIGKILL, which ends the anchor
// together with every remaining member. The anchor cannot observe the
// server's descendants, so it always waits the whole grace.
const SERVER_ANCHOR_SOURCE = `
'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const [graceText, command, ...args] = process.argv.slice(1);
const graceMs = Math.max(0, Number(graceText) || 0);
const control = new net.Socket({ fd: 3, readable: true, writable: true });
let stopping = false;
const signalGroup = signal => {
  try {
    process.kill(-process.pid, signal);
  } catch {}
};
const stopGroup = () => {
  if (stopping) return;
  stopping = true;
  signalGroup('SIGTERM');
  setTimeout(() => {
    signalGroup('SIGKILL');
    process.exit(1);
  }, graceMs);
};
control.on('error', stopGroup);
control.on('end', stopGroup);
process.on('uncaughtException', stopGroup);
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => {});
let reported = false;
const report = status => {
  if (reported || !control.writable) return;
  reported = true;
  control.write(JSON.stringify(status) + '\\n');
};
let received = '';
const start = chunk => {
  received += chunk;
  const end = received.indexOf('\\n');
  if (end < 0) return;
  control.off('data', start);
  control.resume();
  try {
    const env = JSON.parse(received.slice(0, end));
    const server = spawn(command, args, { env, stdio: ['inherit', 'inherit', 'inherit', 'ignore'] });
    server.on('error', error => report({ error: error.message }));
    server.on('exit', (code, signal) => report({ code, signal }));
  } catch (error) {
    report({ error: error.message });
  }
};
control.setEncoding('utf8');
control.on('data', start);
`;

type ServerExit = { code: number | null; signal: NodeJS.Signals | null } | { error: string };

function parseServerExit(line: string): ServerExit {
  try {
    const status = JSON.parse(line) as Record<string, unknown>;
    if (typeof status.error === 'string') return { error: status.error };
    return {
      code: typeof status.code === 'number' ? status.code : null,
      signal: typeof status.signal === 'string' ? status.signal as NodeJS.Signals : null,
    };
  } catch {
    return { code: null, signal: null };
  }
}

// Resolves once with how the server ended: the anchor's report, or the exit
// of the spawned process itself (an anchor that ends unreported, or the
// server on Windows).
function watchServerExit(proc: ChildProcess, anchored: boolean): Promise<ServerExit> {
  return new Promise(resolve => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
    const status = proc.stdio[3];
    if (anchored && status) {
      // A broken control channel (EPIPE when the anchor dies before reading
      // the environment) carries nothing beyond the anchor's own exit.
      status.on('error', () => {});
      readline.createInterface({ input: status as NodeJS.ReadableStream })
        .on('error', () => {})
        .once('line', line => resolve(parseServerExit(line)));
    }
  });
}

// A fresh error for each later call, carrying the recorded transport failure
// (and through it the pipe error) as its cause.
function transportFailureError(failure: Error): Error {
  return new Error(failure.message, { cause: failure });
}

export class McpClient {
  private proc: ChildProcess | null = null;
  private readonly serverExits = new WeakMap<ChildProcess, Promise<ServerExit>>();
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly sampling: SamplingRuntime | null;
  private readonly maxReconnects: number;
  private readonly reconnectPolicy: RetryPolicy;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private initialized = false;
  private startCommand = '';
  private startArgs: string[] = [];
  private startOptions: McpClientStartOptions = {};
  private controlledHome: string | null = null;
  private reconnectCount = 0;
  private reconnecting = false;
  private closed = false;
  private unusable = false;
  private terminationPromise: Promise<void> | null = null;
  private transportFailure: Error | null = null;

  constructor(options?: McpClientOptions) {
    const maxReconnects = options?.maxReconnects ?? 3;
    if (!Number.isSafeInteger(maxReconnects) || maxReconnects < 0) {
      throw new RangeError('McpClient maxReconnects must be a non-negative safe integer');
    }
    this.maxReconnects = maxReconnects;
    this.reconnectPolicy = options?.reconnectPolicy ?? DEFAULT_RETRY_POLICY;
    this.shutdownGraceMs = options?.shutdownGraceMs ?? 250;
    this.killGraceMs = options?.killGraceMs ?? 250;
    this.sampling = options?.sampling
      ? {
          routingConfig: loadSamplingRoutingConfig(options.sampling.routingConfig, options.sampling.defaultRoute),
          backendFactory: options.sampling.backendFactory,
        }
      : null;
  }

  async start(command: string, args: string[], options: McpClientStartOptions = {}): Promise<void> {
    if (this.proc || this.unusable || this.closed) {
      throw new Error('McpClient already started');
    }
    const containment = options.containment ?? 'required';
    if (process.platform === 'win32' && containment === 'required') {
      throw new Error('MCP required process-tree containment is unavailable on Windows; explicitly select best_effort');
    }
    const controlledHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-mcp-home-'));
    fs.chmodSync(controlledHome, 0o700);
    this.startCommand = command;
    this.startArgs = [...args];
    this.startOptions = { ...options, containment };
    this.controlledHome = controlledHome;
    this.closed = false;
    try {
      await this.doStart(command, args, this.startOptions);
    } catch (error) {
      this.unusable = true;
      await this.terminateProcessTree();
      this.removeControlledHome();
      throw error;
    }
  }

  private async doStart(command: string, args: string[], options: McpClientStartOptions): Promise<void> {
    if (!this.controlledHome) throw new Error('McpClient controlled environment is unavailable');
    const configEnv = options.configEnv ?? {};
    const credentials = options.credentials ?? {};
    const env = buildMcpSubprocessEnvironment(
      this.controlledHome,
      configEnv,
      credentials,
      options.requiredCredentialNames ?? [],
    );
    const cwd = options.cwd ?? this.controlledHome;
    const anchored = process.platform !== 'win32';
    const proc = anchored
      ? spawn(process.execPath, ['-e', SERVER_ANCHOR_SOURCE, '--', String(this.killGraceMs), command, ...args], {
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          env: {},
          cwd,
          detached: true,
        })
      : spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
    if (!proc.stdout) {
      throw new Error('No stdout from MCP process');
    }
    this.proc = proc;
    if (anchored) (proc.stdio[3] as NodeJS.WritableStream).write(`${JSON.stringify(env)}\n`);
    const serverExit = watchServerExit(proc, anchored);
    this.serverExits.set(proc, serverExit);
    // stderr is drained, never read: a failure on it carries nothing about
    // the JSON-RPC connection and must not escape as an uncaught exception.
    proc.stderr?.on('error', () => {});
    proc.stderr?.resume();
    // A failed write or read on the JSON-RPC pipes (EPIPE once nothing reads
    // the server's stdin) ends the connection instead of escaping as an
    // uncaught exception. readline re-emits its input's errors.
    proc.stdin?.on('error', error => this.failTransport(proc, 'stdin', error));
    proc.stdout.on('error', error => this.failTransport(proc, 'stdout', error));
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
    }).on('error', error => this.failTransport(proc, 'stdout', error));
    void serverExit.then(status => {
      // An anchor outlives its server: release the server's stdin as Node
      // does when a direct child exits.
      proc.stdin?.destroy();
      if ('error' in status) {
        this.failPending(`MCP process failed to start: ${status.error}`);
        return;
      }
      const wasConnected = this.initialized;
      this.failPending(status.signal
        ? `MCP process exited on signal ${status.signal}`
        : `MCP process exited with code ${status.code}`);
      if (wasConnected && !this.closed && !this.unusable && !this.reconnecting) {
        this.scheduleReconnect();
      }
    });
    proc.on('error', error => {
      this.failPending(`MCP process failed to start: ${error.message}`);
    });

    const initResponse = await this.request('initialize', {
      protocolVersion: MCP_PREFERRED_PROTOCOL_VERSION,
      capabilities: this.sampling ? { sampling: {} } : {},
      clientInfo: { name: '@nullius/orchestrator', version: '0.6.1' },
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
      this.unusable = true;
      void this.terminateProcessTree().then(() => this.removeControlledHome());
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
        // The direct server may have exited while descendants remain in its
        // dedicated process group. Drain that old group before starting a new
        // one; merely dropping the ChildProcess handle would orphan it.
        await this.terminateProcessTree();
        if (this.closed || this.unusable) {
          this.reconnecting = false;
          return;
        }
        await this.doStart(this.startCommand, this.startArgs, this.startOptions);
        this.reconnecting = false;
      } catch {
        await this.terminateProcessTree();
        this.reconnecting = false;
        if (!this.closed && !this.unusable) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  get isConnected(): boolean {
    return this.initialized && this.proc !== null && !this.closed && !this.unusable;
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    if (this.closed || this.unusable || !this.proc?.stdin?.writable) {
      if (this.transportFailure) throw transportFailureError(this.transportFailure);
      throw new Error('McpClient is not usable');
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`MCP request timed out after ${timeoutMs}ms: ${method}; client is unusable`);
        this.invalidateAndTerminate(error);
        reject(error);
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
    this.assertInitialized();
    return toMcpToolResult(await this.request('tools/call', { name: toolName, arguments: args }, timeoutMs));
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
    return this.requestToolCall(toolName, args, timeoutMs);
  }

  async callToolWithPermissionView(
    toolName: string,
    args: Record<string, unknown>,
    permissionView: ToolPermissionView,
    timeoutMs?: number,
  ): Promise<McpToolResult> {
    this.assertInitialized();
    assertToolCallAllowed(toolName, permissionView);
    return this.requestToolCall(toolName, args, timeoutMs);
  }

  // A client whose transport failed reports that failure on every later call,
  // also where initialization is checked first. Any other uninitialized client
  // (never started, or between a server exit and its reconnect) is reported
  // as not initialized.
  private assertInitialized(): void {
    if (this.initialized) return;
    if (this.transportFailure) throw transportFailureError(this.transportFailure);
    throw new Error('McpClient not initialized — call start() first');
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.terminateProcessTree();
    this.removeControlledHome();
  }

  // The first pipe failure of the current server makes the client unusable:
  // pending requests and every later request fail with it. Pipes of a server
  // this client has already replaced carry none of its requests.
  private failTransport(proc: ChildProcess, stream: 'stdin' | 'stdout', error: Error): void {
    if (this.proc !== proc || this.transportFailure) return;
    this.transportFailure = new Error(
      `MCP transport failed on ${stream}: ${error.message}; client is unusable`,
      { cause: error },
    );
    this.invalidateAndTerminate(this.transportFailure);
  }

  private invalidateAndTerminate(error: Error): void {
    this.unusable = true;
    this.initialized = false;
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
    void this.terminateProcessTree().then(() => this.removeControlledHome());
  }

  private async terminateProcessTree(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    const proc = this.proc;
    if (!proc) return;
    this.terminationPromise = this.doTerminateProcessTree(proc).finally(() => {
      if (this.proc === proc) this.proc = null;
      this.initialized = false;
      this.terminationPromise = null;
    });
    return this.terminationPromise;
  }

  private async doTerminateProcessTree(proc: ChildProcess): Promise<void> {
    try {
      proc.stdin?.end();
    } catch {
      // CONTRACT-EXEMPT: CODE-01.5 best-effort shutdown cleanup
    }
    await this.waitForServerExit(proc, this.shutdownGraceMs);
    // Signal from a fresh macrotask, never from inside libuv's reaping pass
    // (see signalProcessTree).
    await new Promise(resolve => setImmediate(resolve));
    const termSent = this.signalProcessTree(proc, 'SIGTERM');
    if (termSent) {
      await new Promise(resolve => setTimeout(resolve, this.killGraceMs));
    }
    this.signalProcessTree(proc, 'SIGKILL');
    await waitForProcessExit(proc, this.killGraceMs);
    proc.stdio[3]?.destroy();
  }

  private async waitForServerExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    const serverExit = this.serverExits.get(proc);
    if (!serverExit) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([serverExit, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(timer);
  }

  // The group number is the anchor's pid and names the server's group exactly
  // while the anchor is unreaped. Node sets exitCode/signalCode in the exit
  // callback that libuv runs for each child it reaped, but libuv reaps every
  // exited child before running any of their callbacks, so inside that pass a
  // reaped child can still show unset fields. libuv runs the whole pass within
  // its poll phase, so callers signal only from a fresh timer or immediate
  // callback, where every reaped child has had its callback and unset fields
  // mean the anchor is unreaped. A member running
  // under credentials this process may not signal is out of reach and cannot
  // be detected either: kill(2) succeeds for a group when any member accepts.
  private signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): boolean {
    if (!proc.pid) return false;
    if (process.platform === 'win32') return proc.kill(signal);
    // The anchor is reaped, so its pid, the group number, may already name an
    // unrelated group: send nothing. Nothing is abandoned by this, because the
    // anchor leaves only through a SIGKILL to the whole group, sent either by
    // this client or by the anchor itself after it lost its client (see
    // SERVER_ANCHOR_SOURCE). The exception is an anchor killed from outside,
    // whose group is out of this client's reach once the anchor is reaped.
    if (proc.exitCode !== null || proc.signalCode !== null) return false;
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch (error) {
      // ESRCH: no member is left. EPERM: none this process may signal; macOS
      // reports it for a group whose members have all exited, such as an
      // anchor killed from outside and not yet reaped.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EPERM') return false;
      throw error;
    }
  }

  private failPending(message: string): void {
    this.initialized = false;
    for (const [, pending] of this.pending) pending.reject(new Error(message));
    this.pending.clear();
  }

  private removeControlledHome(): void {
    const controlledHome = this.controlledHome;
    this.controlledHome = null;
    if (!controlledHome) return;
    fs.rmSync(controlledHome, { recursive: true, force: true });
  }
}
