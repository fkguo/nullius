import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { McpClient } from '../src/mcp-client.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-process-'));
}

async function waitForFile(filePath: string, timeoutMs = 4_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function writeServer(filePath: string, body: string): void {
  fs.writeFileSync(filePath, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    import { spawn } from 'node:child_process';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      ${body}
    });
  `);
}

describe('McpClient subprocess containment', () => {
  const tmpDirs: string[] = [];
  const originalCanary = process.env.NULLIUS_AMBIENT_CANARY;

  afterEach(() => {
    if (originalCanary === undefined) delete process.env.NULLIUS_AMBIENT_CANARY;
    else process.env.NULLIUS_AMBIENT_CANARY = originalCanary;
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('validates maxReconnects as a non-negative safe integer at construction', () => {
    expect(() => new McpClient({ maxReconnects: 0 })).not.toThrow();
    expect(() => new McpClient({ maxReconnects: Number.MAX_SAFE_INTEGER })).not.toThrow();

    for (const maxReconnects of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new McpClient({ maxReconnects })).toThrow(
        new RangeError('McpClient maxReconnects must be a non-negative safe integer'),
      );
    }
  });

  it('passes only the controlled baseline plus declared config and credentials', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const resultPath = path.join(tmpDir, 'environment.json');
    process.env.NULLIUS_AMBIENT_CANARY = 'must-not-cross';
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
          ambient: process.env.NULLIUS_AMBIENT_CANARY ?? null,
          config: process.env.SERVER_MODE ?? null,
          credential: process.env.TEST_API_KEY ?? null,
          home: process.env.HOME ?? null,
          cwd: process.cwd(),
        }));
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { RESULT_PATH: resultPath, SERVER_MODE: 'isolated' },
      credentials: { TEST_API_KEY: 'declared-secret' },
      cwd: fs.realpathSync(tmpDir),
    });
    const result = JSON.parse(await waitForFile(resultPath)) as Record<string, unknown>;
    await client.close();

    expect(result).toMatchObject({
      ambient: null,
      config: 'isolated',
      credential: 'declared-secret',
      cwd: fs.realpathSync(tmpDir),
    });
    expect(result.home).not.toBe(os.homedir());
  });

  it('rejects loader injection and credential/config channel confusion without echoing values', async () => {
    const client = new McpClient();
    await expect(client.start(process.execPath, ['unused'], {
      configEnv: { NODE_OPTIONS: 'secret-loader-value' },
    })).rejects.toThrow('MCP config environment rejects dangerous key: NODE_OPTIONS');
    await expect(client.close()).resolves.toBeUndefined();

    const second = new McpClient();
    await expect(second.start(process.execPath, ['unused'], {
      configEnv: { TEST_API_KEY: 'secret-api-value' },
    })).rejects.toThrow('MCP credential-like key must be supplied through credentials: TEST_API_KEY');
    await expect(second.close()).resolves.toBeUndefined();
  });

  it('accepts explicitly declared credentials whose names are not heuristic secret names', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const resultPath = path.join(tmpDir, 'credential.json');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ databaseUrl: process.env.DATABASE_URL }));
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { RESULT_PATH: resultPath },
      credentials: { DATABASE_URL: 'postgres://declared-only' },
      requiredCredentialNames: ['DATABASE_URL'],
      cwd: tmpDir,
    });
    expect(JSON.parse(await waitForFile(resultPath))).toEqual({ databaseUrl: 'postgres://declared-only' });
    await client.close();
  });

  it('does not inherit proxy URLs containing credentials', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const resultPath = path.join(tmpDir, 'proxy.json');
    const originalProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy-user:proxy-password@127.0.0.1:7890';
    try {
      writeServer(scriptPath, `
        if (msg.method === 'initialize') {
          fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ proxy: process.env.HTTPS_PROXY ?? null }));
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
          } }) + '\\n');
        }
      `);
      const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
      await client.start(process.execPath, [scriptPath], {
        configEnv: { RESULT_PATH: resultPath },
        cwd: tmpDir,
      });
      expect(JSON.parse(await waitForFile(resultPath))).toEqual({ proxy: null });
      await client.close();
    } finally {
      if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = originalProxy;
    }
  });

  it('fails before spawn when a declared server credential is missing or empty', async () => {
    const client = new McpClient();
    await expect(client.start(process.execPath, ['must-not-run'], {
      credentials: {},
      requiredCredentialNames: ['OPENALEX_API_KEY'],
    })).rejects.toThrow('MCP required credential is missing: OPENALEX_API_KEY');
    await client.close();

    const second = new McpClient();
    await expect(second.start(process.execPath, ['must-not-run'], {
      credentials: { OPENALEX_API_KEY: '' },
      requiredCredentialNames: ['OPENALEX_API_KEY'],
    })).rejects.toThrow('MCP required credential is missing: OPENALEX_API_KEY');
    await second.close();
  });

  it('cleans the process group when initialization fails', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const sentinelPath = path.join(tmpDir, 'late-init-sentinel');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        spawn(process.execPath, ['-e', \`setTimeout(() => require('fs').writeFileSync(\${JSON.stringify(process.env.SENTINEL_PATH)}, 'late'), 350)\`]);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '1999-01-01', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await expect(client.start(process.execPath, [scriptPath], {
      configEnv: { SENTINEL_PATH: sentinelPath },
      cwd: tmpDir,
    })).rejects.toThrow('unsupported protocol version');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('makes a timed-out client unusable and kills child and grandchild work', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const sentinelPath = path.join(tmpDir, 'late-call-sentinel');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
      if (msg.method === 'tools/call') {
        spawn(process.execPath, ['-e', \`setTimeout(() => require('fs').writeFileSync(\${JSON.stringify(process.env.SENTINEL_PATH)}, 'late'), 350)\`]);
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20, maxReconnects: 3 });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { SENTINEL_PATH: sentinelPath },
      cwd: tmpDir,
    });
    await expect(client.callTool('hang', {}, 30)).rejects.toThrow('client is unusable');
    expect(client.isConnected).toBe(false);
    await expect(client.callTool('retry', {})).rejects.toThrow('not initialized');
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('cleans the exited server process group before reconnecting', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const generationPath = path.join(tmpDir, 'generation');
    const sentinelPath = path.join(tmpDir, 'orphan-sentinel');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
      if (msg.method === 'notifications/initialized' && !fs.existsSync(process.env.GENERATION_PATH)) {
        fs.writeFileSync(process.env.GENERATION_PATH, 'first');
        spawn(process.execPath, ['-e', \`setTimeout(() => require('fs').writeFileSync(\${JSON.stringify(process.env.SENTINEL_PATH)}, 'orphan'), 500)\`]);
        process.exit(0);
      }
    `);
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 1,
      reconnectPolicy: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { GENERATION_PATH: generationPath, SENTINEL_PATH: sentinelPath },
      cwd: tmpDir,
    });
    await waitForFile(generationPath);
    const reconnectDeadline = Date.now() + 2_000;
    while (!client.isConnected && Date.now() < reconnectDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(client.isConnected).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(fs.existsSync(sentinelPath)).toBe(false);
    await client.close();
  });

  it('bounds repeated post-initialize crashes across successful reconnects', async () => {
    if (process.platform === 'win32') return;
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    const countPath = path.join(tmpDir, 'starts');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
      if (msg.method === 'notifications/initialized') {
        const count = fs.existsSync(process.env.COUNT_PATH)
          ? Number(fs.readFileSync(process.env.COUNT_PATH, 'utf8'))
          : 0;
        fs.writeFileSync(process.env.COUNT_PATH, String(count + 1));
        process.exit(0);
      }
    `);
    const client = new McpClient({
      shutdownGraceMs: 20,
      killGraceMs: 20,
      maxReconnects: 2,
      reconnectPolicy: { baseDelayMs: 10, maxDelayMs: 10 },
    });
    await client.start(process.execPath, [scriptPath], {
      configEnv: { COUNT_PATH: countPath },
      cwd: tmpDir,
    });
    const deadline = Date.now() + 2_000;
    while ((!fs.existsSync(countPath) || fs.readFileSync(countPath, 'utf8') !== '3') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(fs.readFileSync(countPath, 'utf8')).toBe('3');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(fs.readFileSync(countPath, 'utf8')).toBe('3');
    expect(client.isConnected).toBe(false);
    await expect(client.callTool('retry', {})).rejects.toThrow('not initialized');
    await client.close();
  });

  it('closes idempotently', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'server.mjs');
    writeServer(scriptPath, `
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2025-03-26', serverInfo: { name: 'stub', version: '1' }, capabilities: {}
        } }) + '\\n');
      }
    `);
    const client = new McpClient({ shutdownGraceMs: 20, killGraceMs: 20 });
    await client.start(process.execPath, [scriptPath], { cwd: tmpDir });
    await Promise.all([client.close(), client.close()]);
    await expect(client.close()).resolves.toBeUndefined();
  });
});
