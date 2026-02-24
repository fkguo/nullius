import { spawn } from 'child_process';
import { invalidParams, upstreamError } from '@autoresearch/shared';

export function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

const SQLITE_MAX_STDOUT_BYTES = parsePositiveIntEnv('PDG_SQLITE_MAX_STDOUT_BYTES', 50 * 1024 * 1024);
const SQLITE_CONCURRENCY = parsePositiveIntEnv('PDG_SQLITE_CONCURRENCY', 4);

let inFlight = 0;
const queue: Array<() => void> = [];

async function withSqliteConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= SQLITE_CONCURRENCY) {
    await new Promise<void>(resolve => queue.push(resolve));
  }

  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    const next = queue.shift();
    if (next) next();
  }
}

export async function sqlite3JsonQuery(dbPath: string, sql: string): Promise<unknown[]> {
  return withSqliteConcurrencyLimit(async () => {
    const args = ['-readonly', '-bail', '-batch', '-safe', '-json', dbPath, sql];

    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('sqlite3', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      let exceeded = false;

      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');

      child.stdout?.on('data', (chunk: string) => {
        if (exceeded) return;
        stdout += chunk;
        if (stdout.length > SQLITE_MAX_STDOUT_BYTES) {
          exceeded = true;
          child.kill();
        }
      });
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length > 1024 * 1024) return;
        stderr += chunk;
      });

      child.on('error', err => reject(err));
      child.on('close', status => {
        if (exceeded) {
          reject(
            upstreamError('sqlite3 output exceeded PDG_SQLITE_MAX_STDOUT_BYTES', {
              max_bytes: SQLITE_MAX_STDOUT_BYTES,
              sql,
            })
          );
          return;
        }
        resolve({ status, stdout, stderr });
      });
    }).catch(err => {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === 'ENOENT') {
        throw invalidParams('sqlite3 not found in PATH; install sqlite3 to use PDG_DB_PATH', {
          which: 'sqlite3',
        });
      }
      throw upstreamError('sqlite3 execution failed', {
        code: e?.code,
        message: e instanceof Error ? e.message : String(e),
        sql,
      });
    });

    if (res.status !== 0) {
      throw upstreamError('sqlite3 query failed', {
        status: res.status,
        stderr: res.stderr?.trim() || undefined,
        sql,
      });
    }

    const stdout = (res.stdout ?? '').trim();
    if (stdout.length === 0) return [];

    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (err) {
      throw upstreamError('sqlite3 returned non-JSON output', {
        message: err instanceof Error ? err.message : String(err),
        stdout_preview: stdout.slice(0, 2000),
      });
    }
  });
}
