import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { McpClient, loadSamplingRoutingConfig } from '../src/index.js';
import { bindToolPermissionView } from '../src/mcp-client.js';
import { handleMcpServerRequest } from '../src/mcp-server-request-handler.js';
import { buildRuntimeToolPermissionView } from '../src/tool-execution-policy.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-sampling-'));
}

function buildRoutingConfig() {
  return loadSamplingRoutingConfig({
    version: 1,
    default_route: 'balanced',
    routes: { balanced: { backend: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 700 } },
    selectors: { modules: { sem02_claim_extraction: 'balanced' } },
  }, 'balanced');
}

function readResponse(write: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String(write.mock.calls.at(-1)?.[0] ?? '').trim()) as Record<string, unknown>;
}

async function waitForFile(filePath: string, timeoutMs = 4_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForJson<T>(
  filePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
        if (predicate(value)) {
          return value;
        }
      } catch {
        // The stub server can rewrite the file while the test is polling.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for JSON predicate on ${filePath}`);
}

describe('McpClient sampling support', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advertises sampling capability during initialize', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'stub-server.mjs');
    const resultPath = path.join(tmpDir, 'result.json');
    fs.writeFileSync(scriptPath, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const resultPath = process.env.RESULT_PATH;
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          fs.writeFileSync(resultPath, JSON.stringify({ capabilities: msg.params?.capabilities ?? null }, null, 2));
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stub', version: '0.0.1' }, capabilities: {} } }) + '\\n');
        }
      });
    `);

    const client = new McpClient({
      sampling: {
        defaultRoute: 'balanced',
        routingConfig: buildRoutingConfig(),
      },
    });

    await client.start(process.execPath, [scriptPath], { RESULT_PATH: resultPath });
    const result = JSON.parse(await waitForFile(resultPath));
    await client.close();

    expect(result.capabilities).toMatchObject({ sampling: {} });
  });

  it('blocks bound tool calls before tools/call reaches the server', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'stub-server.mjs');
    const resultPath = path.join(tmpDir, 'methods.json');
    fs.writeFileSync(scriptPath, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const resultPath = process.env.RESULT_PATH;
      const methods = [];
      const persist = () => fs.writeFileSync(resultPath, JSON.stringify({ methods }, null, 2));
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method) {
          methods.push(msg.method);
          persist();
        }
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stub', version: '0.0.1' }, capabilities: {} } }) + '\\n');
        }
        if (msg.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'unexpected' }], isError: false } }) + '\\n');
        }
      });
    `);

    const client = new McpClient();
    await client.start(process.execPath, [scriptPath], { RESULT_PATH: resultPath });

    const scoped = bindToolPermissionView(
      client,
      buildRuntimeToolPermissionView({
        tools: [{ name: 'allowed_tool', input_schema: {} }],
        allowedToolNames: ['allowed_tool'],
      }),
    );

    await expect(scoped.callTool('blocked_tool', {})).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });

    const result = await waitForJson<{ methods: string[] }>(resultPath, value => value.methods.includes('initialize'));
    await client.close();

    expect(result.methods).toContain('initialize');
    expect(result.methods).not.toContain('tools/call');
  });

  it('keeps visible tool calls backward compatible through the bound permission seam', async () => {
    const tmpDir = makeTmpDir();
    tmpDirs.push(tmpDir);
    const scriptPath = path.join(tmpDir, 'stub-server.mjs');
    const resultPath = path.join(tmpDir, 'methods.json');
    fs.writeFileSync(scriptPath, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const resultPath = process.env.RESULT_PATH;
      const methods = [];
      const persist = () => fs.writeFileSync(resultPath, JSON.stringify({ methods }, null, 2));
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method) {
          methods.push(msg.method);
          persist();
        }
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stub', version: '0.0.1' }, capabilities: {} } }) + '\\n');
        }
        if (msg.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'allowed-result' }], isError: false } }) + '\\n');
        }
      });
    `);

    const client = new McpClient();
    await client.start(process.execPath, [scriptPath], { RESULT_PATH: resultPath });

    const scoped = bindToolPermissionView(
      client,
      buildRuntimeToolPermissionView({
        tools: [{ name: 'allowed_tool', input_schema: {} }],
        allowedToolNames: ['allowed_tool'],
      }),
    );

    const result = await scoped.callTool('allowed_tool', {});
    const methods = await waitForJson<{ methods: string[] }>(resultPath, value => value.methods.includes('tools/call'));
    await client.close();

    expect(result.rawText).toContain('allowed-result');
    expect(methods.methods).toContain('tools/call');
  });

  it('answers server sampling/createMessage requests via host routing handler', async () => {
    const write = vi.fn();

    await handleMcpServerRequest({
      message: {
        id: 77,
        method: 'sampling/createMessage',
        params: {
          messages: [{ role: 'user', content: { type: 'text', text: 'hello from stub' } }],
          maxTokens: 400,
          metadata: {
            module: 'sem02_claim_extraction',
            tool: 'inspire_grade_evidence',
            prompt_version: 'sem02_claim_extraction_v1',
            risk_level: 'read',
            cost_class: 'high',
          },
        },
      },
      sampling: {
        routingConfig: buildRoutingConfig(),
        backendFactory: () => ({
          createMessage: vi.fn().mockResolvedValue({
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: '{"claims":[]}' }],
            stop_reason: 'end_turn',
          }),
        }),
      },
      writeResponse: response => write(JSON.stringify(response) + '\n'),
    });

    const response = readResponse(write);
    expect(response.id).toBe(77);
    expect((response.result as { model: string }).model).toBe('claude-sonnet-4-6');
    expect(((response.result as { content: Array<{ text: string }> }).content[0]).text).toContain('claims');
  });

  it('fails closed on unsupported server requests', async () => {
    const write = vi.fn();

    await handleMcpServerRequest({
      message: { id: 'unsupported-1', method: 'sampling/unknown' },
      sampling: { routingConfig: buildRoutingConfig() },
      writeResponse: response => write(JSON.stringify(response) + '\n'),
    });

    expect(readResponse(write)).toMatchObject({
      id: 'unsupported-1',
      error: { code: -32601, message: 'Unsupported server request: sampling/unknown' },
    });
  });

  it('fails closed when client sampling support is not configured', async () => {
    const write = vi.fn();

    await handleMcpServerRequest({
      message: {
        id: 'unsupported-2',
        method: 'sampling/createMessage',
        params: { messages: [], metadata: {} },
      },
      sampling: null,
      writeResponse: response => write(JSON.stringify(response) + '\n'),
    });

    expect(readResponse(write)).toMatchObject({
      id: 'unsupported-2',
      error: { code: -32601, message: 'Client sampling support is not configured' },
    });
  });

  it('returns JSON-RPC failure when sampling execution exhausts all attempts', async () => {
    const write = vi.fn();

    await handleMcpServerRequest({
      message: {
        id: 'unsupported-3',
        method: 'sampling/createMessage',
        params: {
          messages: [{ role: 'user', content: { type: 'text', text: 'trigger failure' } }],
          metadata: {
            module: 'sem02_claim_extraction',
            tool: 'inspire_grade_evidence',
            prompt_version: 'sem02_claim_extraction_v1',
            risk_level: 'read',
            cost_class: 'high',
          },
        },
      },
      sampling: {
        routingConfig: buildRoutingConfig(),
        backendFactory: () => ({
          createMessage: vi.fn().mockRejectedValue(new Error('backend offline')),
        }),
      },
      writeResponse: response => write(JSON.stringify(response) + '\n'),
    });

    expect(readResponse(write)).toMatchObject({
      id: 'unsupported-3',
      error: {
        code: -32000,
        message: 'sampling/createMessage failed',
        data: { reason: 'Sampling request failed after 1 attempt(s)' },
      },
    });
  });
});
