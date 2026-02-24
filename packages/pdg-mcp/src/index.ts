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
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getTools, handleToolCall, type ToolExposureMode } from './tools/index.js';
import { listPdgResources, listPdgResourceTemplates, readPdgResource } from './resources.js';
import { cleanupOldPdgArtifacts } from './artifactTtl.js';

const TOOL_MODE: ToolExposureMode = process.env.PDG_TOOL_MODE === 'full' ? 'full' : 'standard';

const server = new Server(
  {
    name: 'pdg-mcp',
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
  return { resources: listPdgResources() };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates: listPdgResourceTemplates() };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const content = readPdgResource(request.params.uri);
  return { contents: [content] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return handleToolCall(request.params.name, request.params.arguments ?? {}, TOOL_MODE);
});

async function main() {
  try {
    const cleaned = cleanupOldPdgArtifacts();
    if (cleaned.deleted_files > 0) {
      console.error(`[pdg-mcp] Cleaned up ${cleaned.deleted_files} old artifact files`);
    }
  } catch {
    // ignore cleanup errors
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[pdg-mcp] Server started');
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
