import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { listIdeaTools } from '../src/server.js';
import { SERVER_INSTRUCTIONS } from '../src/serverInstructions.js';
import { IDEA_TOOLS } from '../src/tool-registry.js';

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));

describe('MCP annotations and titles', () => {
  it('every listed tool carries a non-empty title and all four boolean hints', () => {
    const issues: string[] = [];
    for (const tool of listIdeaTools()) {
      if (typeof tool.title !== 'string' || tool.title.trim() === '') issues.push(`${tool.name}: missing title`);
      const annotations = tool.annotations as unknown as Record<string, unknown>;
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        if (typeof annotations?.[hint] !== 'boolean') issues.push(`${tool.name}: ${hint} is not a boolean`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('readOnlyHint and destructiveHint follow riskLevel', () => {
    const byName = new Map(IDEA_TOOLS.map(t => [t.name, t]));
    for (const tool of listIdeaTools()) {
      const risk = byName.get(tool.name)!.riskLevel;
      expect(tool.annotations.readOnlyHint, tool.name).toBe(risk === 'read');
      expect(tool.annotations.destructiveHint, tool.name).toBe(risk === 'destructive');
    }
  });
});

describe('idea-mcp over stdio', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('lists titles, annotations and instructions, and mirrors results in structuredContent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'idea-mcp-contract-'));
    dirs.push(dataDir);
    const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    const client = new Client({ name: 'idea-contract-test', version: '1.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd: dataDir,
      env: { ...env, IDEA_MCP_DATA_DIR: dataDir },
      stderr: 'pipe',
    }));
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
      const listed = await client.listTools();
      expect(listed.tools.map(t => ({ name: t.name, title: t.title, annotations: t.annotations })))
        .toEqual(listIdeaTools().map(t => ({ name: t.name, title: t.title, annotations: t.annotations })));

      const result = await client.callTool({
        name: 'idea_campaign_init',
        arguments: {
          budget: { max_steps: 5, max_tokens: 10_000 },
          charter: {
            approval_gate_ref: 'gate://idea.contract',
            campaign_name: 'contract',
            domain: 'test-domain',
            scope: 'idea-mcp structuredContent contract',
          },
          idempotency_key: 'contract-init',
          seed_pack: { seeds: [{ content: 'seed-a', seed_type: 'text' }] },
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(result.structuredContent).toEqual(JSON.parse(text));

      const failed = await client.callTool({ name: 'idea_campaign_status', arguments: { campaign_id: 'not-a-short-id!' } });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 30_000);
});
