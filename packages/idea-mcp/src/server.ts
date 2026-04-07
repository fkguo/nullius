#!/usr/bin/env node

import * as path from 'path';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpError, invalidParams } from '@autoresearch/shared';
import { DEFAULT_IDEA_RPC_BACKEND, type IdeaRpcBackend } from './backend.js';
import { IdeaRpcClient } from './rpc-client.js';
import { zodToMcpInputSchema } from './mcp-input-schema.js';
import { IDEA_TOOLS } from './tool-registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export function resolveIdeaBackend(env: NodeJS.ProcessEnv = process.env): IdeaRpcBackend {
  const envValue = env.IDEA_MCP_BACKEND?.trim();
  if (!envValue) return DEFAULT_IDEA_RPC_BACKEND;
  if (envValue === 'idea-engine' || envValue === 'idea-core-python') return envValue;
  throw new Error(`Unsupported IDEA_MCP_BACKEND: ${envValue}`);
}

export function resolveIdeaDataDir(
  env: NodeJS.ProcessEnv = process.env,
  backend: IdeaRpcBackend = resolveIdeaBackend(env),
): string {
  const envPath = env.IDEA_MCP_DATA_DIR;
  if (envPath) return path.resolve(envPath);
  const packageDir = backend === 'idea-core-python' ? '../../idea-core/runs' : '../../idea-engine/runs';
  return path.resolve(import.meta.dirname, packageDir);
}

export function resolveIdeaCorePath(env: NodeJS.ProcessEnv = process.env): string {
  // This resolver is only consumed on the explicit idea-core-python compatibility branch.
  const envPath = env.IDEA_CORE_PATH;
  if (envPath) return path.resolve(envPath);
  return path.resolve(import.meta.dirname, '../../idea-core');
}

function resolveIdeaContractDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envPath = env.IDEA_MCP_CONTRACT_DIR;
  return envPath ? path.resolve(envPath) : undefined;
}

export function createIdeaRpcClient(env: NodeJS.ProcessEnv = process.env): IdeaRpcClient {
  const backend = resolveIdeaBackend(env);
  const contractDir = resolveIdeaContractDir(env);
  if (backend === 'idea-core-python') {
    return new IdeaRpcClient({
      backend,
      contractDir,
      dataDir: resolveIdeaDataDir(env, backend),
      ideaCorePath: resolveIdeaCorePath(env),
    });
  }
  return new IdeaRpcClient({
    backend,
    contractDir,
    rootDir: resolveIdeaDataDir(env, backend),
  });
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rpc = createIdeaRpcClient(env);

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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startServer().catch((err) => {
    process.stderr.write(`[idea-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
