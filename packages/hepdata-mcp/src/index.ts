#!/usr/bin/env node

import './utils/stdioHygiene.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { isMainModule } from '@nullius/shared';

import { getTools, handleToolCall, type ToolExposureMode } from './tools/index.js';

const TOOL_MODE: ToolExposureMode = process.env.HEPDATA_TOOL_MODE === 'full' ? 'full' : 'standard';

const server = new Server(
  { name: 'hepdata-mcp', version: '0.6.0' },
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
  console.error('[hepdata-mcp] Server started');
}

if (isMainModule(import.meta.url)) {
  main().catch(console.error);
}
