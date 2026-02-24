import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePathWithinParent } from './pathGuard.js';

export const HEP_DATA_DIR_ENV = 'HEP_DATA_DIR';
export const HEP_DOWNLOAD_DIR_ENV = 'HEP_DOWNLOAD_DIR';
export const ARXIV_DOWNLOAD_DIR_ENV = 'ARXIV_DOWNLOAD_DIR';
export const WRITING_PROGRESS_DIR_ENV = 'WRITING_PROGRESS_DIR';

const DEFAULT_DATA_DIR_NAME = '.hep-research-mcp';

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function getDataDir(): string {
  const candidate = process.env[HEP_DATA_DIR_ENV] || path.join(os.homedir(), DEFAULT_DATA_DIR_NAME);
  return path.resolve(expandTilde(candidate));
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
}

export function getCacheDir(): string {
  return path.join(getDataDir(), 'cache');
}

export function getWritingProgressDir(): string {
  const dataDir = getDataDir();
  const candidate = expandTilde(process.env[WRITING_PROGRESS_DIR_ENV] || path.join(dataDir, 'writing_progress'));
  return resolvePathWithinParent(dataDir, candidate, WRITING_PROGRESS_DIR_ENV);
}

export function getDownloadsDir(): string {
  const dataDir = getDataDir();
  const candidate =
    process.env[HEP_DOWNLOAD_DIR_ENV] ||
    process.env[ARXIV_DOWNLOAD_DIR_ENV] ||
    path.join(dataDir, 'downloads');
  return resolvePathWithinParent(dataDir, expandTilde(candidate), 'downloads dir');
}
