#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProjectAdapter } from './adapter.js';
import type { Context } from './policy.js';

const adapter = new ProjectAdapter(process.env.NULLIUS_PROJECT_ROOT ?? '');
process.chdir(adapter.root);
const server = new Server({ name: 'nullius-project-mcp', version: '0.5.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: adapter.listTools() }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const supportsSampling = Boolean(server.getClientCapabilities()?.sampling);
  const createMessage: Context['createMessage'] = supportsSampling
    ? async input => server.createMessage(input as Parameters<typeof server.createMessage>[0]) as ReturnType<NonNullable<Context['createMessage']>>
    : undefined;
  return adapter.call(request.params.name, request.params.arguments ?? {}, { createMessage });
});
await server.connect(new StdioServerTransport());
