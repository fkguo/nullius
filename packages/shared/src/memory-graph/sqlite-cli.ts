import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { invalidParams, upstreamError } from '../errors.js';

export interface SqliteRunOptions {
  readonly?: boolean;
  json?: boolean;
}

export function resolveDbPath(dbPath: string): string {
  if (!dbPath || dbPath.trim().length === 0) {
    throw invalidParams('memory graph dbPath must be a non-empty string');
  }

  const resolved = resolve(dbPath);
  if (!existsSync(dirname(resolved))) {
    throw invalidParams('memory graph dbPath parent directory does not exist', { dbPath: resolved });
  }
  return resolved;
}

export function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlJsonLiteral(value: unknown): string {
  return sqlStringLiteral(JSON.stringify(value));
}

export async function runSql(dbPath: string, sql: string, options: SqliteRunOptions = {}): Promise<string> {
  // Keep busy_timeout as a CLI command so JSON queries don't emit PRAGMA rows.
  const args = ['-batch', '-bail', '-safe', '-cmd', '.timeout 5000'];
  if (options.readonly) args.push('-readonly');
  if (options.json) args.push('-json');
  args.push(dbPath, sql);

  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn('sqlite3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolvePromise({ status, stdout, stderr }));
  }).catch(error => {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      throw invalidParams('sqlite3 not found in PATH; install sqlite3 to use the memory graph store', { which: 'sqlite3' });
    }
    throw upstreamError('sqlite3 execution failed', { code: err?.code, message: err instanceof Error ? err.message : String(err) });
  });

  if (result.status !== 0) {
    throw upstreamError('sqlite3 query failed', {
      dbPath,
      status: result.status,
      stderr: result.stderr.trim() || undefined,
    });
  }

  return result.stdout.trim();
}

export async function execSql(dbPath: string, sql: string, options: SqliteRunOptions = {}): Promise<void> {
  await runSql(dbPath, sql, options);
}

export async function queryJson<T>(dbPath: string, sql: string, options: SqliteRunOptions = {}): Promise<T[]> {
  const stdout = await runSql(dbPath, sql, { ...options, json: true });
  if (stdout.length === 0) return [];

  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    const segments = stdout.split('\n').map(segment => segment.trim()).filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(segments[index] as string) as unknown;
        if (Array.isArray(parsed)) return parsed as T[];
      } catch {
        // Try earlier JSON documents emitted by sqlite3 for preceding statements.
      }
    }
    throw upstreamError('sqlite3 returned non-JSON output', {
      message: error instanceof Error ? error.message : String(error),
      stdout_preview: stdout.slice(0, 1000),
    });
  }
}
