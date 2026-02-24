#!/usr/bin/env node

import './utils/stdioHygiene.js';

// H-20: Load .env from CWD (override: false — environment variables take precedence).
import 'dotenv/config';

import * as fs from 'fs';
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

import { getTools, handleToolCall } from './tools/index.js';
import type { ToolExposureMode } from './tools/index.js';
import { ensureDir, getDataDir, getDownloadsDir } from './data/dataDir.js';
import { cleanupRegisteredDownloadDirs } from './data/downloadSession.js';
import { isMarkedDirectory } from './data/markers.js';
import { listHepResourceTemplates, listHepResources, readHepResource } from './vnext/resources.js';
import {
  cleanupOldPdgArtifacts,
  listPdgResourceTemplates,
  listPdgResources,
  readPdgResource,
} from '@autoresearch/pdg-mcp/tooling';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TTL_HOURS = 24;
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

// Tool exposure mode: 'standard' or 'full'
function parseToolMode(): ToolExposureMode {
  const raw = process.env.HEP_TOOL_MODE;
  if (raw === undefined) return 'standard';
  const v = raw.trim().toLowerCase();
  if (v === '') return 'standard';
  if (v === 'standard') return 'standard';
  if (v === 'full') return 'full';
  throw new Error(`[hep-research-mcp] Invalid HEP_TOOL_MODE: ${raw} (expected 'standard' or 'full')`);
}

const TOOL_MODE: ToolExposureMode = parseToolMode();

// ─────────────────────────────────────────────────────────────────────────────
// Environment Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate environment configuration on startup
 */
function validateEnvironment(): void {
  const errors: string[] = [];

  // Validate data dir exists and is writable
  try {
    const dataDir = getDataDir();
    ensureDir(dataDir);
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (err) {
    errors.push(`HEP_DATA_DIR not writable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate downloads dir exists and is writable (must be within data dir)
  try {
    const downloadsDir = getDownloadsDir();
    ensureDir(downloadsDir);
    fs.accessSync(downloadsDir, fs.constants.W_OK);
  } catch (err) {
    errors.push(`Downloads dir not writable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (errors.length > 0) {
    throw new Error(`[hep-research-mcp] Startup validation failed:\n- ${errors.join('\n- ')}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session cleanup - track downloaded directories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean up all registered download directories
 */
function cleanupOnExit(): void {
  cleanupRegisteredDownloadDirs();
}

// Register cleanup handlers
process.on('exit', cleanupOnExit);
process.on('SIGTERM', () => {
  cleanupOnExit();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanupOnExit();
  process.exit(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// TTL Cleanup - remove old temporary directories on startup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean up old arxiv download directories (older than TTL_HOURS)
 * Runs on startup to prevent accumulation of temporary files
 */
function cleanupOldDownloads(): void {
  try {
    const downloadDir = getDownloadsDir();
    const entries = fs.readdirSync(downloadDir, { withFileTypes: true });
    const now = Date.now();
    let cleanedCount = 0;

    for (const entry of entries) {
      // Only clean arxiv-* directories created by this tool
      if (!entry.isDirectory() || !entry.name.startsWith('arxiv-')) {
        continue;
      }

      const dirPath = path.join(downloadDir, entry.name);
      try {
        if (!isMarkedDirectory(dirPath, 'download_dir')) continue;
        const stat = fs.statSync(dirPath);
        const age = now - stat.mtimeMs;

        if (age > TTL_MS) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleanedCount++;
        }
      } catch {
        // Skip directories we can't access
      }
    }

    if (cleanedCount > 0) {
      console.error(`[hep-research-mcp] Cleaned up ${cleanedCount} old download directories`);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'hep-research-mcp',
    version: '0.3.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getTools(TOOL_MODE) };
});

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: [...listHepResources(), ...listPdgResources()] };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates: [...listHepResourceTemplates(), ...listPdgResourceTemplates()] };
});

// Read a resource by URI
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const content = uri.startsWith('pdg://') ? readPdgResource(uri) : readHepResource(uri);
  return { contents: [content] };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const progressToken = request.params?._meta?.progressToken;
  return handleToolCall(request.params.name, request.params.arguments ?? {}, TOOL_MODE, {
    requestId: extra.requestId,
    progressToken,
    sendNotification: extra.sendNotification,
  });
});

// Start server
async function main() {
  // Validate environment on startup
  validateEnvironment();

  // Clean up old download directories on startup
  cleanupOldDownloads();

  try {
    const cleaned = cleanupOldPdgArtifacts();
    if (cleaned.deleted_files > 0) {
      console.error(`[hep-research-mcp] Cleaned up ${cleaned.deleted_files} old PDG artifact files`);
    }
  } catch {
    // ignore PDG cleanup errors
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[hep-research-mcp] Server started');
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
