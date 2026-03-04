#!/usr/bin/env node

import './utils/stdioHygiene.js';

import * as path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getTools, handleToolCall, type ToolExposureMode } from './tools/index.js';

const TOOL_MODE: ToolExposureMode = process.env.OPENALEX_TOOL_MODE === 'full' ? 'full' : 'standard';

const server = new Server(
  { name: 'openalex-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getTools(TOOL_MODE) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return handleToolCall(
    request.params.name,
    request.params.arguments ?? {},
    TOOL_MODE,
  );
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[openalex-mcp] Server started');
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
