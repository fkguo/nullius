import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { invalidParams } from '@autoresearch/shared';

export const PDG_DB_PATH_ENV = 'PDG_DB_PATH';

let sha256Cache:
  | {
    filePath: string;
    sizeBytes: number;
    mtimeMs: number;
    sha256: string;
  }
  | undefined;

export function getPdgDbPathFromEnv(): string | undefined {
  const raw = process.env[PDG_DB_PATH_ENV];
  if (!raw || raw.trim().length === 0) return undefined;

  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    throw invalidParams(`${PDG_DB_PATH_ENV} must be an absolute path`, { env: PDG_DB_PATH_ENV, value: trimmed });
  }

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw invalidParams(`${PDG_DB_PATH_ENV} does not exist`, { env: PDG_DB_PATH_ENV, value: resolved });
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw invalidParams(`${PDG_DB_PATH_ENV} must point to a file`, { env: PDG_DB_PATH_ENV, value: resolved });
  }

  return resolved;
}

export function requirePdgDbPathFromEnv(): string {
  const p = getPdgDbPathFromEnv();
  if (!p) {
    throw invalidParams(`${PDG_DB_PATH_ENV} is required`, {
      env: PDG_DB_PATH_ENV,
      how_to: 'Set PDG_DB_PATH=/abs/path/to/pdg.sqlite',
    });
  }
  return p;
}

export async function sha256File(filePath: string): Promise<string> {
  const stat = fs.statSync(filePath);
  if (
    sha256Cache
    && sha256Cache.filePath === filePath
    && sha256Cache.sizeBytes === stat.size
    && sha256Cache.mtimeMs === stat.mtimeMs
  ) {
    return sha256Cache.sha256;
  }

  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  const digest = hash.digest('hex');

  sha256Cache = {
    filePath,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: digest,
  };

  return digest;
}

export async function getFileMetadata(filePath: string): Promise<{
  size_bytes: number;
  mtime_iso: string;
  sha256: string;
}> {
  const stat = fs.statSync(filePath);
  const digest = await sha256File(filePath);
  return {
    size_bytes: stat.size,
    mtime_iso: stat.mtime.toISOString(),
    sha256: digest,
  };
}
