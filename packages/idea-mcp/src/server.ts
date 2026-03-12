#!/usr/bin/env node

import * as path from 'path';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpError, invalidParams } from '@autoresearch/shared';
import { IdeaRpcClient } from './rpc-client.js';
import { zodToMcpInputSchema } from './mcp-input-schema.js';
import { IDEA_TOOLS } from './tool-registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function resolveIdeaCorePath(): string {
  const envPath = process.env.IDEA_CORE_PATH;
  if (envPath) return path.resolve(envPath);
  // Default: sibling package in monorepo
  return path.resolve(import.meta.dirname, '../../idea-core');
}

export async function startServer(): Promise<void> {
  const ideaCorePath = resolveIdeaCorePath();
  const rpc = new IdeaRpcClient({ ideaCorePath });

  const server = new Server(
    { name: 'idea-mcp', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: IDEA_TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToMcpInputSchema(t.schema),
    })),
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolDef = IDEA_TOOLS.find(t => t.name === toolName);

    if (!toolDef) {
      const err = invalidParams(`Unknown tool: ${toolName}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
        isError: true,
      };
    }

    try {
      const params = toolDef.schema.parse(request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await rpc.call(toolDef.rpcMethod, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const mcpErr = err instanceof McpError ? err : (
        err instanceof z.ZodError
          ? invalidParams(err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
          : new McpError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err))
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(mcpErr.toJSON()) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', () => {
    rpc.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    rpc.close();
    process.exit(0);
  });
}

startServer().catch((err) => {
  process.stderr.write(`[idea-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
