#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distEntry = path.resolve(__dirname, '..', 'dist', 'index.js');

if (!existsSync(distEntry)) {
  console.error(`[arxiv-mcp] Build output missing: ${distEntry}`);
  console.error('[arxiv-mcp] Run: pnpm -C packages/arxiv-mcp build');
  process.exitCode = 1;
  process.exit();
}

const child = spawn(process.execPath, [distEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error('[arxiv-mcp] Failed to start:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
