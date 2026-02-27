#!/usr/bin/env node

import * as path from 'path';
import { z, toJSONSchema } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpError, invalidParams } from '@autoresearch/shared';
import { IdeaRpcClient } from './rpc-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

const CampaignInitSchema = z.object({
  topic: z.string().min(1).describe('Research topic for the campaign'),
  budget: z.number().int().positive().optional().describe('Maximum number of search steps'),
});

const CampaignIdSchema = z.object({
  campaign_id: z.string().min(1).describe('Campaign identifier'),
});

const CampaignTopupSchema = z.object({
  campaign_id: z.string().min(1).describe('Campaign identifier'),
  budget: z.number().int().positive().describe('Additional search steps to add'),
});

const SearchStepSchema = z.object({
  campaign_id: z.string().min(1).describe('Campaign identifier'),
  query: z.string().optional().describe('Optional override query for this search step'),
});

const EvalRunSchema = z.object({
  campaign_id: z.string().min(1).describe('Campaign identifier'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType<any, any>;
  rpcMethod: string;
}

const TOOLS: ToolDef[] = [
  {
    name: 'idea_campaign_init',
    description: 'Create a new idea search campaign for a research topic.',
    schema: CampaignInitSchema,
    rpcMethod: 'campaign.init',
  },
  {
    name: 'idea_campaign_status',
    description: 'Get the current status of an idea campaign.',
    schema: CampaignIdSchema,
    rpcMethod: 'campaign.status',
  },
  {
    name: 'idea_campaign_topup',
    description: 'Add more search budget to an existing campaign.',
    schema: CampaignTopupSchema,
    rpcMethod: 'campaign.topup',
  },
  {
    name: 'idea_campaign_pause',
    description: 'Pause an active campaign.',
    schema: CampaignIdSchema,
    rpcMethod: 'campaign.pause',
  },
  {
    name: 'idea_campaign_resume',
    description: 'Resume a paused campaign.',
    schema: CampaignIdSchema,
    rpcMethod: 'campaign.resume',
  },
  {
    name: 'idea_campaign_complete',
    description: 'Mark a campaign as complete and finalize results.',
    schema: CampaignIdSchema,
    rpcMethod: 'campaign.complete',
  },
  {
    name: 'idea_search_step',
    description: 'Execute one search step in a campaign, exploring or refining ideas.',
    schema: SearchStepSchema,
    rpcMethod: 'search.step',
  },
  {
    name: 'idea_eval_run',
    description: 'Run evaluation on the current campaign ideas, scoring and ranking them.',
    schema: EvalRunSchema,
    rpcMethod: 'eval.run',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Schema conversion (same pattern as hep-mcp/mcpSchema.ts)
// ─────────────────────────────────────────────────────────────────────────────

function zodToMcpInputSchema(schema: z.ZodType<any, any>): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-07',
    reused: 'inline',
    unrepresentable: 'any',
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, $defs, ['~standard']: _standard, ...rest } = jsonSchema as unknown as {
    $schema?: string;
    $defs?: unknown;
    '~standard'?: unknown;
    [key: string]: unknown;
  };

  const normalized = { ...rest } as Record<string, unknown>;
  const type = normalized.type;
  if (type === undefined) {
    normalized.type = 'object';
    return normalized;
  }
  if (type !== 'object') {
    throw new Error(`Invalid MCP inputSchema: expected top-level type "object", got ${JSON.stringify(type)}`);
  }
  return normalized;
}

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
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToMcpInputSchema(t.schema),
    })),
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolDef = TOOLS.find(t => t.name === toolName);

    if (!toolDef) {
      const err = invalidParams(`Unknown tool: ${toolName}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
        isError: true,
      };
    }

    try {
      const params = toolDef.schema.parse(request.params.arguments ?? {});
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
