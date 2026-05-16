import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { invalidParams } from '@autoresearch/shared';
import { resolvePathWithinParent } from './pathGuard.js';

export const HEP_DATA_DIR_ENV = 'HEP_DATA_DIR';
export const HEP_DOWNLOAD_DIR_ENV = 'HEP_DOWNLOAD_DIR';
export const ARXIV_DOWNLOAD_DIR_ENV = 'ARXIV_DOWNLOAD_DIR';
export const WRITING_PROGRESS_DIR_ENV = 'WRITING_PROGRESS_DIR';

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.autoresearch', 'hep-mcp');
const PROJECT_LOCAL_HEP_DATA_DIR = path.join('artifacts', 'hep-mcp');

export type HepDataRootSource = 'project_root' | 'env' | 'scratch';

export interface HepDataRootResolution {
  path: string;
  source: HepDataRootSource;
  project_root?: string;
}

const hepDataRootScope = new AsyncLocalStorage<HepDataRootResolution>();

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function normalizeProjectRoot(rawProjectRoot: unknown): string | undefined {
  if (rawProjectRoot === undefined || rawProjectRoot === null) return undefined;
  if (typeof rawProjectRoot !== 'string') {
    throw invalidParams('project_root must be a string path', { project_root: rawProjectRoot });
  }

  const trimmed = rawProjectRoot.trim();
  if (trimmed.length === 0) {
    throw invalidParams('project_root must not be empty');
  }

  const expanded = expandTilde(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw invalidParams('project_root must be an absolute path or tilde-prefixed path', { project_root: rawProjectRoot });
  }

  const resolved = path.resolve(expanded);
  const markerDir = path.join(resolved, '.autoresearch');
  if (!fs.existsSync(markerDir) || !fs.statSync(markerDir).isDirectory()) {
    throw invalidParams('project_root is not an initialized autoresearch project', {
      project_root: resolved,
      required_marker: markerDir,
    });
  }

  return resolved;
}

export function resolveHepDataRoot(projectRoot?: unknown): HepDataRootResolution {
  const normalizedProjectRoot = normalizeProjectRoot(projectRoot);
  if (normalizedProjectRoot) {
    return {
      path: path.join(normalizedProjectRoot, PROJECT_LOCAL_HEP_DATA_DIR),
      source: 'project_root',
      project_root: normalizedProjectRoot,
    };
  }

  const configured = process.env[HEP_DATA_DIR_ENV];
  if (configured && configured.trim().length > 0) {
    return {
      path: path.resolve(expandTilde(configured)),
      source: 'env',
    };
  }

  return {
    path: path.resolve(DEFAULT_DATA_DIR),
    source: 'scratch',
  };
}

export function getDataRootInfo(): HepDataRootResolution {
  return hepDataRootScope.getStore() ?? resolveHepDataRoot();
}

export async function withHepDataRoot<T>(projectRoot: unknown, fn: () => Promise<T>): Promise<T> {
  if ((projectRoot === undefined || projectRoot === null) && hepDataRootScope.getStore()) {
    return fn();
  }
  return hepDataRootScope.run(resolveHepDataRoot(projectRoot), fn);
}

export function getDataDir(): string {
  return getDataRootInfo().path;
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
  const root = getDataRootInfo();
  const dataDir = root.path;
  const candidate = root.source === 'project_root'
    ? path.join(dataDir, 'writing_progress')
    : expandTilde(process.env[WRITING_PROGRESS_DIR_ENV] || path.join(dataDir, 'writing_progress'));
  return resolvePathWithinParent(dataDir, candidate, WRITING_PROGRESS_DIR_ENV);
}

export function getDownloadsDir(): string {
  const root = getDataRootInfo();
  const dataDir = root.path;
  const candidate =
    root.source === 'project_root'
      ? path.join(dataDir, 'downloads')
      : process.env[HEP_DOWNLOAD_DIR_ENV] ||
        process.env[ARXIV_DOWNLOAD_DIR_ENV] ||
        path.join(dataDir, 'downloads');
  return resolvePathWithinParent(dataDir, expandTilde(candidate), 'downloads dir');
}
