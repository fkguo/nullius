import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePathWithinParent } from './pathGuard.js';

export const PDG_DATA_DIR_ENV = 'PDG_DATA_DIR';
const HEP_DATA_DIR_ENV = 'HEP_DATA_DIR';

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.hep-research-mcp', 'pdg');

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function getDataDir(): string {
  const explicit = process.env[PDG_DATA_DIR_ENV];
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(expandTilde(explicit));
  }

  // Convenience: when hep-research-mcp is configured with a per-project HEP_DATA_DIR, default PDG_DATA_DIR
  // to live under the same root to keep everything easy to relocate/clean up.
  const hepDataDir = process.env[HEP_DATA_DIR_ENV];
  if (hepDataDir && hepDataDir.trim().length > 0) {
    const expanded = expandTilde(hepDataDir);
    return path.resolve(path.join(expanded, 'pdg'));
  }

  return path.resolve(DEFAULT_DATA_DIR);
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

export function getArtifactsDir(): string {
  const dataDir = getDataDir();
  const candidate = path.join(dataDir, 'artifacts');
  return resolvePathWithinParent(dataDir, candidate, 'artifacts dir');
}
