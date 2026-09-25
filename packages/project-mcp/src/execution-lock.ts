import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, fsyncParentDirectoryDurable } from '@nullius/shared';
import { boundPath } from './paths.js';

function lockPath(root: string): string { return boundPath(root, '.nullius/project_mcp_execution.lock'); }
export function acquireExecution(root: string, owner: string): void {
  const target = lockPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let fd: number;
  try { fd = fs.openSync(target, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let holder: { owner: string | null; pid: number | null; created_at: string | null } | null = null;
    try {
      // Only bounded ownership metadata is exposed; no raw hidden-file content.
      if (fs.statSync(target).size <= 1024) {
        const record = JSON.parse(fs.readFileSync(target, 'utf8'));
        holder = {
          owner: typeof record?.owner === 'string' ? record.owner.slice(0, 128) : null,
          pid: Number.isSafeInteger(record?.pid) ? record.pid : null,
          created_at: typeof record?.created_at === 'string' ? record.created_at.slice(0, 64) : null,
        };
      }
    } catch { /* Missing or malformed ownership still requires local inspection. */ }
    throw invalidParams('Project MCP execution is busy or requires local reconciliation. Read a delivery owner with project_delivery_read; foreground sampling/file operations have no transport delivery. Never remove a lock until all writers have stopped and canonical outputs have been inspected.', {
      lock: '.nullius/project_mcp_execution.lock', holder,
    });
  }
  try {
    try { fs.writeSync(fd, JSON.stringify({ owner, pid: process.pid, created_at: new Date().toISOString() })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fsyncParentDirectoryDurable(target);
  } catch (error) {
    // No execution can have started before ownership metadata is durable.
    fs.unlinkSync(target);
    throw error;
  }
}
export function releaseExecution(root: string, owner: string): void {
  const target = lockPath(root);
  const holder = JSON.parse(fs.readFileSync(target, 'utf8')) as { owner: string };
  if (holder.owner !== owner) throw invalidParams('Execution lock owner mismatch.');
  fs.unlinkSync(target);
  fsyncParentDirectoryDurable(target);
}
