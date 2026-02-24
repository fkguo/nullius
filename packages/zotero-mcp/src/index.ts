#!/usr/bin/env node

import './utils/stdioHygiene.js';

import * as path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getTools, handleToolCall, type ToolExposureMode } from './tools/index.js';

const TOOL_MODE: ToolExposureMode = process.env.ZOTERO_TOOL_MODE === 'full' ? 'full' : 'standard';

const server = new Server(
  {
    name: 'zotero-mcp',
    version: '0.3.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getTools(TOOL_MODE) };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: [] };
});

server.setRequestHandler(ReadResourceRequestSchema, async () => {
  throw new Error('zotero-mcp does not expose resources');
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return handleToolCall(request.params.name, request.params.arguments ?? {}, TOOL_MODE);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[zotero-mcp] Server started');
}

const isExecutedAsScript = (() => {
  try {
    const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const modulePath = fileURLToPath(import.meta.url);
    return entryPath === modulePath;
  } catch {
    return false;
  }
})();

if (isExecutedAsScript) {
  main().catch(console.error);
}
