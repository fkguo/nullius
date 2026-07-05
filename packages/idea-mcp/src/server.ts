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
import { McpError, invalidParams, verifyHarnessInvocationMarker } from '@nullius/shared';
import { isStateTouchingIdeaMcp } from './state-touch-classification.js';
import { IdeaRpcClient } from './rpc-client.js';
import { zodToMcpInputSchema } from './mcp-input-schema.js';
import { CONFIRM_FIELD, IDEA_TOOLS, type IdeaToolDef } from './tool-registry.js';

/**
 * B-10 testable helper: Zod-parse `rawArgs` against the tool's schema, then
 * strip the destructive-gate marker before the result is forwarded to the
 * idea-engine RPC backend.
 *
 * Behavior:
 *   - For destructive tools the schema already requires `_confirm: true`;
 *     the parse throws on missing/wrong values. After parse, `_confirm` is
 *     removed so the RPC backend never sees it (the field is part of the
 *     tool-surface confirmation contract, not the state-machine contract).
 *   - For non-destructive tools the schema rejects `_confirm` as an
 *     unknown field via `.strict()`, preserving the existing contract.
 *
 * Returns the cleaned args dict suitable for `rpc.call(toolDef.rpcMethod, args)`.
 *
 * Exported for direct unit testing (the server's `setRequestHandler` call
 * graph is awkward to drive in isolation).
 */
export function parseAndCleanToolArgs(
  toolDef: IdeaToolDef,
  rawArgs: unknown,
): Record<string, unknown> {
  const params = toolDef.schema.parse(rawArgs ?? {}) as Record<string, unknown>;
  if (CONFIRM_FIELD in params) {
    delete params[CONFIRM_FIELD];
  }
  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const IDEA_MCP_REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function isWithinRepoRoot(targetPath: string, repoRoot: string = IDEA_MCP_REPO_ROOT): boolean {
  const relative = path.relative(repoRoot, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertNoLegacyIdeaEnv(env: NodeJS.ProcessEnv = process.env): void {
  const legacyEnvNames = ['IDEA_MCP_BACKEND'].filter((name) => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (legacyEnvNames.length === 0) return;
  throw new Error(
    `idea-mcp no longer supports legacy backend envs: ${legacyEnvNames.join(', ')}; TS idea-engine is the only host authority`,
  );
}

export function resolveIdeaDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const envPath = env.IDEA_MCP_DATA_DIR?.trim();
  if (!envPath) {
    throw new Error(
      'idea-mcp requires IDEA_MCP_DATA_DIR; repo-local default data roots are forbidden',
    );
  }
  const resolved = path.resolve(envPath);
  if (isWithinRepoRoot(resolved)) {
    throw new Error(
      `idea-mcp requires IDEA_MCP_DATA_DIR outside the dev repo: ${IDEA_MCP_REPO_ROOT}`,
    );
  }
  return resolved;
}

function resolveIdeaContractDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envPath = env.IDEA_MCP_CONTRACT_DIR;
  return envPath ? path.resolve(envPath) : undefined;
}

export function createIdeaRpcClient(env: NodeJS.ProcessEnv = process.env): IdeaRpcClient {
  assertNoLegacyIdeaEnv(env);
  const contractDir = resolveIdeaContractDir(env);
  return new IdeaRpcClient({
    contractDir,
    rootDir: resolveIdeaDataDir(env),
  });
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rpc = createIdeaRpcClient(env);

  const server = new Server(
    { name: 'idea-mcp', version: '0.5.0' },
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
      // P3-C (redesigned 2026-05-23): event-driven anchor verification.
      // idea-mcp classifier: ALL idea_* tools are STATE_TOUCHING per audit
      // (every campaign tool mutates `<rootDir>/campaigns/...`).
      verifyHarnessInvocationMarker(process.cwd(), {
        toolIsStateTouching: isStateTouchingIdeaMcp(toolName),
      });
      const params = parseAndCleanToolArgs(toolDef, request.params.arguments);
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
